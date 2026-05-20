import { NextRequest, NextResponse } from 'next/server';
import { getTeam } from '../../../../../../lib/teams/schema';
import { getRun, listRuns } from '../../../../../../lib/deploy/execute';

export const dynamic = 'force-dynamic';

/**
 * GET /api/teams/:id/ship/status?run_id=...
 * Returns current state of a specific ship run, or the latest for the team.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  if (!getTeam(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const runId = request.nextUrl.searchParams.get('run_id');
  if (runId) {
    const run = getRun(runId);
    if (!run) return NextResponse.json({ run: null });
    return NextResponse.json({ run });
  }
  const latest = listRuns(teamId)[0] || null;
  return NextResponse.json({ run: latest });
}
