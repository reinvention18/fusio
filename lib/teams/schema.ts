import 'server-only';
import { getDb } from '../memory-db';
import { randomUUID } from 'node:crypto';

// ─── Row types ───────────────────────────────────────────────────────────

export type TeamStatus =
  | 'idle' | 'planning' | 'running' | 'paused' | 'completed'
  | 'review' | 'merging' | 'done' | 'cancelled' | 'error';

export type TeamAgentRole =
  | 'commander' | 'architect' | 'builder' | 'inspector'
  | 'sentinel' | 'scout' | 'scribe' | 'navigator'
  | 'security' | 'dba' | 'tester' | 'perfanalyst'
  | 'uxreviewer' | 'deployer' | 'apidesigner' | 'refactorer';

export type TeamAgentStatus =
  | 'spawning' | 'idle' | 'working' | 'needs_input'
  | 'blocked' | 'error' | 'paused' | 'crashed' | 'done';

export type TeamTaskStatus =
  | 'pending' | 'claimed' | 'in_progress'
  | 'ready_for_review' | 'review' | 'approved'
  | 'needs_rework' | 'rework_in_progress' | 're_testing'
  | 'merging' | 'done' | 'blocked' | 'failed' | 'cancelled';

export type ReviewFindingSeverity =
  | 'critical' | 'high' | 'medium' | 'low' | 'nit' | 'pre_existing' | 'info';

export interface ChatContext {
  workspace: string;
  contextSnapshot?: string;
  keyFacts?: Array<{ category: string; label: string; value: string }>;
  environment?: { name: string; saasUrl: string; appUrl: string; branch: string; supabaseRef: string };
  githubRepo?: { name: string; fullName: string; url: string; defaultBranch: string };
  recentMessages?: Array<{ role: string; content: string }>;
}

export interface TeamRow {
  id: string;
  name: string;
  constellation: string;
  project_id: string;
  main_branch: string;
  parent_chat_key: string | null;
  preset: string | null;
  goal: string | null;
  status: TeamStatus;
  pause_reason: string | null;
  budget_usd: number | null;
  spent_usd: number;
  max_agents: number;
  max_parallel: number;
  settings_json: string;
  chat_context: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  archived_at: number | null;
}

