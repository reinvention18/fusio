/**
 * Learned Skills — auto-extracted knowledge from completed Constellation tasks.
 *
 * Unlike Multica's static CRUD approach (admin manually creates skills and
 * attaches them to agents), this system automatically generates skill entries
 * when tasks complete successfully. Skills compound over time: when a skill
 * gets reused and the task succeeds, its `applicability` score increases,
 * making it more likely to surface for future similar tasks.
 *
 * Lifecycle:
 *   task → done → extractSkill() → learned_skills row
 *   new task → retrieveRelevantSkills(project, tags) → injected into agent prompt
 *   task succeeds with injected skill → bumpSkillApplicability()
 */

import 'server-only';
import { getDb } from '../memory-db';
import { randomUUID } from 'node:crypto';
import type { TeamTaskRow, TeamAgentRow, TeamRow } from './schema';
import { getTeam, getTeamAgent } from './schema';

export interface LearnedSkill {
  id: string;
  team_id: string | null;
  task_id: string | null;
  project_id: string;
  title: string;
  summary: string;
  pattern: string | null;
  files_involved: string[];
  tags: string[];
  tools_used: string[];
  outcome: 'success' | 'partial' | 'learned_failure';
  agent_role: string | null;
  agent_model: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  applicability: number;
  times_applied: number;
  last_applied_at: number | null;
  created_at: number;
}

// ─── Extract a skill from a completed task ───────────────────────────────

/**
 * Called automatically when a task transitions to `done`. Extracts a learned
 * skill from the task's metadata — what was done, what files were touched,
 * what role did it, and what tags describe it.
 *
 * This is NOT LLM-based extraction (that would be expensive and slow). It's
 * structured metadata extraction from the task row + team context. The
 * `summary` comes from the agent's own `mc_submit_task_result` call; the
 * `pattern` field is populated later if the skill proves reusable.
 */
export function extractSkillFromTask(task: TeamTaskRow): string | null {
  if (!task.result_summary) return null;

  const team = getTeam(task.team_id);
  if (!team) return null;

  const agent = task.assigned_agent_id ? getTeamAgent(task.assigned_agent_id) : null;
  const files: string[] = (() => { try { return JSON.parse(task.files_touched || '[]'); } catch { return []; } })();

  // Auto-generate tags from: role, file extensions, task title keywords
  const tags: string[] = [];
  if (agent?.role) tags.push(agent.role);
  const extensions = new Set(files.map(f => f.split('.').pop()?.toLowerCase()).filter(Boolean));
  for (const ext of extensions) tags.push(ext!);
  // Extract meaningful words from title (>3 chars, not common stopwords)
  const stopwords = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when', 'what', 'where', 'which']);
  const titleWords = task.title.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stopwords.has(w));
  tags.push(...titleWords.slice(0, 5));

  const db = getDb();
  const id = randomUUID();
  const now = Date.now();

  const duration = task.completed_at && task.claimed_at
    ? task.completed_at - task.claimed_at
    : null;

  db.prepare(
    `INSERT INTO learned_skills (
      id, team_id, task_id, project_id, title, summary, pattern,
      files_involved, tags, tools_used, outcome, agent_role, agent_model,
      cost_usd, duration_ms, applicability, times_applied, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, '[]', 'success', ?, ?, ?, ?, 1, 0, ?, ?)`
  ).run(
    id,
    task.team_id,
    task.id,
    team.project_id,
    task.title,
    task.result_summary,
    JSON.stringify(files),
    JSON.stringify([...new Set(tags)]),
    agent?.role ?? null,
    agent?.model ?? null,
    agent?.cost_usd ?? null,
    duration,
    now,
    now,
  );

  return id;
}

// ─── Retrieve relevant skills for a new task ─────────────────────────────

/**
 * Find learned skills relevant to a new task. Uses tag overlap scoring:
 * more matching tags + higher applicability = higher rank.
 *
 * Returns skills sorted by relevance, limited to `maxResults`.
 */
