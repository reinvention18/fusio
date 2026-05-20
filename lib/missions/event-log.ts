/**
 * Missions — append-only event log.
 *
 * Phase 4: every event the mission runner emits is written to
 * `data/missions/<id>.events.jsonl` as one JSON object per line. The HTTP
 * SSE endpoint becomes a thin **subscriber** to this file — it tails the
 * log instead of running the mission inline. This decouples the runner
 * lifecycle from any single HTTP connection: the user can close their
 * browser, the connection drops, the runner keeps writing, the next SSE
 * client replays from offset 0 and catches up.
 *
 * On-disk format:
 *   { "seq": 0, "ts": "<ISO>", "type": "mission.start", "payload": {...} }
 *   { "seq": 1, "ts": "<ISO>", "type": "phase.start", "payload": {...} }
 *   ...
 *
 * Append semantics:
 *   • appendEvent() opens with O_APPEND so concurrent writes don't tear
 *     within a Node process (kernel guarantees < 4096 byte writes are atomic).
 *   • Cross-process safety relies on the runner being the sole writer.
 *
 * Tail semantics:
 *   • tailEvents() yields events from a starting byte offset, then blocks
 *     waiting for new lines using fs.watch. Caller passes an AbortSignal
 *     to stop tailing (e.g. when the SSE client disconnects).
 *
 * No DB, no library — a plain JSONL file. This keeps the format trivially
 * inspectable (`tail -f` works), trivially recoverable, and cheap.
 */

import 'server-only';
import { promises as fs } from 'node:fs';
import { watch, createReadStream } from 'node:fs';
import * as path from 'node:path';
import { missionEventLogPath } from './persistence';

// ─── Event types ─────────────────────────────────────────────────────────

/** Discriminated union of mission event types. The full event payload union
 *  is left as `unknown` here — runner.ts and the SSE consumer agree on the
 *  shape per `type`. The on-disk format only requires `seq`, `ts`, `type`. */
export type MissionEventType =
  | 'mission.start'
  | 'mission.end'
  | 'mission.status'
  | 'mission.error'
  | 'phase.start'
  | 'phase.audit'
  | 'phase.rework'
  | 'phase.complete'
  | 'phase.followup'
  | 'phase.stuck'
  | 'voice'
  | 'text'
  | 'status'
  | 'audit'
  | 'contract_progress'
  | 'question'
  | 'finish';

export interface MissionEvent<P = unknown> {
  /** Monotonically increasing sequence per mission. The runner reads the
   *  current line count from the file before its first append to seed seq. */
  seq: number;
  /** ISO timestamp (UTC). */
  ts: string;
  /** Event type — see MissionEventType. */
  type: MissionEventType;
  /** Free-form payload, type-specific. */
  payload: P;
}

// ─── Append ───────────────────────────────────────────────────────────────

/** Append a single event to a mission's log. Opens the file in append-only
 *  mode each time so the kernel handles the seek + partial-write semantics.
 *  Cheap enough at the volumes we care about (<10/sec per mission). */
export async function appendEvent(missionId: string, event: Omit<MissionEvent, 'seq' | 'ts'> & Partial<Pick<MissionEvent, 'seq' | 'ts'>>): Promise<MissionEvent> {
  const logPath = missionEventLogPath(missionId);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  // Compute the next sequence number from the file's current line count.
  // Reading is O(file size) — at ~200 bytes/event and 10 events/sec for a
  // 16-day mission that's ~28GB; we keep events terse and rely on the fact
  // that most missions complete in hours, not weeks.
  const seq = event.seq ?? await countLines(logPath);
  const filled: MissionEvent = {
    seq,
    ts: event.ts ?? new Date().toISOString(),
    type: event.type,
    payload: event.payload,
  };
  const line = JSON.stringify(filled) + '\n';
  // O_APPEND: writes are atomic relative to other O_APPEND writers per
  // POSIX, so multiple concurrent appendEvent() calls within one process
  // are serialized by the kernel without us needing a mutex.
  await fs.appendFile(logPath, line, { encoding: 'utf8' });
  return filled;
}

