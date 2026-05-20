import { NextRequest, NextResponse } from 'next/server';
import {
  getTeam,
  getTeamTask,
  listTeamTasks,
  transitionTask,
  appendEvent,
  createTeamDecision,
} from '../../../../../lib/teams/schema';
import { mergeBranch } from '../../../../../lib/teams/worktree';
import { executeShipRun } from '../../../../../lib/deploy/execute';
import type { DeployTarget } from '../../../../../lib/deploy/plan';

export const dynamic = 'force-dynamic';
export const maxDuration = 3600; // allow up to 1h for long EAS builds

interface ShipBody {
  task_ids?: string[];           // which tasks to ship (default: all shippable)
  approve?: boolean;             // flip ready_for_review → approved first (default: true)
  merge?: boolean;               // actually merge branches to main (default: true)
  squash?: boolean;              // squash-merge (default: false)
  deploy_targets?: Array<{       // which deploy targets to run (UI-filtered)
    kind: DeployTarget['kind'];
    run: boolean;
  }>;
  skip_deploy?: boolean;         // if true, only commit (no deploys)
}

/**
 * POST /api/teams/:id/ship
 * The big button. Approves → merges → deploys. Returns a runId the UI can
 * stream via /ship/stream?run_id=<id>.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  const team = getTeam(teamId);
  if (!team) return NextResponse.json({ error: 'Team not found' }, { status: 404 });

  const body: ShipBody = await request.json().catch(() => ({}));
  const {
    task_ids,
    approve = true,
    merge = true,
    squash = false,
    deploy_targets,
    skip_deploy = false,
  } = body;

  // 1. Determine which tasks to ship.
  const all = listTeamTasks(teamId);
  const shippable = all.filter(t => ['ready_for_review', 'review', 'approved'].includes(t.status));
  const selected = task_ids && task_ids.length > 0
    ? shippable.filter(t => task_ids.includes(t.id))
    : shippable;

  if (selected.length === 0) {
    return NextResponse.json({ error: 'No shippable tasks selected' }, { status: 400 });
  }

  // 2. Approve anything not already approved.
  const approved: string[] = [];
  if (approve) {
    for (const t of selected) {
      if (t.status !== 'approved') {
        transitionTask(t.id, 'approved');
        appendEvent({
          team_id: teamId,
          task_id: t.id,
          kind: 'task_transition',
          payload: { from: t.status, to: 'approved', by: 'commander', via: 'ship' },
          chat_report: false,
        });
        approved.push(t.id);
      }
    }
  }

  // 3. Merge approved task branches into main.
  const mergeResults: Array<{ task_id: string; title: string; ok: boolean; error?: string; lines_added?: number; lines_removed?: number }> = [];
  const mergedFilesSet = new Set<string>();

  if (merge) {
    for (const t of selected) {
      const task = getTeamTask(t.id);
      if (!task) continue;
      if (task.status !== 'approved') {
        mergeResults.push({ task_id: t.id, title: t.title, ok: false, error: `status=${task.status} (need approved)` });
        continue;
      }
      if (!task.branch_name) {
        mergeResults.push({ task_id: t.id, title: t.title, ok: false, error: 'No branch name' });
        continue;
      }
      transitionTask(t.id, 'merging');
      const result = await mergeBranch({
        repoRoot: team.project_id,
        branchName: task.branch_name,
        mainBranch: team.main_branch,
        squash,
        commitMessage: squash ? `[${team.name}] ${task.title}` : undefined,
      });
      if (result.ok) {
        transitionTask(t.id, 'done');
        appendEvent({
          team_id: teamId,
          task_id: t.id,
          kind: 'task_transition',
          payload: { to: 'done', merged: true, lines_added: result.linesAdded, lines_removed: result.linesRemoved, via: 'ship' },
          chat_report: true,
        });
        // Capture files from task metadata to feed the deploy planner
        try {
          const files: string[] = JSON.parse(task.files_touched || '[]');
          for (const f of files) if (f) mergedFilesSet.add(f);
        } catch { /* ignore */ }
        mergeResults.push({ task_id: t.id, title: t.title, ok: true, lines_added: result.linesAdded, lines_removed: result.linesRemoved });
      } else {
        transitionTask(t.id, 'blocked', {
          status_reason: `Merge conflict: ${result.error}`,
          error_detail: result.conflictFiles?.join(', ') || result.error,
        });
        appendEvent({
          team_id: teamId,
          task_id: t.id,
          kind: 'task_transition',
          severity: 'warn',
          payload: { to: 'blocked', reason: 'merge_conflict', files: result.conflictFiles, via: 'ship' },
          chat_report: true,
        });
        mergeResults.push({ task_id: t.id, title: t.title, ok: false, error: result.error });
      }
    }
  }

  const mergedOk = mergeResults.filter(r => r.ok).length;
  const mergedFailed = mergeResults.length - mergedOk;

  // 4. Deploy — only if requested, if anything was merged, and targets supplied.
  let shipRunId: string | null = null;
  if (!skip_deploy && mergedOk > 0 && Array.isArray(deploy_targets) && deploy_targets.some(t => t.run)) {
    const { planDeploy } = await import('../../../../../lib/deploy/plan');
    const filesChanged = Array.from(mergedFilesSet).sort();
    const plan = planDeploy(team.project_id, filesChanged);
    // Apply UI toggles on top of detected plan (match by kind + command to be resilient)
    const targetsWithRun = plan.targets.map(t => {
      const ui = deploy_targets.find(d => d.kind === t.kind);
      return { ...t, run: ui ? ui.run : t.shouldRun };
    });

    // Fire and forget — SSE stream tracks progress.
    const runPromise = executeShipRun({ teamId, targets: targetsWithRun });
    // Grab runId synchronously from the promise start. executeShipRun creates
    // the run and emits immediately; we need access to it. Refactor: make it
    // accept an onStart callback… cheaper: wait for first emit via a one-shot.
    // For simplicity: await it to resolve with the run id — but don't block on
    // completion. executeShipRun resolves on completion, so we need another path.
    // Work around by racing with a first-emit sentinel.
    // Simpler: executeShipRun already returns a ShipRun; we can call a sync
    // helper to pre-create + return id. Keep it simple: block briefly for the
    // run id from a helper import.
    try {
      // Give the run time to at least register before we grab its id.
      const { listRuns } = await import('../../../../../lib/deploy/execute');
      await new Promise(r => setTimeout(r, 50));
      const latest = listRuns(teamId)[0];
      if (latest) shipRunId = latest.id;
      // Don't await runPromise — deploys stream via SSE.
      void runPromise.catch(e => console.warn('[ship] deploy run failed:', e?.message));
    } catch { /* ignore */ }
  }

  // 5. Log decision
  createTeamDecision({
    team_id: teamId,
    decision_type: 'merge_decision',
    summary: `Ship: ${approved.length} approved, ${mergedOk} merged${mergedFailed ? `, ${mergedFailed} conflict${mergedFailed === 1 ? '' : 's'}` : ''}${shipRunId ? `, deploy run ${shipRunId.slice(0, 8)}` : ''}.`,
    details: { approved, merge_results: mergeResults, ship_run_id: shipRunId, squash, skip_deploy },
  });

  return NextResponse.json({
    approved_count: approved.length,
    merged_ok: mergedOk,
    merged_failed: mergedFailed,
    merge_results: mergeResults,
    files_merged: Array.from(mergedFilesSet).sort(),
    ship_run_id: shipRunId,
  });
}
