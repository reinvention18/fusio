import { NextRequest, NextResponse } from 'next/server';
import { getTeam, listTeamAgents, listTeamTasks, archiveTeam, deleteTeam } from '../../../../lib/teams/schema';
import { costBreakdown } from '../../../../lib/teams/cost';
import { haltTeam, getActiveRunners } from '../../../../lib/teams/runner';
import { computeBlocker } from '../../../../lib/teams/blocker';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execp = promisify(exec);

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  const team = getTeam(teamId);
  if (!team) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const agents = listTeamAgents(teamId);
  const tasks = listTeamTasks(teamId);
  const cost = costBreakdown(teamId);
  const pending = tasks.filter(t => t.status === 'pending').length;
  const inProgress = tasks.filter(t => ['claimed', 'in_progress'].includes(t.status)).length;
  const review = tasks.filter(t => ['ready_for_review', 'review'].includes(t.status)).length;
  const done = tasks.filter(t => t.status === 'done').length;
  const blocker = computeBlocker(teamId);
  return NextResponse.json({ team, agents, tasks, cost, summary: { pending, inProgress, review, done, total: tasks.length }, blocker });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  const team = getTeam(teamId);
  if (!team) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const { searchParams } = new URL(_req.url);
  // Stop any running agents first
  const runners = getActiveRunners();
  const agents = listTeamAgents(teamId);
  for (const agent of agents) {
    const handle = runners.get(agent.id);
    if (handle) {
      try { await handle.close(); } catch { /* best effort */ }
    }
  }

  if (searchParams.get('purge') === 'true') {
    // Clean up worktrees on disk AND remove their git registrations + branches.
    // Without the git-side cleanup, re-launching a team with the same slug
    // fails because git still considers the worktree paths registered.
    const projectDir = team.project_id;
    for (const agent of agents) {
      if (agent.worktree_path) {
        // Best-effort git worktree remove (works even if path is missing)
        try {
          await execp(`git -C "${projectDir}" worktree remove --force "${agent.worktree_path}"`, { timeout: 10000 });
        } catch { /* fall through to rm */ }
        if (fs.existsSync(agent.worktree_path)) {
          try { await fsp.rm(agent.worktree_path, { recursive: true, force: true }); } catch { /* best effort */ }
        }
      }
      if (agent.branch_name) {
        try {
          await execp(`git -C "${projectDir}" branch -D "${agent.branch_name}"`, { timeout: 10000 });
        } catch { /* branch may not exist or already deleted */ }
      }
    }
    // Final prune to clear any half-stale registrations (parallel-purge races).
    try { await execp(`git -C "${projectDir}" worktree prune`, { timeout: 10000 }); } catch { /* best effort */ }
    deleteTeam(teamId);
    return NextResponse.json({ deleted: true });
  }
  archiveTeam(teamId);
  return NextResponse.json({ archived: true });
}