async function countLines(filePath: string): Promise<number> {
  try {
    const body = await fs.readFile(filePath, 'utf8');
    if (!body) return 0;
    // Lines are separated by \n. The trailing \n means the last entry's
    // split() result includes an empty trailing element — drop it.
    let n = 0;
    for (let i = 0; i < body.length; i++) if (body.charCodeAt(i) === 10) n++;
    return n;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
}

// ─── Replay ───────────────────────────────────────────────────────────────

/** Read all events currently in the log (synchronous snapshot). Used when
 *  a new SSE subscriber connects mid-mission — they replay everything so
 *  far before the live tail starts. */
export async function readAllEvents(missionId: string): Promise<MissionEvent[]> {
  const logPath = missionEventLogPath(missionId);
  let body: string;
  try {
    body = await fs.readFile(logPath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  return parseLines(body);
}

function parseLines(body: string): MissionEvent[] {
  const out: MissionEvent[] = [];
  let lineStart = 0;
  for (let i = 0; i < body.length; i++) {
    if (body.charCodeAt(i) === 10) {
      const line = body.slice(lineStart, i);
      if (line.trim()) {
        try { out.push(JSON.parse(line) as MissionEvent); } catch { /* tolerate corruption */ }
      }
      lineStart = i + 1;
    }
  }
  // Tolerate a trailing partial line (write in flight) by ignoring it; the
  // tail watcher will pick it up next time the file changes.
  return out;
}

// ─── Tail ─────────────────────────────────────────────────────────────────

export interface TailOptions {
  /** Resume from this seq (inclusive). If undefined, starts from the head. */
  fromSeq?: number;
  /** AbortSignal for cancellation (e.g. SSE client disconnect). */
  signal?: AbortSignal;
  /** Max time to wait for the next event before yielding heartbeat null
   *  (the SSE consumer can use this for keep-alives). Default 15_000ms. */
  heartbeatMs?: number;
}

/** Async iterator over a mission's event log. Yields:
 *   • every event in the log at start (replay phase), then
 *   • every event appended thereafter (tail phase), until either
 *   • signal.abort() fires → loop exits cleanly, or
 *   • heartbeatMs elapses with no new event → yields null (caller can decide
 *     whether to keep polling or close).
 *
 * Implementation: fs.watch on the log file. When a change fires, re-read the
 * file from the saved byte offset and parse new lines. fs.watch is "best
 * effort" on some filesystems (network mounts, Docker bind mounts) — we
 * fall back to a 500ms poll loop if fs.watch never fires within the
 * heartbeat window.
 */
export async function* tailEvents(missionId: string, opts: TailOptions = {}): AsyncIterableIterator<MissionEvent | null> {
  const logPath = missionEventLogPath(missionId);
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const fromSeq = opts.fromSeq ?? 0;
  let byteOffset = 0;

  // Phase 1: replay everything in the file at start time.
  const initial = await readAllEvents(missionId);
  for (const ev of initial) {
    if (opts.signal?.aborted) return;
    if (ev.seq < fromSeq) continue;
    yield ev;
  }
  // Track byte offset for the tail phase.
  try {
    const stat = await fs.stat(logPath);
    byteOffset = stat.size;
  } catch {
    byteOffset = 0;
  }

  // Phase 2: tail with fs.watch + poll fallback. We resolve a "wake" promise
  // whenever either (a) fs.watch fires a change event, (b) the poll timer
  // elapses, or (c) the abort signal fires. Then we re-read from offset.
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    // fs.watch on the file path itself — if the file doesn't yet exist,
    // we'll catch ENOENT and fall through to polling.
    try { watcher = watch(logPath, { persistent: false }); } catch { /* fall through */ }

    while (!opts.signal?.aborted) {
      // Wait for next signal — fs.watch event, poll tick, abort, or heartbeat.
      const tickedAtLeastOnce = await waitForChange(watcher, heartbeatMs, opts.signal);
      if (opts.signal?.aborted) break;

      // Read any new bytes since byteOffset.
      let stat;
      try { stat = await fs.stat(logPath); } catch { stat = null; }
      if (!stat) {
        if (!tickedAtLeastOnce) yield null;
        continue;
      }
      if (stat.size <= byteOffset) {
        // No new bytes; emit a heartbeat and keep waiting.
        if (!tickedAtLeastOnce) yield null;
        continue;
      }

      // Read incrementally from the offset to avoid re-reading the head every
      // time. Use a stream so a 100MB log doesn't allocate a 100MB string.
      const newBytes = await readSliceUtf8(logPath, byteOffset, stat.size - byteOffset);
      byteOffset = stat.size;
      const events = parseLines(newBytes);
      for (const ev of events) {
        if (opts.signal?.aborted) break;
        if (ev.seq < fromSeq) continue;
        yield ev;
      }
    }
  } finally {
    try { watcher?.close(); } catch { /* ignore */ }
  }
}

function waitForChange(watcher: ReturnType<typeof watch> | null, heartbeatMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (changed: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(changed);
    };
    const cleanup = () => {
      watcher?.off('change', onChange);
      if (poll) clearTimeout(poll);
      if (heartbeat) clearTimeout(heartbeat);
      signal?.removeEventListener('abort', onAbort);
    };
    const onChange = () => settle(true);
    const onAbort = () => settle(false);

    // 500ms poll handles fs.watch's flakiness on some filesystems.
    const poll = setTimeout(() => settle(true), 500);
    // Heartbeat: hard cap. After heartbeatMs we resolve so the iterator can
    // emit a null tick — even if the poll/watch never fired.
    const heartbeat = setTimeout(() => settle(false), heartbeatMs);

    watcher?.on('change', onChange);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readSliceUtf8(filePath: string, start: number, length: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const stream = createReadStream(filePath, { start, end: start + length - 1, encoding: 'utf8' });
    let out = '';
    stream.on('data', (chunk: string | Buffer) => { out += typeof chunk === 'string' ? chunk : chunk.toString('utf8'); });
    stream.on('end', () => resolve(out));
    stream.on('error', (err) => reject(err));
  });
}

// ─── Convenience constructors ────────────────────────────────────────────
//
// The runner uses these to keep its emit calls type-safe and consistent.

export function evt<T>(type: MissionEventType, payload: T): Omit<MissionEvent<T>, 'seq' | 'ts'> {
  return { type, payload };
}
