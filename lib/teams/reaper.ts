/**
 * Constellation reaper — background 30-second sweep that cleans up:
 *   1. Stale task claims (claimed/in_progress > 5 min with no active runner)
 *   2. Crashed agents (status != terminal but runner missing from activeRunners)
 *   3. mc_subagents GC (completed > 7 days)
 */

import 'server-only';
import { reapStaleClaims, listTeamAgents, updateTeamAgentStatus, listTeams, enqueueMessage, appendEvent } from './schema';
import { getDb } from '../memory-db';
import { getActiveRunners } from './runner';
import { gc as gcSubagents } from '../mc-subagents-store';

const REAPER_INTERVAL_MS = 30_000;
const STALE_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
const STALE_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
const STALL_ESCALATION_MS = 5 * 60 * 1000;
const STALL_RENOTIFY_MS = 10 * 60 * 1000;

let reaperInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Revert tasks stuck in `review` status for > STALE_REVIEW_TIMEOUT_MS back to
 * `ready_for_review` so another reviewer can claim. Without this, a single
 * hung reviewer holds a task hostage and deadlocks downstream work.
 */
function reapStaleReviews(): number {
  const db = getDb();
  const cutoff = Date.now() - STALE_REVIEW_TIMEOUT_MS;
  const result = db.prepare(
    `UPDATE team_tasks
        SET status = 'ready_for_review',
            status_reason = 'Review reverted: no progress in ' || ?||' min'
      WHERE status = 'review'
        AND reviewed_at IS NOT NULL
        AND reviewed_at < ?`
  ).run(Math.round(STALE_REVIEW_TIMEOUT_MS / 60000), cutoff);
  return result.changes;
}

/**
 * Stall escalation: if a team has pending tasks but nothing has moved for
 * STALL_ESCALATION_MS, send a structured message to the architect so they
 * can reassign or cancel. Without this, dead-lock situations sit forever.
 * Re-fires every STALL_RENOTIFY_MS so a single missed message doesn't kill
 * the escalation.
 */
function escalateStalls(): void {
  const db = getDb();
  const now = Date.now();
  const runningTeams = listTeams({ status: 'running' });
  for (const team of runningTeams) {
    // Find pending tasks claimable by SOMEONE on this team
    const pending = db.prepare(
      `SELECT id, title, role_hint, phase FROM team_tasks
         WHERE team_id = ? AND status = 'pending'`
    ).all(team.id) as Array<{ id: string; title: string; role_hint: string | null; phase: string | null }>;
    if (pending.length === 0) continue;

    // Check last team-wide progress event (task_transition or tasks_proposed)
    const lastProgress = db.prepare(
      `SELECT MAX(created_at) AS t FROM team_events
         WHERE team_id = ? AND kind IN ('task_transition', 'tasks_proposed', 'phase_active', 'phase_completed')`
    ).get(team.id) as { t: number | null };
    const lastProgressAt = lastProgress?.t ?? 0;
    const stalledFor = now - lastProgressAt;
    if (stalledFor < STALL_ESCALATION_MS) continue;

    // Check if we already escalated recently
    const lastEscalation = db.prepare(
      `SELECT MAX(created_at) AS t FROM team_events
         WHERE team_id = ? AND kind = 'stall_escalated'`
    ).get(team.id) as { t: number | null };
    const lastEscAt = lastEscalation?.t ?? 0;
    if (now - lastEscAt < STALL_RENOTIFY_MS) continue;

    // Find architect
    const architect = db.prepare(
      `SELECT id, role_handle FROM team_agents WHERE team_id = ? AND role = 'architect' LIMIT 1`
    ).get(team.id) as { id: string; role_handle: string } | undefined;

    const blockerList = pending.slice(0, 8).map(p =>
      `  - ${p.role_hint || '?'} | ${p.phase || 'no-phase'} | ${p.title.slice(0, 80)}`
    ).join('\n');

    const body = [
      `[REAPER STALL ALERT] No team progress in ${Math.round(stalledFor / 60000)} minutes.`,
      ``,
      `${pending.length} task${pending.length === 1 ? '' : 's'} stuck in pending:`,
      blockerList,
      pending.length > 8 ? `  …and ${pending.length - 8} more.` : '',
      ``,
      `Likely causes (check in order):`,
      `  1. Task targets a role NOT on this team → reassign via mc_propose_tasks (re-tag role_hint).`,
      `  2. Phase is not yet active → previous phase has incomplete tasks; check task list.`,
      `  3. Dependencies unmet — depends_on points to a task that's still pending or needs_rework.`,
      ``,
      `Decide and act: cancel the team, propose new tasks, or reassign blocking work.`,
    ].filter(Boolean).join('\n');

    if (architect) {
      enqueueMessage({
        team_id: team.id,
        from_agent_id: null,
        to_agent_id: architect.id,
        type: 'direct',
        priority: 'now',
        body,
        metadata: { kind: 'stall_alert', stalled_minutes: Math.round(stalledFor / 60000), pending_count: pending.length },
      });
    } else {
      // No architect — message commander
      enqueueMessage({
        team_id: team.id,
        from_agent_id: null,
        to_agent_id: null,
        type: 'chat_report',
        priority: 'now',
        body,
        metadata: { kind: 'stall_alert', urgency: 'blocker', stalled_minutes: Math.round(stalledFor / 60000) },
      });
    }

    appendEvent({
      team_id: team.id,
      kind: 'stall_escalated',
      severity: 'warn',
      payload: { stalled_minutes: Math.round(stalledFor / 60000), pending_count: pending.length, escalated_to: architect?.role_handle || 'commander' },
      chat_report: true,
    });
    console.warn(`[Reaper] Stall escalated for team ${team.id.slice(0, 8)} (${pending.length} pending, stuck ${Math.round(stalledFor / 60000)}m)`);
  }
}

function tick(): void {
  try {
    const reaped = reapStaleClaims(STALE_CLAIM_TIMEOUT_MS);
    if (reaped > 0) {
      console.log(`[Reaper] reverted ${reaped} stale task claims to pending`);
    }

    const reviewsReverted = reapStaleReviews();
    if (reviewsReverted > 0) {
      console.log(`[Reaper] reverted ${reviewsReverted} stale review claims to ready_for_review`);
    }

    const runners = getActiveRunners();
    const runningTeams = listTeams({ status: 'running' });
    for (const team of runningTeams) {
      const agents = listTeamAgents(team.id);
      for (const agent of agents) {
        const nonTerminal = !['done', 'error', 'cancelled'].includes(agent.status);
        const hasRunner = runners.has(agent.id);
        if (nonTerminal && !hasRunner && agent.status !== 'spawning') {
          console.warn(`[Reaper] agent ${agent.role_handle} (${agent.id}) has status=${agent.status} but no active runner — marking crashed`);
          updateTeamAgentStatus(agent.id, 'crashed', 'runner missing (detected by reaper)');
        }
      }
    }

    escalateStalls();

    gcSubagents();
  } catch (err) {
    console.error('[Reaper] tick error:', err);
  }
}

export function startReaper(): void {
  if (reaperInterval) return;
  reaperInterval = setInterval(tick, REAPER_INTERVAL_MS);
  tick();
}

export function stopReaper(): void {
  if (reaperInterval) {
    clearInterval(reaperInterval);
    reaperInterval = null;
  }
}
