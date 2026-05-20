/**
 * Mission Control subagent store.
 *
 * Tracks Task tool invocations made by the parent `claude -p` process so the
 * chat header dropdown can show running/completed subagents. Persists to the
 * `mc_subagents` table in `data/memory.db` (migration #3). Previously backed
 * by `data/mc-subagents.json` — see `migrateLegacyJson()` for the one-shot
 * forward migration that runs the first time this module loads.
 *
 * The exported surface (recordStart / recordFinish / listRuns / gc /
 * McSubagentRun) is unchanged from the JSON-backed version.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './memory-db';

const DATA_DIR = path.join(process.cwd(), 'data');
const LEGACY_STORE_FILE = path.join(DATA_DIR, 'mc-subagents.json');

export interface McSubagentRun {
  /** Matches Claude Code's tool_use.id (e.g. "toolu_01ABC...") */
  toolUseId: string;
  /** Mission Control chat session key OR 'team:<team_id>:<role_handle>' */
  sessionKey: string;
  /** Claude Code session id of the parent process */
  parentSessionId?: string;
  /** The specialized agent type passed to Task (e.g. "general-purpose", "Explore") */
  subagentType: string;
  /** Short label from Task input.description */
  label: string;
  /** Full prompt the parent sent to the subagent */
  task: string;
  status: 'running' | 'complete' | 'failed';
  startedAt: number;
  endedAt?: number;
  /** Final text result, captured from the matching tool_result block */
  resultFull?: string;
  /** If the subagent errored */
  error?: string;
  /** Team scope (null for regular chat subagents; resolves hidden coupling #3) */
  teamId?: string | null;
  teamAgentId?: string | null;
  teamTaskId?: string | null;
}

interface Row {
  tool_use_id: string;
  session_key: string;
  parent_session_id: string | null;
  team_id: string | null;
  team_agent_id: string | null;
  team_task_id: string | null;
  subagent_type: string | null;
  label: string | null;
  task: string | null;
  status: 'running' | 'complete' | 'failed' | 'cancelled';
  started_at: number;
  ended_at: number | null;
  result_full: string | null;
  error: string | null;
  created_at: number;
}

function rowToRun(r: Row): McSubagentRun {
  return {
    toolUseId: r.tool_use_id,
    sessionKey: r.session_key,
    parentSessionId: r.parent_session_id ?? undefined,
    subagentType: r.subagent_type ?? '',
    label: r.label ?? '',
    task: r.task ?? '',
    status: r.status === 'cancelled' ? 'failed' : r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    resultFull: r.result_full ?? undefined,
    error: r.error ?? undefined,
    teamId: r.team_id,
    teamAgentId: r.team_agent_id,
    teamTaskId: r.team_task_id,
  };
}

// ─── One-shot legacy JSON migration ──────────────────────────────────────
// Runs the first time the module is loaded after migration #3. Imports any
// existing rows from mc-subagents.json into the SQLite table, then renames
// the file to .bak so it won't get re-imported or overwritten.

let legacyMigrationDone = false;

function migrateLegacyJson(): void {
  if (legacyMigrationDone) return;
  legacyMigrationDone = true;
  if (!fs.existsSync(LEGACY_STORE_FILE)) return;
  try {
    const raw = fs.readFileSync(LEGACY_STORE_FILE, 'utf-8');
    const data = JSON.parse(raw) as { version?: number; runs?: Record<string, McSubagentRun> };
    const runs = data?.runs ?? {};
    const entries = Object.values(runs);
    if (entries.length === 0) {
      fs.renameSync(LEGACY_STORE_FILE, LEGACY_STORE_FILE + '.bak');
      return;
    }
    const db = getDb();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO mc_subagents (
        tool_use_id, session_key, parent_session_id, subagent_type,
        label, task, status, started_at, ended_at, result_full, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const migrate = db.transaction((rows: McSubagentRun[]) => {
      const now = Date.now();
      for (const r of rows) {
        const status = r.status === 'running' || r.status === 'complete' || r.status === 'failed' ? r.status : 'complete';
        insert.run(
          r.toolUseId,
          r.sessionKey,
          r.parentSessionId ?? null,
          r.subagentType ?? null,
          r.label ?? null,
          r.task ?? null,
          status,
          r.startedAt ?? now,
          r.endedAt ?? null,
          r.resultFull ?? null,
          r.error ?? null,
          now,
        );
      }
    });
    migrate(entries);
    fs.renameSync(LEGACY_STORE_FILE, LEGACY_STORE_FILE + '.bak');
    console.log(`[mc-subagents-store] migrated ${entries.length} legacy runs to SQLite; renamed JSON to .bak`);
  } catch (e) {
    console.warn('[mc-subagents-store] legacy JSON migration failed:', (e as Error).message);
  }
}

function ensureReady(): void {
  migrateLegacyJson();
}

// ─── Public API (signatures preserved) ───────────────────────────────────

export function recordStart(run: Omit<McSubagentRun, 'status' | 'startedAt'> & { startedAt?: number }): void {
  ensureReady();
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO mc_subagents (
      tool_use_id, session_key, parent_session_id, team_id, team_agent_id, team_task_id,
      subagent_type, label, task, status, started_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`
  ).run(
    run.toolUseId,
    run.sessionKey,
    run.parentSessionId ?? null,
    run.teamId ?? null,
    run.teamAgentId ?? null,
    run.teamTaskId ?? null,
    run.subagentType ?? null,
    run.label ?? null,
    run.task ?? null,
    run.startedAt ?? now,
    now,
  );
}

export function recordFinish(
  toolUseId: string,
  opts: { resultFull?: string; error?: string; isError?: boolean },
): void {
  ensureReady();
  const db = getDb();
  const status: 'complete' | 'failed' = opts.isError || opts.error ? 'failed' : 'complete';
  db.prepare(
    `UPDATE mc_subagents
        SET status = ?, ended_at = ?, result_full = ?, error = ?
      WHERE tool_use_id = ?`
  ).run(
    status,
    Date.now(),
    opts.resultFull ?? null,
    opts.error ?? null,
    toolUseId,
  );
}

export function listRuns(sessionKeyFilter?: string): McSubagentRun[] {
  ensureReady();
  const db = getDb();
  // Sort: running first, then most-recent first (matches old sort).
  const baseSql = `
    SELECT *,
           CASE WHEN status = 'running' THEN 0 ELSE 1 END AS _sort_running
      FROM mc_subagents
     {where}
     ORDER BY _sort_running ASC, started_at DESC`;
  let rows: Row[];
  if (sessionKeyFilter) {
    rows = db.prepare(baseSql.replace('{where}', 'WHERE session_key = ? OR session_key LIKE ?'))
      .all(sessionKeyFilter, `%${sessionKeyFilter}%`) as Row[];
  } else {
    rows = db.prepare(baseSql.replace('{where}', '')).all() as Row[];
  }
  return rows.map(rowToRun);
}

/**
 * Garbage-collect runs older than maxAgeMs.
 * Defaults: keep completed runs for 7 days, running runs for 24h (stuck).
 * (Previously existed but was never called. Now actually invoked from
 * /api/subagents on every list call.)
 */
export function gc(maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
  ensureReady();
  const db = getDb();
  const now = Date.now();
  const oldCompleted = now - maxAgeMs;
  const oldRunning = now - 24 * 60 * 60 * 1000;
  db.prepare(
    `DELETE FROM mc_subagents
      WHERE (ended_at IS NOT NULL AND ended_at < ?)
         OR (status = 'running' AND started_at < ?)`
  ).run(oldCompleted, oldRunning);
}
