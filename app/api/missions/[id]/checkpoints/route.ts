/**
 * GET /api/missions/[id]/checkpoints
 *
 * Phase 10: list every milestone checkpoint written for a mission. Each entry
 * has `{ n, label, path }`. The dashboard's per-mission detail view uses this
 * to render a "rewind to checkpoint N" picker. Loading the actual state is
 * a separate call (`POST .../rewind`) so the user gets a confirm step
 * before destructive rollback.
 */

import { NextRequest } from 'next/server';
import { listCheckpoints } from '@/lib/missions/checkpoints';
import { loadMission } from '@/lib/missions/persistence';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const state = await loadMission(id);
  if (!state) return Response.json({ error: 'mission_not_found', id }, { status: 404 });
  const checkpoints = await listCheckpoints(id);
  return Response.json({ checkpoints });
}
