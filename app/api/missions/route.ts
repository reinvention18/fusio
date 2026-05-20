/**
 * GET  /api/missions          — list all missions on disk (dashboard data)
 * POST /api/missions          — create a new mission and (optionally) start it
 *
 * Phase 4: thin wrappers over `lib/missions/persistence.ts` + runtime registry.
 * The Luke's Chat UI calls these to seed and launch missions; the runner runs
 * in the background, the SSE endpoint at `/api/missions/[id]/events` streams
 * progress.
 */

import { NextRequest } from 'next/server';
import { listMissions, saveMission } from '@/lib/missions/persistence';
import { startMission } from '@/lib/missions/runtime';
import type { MissionState, Mission, MissionStatus } from '@/lib/missions/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const statusParam = req.nextUrl.searchParams.get('status');
  const statuses = statusParam
    ? (statusParam.split(',').map(s => s.trim()).filter(Boolean) as MissionStatus[])
    : undefined;
  const items = await listMissions(statuses ? { statuses } : undefined);
  return Response.json({ missions: items });
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const mission = body?.mission as Mission | undefined;
  if (!mission?.id || !mission?.goal || !Array.isArray(mission?.phases)) {
    return Response.json({ error: 'invalid_mission', need: ['mission.id', 'mission.goal', 'mission.phases'] }, { status: 400 });
  }
  // Set safe defaults for fresh missions.
  const now = new Date().toISOString();
  const state: MissionState = {
    mission: {
      ...mission,
      status: mission.status ?? 'draft',
      created_at: mission.created_at ?? now,
      last_activity_at: now,
    },
    handoffs: [],
    audits: [],
    current_phase_index: 1,
    current_attempt: 0,
    paused_at: null,
  };

  await saveMission(state);

  // Optional: kick off the runner immediately. Default behavior matches the
  // user's stated preference ("just write the code, code complete is what
  // matters") — start running unless the caller explicitly says otherwise.
  const autoStart = body?.auto_start !== false;
  if (autoStart) {
    try {
      await startMission(state.mission.id);
    } catch (err: any) {
      // Persisted but not yet running; surface so the client knows to retry.
      return Response.json({
        mission_id: state.mission.id,
        status: 'created-not-started',
        start_error: String(err?.message || err),
      }, { status: 201 });
    }
  }

  return Response.json({ mission_id: state.mission.id, status: 'started' }, { status: 201 });
}
