/**
 * Final cross-model mission audit.
 *
 * When a constellation completes, we want an independent read on whether the
 * team actually addressed the user's original prompt. Running Codex (GPT) over
 * the team's deliverable catches blind spots that Claude-based agents tend to
 * miss — or just validates that the work is cohesive.
 *
 * This module:
 *   1. Gathers the mission brief + deliverable evidence
 *   2. Calls `runCodexMissionAudit` in codex.ts
 *   3. Persists the result as a team_decision + a mem_observation (so it
 *      propagates into the parent chat's memory scope)
 *   4. Exposes `getLatestFinalAudit(teamId)` for the API route + UI
 */

import 'server-only';
import {
  getTeam,
  getScratchpad,
  listTeamTasks,
  createTeamDecision,
  listTeamDecisions,
  listTeamAgents,
  updateTeamStatus,
  enqueueMessage,
  appendEvent,
  createTeamTask,
} from './schema';
import { runCodexMissionAudit, type MissionAuditResult } from './codex';

export interface StoredFinalAudit extends MissionAuditResult {
  team_id: string;
  created_at: number;
  decision_id: string;
}

export async function runAndStoreFinalAudit(teamId: string): Promise<StoredFinalAudit | null> {
  const team = getTeam(teamId);
  if (!team) return null;
  if (!team.goal) {
    console.warn(`[final-audit] team ${teamId} has no goal — skipping`);
    return null;
  }

  const scratchpad = getScratchpad(teamId);
  const tasks = listTeamTasks(teamId);
  const completed = tasks.filter(t => ['done', 'approved', 'merging', 'ready_for_review'].includes(t.status));

  const filesSet = new Set<string>();
  for (const t of completed) {
    try {
      const files: string[] = JSON.parse(t.files_touched || '[]');
      for (const f of files) filesSet.add(f);
    } catch { /* ignore */ }
  }

  // Find any agent's worktree to cwd into — codex exec needs a real directory.
  const cwd = team.project_id;

  const result = await runCodexMissionAudit({
    teamId,
    cwd,
    userPrompt: team.goal,
    scratchpad: scratchpad.content,
    filesChanged: Array.from(filesSet),
    completedTaskSummaries: completed.map(t => ({
      title: t.title,
      summary: t.result_summary,
      role: t.role_hint,
    })),
  });

  const decision = createTeamDecision({
    team_id: teamId,
    decision_type: 'mission_complete',
    summary: `Codex cross-model audit: verdict=${result.verdict}, score=${result.quality_score}/10. ${result.summary.slice(0, 200)}`,
    details: {
      verdict: result.verdict,
      quality_score: result.quality_score,
      coverage: result.coverage,
      missing_work: result.missing_work,
      unrelated_work: result.unrelated_work,
      summary: result.summary,
      raw_preview: result.raw.slice(0, 2000),
      duration_ms: result.duration_ms,
    },
  });

  // Also drop an observation into the team_meta memory so the parent chat
  // inherits the audit finding.
  try {
    const { ensureTeamMetaSession, putObservation } =
      await import('../mem/api');
    const session = ensureTeamMetaSession(teamId);
    await putObservation({
      sessionId: session.id,
      type: result.verdict === 'missed' ? 'blocker' : 'summary',
      title: `Codex audit: ${result.verdict} (score ${result.quality_score}/10)`,
      content: [
        `Verdict: ${result.verdict}`,
        `Quality score: ${result.quality_score}/10`,
        `Summary: ${result.summary}`,
        result.missing_work.length > 0 ? `Missing: ${result.missing_work.join('; ')}` : '',
      ].filter(Boolean).join('\n'),
      tags: ['codex', 'mission-audit', result.verdict],
    });
  } catch (e: any) {
    console.warn('[final-audit] observation write failed:', e?.message);
  }

  // Auto-remediation: when Codex flags gaps, reopen the team and deliver the
  // findings to the architect so it can plan remediation tasks. Without this,
  // audit findings sit in the decision log and never turn into action.
  if ((result.verdict === 'partial' || result.verdict === 'missed') && result.missing_work.length > 0) {
    try {
      await triggerAuditRemediation(teamId, result);
    } catch (e: any) {
      console.warn('[final-audit] remediation trigger failed:', e?.message);
    }
  }

  return {
    ...result,
    team_id: teamId,
    created_at: decision.created_at,
    decision_id: decision.id,
  };
}

/**
 * When a Codex audit surfaces unmet requirements, reopen the team (if it
 * auto-completed) and deliver the gap list to the architect with an explicit
 * directive to propose new tasks. Idempotent — safe to call repeatedly.
 */
