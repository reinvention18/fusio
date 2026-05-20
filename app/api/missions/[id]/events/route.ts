/**
 * GET /api/missions/[id]/events
 *
 * Phase 4: SSE endpoint that tails a mission's append-only event log. Replaces
 * the legacy "run the mission inline in the request handler" pattern, which
 * died if the browser closed or the network blipped. This handler is a thin
 * subscriber — it doesn't start, run, pause, or abort the mission; it just
 * streams whatever the mission has written to its log so far, then live-tails
 * for new events.
 *
 * Lifecycle:
 *   1. Client connects → handler reads everything in the log file from the
 *      requested ?from_seq= (default 0) and pushes it as SSE frames.
 *   2. Handler then subscribes to log file changes via fs.watch (with poll
 *      fallback) and pushes each new event.
 *   3. Heartbeat comments every ~15s keep the proxy from idle-closing.
 *   4. Client disconnects → AbortSignal fires → tail loop exits → file
 *      watcher closed.
 *
 * Query params:
 *   • from_seq — resume from a specific sequence (for replay-with-offset).
 *
 * The SSE frames mirror the event log payload directly — runner.ts's
 * `makeLogEmitter` wrote events as `{ type, payload }`, and the legacy SSE
 * frame shape was `{ type, ...fields }`. We rebuild the legacy shape here so
 * existing client renderers don't need changes.
 */

import { NextRequest } from 'next/server';
import { tailEvents, type MissionEvent } from '@/lib/missions/event-log';
import { loadMission } from '@/lib/missions/persistence';

export const dynamic = 'force-dynamic';
// Streaming SSE — Edge runtime would also work but Node gives us fs.watch
// which is more reliable than polling on local dev FS.
export const runtime = 'nodejs';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Verify the mission exists. We accept not-yet-running missions (event
  // log may be empty) as long as the state file is present.
  const state = await loadMission(id);
  if (!state) {
    return new Response(JSON.stringify({ error: 'mission_not_found', id }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const fromSeqRaw = req.nextUrl.searchParams.get('from_seq');
  const fromSeq = fromSeqRaw ? Math.max(0, parseInt(fromSeqRaw, 10) || 0) : 0;

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (frame: string) => { try { controller.enqueue(enc.encode(frame)); } catch { /* closed */ } };

      // Initial SSE comment so the browser flushes headers and the connection
      // is "open" before the first data event.
      send(`: connected to mission ${id} from seq ${fromSeq}\n\n`);
      send(`data: ${JSON.stringify({ type: 'mission-state', mission: state.mission, current_phase_index: state.current_phase_index })}\n\n`);

      const abortCtl = new AbortController();
      // Wire the request abort signal so closing the browser tab terminates
      // the tail loop. Fall back to a no-op if the runtime doesn't expose it.
      try { (req as any).signal?.addEventListener?.('abort', () => abortCtl.abort()); } catch { /* ignore */ }

      try {
        for await (const ev of tailEvents(id, { fromSeq, signal: abortCtl.signal, heartbeatMs: 15_000 })) {
          if (abortCtl.signal.aborted) break;
          if (ev === null) {
            // Heartbeat — SSE comment line so proxies don't close idle conns.
            send(`: heartbeat\n\n`);
            continue;
          }
          send(formatFrame(ev));
        }
      } catch (err: any) {
        send(`data: ${JSON.stringify({ type: 'mission-error', message: String(err?.message || err) })}\n\n`);
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      // ReadableStream cancel fires when the consumer disconnects. The
      // tailEvents iterator has its own AbortSignal wired above — nothing
      // else to do here, but defining cancel() prevents Node from logging
      // "stream cancelled" warnings in dev.
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      // Disable Vercel's response buffering on this route; SSE needs flush-as-written.
      'x-accel-buffering': 'no',
    },
  });
}

/** Convert a log event into an SSE frame whose `data:` payload matches the
 *  legacy runner-emitter shapes. Existing client code dispatches on `type`,
 *  so we rebuild fields like `agent`, `phase`, `index` at this layer. */
function formatFrame(ev: MissionEvent<any>): string {
  const p = ev.payload || {};
  switch (ev.type) {
    case 'voice':
      return `data: ${JSON.stringify({ type: 'agent', agent: p.agent, phase: p.phase, seq: ev.seq })}\n\n`;
    case 'text':
      // The runner's `makeLogEmitter.raw` flagged raw_sse=true on
      // pre-formatted SSE frames coming out of streamClaudeTurn. Pass the
      // raw text through unchanged in that case.
      if (p.raw_sse && typeof p.text === 'string') return p.text;
      return `data: ${JSON.stringify({ type: 'chunk', text: p.text, seq: ev.seq })}\n\n`;
    case 'status':
      return `data: ${JSON.stringify({ type: 'status', status: p.status, seq: ev.seq })}\n\n`;
    case 'audit':
      return `data: ${JSON.stringify({ type: 'mission-audit', audit: p.audit, seq: ev.seq })}\n\n`;
    case 'contract_progress':
      return `data: ${JSON.stringify({ type: 'mission-coverage', covered: p.covered, total: p.total, seq: ev.seq })}\n\n`;
    case 'question':
      return `data: ${JSON.stringify({ type: 'mission-question', index: p.index, question: p.question, audit_summary: p.audit_summary, audit: p.audit, seq: ev.seq })}\n\n`;
    case 'finish':
      return `data: ${JSON.stringify({ type: 'mission-finish', summary: p.summary, seq: ev.seq })}\n\n`;
    case 'mission.start':
    case 'mission.end':
    case 'mission.status':
    case 'mission.error':
      return `data: ${JSON.stringify({ type: ev.type, ...p, seq: ev.seq })}\n\n`;
    case 'phase.start':
    case 'phase.audit':
    case 'phase.rework':
    case 'phase.complete':
    case 'phase.followup':
    case 'phase.stuck': {
      // legacy shape: { type: 'mission-phase', index, total, name, status, ...extra }
      const status = ev.type.split('.')[1];
      return `data: ${JSON.stringify({ type: 'mission-phase', status, ...p, seq: ev.seq })}\n\n`;
    }
    default:
      return `data: ${JSON.stringify({ type: ev.type, ...p, seq: ev.seq })}\n\n`;
  }
}
