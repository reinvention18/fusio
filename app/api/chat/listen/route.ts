/**
 * /api/chat/listen?chatId=<chatId>&clientId=<clientId> — GET SSE.
 *
 * Opens a long-lived SSE that fans out every event from the in-flight turn
 * on <chatId>. Called by every browser/tab/PWA viewing that chat so they
 * all see the streaming reply in real time, regardless of which device
 * actually sent the message.
 *
 * The sending client's own broadcasts are filtered out server-side so the
 * originator doesn't double-render its own reply (it already has the
 * direct SSE from POST /api/chat).
 */

import { NextRequest } from 'next/server';
import { subscribe, snapshot } from '../../../../lib/chat-broadcast';

// 4-hour cap. Long autopilot runs and multi-step research sessions can
// run well past an hour; the SSE listener just needs to stay alive long
// enough for the user to see the result land.
export const maxDuration = 14400;
export const dynamic = 'force-dynamic';

// Idle timeout for SSE listeners. 60 min: a legit Claude turn can think
// for many minutes between deltas (especially extended-thinking models +
// long tool chains). The original 10 min was too aggressive — killed
// listeners during legitimate long turns. The bounded-streams + bounded
// MCP cache structural fixes from cd0373c already prevent the unbounded
// leak this guard was meant to catch; this timeout is now just a courtesy
// for clients that closed without firing abort.
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

export async function GET(request: NextRequest) {
  const chatId = request.nextUrl.searchParams.get('chatId');
  const clientId = request.nextUrl.searchParams.get('clientId') || undefined;

  if (chatId === '__snapshot__') {
    return new Response(JSON.stringify({ streams: snapshot() }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!chatId) {
    return new Response(JSON.stringify({ error: 'chatId required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let dead = false;
      // Track last real (non-keepalive) fan-out. The keep-alive interval
      // checks this each tick and drops the connection if it's been idle
      // longer than IDLE_TIMEOUT_MS — that's the zombie-listener fix.
      let lastActivity = Date.now();
      const write = (payload: string) => {
        if (dead) return;
        // Only treat real broadcast events as activity (skip our own
        // keepalive comments which start with `: `). The broadcast layer
        // calls write() with real SSE data lines, never with comments.
        if (!payload.startsWith(': ')) lastActivity = Date.now();
        try { controller.enqueue(enc.encode(payload)); } catch { dead = true; }
      };
      const unsub = subscribe(chatId, clientId, write);
      const cleanup = () => {
        if (dead) return;
        dead = true;
        clearInterval(ka);
        unsub();
        try { controller.close(); } catch { /* ignore */ }
      };
      // Keep-alive comment every 15s — prevents intermediate proxies from
      // closing an idle connection AND polls for zombie listeners. When
      // the client tab has been suspended / closed without the abort
      // signal firing, no real events fan out, lastActivity stays stale,
      // and after IDLE_TIMEOUT_MS we close the connection ourselves.
      const ka = setInterval(() => {
        if (dead) { clearInterval(ka); return; }
        if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
          // Idle too long — assume the client tab is gone. Close the
          // listener so we don't pin the event loop with hundreds of
          // zombie connections accumulating over 24h+ of uptime.
          cleanup();
          return;
        }
        try { controller.enqueue(enc.encode(': keepalive\n\n')); } catch { dead = true; clearInterval(ka); }
      }, 15_000);
      request.signal.addEventListener('abort', cleanup);
    },
    cancel() { /* writer cleanup handled via abort signal */ },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
