import { NextRequest, NextResponse } from 'next/server';
import { getTeam, getTeamTask } from '../../../../../../lib/teams/schema';
import { diffAgainstBase } from '../../../../../../lib/teams/worktree';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ teamId: string; taskId: string }> }) {
  const { teamId, taskId } = await params;
  const team = getTeam(teamId);
  if (!team) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const task = getTeamTask(taskId);
  if (!task || task.team_id !== teamId) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  const worktree = task.worktree_path;
  if (!worktree) return NextResponse.json({ error: 'Task has no worktree' }, { status: 400 });
  try {
    const diff = await diffAgainstBase(worktree, team.main_branch);
    return NextResponse.json({ diff });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
