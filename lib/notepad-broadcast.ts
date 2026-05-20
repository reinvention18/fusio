/**
 * notepad-broadcast — in-process SSE fan-out for the shared notepad.
 *
 * One pad (keyed by padId, default = "default") has many listeners — Linux
 * web UI, PC web UI, mobile PWA — all subscribed at /api/notepad/listen.
 * When any client POSTs an update, the server writes to disk + fans the
 * new state out to every other subscriber. Last-write-wins; this is a
 * casual shared notepad, not a true CRDT collaborative editor.
 *
 * Mirrors lib/chat-broadcast.ts in shape so the lifecycle (subscribe,
 * unsubscribe, GC) is familiar.
 */

import 'server-only';

type Writer = (payload: string) => void;

interface NotepadStream {
  listeners: Set<Writer>;
  /** Last activity timestamp for idle GC. */
  lastTouched: number;
}

const streams = new Map<string, NotepadStream>();

function getOrCreate(padId: string): NotepadStream {
  let s = streams.get(padId);
  if (!s) {
    s = { listeners: new Set(), lastTouched: Date.now() };
    streams.set(padId, s);
  }
  return s;
}

/** Subscribe a writer to updates for this padId. Returns an unsubscribe. */
export function subscribe(padId: string, write: Writer): () => void {
  const s = getOrCreate(padId);
  s.listeners.add(write);
  s.lastTouched = Date.now();
  return () => {
    s.listeners.delete(write);
    s.lastTouched = Date.now();
  };
}

/** Broadcast an update to every subscriber EXCEPT the originator (so the
 *  client that POSTed the change doesn't see its own echo and overwrite
 *  the user's still-in-flight typing). */
export function broadcast(padId: string, payload: object, originClientId?: string): void {
  const s = streams.get(padId);
  if (!s) return;
  // Tag the payload with the origin so listeners can filter their own.
  const data = `data: ${JSON.stringify({ ...payload, originClientId })}\n\n`;
  s.lastTouched = Date.now();
  for (const writer of s.listeners) {
    try { writer(data); } catch { /* dead listener, will be reaped via abort */ }
  }
}

/** Listener count for diagnostics. */
export function listenerCount(padId: string): number {
  return streams.get(padId)?.listeners.size ?? 0;
}

/** GC: drop streams with zero listeners that have been idle > 5 min. */
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of streams) {
    if (s.listeners.size === 0 && now - s.lastTouched > 5 * 60_000) {
      streams.delete(id);
    }
  }
}, 60_000);
