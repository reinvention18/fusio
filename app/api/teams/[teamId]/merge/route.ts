import { NextRequest, NextResponse } from 'next/server';
import { getTeam, listTeamTasks, transitionTask, appendEvent } from '../../../../../lib/teams/schema';
import { mergeBranch } from '../../../../../lib/teams/worktree';

export const dynamic = 'force-dynamic';

// POST /api/teams/:id/merge — merge all approved tasks to main
export async function POST(request: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  const team = getTeam(teamId);
  if (!team) return NextResponse.json({ error: 'Team not found' }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const squash = body.squash ?? false;
  const taskIds: string[] | undefined = body.task_ids; // optional filter

  const tasks = listTeamTasks(teamId, { status: 'approved' });
  const toMerge = taskIds ? tasks.filter(t => taskIds.includes(t.id)) : tasks;

  const results: Array<{ task_id: string; ok: boolean; error?: string; lines_added?: number; lines_removed?: number }> = [];

  for (const task of toMerge) {
    if (!task.branch_name) {
      results.push({ task_id: task.id, ok: false, error: 'No branch name on task' });
      continue;
    }
    transitionTask(task.id, 'merging');
    const result = await mergeBranch({
      repoRoot: team.project_id,
      branchName: task.branch_name,
      mainBranch: team.main_branch,
      squash,
      commitMessage: squash ? `[${team.name}] ${task.title}` : undefined,
    });
    if (result.ok) {
      transitionTask(task.id, 'done');
      appendEvent({
        team_id: teamId,
        task_id: task.id,
        kind: 'task_transition',
        payload: { to: 'done', merged: true, lines_added: result.linesAdded, lines_removed: result.linesRemoved },
        chat_report: true,
      });
      results.push({ task_id: task.id, ok: true, lines_added: result.linesAdded, lines_removed: result.linesRemoved });
    } else {
      transitionTask(task.id, 'blocked', {
        status_reason: `Merge conflict: ${result.error}`,
        error_detail: result.conflictFiles?.join(', ') || result.error,
      });
      appendEvent({
        team_id: teamId,
        task_id: task.id,
        kind: 'task_transition',
        severity: 'warn',
        payload: { to: 'blocked', reason: 'merge_conflict', files: result.conflictFiles },
        chat_report: true,
      });
      results.push({ task_id: task.id, ok: false, error: result.error });
    }
  }

  return NextResponse.json({ results, merged: results.filter(r => r.ok).length, total: toMerge.length });
}
