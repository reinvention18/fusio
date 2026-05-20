/**
 * POST /api/missions/[id]/abort
 *
 * Phase 4: cooperatively cancel a running mission. The runner finishes its
 * current in-flight API call (so we don't leak partial Anthropic/Codex turns
 * mid-stream), persists `paused-checkpoint`, releases its lock, and exits.
 * The user can later POST /resume to pick up where it left off.
 *
 * Returns immediately after the abort is signalled — the caller does NOT
 * wait for the runner's promise, since "current API call" can take up to a
 * minute. The next /events tail will show the `mission.error` (reason=aborted)
 * event when the runner actually finishes shutting down.
 */

import { NextRequest } from 'next/server';
import { abortMission, isMissionRunning } from '@/lib/missions/runtime';
import { loadMission, updateMissionStatus } from '@/lib/missions/persistence';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const state = await loadMission(id);
  if (!state) return Response.json({ error: 'mission_not_found', id }, { status: 404 });

  let body: any = {};
  try { body = await req.json(); } catch { /* no body is fine */ }
  const reason = (typeof body?.reason === 'string' ? body.reason : 'user-requested').slice(0, 200);

  if (!isMissionRunning(id)) {
    // No runner attached. Update on-disk status anyway so re-attach logic
    // doesn't auto-resume on next MC startup.
    await updateMissionStatus(id, 'paused-checkpoint');
    return Response.json({ ok: true, was_running: false });
  }

  // Fire-and-forget the abort — the actual cooperative shutdown can take a
  // bit while in-flight API calls finish. The /events stream will show the
  // mission.error event when it's truly done.
  void abortMission(id, reason).catch(() => undefined);

  return Response.json({ ok: true, was_running: true, signalled_reason: reason });
}
