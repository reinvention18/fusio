import { NextRequest, NextResponse } from 'next/server';
import { getTeam, listTeamTasks } from '../../../../../../lib/teams/schema';
import { planDeploy } from '../../../../../../lib/deploy/plan';

export const dynamic = 'force-dynamic';

/**
 * GET /api/teams/:id/ship/plan
 * Returns: which tasks are shippable, aggregated files changed, and the
 * recommended deploy plan (without executing anything).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  const team = getTeam(teamId);
  if (!team) return NextResponse.json({ error: 'Team not found' }, { status: 404 });

  const allTasks = listTeamTasks(teamId);
  const shippable = allTasks.filter(t => ['ready_for_review', 'review', 'approved'].includes(t.status));

  // Aggregate files changed across all shippable tasks
  const filesSet = new Set<string>();
  for (const t of shippable) {
    try {
      const files: string[] = JSON.parse(t.files_touched || '[]');
      for (const f of files) if (f) filesSet.add(f);
    } catch { /* ignore */ }
  }
  const filesChanged = Array.from(filesSet).sort();

  const plan = planDeploy(team.project_id, filesChanged);

  return NextResponse.json({
    team_id: teamId,
    project_root: team.project_id,
    main_branch: team.main_branch,
    shippable_tasks: shippable.map(t => ({
      id: t.id,
      title: t.title,
      role_hint: t.role_hint,
      status: t.status,
      branch_name: t.branch_name,
      diff_numstat: t.diff_numstat,
      result_summary: t.result_summary,
    })),
    files_changed: filesChanged,
    deploy_plan: plan,
  });
}
