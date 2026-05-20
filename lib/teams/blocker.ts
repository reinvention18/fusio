/**
 * Live blocker indicator — answers "what is the team waiting on RIGHT NOW?".
 *
 * Surfaced in the team detail API so the constellation panel can show a
 * single-line "Blocked on: …" header. Removes the "is this thing alive?"
 * uncertainty without forcing the commander to dig through tabs.
 */

import 'server-only';
import { getDb } from '../memory-db';

export interface BlockerSummary {
  /** Short headline for the UI: "Phase Build · scout-1 running pnpm install (2m)" */
  headline: string;
  /** Severity for UI tinting. ok = active progress, warn = idle, error = stuck. */
  severity: 'ok' | 'warn' | 'error' | 'idle';
  /** Phase name if the team has phases configured, else null. */
  phase: string | null;
  /** Optional details for hover/expand. */
  detail?: string;
}

interface AgentRow {
  id: string;
  role: string;
  role_handle: string;
  status: string;
  current_task_id: string | null;
  last_activity_at: number | null;
  created_at: number;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  phase: string | null;
  assigned_agent_id: string | null;
  role_hint: string | null;
}

interface PhaseRow {
  id: string;
  name: string;
  status: string;
  ordering: number;
}

const TERMINAL_TEAM_STATUSES = new Set(['done', 'cancelled', 'archived', 'completed']);

export function computeBlocker(team_id: string): BlockerSummary {
  const db = getDb();
  const team = db.prepare('SELECT id, status FROM teams WHERE id = ?').get(team_id) as { id: string; status: string } | undefined;

  if (!team) return { headline: 'Team not found', severity: 'error', phase: null };
  if (TERMINAL_TEAM_STATUSES.has(team.status)) {
    return { headline: `Team ${team.status}`, severity: 'ok', phase: null };
  }
  if (team.status === 'paused') {
    return { headline: 'Team paused', severity: 'warn', phase: null };
  }
  if (team.status === 'error') {
    return { headline: 'Team errored — check logs', severity: 'error', phase: null };
  }

  const activePhase = db.prepare(
    `SELECT id, name, status, ordering FROM team_phases WHERE team_id = ? AND status = 'active' ORDER BY ordering ASC LIMIT 1`
  ).get(team_id) as PhaseRow | undefined;
  const phaseName = activePhase?.name || null;
  const phaseTag = phaseName ? `Phase ${phaseName} · ` : '';

  if (team.status === 'planning') {
    const arch = db.prepare(
      `SELECT * FROM team_agents WHERE team_id = ? AND role = 'architect' LIMIT 1`
    ).get(team_id) as AgentRow | undefined;
    if (!arch) return { headline: 'Planning · waiting for architect', severity: 'warn', phase: phaseName };
    const idleMin = arch.last_activity_at ? Math.floor((Date.now() - arch.last_activity_at) / 60000) : null;
    const note = arch.status === 'working' ? 'planning…' : `${arch.status}`;
    return {
      headline: `${phaseTag}architect ${note}${idleMin !== null && idleMin > 1 ? ` (${idleMin}m)` : ''}`,
      severity: idleMin !== null && idleMin > 5 ? 'warn' : 'ok',
      phase: phaseName,
    };
  }

  // Running: pick the most informative signal.
  const agents = db.prepare(
    `SELECT id, role, role_handle, status, current_task_id, last_activity_at, created_at FROM team_agents WHERE team_id = ?`
  ).all(team_id) as AgentRow[];

  const tasks = db.prepare(
    `SELECT id, title, status, phase, assigned_agent_id, role_hint FROM team_tasks WHERE team_id = ?`
  ).all(team_id) as TaskRow[];

  const working = agents.filter(a => a.status === 'working');
  const pending = tasks.filter(t => t.status === 'pending');
  const inFlight = tasks.filter(t => ['claimed', 'in_progress'].includes(t.status));
  const review = tasks.filter(t => ['ready_for_review', 'review'].includes(t.status));

  // 1) Working agents → show the most-recently-active one with its task title.
  if (working.length > 0) {
    const sorted = [...working].sort((a, b) => (b.last_activity_at || 0) - (a.last_activity_at || 0));
    const best = sorted[0];
    const task = best.current_task_id ? tasks.find(t => t.id === best.current_task_id) : undefined;
    const idleMin = best.last_activity_at ? Math.floor((Date.now() - best.last_activity_at) / 60000) : 0;
    const recentToolUse = lastToolUse(team_id, best.id);
    const action = recentToolUse || task?.title || 'working';
    const sev = idleMin >= 5 ? 'warn' : 'ok';
    return {
      headline: `${phaseTag}${best.role_handle}: ${truncate(action, 70)}${idleMin > 1 ? ` (${idleMin}m)` : ''}`,
      severity: sev,
      phase: phaseName,
      detail: working.length > 1 ? `+${working.length - 1} other agent${working.length === 2 ? '' : 's'} working` : undefined,
    };
  }

  // 2) Tasks waiting on review with no claimer → likely a reviewer-side stall.
  if (review.length > 0 && working.length === 0) {
    const claimedReview = review.filter(t => t.status === 'review');
    if (claimedReview.length > 0) {
      return { headline: `${phaseTag}reviewer working on ${truncate(claimedReview[0].title, 60)}`, severity: 'ok', phase: phaseName };
    }
    return {
      headline: `${phaseTag}${review.length} task${review.length === 1 ? '' : 's'} awaiting review`,
      severity: 'warn',
      phase: phaseName,
      detail: review.map(t => t.title).slice(0, 3).join('; '),
    };
  }

  // 3) Pending tasks but nobody working → either deps blocked or phase gated.
  if (pending.length > 0 && working.length === 0 && inFlight.length === 0) {
    return {
      headline: `${phaseTag}${pending.length} pending task${pending.length === 1 ? '' : 's'} blocked (deps or phase)`,
      severity: 'warn',
      phase: phaseName,
      detail: pending.map(t => `${t.role_hint || '?'}: ${t.title}`).slice(0, 3).join('; '),
    };
  }

  // 4) Nothing pending, nothing in flight — team likely about to complete.
  if (pending.length === 0 && inFlight.length === 0 && review.length === 0) {
    return { headline: `${phaseTag}wrapping up`, severity: 'ok', phase: phaseName };
  }

  return { headline: `${phaseTag}running`, severity: 'ok', phase: phaseName };
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Best-effort: last `tool_use` event payload for an agent, summarized.
 * Returns null if no recent tool use is recorded.
 */
function lastToolUse(team_id: string, agent_id: string): string | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT payload FROM team_events
       WHERE team_id = ? AND agent_id = ? AND kind IN ('tool_use', 'task_transition')
       ORDER BY id DESC LIMIT 1`
  ).get(team_id, agent_id) as { payload: string } | undefined;
  if (!row?.payload) return null;
  try {
    const p = JSON.parse(row.payload);
    if (p.tool_name) return `${p.tool_name}${p.input_summary ? ` (${p.input_summary})` : ''}`;
    if (p.from && p.to) return `${p.from}→${p.to}`;
  } catch { /* ignore */ }
  return null;
}