export function retrieveRelevantSkills(
  project_id: string,
  taskTags: string[],
  maxResults = 5,
): LearnedSkill[] {
  const db = getDb();

  // Get all successful skills for this project, ordered by applicability
  const rows = db.prepare(
    `SELECT * FROM learned_skills
      WHERE project_id = ? AND outcome = 'success'
      ORDER BY applicability DESC, times_applied DESC, created_at DESC
      LIMIT 50`
  ).all(project_id) as any[];

  if (rows.length === 0 || taskTags.length === 0) {
    // No tags to match — return top skills by applicability
    return rows.slice(0, maxResults).map(rowToSkill);
  }

  // Score by tag overlap
  const tagSet = new Set(taskTags.map(t => t.toLowerCase()));
  const scored = rows.map(row => {
    const skillTags: string[] = (() => { try { return JSON.parse(row.tags || '[]'); } catch { return []; } })();
    const overlap = skillTags.filter(t => tagSet.has(t.toLowerCase())).length;
    const score = overlap * 10 + (row.applicability ?? 1);
    return { row, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).filter(s => s.score > 0).map(s => rowToSkill(s.row));
}

/**
 * Format retrieved skills as a context block for injection into an agent's
 * system prompt. This is what makes skills "compound" — agents see what
 * worked before on similar tasks.
 */
export function formatSkillsForPrompt(skills: LearnedSkill[]): string {
  if (skills.length === 0) return '';
  const lines = ['## Learned Skills (from prior successful tasks)\n'];
  for (const s of skills) {
    lines.push(`### ${s.title}`);
    lines.push(`${s.summary}`);
    if (s.pattern) lines.push(`**Pattern:** ${s.pattern}`);
    if (s.files_involved.length > 0) lines.push(`**Files:** ${s.files_involved.join(', ')}`);
    if (s.cost_usd) lines.push(`**Cost:** $${s.cost_usd.toFixed(2)} | ${s.duration_ms ? Math.round(s.duration_ms / 1000) + 's' : 'unknown'}`);
    lines.push(`**Applicability:** ${s.applicability}/5 (used ${s.times_applied} times)\n`);
  }
  return lines.join('\n');
}

// ─── Skill compounding ──────────────────────────────────────────────────

/**
 * Called when a task completes successfully AND that task had learned skills
 * injected into its agent's prompt. Bumps the applicability score of each
 * skill that was used, making it more likely to surface for future tasks.
 */
export function bumpSkillApplicability(skillIds: string[]): void {
  if (skillIds.length === 0) return;
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `UPDATE learned_skills
        SET times_applied = times_applied + 1,
            applicability = MIN(5, applicability + 1),
            last_applied_at = ?,
            updated_at = ?
      WHERE id = ?`
  );
  db.transaction(() => {
    for (const id of skillIds) stmt.run(now, now, id);
  })();
}

/**
 * Record a "learned failure" — a task that failed in an instructive way.
 * These are surfaced with lower priority but help agents avoid known pitfalls.
 */
export function recordLearnedFailure(task: TeamTaskRow, lesson: string): string | null {
  const team = getTeam(task.team_id);
  if (!team) return null;
  const agent = task.assigned_agent_id ? getTeamAgent(task.assigned_agent_id) : null;
  const files: string[] = (() => { try { return JSON.parse(task.files_touched || '[]'); } catch { return []; } })();

  const db = getDb();
  const id = randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO learned_skills (
      id, team_id, task_id, project_id, title, summary, pattern,
      files_involved, tags, tools_used, outcome, agent_role, agent_model,
      cost_usd, duration_ms, applicability, times_applied, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', 'learned_failure', ?, ?, NULL, NULL, 1, 0, ?, ?)`
  ).run(
    id, task.team_id, task.id, team.project_id,
    `[PITFALL] ${task.title}`,
    lesson,
    task.error_detail || null,
    JSON.stringify(files),
    agent?.role ?? null, agent?.model ?? null,
    now, now,
  );
  return id;
}

// ─── List / stats ────────────────────────────────────────────────────────

export function listLearnedSkills(project_id: string, limit = 50): LearnedSkill[] {
  return (getDb().prepare(
    `SELECT * FROM learned_skills WHERE project_id = ? ORDER BY applicability DESC, created_at DESC LIMIT ?`
  ).all(project_id, limit) as any[]).map(rowToSkill);
}

export function getSkillStats(project_id: string): { total: number; successes: number; failures: number; avgApplicability: number } {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) AS n FROM learned_skills WHERE project_id = ?').get(project_id) as any).n;
  const successes = (db.prepare("SELECT COUNT(*) AS n FROM learned_skills WHERE project_id = ? AND outcome = 'success'").get(project_id) as any).n;
  const failures = (db.prepare("SELECT COUNT(*) AS n FROM learned_skills WHERE project_id = ? AND outcome = 'learned_failure'").get(project_id) as any).n;
  const avg = (db.prepare('SELECT AVG(applicability) AS a FROM learned_skills WHERE project_id = ?').get(project_id) as any).a ?? 0;
  return { total, successes, failures, avgApplicability: Math.round(avg * 10) / 10 };
}

// ─── Internal ────────────────────────────────────────────────────────────

function rowToSkill(row: any): LearnedSkill {
  return {
    ...row,
    files_involved: (() => { try { return JSON.parse(row.files_involved || '[]'); } catch { return []; } })(),
    tags: (() => { try { return JSON.parse(row.tags || '[]'); } catch { return []; } })(),
    tools_used: (() => { try { return JSON.parse(row.tools_used || '[]'); } catch { return []; } })(),
  };
}