export interface TeamAgentRow {
  id: string;
  team_id: string;
  role: TeamAgentRole;
  role_handle: string;
  role_file: string | null;
  model: string;
  status: TeamAgentStatus;
  status_reason: string | null;
  session_id: string | null;
  session_key: string;
  worktree_path: string;
  branch_name: string;
  last_output_hash: string | null;
  last_activity_at: number | null;
  current_task_id: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cost_usd: number;
  retries_remaining: number;
  permission_mode: string | null;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TeamTaskRow {
  id: string;
  team_id: string;
  parent_task_id: string | null;
  title: string;
  description: string;
  status: TeamTaskStatus;
  status_reason: string | null;
  priority: number;
  role_hint: TeamAgentRole | null;
  assigned_agent_id: string | null;
  depends_on: string;            // JSON array
  files_touched: string;         // JSON array
  diff_numstat: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  commit_sha: string | null;
  result_summary: string | null;
  error_detail: string | null;
  retry_count: number;
  max_retries: number;
  phase: string | null;
  rework_count: number;
  acceptance: string | null;     // criteria for "this is done" — verified by reviewer
  model_override: string | null; // 'haiku'|'sonnet'|'opus' — per-task model hint
  created_at: number;
  claimed_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  reviewed_at: number | null;
  merged_at: number | null;
}

export interface TeamEventRow {
  id: number;
  team_id: string;
  agent_id: string | null;
  task_id: string | null;
  kind: string;
  severity: 'debug' | 'info' | 'warn' | 'error';
  payload: string;               // JSON
  chat_report: number;
  created_at: number;
}

export interface TeamMessageRow {
  id: string;
  team_id: string;
  from_agent_id: string | null;
  to_agent_id: string | null;
  type: 'direct' | 'broadcast' | 'halt' | 'note' | 'chat_report';
  priority: 'now' | 'next' | 'later';
  body: string;
  metadata_json: string;
  created_at: number;
  delivered_at: number | null;
  read_at: number | null;
}

export interface TaskReviewRow {
  id: string;
  task_id: string;
  reviewer_agent_id: string | null;
  reviewer_model: string;
  review_kind: 'sentinel' | 'diff' | 'holistic' | 'security' | 'framework' | 'adversarial';
  clean: number;                 // 0|1
  verdict: string | null;
  summary: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  raw_output: string | null;
  created_at: number;
}

export interface TaskReviewFindingRow {
  id: string;
  review_id: string;
  severity: ReviewFindingSeverity;
  file: string | null;
  line_start: number | null;
  line_end: number | null;
  title: string;
  body: string | null;
  recommendation: string | null;
  confidence: number | null;
  status: 'open' | 'addressed' | 'waived' | 'false_positive';
  addressed_by: string | null;
  addressed_at: number | null;
  created_at: number;
}

// ─── Team CRUD ───────────────────────────────────────────────────────────

export interface CreateTeamInput {
  name: string;
  constellation?: string;
  project_id: string;
  main_branch: string;
  parent_chat_key?: string | null;
  preset?: string;
  goal?: string;
  budget_usd?: number | null;
  max_agents?: number;
  max_parallel?: number;
  settings?: Record<string, unknown>;
  created_by?: string;
  chat_context?: ChatContext;
}

export function createTeam(input: CreateTeamInput): TeamRow {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO teams (
      id, name, constellation, project_id, main_branch, parent_chat_key,
      preset, goal, status, budget_usd, max_agents, max_parallel,
      settings_json, chat_context, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    input.constellation ?? input.name,
    input.project_id,
    input.main_branch,
    input.parent_chat_key ?? null,
    input.preset ?? null,
    input.goal ?? null,
    input.budget_usd ?? null,
    input.max_agents ?? 5,
    input.max_parallel ?? 2,
    JSON.stringify(input.settings ?? {}),
    input.chat_context ? JSON.stringify(input.chat_context) : null,
    input.created_by ?? null,
    now,
    now,
  );
  return getTeam(id)!;
}

export function getTeam(id: string): TeamRow | null {
  return (getDb().prepare('SELECT * FROM teams WHERE id = ?').get(id) as TeamRow | undefined) ?? null;
}

export function listTeams(opts: { includeArchived?: boolean; status?: TeamStatus } = {}): TeamRow[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeArchived) clauses.push('archived_at IS NULL');
  if (opts.status) { clauses.push('status = ?'); params.push(opts.status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM teams ${where} ORDER BY updated_at DESC`).all(...params) as TeamRow[];
}

export function updateTeamStatus(
  id: string,
  status: TeamStatus,
  reason?: string | null,
): void {
  getDb().prepare(
    `UPDATE teams SET status = ?, pause_reason = ?, updated_at = ? WHERE id = ?`
  ).run(status, reason ?? null, Date.now(), id);
}

export function archiveTeam(id: string): void {
  getDb().prepare(`UPDATE teams SET archived_at = ?, updated_at = ? WHERE id = ?`)
    .run(Date.now(), Date.now(), id);
}

export function deleteTeam(id: string): void {
  getDb().prepare('DELETE FROM teams WHERE id = ?').run(id);
}

// ─── Team agent CRUD ─────────────────────────────────────────────────────

export interface CreateTeamAgentInput {
  team_id: string;
  role: TeamAgentRole;
  role_handle: string;
  role_file?: string;
  model: string;
  worktree_path: string;
  branch_name: string;
  permission_mode?: string;
}

export function createTeamAgent(input: CreateTeamAgentInput): TeamAgentRow {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();
  const session_key = `team:${input.team_id}:${input.role_handle}`;
  db.prepare(
    `INSERT INTO team_agents (
      id, team_id, role, role_handle, role_file, model,
      status, session_key, worktree_path, branch_name,
      permission_mode, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'spawning', ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.team_id, input.role, input.role_handle, input.role_file ?? null,
    input.model, session_key, input.worktree_path, input.branch_name,
    input.permission_mode ?? null, now, now,
  );
  return getTeamAgent(id)!;
}

export function getTeamAgent(id: string): TeamAgentRow | null {
  return (getDb().prepare('SELECT * FROM team_agents WHERE id = ?').get(id) as TeamAgentRow | undefined) ?? null;
}

export function getTeamAgentBySessionKey(session_key: string): TeamAgentRow | null {
  return (getDb().prepare('SELECT * FROM team_agents WHERE session_key = ?').get(session_key) as TeamAgentRow | undefined) ?? null;
}

export function listTeamAgents(team_id: string): TeamAgentRow[] {
  return getDb()
    .prepare('SELECT * FROM team_agents WHERE team_id = ? ORDER BY created_at ASC')
    .all(team_id) as TeamAgentRow[];
}

export function listRunnableTeamAgents(): TeamAgentRow[] {
  // Called from boot.ts to re-attach agents after server restart.
  // Include 'planning' teams so the architect can resume after restart.
  return getDb().prepare(
    `SELECT ta.* FROM team_agents ta
     JOIN teams t ON t.id = ta.team_id
     WHERE t.status IN ('running', 'planning') AND t.archived_at IS NULL
       AND ta.status NOT IN ('done','error','crashed','cancelled')`
  ).all() as TeamAgentRow[];
}

export function updateTeamAgentStatus(
  id: string,
  status: TeamAgentStatus,
  reason?: string | null,
): void {
  getDb().prepare(
    `UPDATE team_agents SET status = ?, status_reason = ?, updated_at = ?, last_activity_at = ? WHERE id = ?`
  ).run(status, reason ?? null, Date.now(), Date.now(), id);
}

export function updateTeamAgentSessionId(id: string, session_id: string): void {
  getDb().prepare(`UPDATE team_agents SET session_id = ?, updated_at = ? WHERE id = ?`)
    .run(session_id, Date.now(), id);
}

export function updateTeamAgentCurrentTask(id: string, task_id: string | null): void {
  getDb().prepare(`UPDATE team_agents SET current_task_id = ?, updated_at = ? WHERE id = ?`)
    .run(task_id, Date.now(), id);
}

export function updateTeamAgentHash(id: string, hash: string): void {
  getDb().prepare(`UPDATE team_agents SET last_output_hash = ?, last_activity_at = ? WHERE id = ?`)
    .run(hash, Date.now(), id);
}

// ─── Task CRUD + atomic claim ────────────────────────────────────────────

export interface CreateTeamTaskInput {
  team_id: string;
  title: string;
  description: string;
  priority?: number;
  role_hint?: TeamAgentRole;
  depends_on?: string[];
  parent_task_id?: string;
  worktree_path?: string;
  branch_name?: string;
  max_retries?: number;
  phase?: string | null;
  acceptance?: string | null;
  model_override?: string | null;
}

export function createTeamTask(input: CreateTeamTaskInput): TeamTaskRow {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO team_tasks (
      id, team_id, parent_task_id, title, description, status, priority,
      role_hint, depends_on, worktree_path, branch_name, max_retries, phase,
      acceptance, model_override, created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.team_id, input.parent_task_id ?? null, input.title, input.description,
    input.priority ?? 0, input.role_hint ?? null,
    JSON.stringify(input.depends_on ?? []),
    input.worktree_path ?? null, input.branch_name ?? null,
    input.max_retries ?? 3, input.phase ?? null,
    input.acceptance ?? null, input.model_override ?? null, now,
  );
  return getTeamTask(id)!;
}

export function getTeamTask(id: string): TeamTaskRow | null {
  return (getDb().prepare('SELECT * FROM team_tasks WHERE id = ?').get(id) as TeamTaskRow | undefined) ?? null;
}

export function listTeamTasks(
  team_id: string,
  opts: { status?: TeamTaskStatus | TeamTaskStatus[] } = {},
): TeamTaskRow[] {
  const db = getDb();
  if (opts.status) {
    const list = Array.isArray(opts.status) ? opts.status : [opts.status];
    const placeholders = list.map(() => '?').join(',');
    return db
      .prepare(`SELECT * FROM team_tasks WHERE team_id = ? AND status IN (${placeholders}) ORDER BY priority DESC, created_at ASC`)
      .all(team_id, ...list) as TeamTaskRow[];
  }
  return db
    .prepare('SELECT * FROM team_tasks WHERE team_id = ? ORDER BY priority DESC, created_at ASC')
    .all(team_id) as TeamTaskRow[];
}

/**
 * Atomically claim the next pending task for an agent. Returns the claimed row
 * or null if no eligible task is available. Race-free via SQLite single-writer.
 *
 * Dependencies are checked application-side because SQLite cannot easily parse
 * JSON arrays in a single UPDATE. The claim is wrapped in a transaction so
 * dep-checking + claim happen atomically relative to other writers.
 */
export function claimNextTask(
  team_id: string,
  agent_id: string,
  role: TeamAgentRole,
): TeamTaskRow | null {
  const db = getDb();
  const now = Date.now();
  return db.transaction((): TeamTaskRow | null => {
    // Compute "orphan" role_hints for this team — values on tasks that don't
    // correspond to any agent on the team. Those tasks would otherwise sit
    // unclaimable forever, so we let builders/scribes rescue them.
    const teamRoleRows = db.prepare(
      'SELECT DISTINCT role FROM team_agents WHERE team_id = ?'
    ).all(team_id) as Array<{ role: string }>;
    const teamRoleSet = new Set(teamRoleRows.map(r => r.role));
    const RESCUE_ROLES = new Set(['builder', 'scribe', 'scout', 'refactorer']);
    const canRescue = RESCUE_ROLES.has(role);

    // 1. Find a candidate task. SELECT is locked inside the transaction.
    //    Match: (role_hint null) OR (role_hint == our role) OR
    //           (rescue: our role is rescue-capable AND task's role_hint is an orphan)
    const candidates = db.prepare(
      `SELECT * FROM team_tasks
        WHERE team_id = ? AND status = 'pending'
        ORDER BY priority DESC, created_at ASC`
    ).all(team_id) as TeamTaskRow[];

    // Pre-load active-phase IDs so we can gate task claims by phase.
    // Phase gate is backward-compatible: tasks without a phase (legacy) skip the check.
    const activePhaseIds = new Set(
      (db.prepare(
        `SELECT id FROM team_phases WHERE team_id = ? AND status = 'active'`
      ).all(team_id) as Array<{ id: string }>).map(r => r.id)
    );

    for (const cand of candidates) {
      // Role filter: null hint = any role, exact match, or rescue-claim on orphan
      const hint = cand.role_hint;
      const hintIsOrphan = !!hint && !teamRoleSet.has(hint);
      const roleMatches = !hint || hint === role || (canRescue && hintIsOrphan);
      if (!roleMatches) continue;

      // 2. Phase gate: if task has a phase, only claim it when that phase is active.
      // Legacy tasks (phase IS NULL) bypass this check for backward compatibility.
      if (cand.phase && !activePhaseIds.has(cand.phase)) continue;

      // 3. Check dependencies are all completed.
      // ONLY 'done' and 'approved' satisfy a dependency. 'ready_for_review' does
      // NOT — it means the work is awaiting verification and could be reworked.
      // Letting downstream tasks claim against ready_for_review caused builders
      // to start on incomplete/un-reviewed inputs.
      const deps: string[] = JSON.parse(cand.depends_on || '[]');
      if (deps.length > 0) {
        const placeholders = deps.map(() => '?').join(',');
        const depCount = db.prepare(
          `SELECT COUNT(*) AS n FROM team_tasks
             WHERE id IN (${placeholders})
               AND status IN ('done','approved')`
        ).get(...deps) as { n: number };
        if (depCount.n !== deps.length) continue; // deps unmet, skip
      }
      // 3. Atomic claim.
      const result = db.prepare(
        `UPDATE team_tasks
            SET status = 'claimed',
                assigned_agent_id = ?,
                claimed_at = ?
          WHERE id = ? AND status = 'pending'`
      ).run(agent_id, now, cand.id);
      if (result.changes === 1) {
        const claimed = getTeamTask(cand.id);
        // Advance phase pending→active when its first task is claimed.
        if (claimed) {
          try { maybeAdvancePhase(claimed.id); } catch (e) { console.warn('[Schema] Phase advance on claim failed:', (e as Error).message); }
        }
        return claimed;
      }
      // lost the race on this row, try next candidate
    }
    return null;
  })();
}

/**
 * Atomically claim a `ready_for_review` task for review. Transitions it to
 * `review` status and stamps `reviewed_at` so other reviewers skip it. Called
 * by reviewer roles (architect, inspector, sentinel, security, tester) from
 * `mc_get_next_task` when no pending work matches their role.
 *
 * Skips: tasks with no commit_sha (nothing to verify), tasks the reviewer
 * themselves authored, and tasks matching excluded role_hints (the
 * architect's own "mission" placeholder task).
 */
export function claimReviewTask(
  team_id: string,
  reviewer_agent_id: string,
  reviewer_role: TeamAgentRole,
): TeamTaskRow | null {
  const db = getDb();
  const now = Date.now();
  return db.transaction((): TeamTaskRow | null => {
    const candidates = db.prepare(
      `SELECT * FROM team_tasks
        WHERE team_id = ? AND status = 'ready_for_review'
        ORDER BY priority DESC, created_at ASC`
    ).all(team_id) as TeamTaskRow[];

    for (const cand of candidates) {
      // Skip tasks without a commit — nothing to review (e.g. architect's
      // planning placeholder). They'll auto-complete via team-completion check.
      if (!cand.commit_sha) continue;
      // Don't let the author review their own work.
      if (cand.assigned_agent_id === reviewer_agent_id) continue;
      // Role-based eligibility: architect reviews everything; other reviewers
      // can review any task that isn't explicitly targeted at their own role
      // (a sentinel doesn't review sentinel audits, etc.).
      if (reviewer_role !== 'architect' && cand.role_hint === reviewer_role) continue;

      const result = db.prepare(
        `UPDATE team_tasks
            SET status = 'review',
                reviewed_at = ?
          WHERE id = ? AND status = 'ready_for_review'`
      ).run(now, cand.id);
      if (result.changes === 1) {
        return getTeamTask(cand.id);
      }
      // lost the race, try next candidate
    }
    return null;
  })();
}

// Lazy-loaded to avoid circular dependency (learned-skills imports from schema)
let _extractSkill: ((task: TeamTaskRow) => string | null) | null = null;
function getExtractSkill() {
  if (!_extractSkill) {
    try { _extractSkill = require('./learned-skills').extractSkillFromTask; } catch { _extractSkill = () => null; }
  }
  return _extractSkill!;
}

export function transitionTask(
  task_id: string,
  to: TeamTaskStatus,
  patch: {
    status_reason?: string | null;
    result_summary?: string | null;
    error_detail?: string | null;
    files_touched?: string[];
    diff_numstat?: string | null;
    commit_sha?: string | null;
  } = {},
): void {
  const db = getDb();
  const now = Date.now();
  const timestampField =
    to === 'in_progress' ? 'started_at' :
    to === 'done' ? 'completed_at' :
    to === 'merging' ? 'completed_at' :
    to === 'review' ? 'reviewed_at' :
    null;

  const sets: string[] = ['status = ?'];
  const values: unknown[] = [to];
  if (patch.status_reason !== undefined)  { sets.push('status_reason = ?');  values.push(patch.status_reason); }
  if (patch.result_summary !== undefined) { sets.push('result_summary = ?'); values.push(patch.result_summary); }
  if (patch.error_detail !== undefined)   { sets.push('error_detail = ?');   values.push(patch.error_detail); }
  if (patch.files_touched !== undefined)  { sets.push('files_touched = ?');  values.push(JSON.stringify(patch.files_touched)); }
  if (patch.diff_numstat !== undefined)   { sets.push('diff_numstat = ?');   values.push(patch.diff_numstat); }
  if (patch.commit_sha !== undefined)     { sets.push('commit_sha = ?');     values.push(patch.commit_sha); }
  if (timestampField) { sets.push(`${timestampField} = ?`); values.push(now); }

  values.push(task_id);
  db.prepare(`UPDATE team_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  // Auto-extract a learned skill when a task completes successfully
  if (to === 'done') {
    try {
      const completedTask = getTeamTask(task_id);
      if (completedTask) getExtractSkill()(completedTask);
    } catch (e) {
      console.warn('[Schema] Skill extraction failed:', (e as Error).message);
    }
  }

  // Advance phase status when a task moves through it
  try {
    maybeAdvancePhase(task_id);
  } catch (e) {
    console.warn('[Schema] Phase advance failed:', (e as Error).message);
  }
}

/**
 * When a task transitions, maybe flip its phase from pending→active or
 * active→completed. Idempotent; safe to call after any transition.
 */
export function maybeAdvancePhase(task_id: string): void {
  const task = getTeamTask(task_id);
  if (!task || !task.phase) return;
  const db = getDb();
  const phase = db.prepare('SELECT * FROM team_phases WHERE id = ?').get(task.phase) as TeamPhaseRow | undefined;
  if (!phase) return;

  // Pending → active when any task in the phase has been claimed/started/done.
  const ACTIVE_STATUSES = ['claimed', 'in_progress', 'ready_for_review', 'review', 'approved', 'merging', 'done',
    'rework_in_progress', 're_testing', 'needs_rework'];
  const hasProgress = (db.prepare(
    `SELECT COUNT(*) AS n FROM team_tasks WHERE phase = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`
  ).get(phase.id, ...ACTIVE_STATUSES) as { n: number }).n > 0;

  if (phase.status === 'pending' && hasProgress) {
    updateTeamPhaseStatus(phase.id, 'active');
    createTeamDecision({
      team_id: phase.team_id,
      decision_type: 'phase_transition',
      summary: `Phase "${phase.name}" started.`,
      details: { phase_id: phase.id, from: 'pending', to: 'active' },
    });
    appendEvent({
      team_id: phase.team_id,
      task_id: task.id,
      kind: 'phase_active',
      payload: { phase: phase.name, phase_id: phase.id },
      chat_report: true,
    });
  }

  // Active → completed when every task in the phase is terminal.
  if (phase.status === 'active') {
    const remaining = (db.prepare(
      `SELECT COUNT(*) AS n FROM team_tasks
         WHERE phase = ? AND status NOT IN ('done','approved','merging','cancelled','failed')`
    ).get(phase.id) as { n: number }).n;
    const total = (db.prepare('SELECT COUNT(*) AS n FROM team_tasks WHERE phase = ?').get(phase.id) as { n: number }).n;
    if (total > 0 && remaining === 0) {
      updateTeamPhaseStatus(phase.id, 'completed');
      createTeamDecision({
        team_id: phase.team_id,
        decision_type: 'phase_transition',
        summary: `Phase "${phase.name}" completed (${total} task${total === 1 ? '' : 's'}).`,
        details: { phase_id: phase.id, from: 'active', to: 'completed', task_count: total },
      });
      appendEvent({
        team_id: phase.team_id,
        kind: 'phase_completed',
        payload: { phase: phase.name, phase_id: phase.id, task_count: total },
        chat_report: true,
      });
      // Cascade: activate the next pending phase that has tasks.
      try { activateNextPhase(phase.team_id); } catch (e) {
        console.warn('[Schema] Cascading phase activation failed:', (e as Error).message);
      }
    }
  }
}

/** Reaper: stale claimed/in_progress → pending after 5 minutes. */
export function reapStaleClaims(timeoutMs = 5 * 60 * 1000): number {
  const cutoff = Date.now() - timeoutMs;
  const r = getDb().prepare(
    `UPDATE team_tasks
        SET status = 'pending', assigned_agent_id = NULL, claimed_at = NULL
      WHERE status IN ('claimed','in_progress')
        AND claimed_at IS NOT NULL
        AND claimed_at < ?`
  ).run(cutoff);
  return r.changes;
}

// ─── Events & messages ───────────────────────────────────────────────────

export function appendEvent(params: {
  team_id: string;
  agent_id?: string | null;
  task_id?: string | null;
  kind: string;
  severity?: 'debug' | 'info' | 'warn' | 'error';
  payload?: Record<string, unknown>;
  chat_report?: boolean;
}): void {
  getDb().prepare(
    `INSERT INTO team_events (team_id, agent_id, task_id, kind, severity, payload, chat_report, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.team_id,
    params.agent_id ?? null,
    params.task_id ?? null,
    params.kind,
    params.severity ?? 'info',
    JSON.stringify(params.payload ?? {}),
    params.chat_report ? 1 : 0,
    Date.now(),
  );
}

export function listEvents(team_id: string, limit = 500, kind?: string): TeamEventRow[] {
  const db = getDb();
  if (kind) {
    return db.prepare(
      `SELECT * FROM team_events WHERE team_id = ? AND kind = ? ORDER BY id DESC LIMIT ?`
    ).all(team_id, kind, limit) as TeamEventRow[];
  }
  return db.prepare(
    `SELECT * FROM team_events WHERE team_id = ? ORDER BY id DESC LIMIT ?`
  ).all(team_id, limit) as TeamEventRow[];
}

export function enqueueMessage(params: {
  team_id: string;
  from_agent_id?: string | null;
  to_agent_id?: string | null;
  type: TeamMessageRow['type'];
  priority?: TeamMessageRow['priority'];
  body: string;
  metadata?: Record<string, unknown>;
}): TeamMessageRow {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO team_messages (id, team_id, from_agent_id, to_agent_id, type, priority, body, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, params.team_id,
    params.from_agent_id ?? null,
    params.to_agent_id ?? null,
    params.type,
    params.priority ?? 'next',
    params.body,
    JSON.stringify(params.metadata ?? {}),
    now,
  );
  return db.prepare('SELECT * FROM team_messages WHERE id = ?').get(id) as TeamMessageRow;
}

export function claimUndeliveredMessages(to_agent_id: string): TeamMessageRow[] {
  const db = getDb();
  const now = Date.now();
  return db.transaction(() => {
    const rows = db.prepare(
      `SELECT * FROM team_messages WHERE to_agent_id = ? AND delivered_at IS NULL ORDER BY created_at ASC`
    ).all(to_agent_id) as TeamMessageRow[];
    if (rows.length > 0) {
      const stmt = db.prepare(`UPDATE team_messages SET delivered_at = ? WHERE id = ?`);
      for (const r of rows) stmt.run(now, r.id);
    }
    return rows;
  })();
}

export function listTeamMessages(team_id: string, limit = 500): TeamMessageRow[] {
  return getDb().prepare(
    `SELECT * FROM team_messages WHERE team_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(team_id, limit) as TeamMessageRow[];
}

/**
 * Commander↔Architect thread: messages where the architect is either the
 * sender (to commander, via chat_report) or the recipient (direct msg from
 * user). Ordered oldest→newest for chat display.
 */
export function listCommanderThread(team_id: string, limit = 200): TeamMessageRow[] {
  const db = getDb();
  const architects = db.prepare(
    `SELECT id FROM team_agents WHERE team_id = ? AND role = 'architect'`
  ).all(team_id) as Array<{ id: string }>;
  if (architects.length === 0) return [];
  const archIds = architects.map(a => a.id);
  const placeholders = archIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM team_messages
       WHERE team_id = ?
         AND (
           from_agent_id IN (${placeholders})
           OR to_agent_id IN (${placeholders})
         )
       ORDER BY created_at ASC
       LIMIT ?`
  ).all(team_id, ...archIds, ...archIds, limit) as TeamMessageRow[];
}

// ─── Team Phases ────────────────────────────────────────────────────────

export interface TeamPhaseRow {
  id: string;
  team_id: string;
  name: string;
  description: string | null;
  ordering: number;
  roles_json: string;
  status: 'pending' | 'active' | 'completed' | 'skipped';
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
}

export function createTeamPhase(input: {
  team_id: string;
  name: string;
  description?: string;
  ordering: number;
  roles?: string[];
}): TeamPhaseRow {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO team_phases (id, team_id, name, description, ordering, roles_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(id, input.team_id, input.name, input.description ?? null, input.ordering, JSON.stringify(input.roles ?? []), now);
  return db.prepare('SELECT * FROM team_phases WHERE id = ?').get(id) as TeamPhaseRow;
}

export function listTeamPhases(team_id: string): TeamPhaseRow[] {
  return getDb().prepare('SELECT * FROM team_phases WHERE team_id = ? ORDER BY ordering ASC').all(team_id) as TeamPhaseRow[];
}

export function updateTeamPhaseStatus(id: string, status: TeamPhaseRow['status']): void {
  const now = Date.now();
  const ts = status === 'active' ? 'started_at' : status === 'completed' ? 'completed_at' : null;
  if (ts) {
    getDb().prepare(`UPDATE team_phases SET status = ?, ${ts} = ? WHERE id = ?`).run(status, now, id);
  } else {
    getDb().prepare('UPDATE team_phases SET status = ? WHERE id = ?').run(status, id);
  }
}

/**
 * Activate the earliest pending phase that has at least one task.
 * Called after mc_propose_tasks (so the architect's first wave of tasks
 * unblocks the team) and after a phase completes (cascading to the next).
 * Returns the activated phase's name, or null if nothing was activated.
 */
export function activateNextPhase(team_id: string): string | null {
  const db = getDb();
  const phases = db.prepare(
    `SELECT * FROM team_phases WHERE team_id = ? AND status = 'pending' ORDER BY ordering ASC`
  ).all(team_id) as TeamPhaseRow[];
  for (const ph of phases) {
    const taskCount = (db.prepare(
      'SELECT COUNT(*) AS n FROM team_tasks WHERE phase = ?'
    ).get(ph.id) as { n: number }).n;
    if (taskCount === 0) continue;
    updateTeamPhaseStatus(ph.id, 'active');
    createTeamDecision({
      team_id,
      decision_type: 'phase_transition',
      summary: `Phase "${ph.name}" activated.`,
      details: { phase_id: ph.id, from: 'pending', to: 'active', auto: true, task_count: taskCount },
    });
    appendEvent({
      team_id,
      kind: 'phase_active',
      payload: { phase: ph.name, phase_id: ph.id, auto: true },
      chat_report: true,
    });
    return ph.name;
  }
  return null;
}

// ─── Team Decisions ─────────────────────────────────────────────────────

export interface TeamDecisionRow {
  id: string;
  team_id: string;
  agent_id: string | null;
  decision_type: string;
  summary: string;
  details_json: string;
  created_at: number;
}

export function createTeamDecision(input: {
  team_id: string;
  agent_id?: string;
  decision_type: string;
  summary: string;
  details?: Record<string, unknown>;
}): TeamDecisionRow {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO team_decisions (id, team_id, agent_id, decision_type, summary, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.team_id, input.agent_id ?? null, input.decision_type, input.summary, JSON.stringify(input.details ?? {}), now);
  return db.prepare('SELECT * FROM team_decisions WHERE id = ?').get(id) as TeamDecisionRow;
}

export function listTeamDecisions(team_id: string): TeamDecisionRow[] {
  return getDb().prepare('SELECT * FROM team_decisions WHERE team_id = ? ORDER BY created_at DESC').all(team_id) as TeamDecisionRow[];
}

// ─── Scratchpad ──────────────────────────────────────────────────────────

export function getScratchpad(team_id: string): { content: string; version: number; updated_at: number; updated_by: string } {
  const row = getDb().prepare('SELECT content, version, updated_at, updated_by FROM team_scratchpad WHERE team_id = ?')
    .get(team_id) as { content: string; version: number; updated_at: number; updated_by: string } | undefined;
  return row ?? { content: '', version: 0, updated_at: 0, updated_by: '' };
}

/** Version-checked update; returns new version or null on conflict. */
export function updateScratchpad(
  team_id: string,
  content: string,
  expected_version: number,
  updated_by: string,
): number | null {
  const db = getDb();
  const now = Date.now();
  if (expected_version === 0) {
    // First write
    try {
      db.prepare(
        `INSERT INTO team_scratchpad (team_id, content, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)`
      ).run(team_id, content, now, updated_by);
      return 1;
    } catch {
      return null;
    }
  }
  const r = db.prepare(
    `UPDATE team_scratchpad SET content = ?, version = version + 1, updated_at = ?, updated_by = ?
      WHERE team_id = ? AND version = ?`
  ).run(content, now, updated_by, team_id, expected_version);
  return r.changes === 1 ? expected_version + 1 : null;
}

// ─── Task reviews + findings ─────────────────────────────────────────────

export interface PersistReviewInput {
  task_id: string;
  reviewer_agent_id?: string | null;
  reviewer_model: string;
  review_kind: TaskReviewRow['review_kind'];
  clean: boolean;
  verdict?: string;
  summary?: string;
  cost_usd?: number;
  duration_ms?: number;
  raw_output?: string;
  findings: Array<{
    severity: ReviewFindingSeverity;
    file?: string;
    line_start?: number;
    line_end?: number;
    title: string;
    body?: string;
    recommendation?: string;
    confidence?: number;
  }>;
}

export function persistReview(input: PersistReviewInput): { review_id: string; finding_ids: string[] } {
  const db = getDb();
  const now = Date.now();
  const review_id = randomUUID();
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO task_reviews (
        id, task_id, reviewer_agent_id, reviewer_model, review_kind,
        clean, verdict, summary, cost_usd, duration_ms, raw_output, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      review_id, input.task_id, input.reviewer_agent_id ?? null, input.reviewer_model,
      input.review_kind, input.clean ? 1 : 0,
      input.verdict ?? null, input.summary ?? null,
      input.cost_usd ?? null, input.duration_ms ?? null,
      input.raw_output ?? null, now,
    );
    const finding_ids: string[] = [];
    const insertFinding = db.prepare(
      `INSERT INTO task_review_findings (
        id, review_id, severity, file, line_start, line_end,
        title, body, recommendation, confidence, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
    );
    for (const f of input.findings) {
      const fid = randomUUID();
      insertFinding.run(
        fid, review_id, f.severity, f.file ?? null,
        f.line_start ?? null, f.line_end ?? null,
        f.title, f.body ?? null, f.recommendation ?? null,
        f.confidence ?? null, now,
      );
      finding_ids.push(fid);
    }
    return { review_id, finding_ids };
  })();
}

export function listTaskReviews(task_id: string): TaskReviewRow[] {
  return getDb().prepare('SELECT * FROM task_reviews WHERE task_id = ? ORDER BY created_at DESC').all(task_id) as TaskReviewRow[];
}

export function listReviewFindings(review_id: string): TaskReviewFindingRow[] {
  return getDb().prepare('SELECT * FROM task_review_findings WHERE review_id = ? ORDER BY severity, created_at').all(review_id) as TaskReviewFindingRow[];
}

export function listTeamReviews(team_id: string, limit = 100): TaskReviewRow[] {
  return getDb().prepare(
    `SELECT tr.* FROM task_reviews tr
     JOIN team_tasks tt ON tt.id = tr.task_id
     WHERE tt.team_id = ?
     ORDER BY tr.created_at DESC LIMIT ?`
  ).all(team_id, limit) as TaskReviewRow[];
}

export function listTeamFindings(team_id: string, limit = 200): Array<TaskReviewFindingRow & { task_id: string; review_kind: string }> {
  return getDb().prepare(
    `SELECT f.*, tr.task_id, tr.review_kind
     FROM task_review_findings f
     JOIN task_reviews tr ON tr.id = f.review_id
     JOIN team_tasks tt ON tt.id = tr.task_id
     WHERE tt.team_id = ?
     ORDER BY
       CASE f.severity
         WHEN 'critical' THEN 0
         WHEN 'high' THEN 1
         WHEN 'medium' THEN 2
         WHEN 'low' THEN 3
         ELSE 4
       END,
       f.created_at DESC
     LIMIT ?`
  ).all(team_id, limit) as Array<TaskReviewFindingRow & { task_id: string; review_kind: string }>;
}
