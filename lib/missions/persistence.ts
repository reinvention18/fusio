/**
 * Missions — persistence layer.
 *
 * Phase 4 of the missions architecture: missions can run for 16+ days, so
 * their state has to survive MC restart, browser close, and network drops.
 *
 * On disk:
 *   data/missions/<id>.json       — durable mission state (mission, handoffs,
 *                                    audits, current phase/attempt, status)
 *   data/missions/<id>.events.jsonl — append-only event log (see event-log.ts)
 *   data/missions/<id>.lock       — runtime PID lock written by the background
 *                                    runner so we can detect crashed runs
 *
 * Writes are atomic: every save goes through a tmpfile + rename so a crash
 * in the middle of a write can't truncate the JSON. Reads are tolerant of
 * a missing/empty file (`loadMission` returns null) so callers can use it
 * to discover whether a mission exists.
 *
 * Concurrency: in-process per-mission async mutex prevents two save calls
 * from racing within the same Node process. The cross-process lock is the
 * `<id>.lock` file (PID + started_at) — only the process holding the lock
 * may write state. The web request handler reads-only; the background
 * runner is the writer.
 */

import 'server-only';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MissionState, MissionStatus, Mission } from './types';

// ─── Paths ────────────────────────────────────────────────────────────────

const MISSIONS_DIR = path.join(process.cwd(), 'data', 'missions');

export function missionStatePath(missionId: string): string {
  return path.join(MISSIONS_DIR, `${safeId(missionId)}.json`);
}
export function missionEventLogPath(missionId: string): string {
  return path.join(MISSIONS_DIR, `${safeId(missionId)}.events.jsonl`);
}
export function missionLockPath(missionId: string): string {
  return path.join(MISSIONS_DIR, `${safeId(missionId)}.lock`);
}

/** Strip filesystem-hostile characters from a mission id. UUIDs are fine; this
 *  defends against accidental path-traversal if a non-UUID id ever reaches
 *  here from a poorly validated API call. */
function safeId(id: string): string {
  if (!id) throw new Error('mission id is empty');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) {
    throw new Error(`mission id contains invalid characters: ${JSON.stringify(id.slice(0, 32))}`);
  }
  return id;
}

async function ensureMissionsDir(): Promise<void> {
  await fs.mkdir(MISSIONS_DIR, { recursive: true });
}

// ─── In-process per-mission mutex ────────────────────────────────────────
//
// Even though the background runner is the only intended writer, the web
// process may briefly write (e.g. when creating a new mission, or when a
// user action like "approve" updates the status). Two near-simultaneous
// updateMission calls from the same Node process would race. The mutex
// serialises them — across processes the file lock is what protects us.

const inProcessLocks = new Map<string, Promise<void>>();

async function withMissionLock<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
  const id = safeId(missionId);
  const prev = inProcessLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  inProcessLocks.set(id, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // If nobody else queued behind us, drop the entry so the map doesn't grow.
    if (inProcessLocks.get(id) === prev.then(() => next)) {
      inProcessLocks.delete(id);
    }
  }
}

// ─── Atomic write ────────────────────────────────────────────────────────

/** Write `data` to `targetPath` atomically. Crash-safe: a partial write
 *  leaves the previous file intact at `targetPath`. */
async function atomicWriteJson(targetPath: string, data: unknown): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  // Use a sibling tmp file so rename is atomic on the same filesystem.
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const body = JSON.stringify(data, null, 2);
  await fs.writeFile(tmp, body, 'utf8');
  // Force the file to disk before renaming so a power loss between rename
  // and flush can't surface a zero-length file.
  try {
    const fh = await fs.open(tmp, 'r+');
    try { await fh.sync(); } finally { await fh.close(); }
  } catch {
    // fsync isn't available on all filesystems; not critical to durability
    // for our use case (the rename is still atomic on Linux ext4/xfs).
  }
  await fs.rename(tmp, targetPath);
}

// ─── Public API ──────────────────────────────────────────────────────────

/** Load the persistent state for a mission. Returns `null` if no state file
 *  exists or it can't be parsed (caller decides whether that's an error). */
