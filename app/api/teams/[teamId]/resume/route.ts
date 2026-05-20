import { NextRequest, NextResponse } from 'next/server';
import { getTeam, updateTeamStatus, appendEvent } from '../../../../../lib/teams/schema';

export const dynamic = 'force-dynamic';

/**
 * Re-open a paused / done / completed team so the architect can act on new
 * commander input. Triggers the runner.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  const team = getTeam(teamId);
  if (!team) return NextResponse.json({ error: 'Team not found' }, { status: 404 });

  if (team.status === 'running' || team.status === 'planning') {
    return NextResponse.json({ resumed: false, note: 'already running' });
  }

  updateTeamStatus(teamId, 'running');
  appendEvent({
    team_id: teamId,
    kind: 'system',
    severity: 'info',
    payload: { action: 'resume_by_commander' },
    chat_report: true,
  });

  try {
    const { resumeTeam, startTeam } = await import('../../../../../lib/teams/runner');
    const handles = await resumeTeam(teamId).catch(() => null);
    if (!handles || handles.length === 0) await startTeam(teamId);
    return NextResponse.json({ resumed: true });
  } catch (err: any) {
    return NextResponse.json({ resumed: false, error: err?.message }, { status: 500 });
  }
}
