/**
 * /api/notepad/listen?id=<padId>&clientId=<clientId>
 *
 * Long-lived SSE that fans out every notepad update to all subscribers
 * (Linux web, PC web, mobile PWA). The sending client filters its OWN
 * broadcasts (matched by clientId) so it doesn't fight its own POST
 * round-trip and stomp on the user's still-in-flight typing.
 *
 * When this MC instance is a PROXY (see lib/notepad-peer.ts), it pipes
 * the upstream Linux SSE stream directly through to the client. That
 * keeps Linux as the single source of truth — Linux's broadcast() reaches
 * Linux's listeners AND every PC client through this proxy.
 *
 * 4-hour cap, 60-min idle timeout, 15s keepalive — mirrors
 * /api/chat/listen so the same lifecycle assumptions hold.
 */

import { NextRequest } from 'next/server';
import { subscribe } from '../../../../lib/notepad-broadcast';
import { loadPad } from '../../../../lib/notepad-storage';
import { getNotepadPeerUrl } from '../../../../lib/notepad-peer';

export const maxDuration = 14400;
export const dynamic = 'force-dynamic';

const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

export async function GET(request: NextRequest) {
  const padId = (request.nextUrl.searchParams.get('id') || 'default').trim();
  const clientId = request.nextUrl.searchParams.get('clientId') || '';

  // Proxy mode (e.g. PC MC → Linux MC). Open an SSE to the peer and pipe
  // its body straight back. Linux's broadcast() is the single source of
  // truth; PC's listeners are just consumers attached through this proxy.
  const peer = getNotepadPeerUrl();
  if (peer) {
    try {
      const upstream = await fetch(
        `${peer}/api/notepad/listen?id=${encodeURIComponent(padId)}&clientId=${encodeURIComponent(clientId)}`,
        {
          method: 'GET',
          headers: { 'Accept': 'text/event-stream' },
          signal: request.signal,
          // Important: don't cache; we want raw bytes flowing.
          cache: 'no-store',
        },
      );
      if (!upstream.ok || !upstream.body) {
        return new Response(`data: ${JSON.stringify({ type: 'error', message: `peer ${upstream.status}` })}\n\n`, {
          status: upstream.status || 502,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        });
      }
      // Return the upstream body directly — Next/Node will stream it out
      // chunk-for-chunk. SSE keepalive comments from the peer flow through.
      return new Response(upstream.body, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    } catch (e: any) {
      return new Response(`data: ${JSON.stringify({ type: 'error', message: String(e?.message || e) })}\n\n`, {
        status: 502,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
        },
      });
    }
  }

  // Local-canonical mode (Linux).
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let dead = false;
      let lastActivity = Date.now();
      const write = (payload: string) => {
        if (dead) return;
        if (!payload.startsWith(': ')) lastActivity = Date.now();
        try { controller.enqueue(enc.encode(payload)); } catch { dead = true; }
      };

      // 1) Send the current state immediately so a freshly-opened client
      //    sees the latest text without an extra GET round-trip.
      const initial = loadPad(padId);
      write(`data: ${JSON.stringify({
        type: 'snapshot',
        content: initial.content,
        version: initial.version,
        updatedAt: initial.updatedAt,
        updatedBy: initial.updatedBy,
      })}\n\n`);

      // 2) Subscribe to future broadcasts. Filter our own updates by
      //    inspecting the JSON payload server-side: each broadcast carries
      //    originClientId; if it matches OUR clientId, skip the write.
      const filteredWrite = (payload: string) => {
        if (clientId && payload.startsWith('data: ')) {
          try {
            const j = JSON.parse(payload.slice(6));
            if (j.originClientId && j.originClientId === clientId) return;
          } catch { /* fall through */ }
        }
        write(payload);
      };
      const unsub = subscribe(padId, filteredWrite);

      const cleanup = () => {
        if (dead) return;
        dead = true;
        clearInterval(ka);
        unsub();
        try { controller.close(); } catch { /* ignore */ }
      };

      // Keepalive + idle timeout — same pattern as /api/chat/listen.
      const ka = setInterval(() => {
        if (dead) { clearInterval(ka); return; }
        if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) { cleanup(); return; }
        try { controller.enqueue(enc.encode(': keepalive\n\n')); } catch { dead = true; clearInterval(ka); }
      }, 15_000);
      request.signal.addEventListener('abort', cleanup);
    },
    cancel() { /* writer cleanup handled via abort */ },
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
