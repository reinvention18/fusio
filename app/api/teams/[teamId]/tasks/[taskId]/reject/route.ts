import { NextRequest, NextResponse } from 'next/server';
import { getTeam, getTeamTask, transitionTask, appendEvent } from '../../../../../../../lib/teams/schema';

export const dynamic = 'force-dynamic';

/**
 * Reject a task. Transitions to `cancelled` (archived) or `needs_rework`
 * depending on the `mode` flag. Reason is stored on the task.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ teamId: string; taskId: string }> }) {
  const { teamId, taskId } = await params;
  if (!getTeam(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const task = getTeamTask(taskId);
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  if (task.team_id !== teamId) return NextResponse.json({ error: 'Task not in this team' }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const mode: 'cancel' | 'rework' = body.mode === 'rework' ? 'rework' : 'cancel';
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : '';

  const newStatus = mode === 'rework' ? 'needs_rework' : 'cancelled';
  transitionTask(taskId, newStatus as any, {
    status_reason: reason || (mode === 'rework' ? 'Commander requested rework' : 'Commander rejected'),
  });
  appendEvent({
    team_id: teamId,
    task_id: taskId,
    kind: 'task_transition',
    severity: 'warn',
    payload: { from: task.status, to: newStatus, by: 'commander', reason },
    chat_report: true,
  });

  return NextResponse.json({ ok: true, status: newStatus, task_id: taskId });
}
