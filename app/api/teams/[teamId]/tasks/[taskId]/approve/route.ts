import { NextRequest, NextResponse } from 'next/server';
import { getTeam, getTeamTask, transitionTask, appendEvent } from '../../../../../../../lib/teams/schema';

export const dynamic = 'force-dynamic';

/**
 * Approve a task that's in `ready_for_review`. Transitions to `approved`
 * (which the /merge route picks up to actually merge the branch).
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ teamId: string; taskId: string }> }) {
  const { teamId, taskId } = await params;
  if (!getTeam(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const task = getTeamTask(taskId);
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  if (task.team_id !== teamId) return NextResponse.json({ error: 'Task not in this team' }, { status: 400 });

  const ALLOWED_FROM = new Set(['ready_for_review', 'review', 'needs_rework']);
  if (!ALLOWED_FROM.has(task.status)) {
    return NextResponse.json({
      error: `Task is in ${task.status} — only ready_for_review / review / needs_rework tasks can be approved.`,
    }, { status: 409 });
  }

  transitionTask(taskId, 'approved');
  appendEvent({
    team_id: teamId,
    task_id: taskId,
    kind: 'task_transition',
    payload: { from: task.status, to: 'approved', by: 'commander' },
    chat_report: true,
  });

  return NextResponse.json({ ok: true, status: 'approved', task_id: taskId });
}