export async function loadMission(missionId: string): Promise<MissionState | null> {
  const id = safeId(missionId);
  try {
    const body = await fs.readFile(missionStatePath(id), 'utf8');
    const parsed = JSON.parse(body) as MissionState;
    if (!parsed?.mission?.id || parsed.mission.id !== id) {
      // File is corrupt or for a different mission; refuse to use.
      return null;
    }
    return parsed;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/** Persist the entire mission state. Atomic + locked. */
export async function saveMission(state: MissionState): Promise<void> {
  await ensureMissionsDir();
  await withMissionLock(state.mission.id, async () => {
    // Stamp last_activity_at so observers can tell a stale mission file from
    // an active one without crawling the event log.
    state.mission.last_activity_at = new Date().toISOString();
    await atomicWriteJson(missionStatePath(state.mission.id), state);
  });
}

/** Read-modify-write a mission's state under the per-mission lock. The
 *  `mutator` may modify the state in-place AND/OR return a new object; if
 *  it returns null/undefined, the in-place mutation is persisted. */
export async function updateMission(
  missionId: string,
  mutator: (state: MissionState) => MissionState | void | Promise<MissionState | void>
): Promise<MissionState | null> {
  return withMissionLock(missionId, async () => {
    const current = await loadMission(missionId);
    if (!current) return null;
    const result = await mutator(current);
    const next = (result ?? current) as MissionState;
    next.mission.last_activity_at = new Date().toISOString();
    await atomicWriteJson(missionStatePath(missionId), next);
    return next;
  });
}

/** Convenience: update the mission's lifecycle status only. */
export async function updateMissionStatus(missionId: string, status: MissionStatus): Promise<MissionState | null> {
  return updateMission(missionId, (s) => {
    s.mission.status = status;
    if (status === 'paused-question' || status === 'paused-stuck' || status === 'paused-checkpoint') {
      s.paused_at = new Date().toISOString();
    } else if (status === 'running') {
      s.paused_at = null;
    }
  });
}

/** List all missions on disk, optionally filtering by status. Returns the
 *  shallow info needed for a dashboard — no event-log scan. Sorted by
 *  last_activity_at desc so the active ones float to the top. */
export async function listMissions(opts?: { statuses?: MissionStatus[] }): Promise<Array<Pick<Mission, 'id' | 'goal' | 'status' | 'created_at' | 'last_activity_at' | 'parent_mission_id' | 'child_mission_ids'> & { current_phase_index: number; total_phases: number }>> {
  await ensureMissionsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(MISSIONS_DIR);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const stateFiles = entries.filter(e => e.endsWith('.json') && !e.endsWith('.events.jsonl'));
  const summaries = await Promise.all(stateFiles.map(async (f) => {
    const id = f.slice(0, -'.json'.length);
    const state = await loadMission(id).catch(() => null);
    if (!state) return null;
    if (opts?.statuses && !opts.statuses.includes(state.mission.status)) return null;
    return {
      id: state.mission.id,
      goal: state.mission.goal,
      status: state.mission.status,
      created_at: state.mission.created_at,
      last_activity_at: state.mission.last_activity_at,
      current_phase_index: state.current_phase_index,
      total_phases: state.mission.phases.length,
      parent_mission_id: state.mission.parent_mission_id,
      child_mission_ids: state.mission.child_mission_ids,
    };
  }));
  return summaries
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => (b.last_activity_at || '').localeCompare(a.last_activity_at || ''));
}

/** Delete a mission's state, event log, and lock file. Hard-delete — used by
 *  the dashboard's "Discard mission" action and by tests. The caller is
 *  responsible for ensuring no background runner is still attached. */
export async function deleteMission(missionId: string): Promise<void> {
  const id = safeId(missionId);
  await withMissionLock(id, async () => {
    for (const p of [missionStatePath(id), missionEventLogPath(id), missionLockPath(id)]) {
      try { await fs.unlink(p); } catch (err: any) { if (err?.code !== 'ENOENT') throw err; }
    }
  });
}

// ─── PID lock — cross-process "I am the runner" marker ──────────────────
//
// The background runner writes its PID + started_at to <id>.lock when it
// starts, removes it on clean shutdown. instrumentation.ts uses these on
// MC startup to detect runs that crashed (lock present but PID dead) and
// either restart or mark them as crashed.

export interface MissionRunnerLock {
  pid: number;
  started_at: string;
  /** Optional human-readable host hint (e.g. 'linux:mc-dev'). */
  host?: string;
}

/** Write the runner's lock file. Refuses to overwrite a live lock — caller
 *  must verify the prior PID is dead first via `isLockStale`. */
export async function acquireRunnerLock(missionId: string, host?: string): Promise<MissionRunnerLock> {
  await ensureMissionsDir();
  const lock: MissionRunnerLock = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    host,
  };
  await atomicWriteJson(missionLockPath(missionId), lock);
  return lock;
}

/** Read the current lock file (or null if none exists). */
export async function readRunnerLock(missionId: string): Promise<MissionRunnerLock | null> {
  try {
    const body = await fs.readFile(missionLockPath(missionId), 'utf8');
    return JSON.parse(body) as MissionRunnerLock;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/** Is the runner whose PID is in the lock still alive? Returns true iff a
 *  lock file exists AND the PID it names is currently a live process. We
 *  use `process.kill(pid, 0)` which doesn't actually signal the process —
 *  it's the standard way to test for liveness in Node. */
export async function isLockStale(missionId: string): Promise<boolean> {
  const lock = await readRunnerLock(missionId);
  if (!lock) return true;
  try {
    process.kill(lock.pid, 0);
    return false; // process.kill succeeded → process is alive
  } catch {
    return true;  // ESRCH or EPERM both mean "no live process at this pid"
  }
}

/** Release the lock (called on clean shutdown). Tolerates a missing file. */
export async function releaseRunnerLock(missionId: string): Promise<void> {
  try {
    await fs.unlink(missionLockPath(missionId));
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
}
