/**
 * chat-broadcast — in-process SSE fan-out so every open tab / device
 * watching the same chat sees the same live stream.
 *
 * The browser that sent the message still gets its reply via POST /api/chat
 * (the existing SSE return path); broadcasting adds a second fan-out so
 * every OTHER subscriber on the same chat — a different tab, the desktop,
 * the phone PWA — receives the same deltas / sub-agent events / usage
 * updates in real time.
 *
 * Also serves as a safety net for mobile: when iOS/Android backgrounds
 * the PWA, the SSE closes. On foreground, the client reconnects, and the
 * current in-progress content is replayed via `sync-replay` so the user
 * doesn't lose their reply.
 */

import 'server-only';

type Writer = (payload: string) => void;

interface ChatStream {
  /** Full text of the in-flight assistant reply so far. */
  content: string;
  /** Seq number incremented for every emit so clients can order/dedupe. */
  seq: number;
  /** Active SSE writers listening for this chat. */
  listeners: Set<Writer>;
  /** Client that initiated the current turn (skipped in its own listener). */
  originClientId?: string;
  /** True once the turn finished or errored. */
  done: boolean;
  /** Most recent activity timestamp — used for GC. */
  lastTouched: number;
}

const streams = new Map<string, ChatStream>();

// Bound the streams map. Each entry holds listener writers (SSE controller
// closures) + a content buffer. Without a cap, every chat the user ever
// touched stays in memory for the life of the process. We cap at 100 and
// evict the oldest IDLE (done + no listeners + > 1 min old) stream when
// over budget. This is one of the two main leaks behind the daily MC wedge.
const STREAMS_MAX = 100;
function evictIdleStreams(): void {
  if (streams.size <= STREAMS_MAX) return;
  const now = Date.now();
  // First pass: evict streams that are clearly done and unwatched.
  const candidates: string[] = [];
  for (const [id, s] of streams) {
    if (s.done && s.listeners.size === 0 && now - s.lastTouched > 60_000) {
      candidates.push(id);
    }
  }
  for (const id of candidates) {
    streams.delete(id);
    if (streams.size <= STREAMS_MAX) return;
  }
  // If still over budget, fall back to oldest-by-touch eviction (best
  // effort — won't kill an active stream because we ordered candidates).
  if (streams.size <= STREAMS_MAX) return;
  const sortedByAge = [...streams.entries()].sort((a, b) => a[1].lastTouched - b[1].lastTouched);
  for (const [id] of sortedByAge) {
    if (streams.size <= STREAMS_MAX) return;
    streams.delete(id);
  }
}

function ensure(chatId: string): ChatStream {
  let s = streams.get(chatId);
  if (!s) {
    s = { content: '', seq: 0, listeners: new Set(), done: true, lastTouched: Date.now() };
    streams.set(chatId, s);
    evictIdleStreams();
  }
  return s;
}

function send(s: ChatStream, event: Record<string, unknown>): void {
  const payload = `data: ${JSON.stringify({ ...event, seq: s.seq })}\n\n`;
  for (const w of s.listeners) {
    try { w(payload); } catch { /* writer dead — cleaned up on unsubscribe */ }
  }
}

/** Mark the start of a new in-flight turn on this chat. */
export function startTurn(chatId: string, originClientId?: string): void {
  const s = ensure(chatId);
  s.content = '';
  s.seq = 0;
  s.done = false;
  s.originClientId = originClientId;
  s.lastTouched = Date.now();
  s.seq++;
  send(s, { type: 'sync-start', chatId, originClientId });
}

/** Broadcast the user's prompt so other tabs/devices see it in their chat
 *  list immediately, without waiting for their own /api/chats refresh. The
 *  origin client is filtered (it already rendered locally). */
export function broadcastUserMessage(chatId: string, content: string, messageId?: string): void {
  if (!chatId || !content) return;
  const s = ensure(chatId);
  s.lastTouched = Date.now();
  s.seq++;
  send(s, { type: 'user-message', messageId, content });
}

/** Append a text delta and fan out to listeners. */
export function appendDelta(chatId: string, delta: string): void {
  if (!delta) return;
  const s = streams.get(chatId);
  if (!s) return;
  s.content += delta;
  s.seq++;
  s.lastTouched = Date.now();
  send(s, { type: 'sync-delta', delta });
}

/** Fan out a structured event (subagent, heartbeat, usage, approval). */
export function emitEvent(chatId: string, event: Record<string, unknown>): void {
  const s = streams.get(chatId);
  if (!s) return;
  s.seq++;
  s.lastTouched = Date.now();
  send(s, event);
}

/** End the turn. Keeps the stream for ~30s so late subscribers see 'done'. */
export function endTurn(chatId: string): void {
  const s = streams.get(chatId);
  if (!s) return;
  s.done = true;
  s.seq++;
  s.lastTouched = Date.now();
  send(s, { type: 'sync-done' });
  setTimeout(() => {
    const cur = streams.get(chatId);
    if (cur === s && (Date.now() - cur.lastTouched) > 25_000) streams.delete(chatId);
  }, 30_000);
}

/** Subscribe a writer. Replays in-flight content if any. Returns unsubscribe. */
export function subscribe(chatId: string, clientId: string | undefined, writer: Writer): () => void {
  const s = ensure(chatId);
  // Wrapped writer that filters out the origin client's own broadcast so
  // the sending tab doesn't double-render its own deltas.
  const filtered: Writer = (payload) => {
    if (clientId && s.originClientId === clientId) {
      // Suppress replay of our own stream — we have it locally already.
      // Only pass through non-content events (done marker, errors).
      try {
        const idx = payload.indexOf('{');
        const evt = idx >= 0 ? JSON.parse(payload.slice(idx, payload.lastIndexOf('}') + 1)) : null;
        if (evt && (evt.type === 'sync-done' || evt.type === 'sync-error')) writer(payload);
        return;
      } catch { /* fall through */ }
    }
    writer(payload);
  };
  s.listeners.add(filtered);
  // Replay current buffered content + state so a late subscriber catches up
  if (!s.done && s.content) {
    try { writer(`data: ${JSON.stringify({ type: 'sync-replay', chatId, content: s.content, seq: s.seq })}\n\n`); } catch { /* ignore */ }
  }
  try { writer(`data: ${JSON.stringify({ type: 'sync-hello', chatId, done: s.done })}\n\n`); } catch { /* ignore */ }
  return () => { s.listeners.delete(filtered); };
}

/** Snapshot for debugging / health endpoints. */
export function snapshot() {
  return [...streams.entries()].map(([chatId, s]) => ({
    chatId,
    listeners: s.listeners.size,
    done: s.done,
    contentChars: s.content.length,
    originClientId: s.originClientId,
    seq: s.seq,
    ageMs: Date.now() - s.lastTouched,
  }));
}
