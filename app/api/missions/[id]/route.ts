/**
 * GET    /api/missions/[id]     — read full mission state (for state hydration)
 * DELETE /api/missions/[id]     — discard a mission (state, log, lock all gone)
 *
 * Phase 4: state-read endpoint complements the SSE stream at
 * /api/missions/[id]/events. The dashboard uses GET to render missions that
 * aren't currently being tailed; clients with an SSE connection don't need
 * this since `mission-state` is sent as the first frame on connect.
 */

import { NextRequest } from 'next/server';
import { loadMission, deleteMission } from '@/lib/missions/persistence';
import { abortMission, isMissionRunning } from '@/lib/missions/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const state = await loadMission(id);
  if (!state) return Response.json({ error: 'mission_not_found', id }, { status: 404 });
  return Response.json({ state, running: isMissionRunning(id) });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Best-effort: if the mission is running, abort first so its runner closes
  // its file handles before we unlink. abortMission resolves once the runner
  // has fully exited or persisted a checkpoint.
  if (isMissionRunning(id)) {
    await abortMission(id, 'discard-requested');
  }
  await deleteMission(id);
  return Response.json({ ok: true, id });
}
