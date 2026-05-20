/**
 * POST /api/missions/negotiate
 *
 * Full Force workflow's pre-flight stage. Runs an Opus<->Codex negotiation
 * over the source material (existing chat / plan / prompt / prose goal)
 * and streams the rounds back to the client as SSE. When the agents
 * converge (or hit the round cap), emits a `negotiation-final` event with
 * the resulting Mission JSON.
 *
 * The client (CreateMissionPanel in Full Force mode) consumes the stream
 * and surfaces the back-and-forth live, then drops the final Mission JSON
 * into the editable JSON pane so the user can review and POST it to
 * /api/missions to actually start the run.
 *
 * Body:
 *   { source: string, cwd: string, target_url?: string, preset_id?: string,
 *     max_rounds?: number }
 *
 * SSE events emitted:
 *   { type: 'negotiation-start', max_rounds }
 *   { type: 'agent-text', agent: 'opus'|'codex'|'orchestrator', text }
 *   { type: 'negotiation-round', round, opus_accepted, codex_accepted, converged }
 *   { type: 'negotiation-final', mission, rounds, converged, reason }
 *   { type: 'negotiation-error', message }
 */

import { NextRequest } from 'next/server';
import { negotiatePlan, type NegotiationEmit } from '@/lib/missions/plan-negotiation';
import { ROLE_PRESETS, getPreset } from '@/lib/missions/role-config';
import { DEFAULT_ROLE_CONFIG } from '@/lib/missions/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface NegotiateBody {
  source?: string;
  cwd?: string;
  target_url?: string;
  preset_id?: string;
  max_rounds?: number;
}

export async function POST(req: NextRequest) {
  let body: NegotiateBody = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const source = String(body?.source || '').trim();
  const cwd = String(body?.cwd || '').trim();
  if (!source || !cwd) {
    return Response.json({ error: 'invalid_input', need: ['source', 'cwd'] }, { status: 400 });
  }
  const preset = getPreset(String(body?.preset_id || '')) ?? ROLE_PRESETS[0];
  const roles = preset?.config ?? DEFAULT_ROLE_CONFIG;
  const max = typeof body?.max_rounds === 'number' ? body.max_rounds : undefined;

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (frame: string) => { try { controller.enqueue(enc.encode(frame)); } catch { /* closed */ } };
      const sendData = (obj: unknown) => send(`data: ${JSON.stringify(obj)}\n\n`);

      sendData({ type: 'negotiation-start', max_rounds: max ?? 4, preset_id: preset?.id });

      const ctl = new AbortController();
      try { (req as any).signal?.addEventListener?.('abort', () => ctl.abort()); } catch { /* ignore */ }

      const emit: NegotiationEmit = {
        text: (s) => sendData({ type: 'agent-text', text: s }),
        status: (s) => sendData({ type: 'status', status: s }),
        voice: (agent, phase) => sendData({ type: 'agent', agent, phase }),
        raw: (frame) => send(frame),
        round: (info) => sendData({ type: 'negotiation-round-detail', ...info }),
      };

      try {
        const result = await negotiatePlan({
          source,
          cwd,
          target_url: body.target_url,
          roles,
          max_rounds: max,
          signal: ctl.signal,
          emit,
        });
        sendData({
          type: 'negotiation-final',
          mission: result.mission,
          rounds: result.rounds.length,
          converged: result.converged,
          reason: result.reason,
        });
        send(`data: [DONE]\n\n`);
      } catch (err: any) {
        sendData({ type: 'negotiation-error', message: String(err?.message || err) });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