export async function triggerAuditRemediation(
  teamId: string,
  audit: MissionAuditResult,
): Promise<{ reopened: boolean; delivered: boolean }> {
  const team = getTeam(teamId);
  if (!team) return { reopened: false, delivered: false };

  const agents = listTeamAgents(teamId);
  const architect = agents.find(a => a.role === 'architect');
  if (!architect) {
    console.warn(`[final-audit] team ${teamId} has no architect — cannot auto-remediate`);
    return { reopened: false, delivered: false };
  }

  const wasTerminal = ['completed', 'done', 'cancelled', 'archived'].includes(team.status);
  let reopened = false;
  if (wasTerminal) {
    updateTeamStatus(teamId, 'running');
    appendEvent({
      team_id: teamId,
      kind: 'system',
      payload: { action: 'auto_remediation_reopen', verdict: audit.verdict, missing_count: audit.missing_work.length },
      chat_report: true,
    });
    reopened = true;

    // Anchor task: prevents the autonomy tick's auto-complete from firing
    // while the architect is still planning remediation. Architect claims and
    // submits this after proposing the remediation sub-tasks.
    try {
      const anchorDesc = [
        `WHAT: Plan remediation for ${audit.missing_work.length} scope gap(s) surfaced by Codex audit (verdict: ${audit.verdict}, score ${audit.quality_score}/10).`,
        `WHERE: scratchpad + mc_propose_tasks.`,
        `OUTPUT: ## Architect: Audit Remediation <date> + new tasks for each missed/partial item.`,
        ``,
        `Missing items:`,
        ...audit.missing_work.map((m, i) => `  ${i + 1}. ${m}`),
      ].join('\n');
      createTeamTask({
        team_id: teamId,
        title: `Audit Remediation: address ${audit.missing_work.length} Codex gap(s)`,
        description: anchorDesc,
        role_hint: 'architect' as any,
        priority: 10,
      });
    } catch (e: any) {
      console.warn('[final-audit] anchor-task creation failed:', e?.message);
    }
    // Respawn architect if its runner died (which happens after team_completed).
    try {
      const { getActiveRunners, spawnSingleAgent } = await import('./runner');
      const runners = getActiveRunners();
      if (!runners.has(architect.id)) {
        // Flip the architect back to idle if it was auto-done'd
        try {
          const { getDb } = await import('../memory-db');
          getDb().prepare("UPDATE team_agents SET status = 'idle' WHERE id = ? AND status IN ('done','crashed')").run(architect.id);
        } catch {}
        await spawnSingleAgent(architect.id);
      }
    } catch (e: any) {
      console.warn('[final-audit] architect respawn failed:', e?.message);
    }
  }

  // Build the remediation brief and deliver it via the message queue (which
  // the architect reads at the start of every turn) AND via the live input
  // queue if the runner is up.
  const brief = buildRemediationBrief(audit);
  enqueueMessage({
    team_id: teamId,
    from_agent_id: null,
    to_agent_id: architect.id,
    type: 'direct',
    priority: 'now',
    body: brief,
    metadata: { from: 'commander', kind: 'audit_remediation', audit_verdict: audit.verdict },
  });

  try {
    const { getRunnerForAgent } = await import('./runner');
    const handle = getRunnerForAgent(architect.id);
    if (handle && typeof handle.send === 'function') {
      handle.send(`[@commander AUDIT REMEDIATION]\n\n${brief}`, { priority: 'now' });
    }
  } catch { /* best-effort */ }

  appendEvent({
    team_id: teamId,
    kind: 'system',
    payload: { action: 'audit_remediation_dispatched', missing_count: audit.missing_work.length, reopened },
    chat_report: true,
  });

  return { reopened, delivered: true };
}

function buildRemediationBrief(audit: MissionAuditResult): string {
  const lines: string[] = [];
  lines.push(`🔍 CODEX MISSION AUDIT — verdict: ${audit.verdict} (score ${audit.quality_score}/10)`);
  lines.push('');
  lines.push(`The independent cross-model review found scope gaps in the team's delivery. You must address these now.`);
  lines.push('');
  lines.push('**Missing work (per Codex):**');
  for (let i = 0; i < audit.missing_work.length; i++) {
    lines.push(`${i + 1}. ${audit.missing_work[i]}`);
  }
  lines.push('');
  if (audit.coverage && audit.coverage.length > 0) {
    lines.push('**Coverage summary:**');
    for (const c of audit.coverage) {
      lines.push(`- [${c.status}] ${c.requirement}`);
    }
    lines.push('');
  }
  lines.push('**Your next steps (this turn, no waiting):**');
  lines.push('1. Call `mc_read_scratchpad` to see what was already delivered.');
  lines.push('2. For each **missed** or **partial** item above, design a task (or a small phase) to close the gap.');
  lines.push('3. Update the scratchpad with a `## Architect: Audit Remediation <date>` section listing the new tasks.');
  lines.push('4. Call `mc_propose_tasks` with the new tasks. Route them to the right specialists (scout for research, builder for feature work, inspector for verification, scribe for the updated deliverable).');
  lines.push('5. Do NOT re-do work that was already addressed — only target the gaps.');
  lines.push('');
  lines.push('This is a mandatory follow-up. The team is NOT done until these are closed or you explicitly justify (with commander approval) why a gap should be accepted.');
  return lines.join('\n');
}

export function getLatestFinalAudit(teamId: string): StoredFinalAudit | null {
  const decisions = listTeamDecisions(teamId);
  const audit = decisions.find(d => d.decision_type === 'mission_complete');
  if (!audit) return null;
  let details: any = {};
  try { details = JSON.parse(audit.details_json); } catch { /* ignore */ }
  return {
    team_id: teamId,
    created_at: audit.created_at,
    decision_id: audit.id,
    verdict: details.verdict || 'partial',
    coverage: details.coverage || [],
    missing_work: details.missing_work || [],
    unrelated_work: details.unrelated_work || [],
    quality_score: typeof details.quality_score === 'number' ? details.quality_score : 5,
    summary: details.summary || '',
    raw: details.raw_preview || '',
    duration_ms: details.duration_ms || 0,
  };
}
