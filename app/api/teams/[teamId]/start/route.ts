import { NextRequest, NextResponse } from 'next/server';
import { startTeam, promoteToRunning } from '../../../../../lib/teams/runner';
import { getTeam } from '../../../../../lib/teams/schema';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  const team = getTeam(teamId);
  if (!team) return NextResponse.json({ error: 'Team not found' }, { status: 404 });

  const promote = req.nextUrl.searchParams.get('promote') === 'true';

  try {
    let handles;
    if (promote && team.status === 'planning') {
      // Skip waiting for architect — promote directly to running
      handles = await promoteToRunning(teamId);
    } else {
      handles = await startTeam(teamId);
    }
    return NextResponse.json({
      started: true,
      status: team.status === 'planning' && promote ? 'promoted' : 'started',
      agents: handles.map(h => ({ id: h.agentId, sessionId: h.sessionId })),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
