/**
 * mem/sessions — CRUD over `mem_sessions`.
 *
 * Sessions namespace observations. A single MC chat maps to exactly one
 * `kind='chat'` session. Each Constellation agent gets its own `kind='team_agent'`
 * session; the team itself gets a `kind='team_meta'` session. Children link to
 * parents via parent_session_id so the orchestrator can pull child summaries.
 */

import 'server-only';
import { randomUUID } from 'node:crypto';
import { getDb } from '../memory-db';

export type MemSessionKind = 'chat' | 'team_agent' | 'team_meta' | 'manual';

export interface MemSessionRow {
  id: string;
  kind: MemSessionKind;
  chat_id: string | null;
  team_id: string | null;
  agent_id: string | null;
  parent_session_id: string | null;
  title: string;
  summary: string;
  tags: string; // JSON string[]
  created_at: number;
  updated_at: number;
  ended_at: number | null;
}

export interface CreateMemSessionInput {
  kind: MemSessionKind;
  chatId?: string;
  teamId?: string;
  agentId?: string;
  parentSessionId?: string;
  title?: string;
  tags?: string[];
}

export function createMemSession(input: CreateMemSessionInput): MemSessionRow {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO mem_sessions
       (id, kind, chat_id, team_id, agent_id, parent_session_id, title, summary, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`
  ).run(
    id,
    input.kind,
    input.chatId ?? null,
    input.teamId ?? null,
    input.agentId ?? null,
    input.parentSessionId ?? null,
    input.title ?? '',
    JSON.stringify(input.tags ?? []),
    now,
    now,
  );
  return getMemSession(id)!;
}

export function getMemSession(id: string): MemSessionRow | undefined {
  return getDb()
    .prepare('SELECT * FROM mem_sessions WHERE id = ?')
    .get(id) as MemSessionRow | undefined;
}

/** Lookup (or create) the single chat session for a given chat_id. */
export function ensureChatSession(chatId: string, title?: string): MemSessionRow {
  const existing = getDb()
    .prepare('SELECT * FROM mem_sessions WHERE kind = ? AND chat_id = ? ORDER BY created_at ASC LIMIT 1')
    .get('chat', chatId) as MemSessionRow | undefined;
  if (existing) return existing;
  return createMemSession({ kind: 'chat', chatId, title: title ?? chatId });
}

/** Lookup (or create) a team-meta session for a given team_id. When
 *  parentSessionId is provided and the existing row has no parent (or a
 *  different one), we upgrade the row so observation scope propagates. */
export function ensureTeamMetaSession(
  teamId: string,
  title?: string,
  parentSessionId?: string,
): MemSessionRow {
  const db = getDb();
  const existing = db
    .prepare('SELECT * FROM mem_sessions WHERE kind = ? AND team_id = ? AND agent_id IS NULL LIMIT 1')
    .get('team_meta', teamId) as MemSessionRow | undefined;
  if (existing) {
    if (parentSessionId && existing.parent_session_id !== parentSessionId) {
      db.prepare('UPDATE mem_sessions SET parent_session_id = ?, updated_at = ? WHERE id = ?')
        .run(parentSessionId, Date.now(), existing.id);
      return { ...existing, parent_session_id: parentSessionId };
    }
    return existing;
  }
  return createMemSession({ kind: 'team_meta', teamId, title: title ?? `team:${teamId}`, parentSessionId });
}

/** Lookup (or create) a per-agent session. Parent defaults to the team_meta session. */
export function ensureAgentSession(params: {
  teamId: string;
  agentId: string;
  title?: string;
  role?: string;
}): MemSessionRow {
  const existing = getDb()
    .prepare('SELECT * FROM mem_sessions WHERE kind = ? AND agent_id = ? LIMIT 1')
    .get('team_agent', params.agentId) as MemSessionRow | undefined;
  if (existing) return existing;
  const parent = ensureTeamMetaSession(params.teamId);
  return createMemSession({
    kind: 'team_agent',
    teamId: params.teamId,
    agentId: params.agentId,
    parentSessionId: parent.id,
    title: params.title ?? `${params.role ?? 'agent'}:${params.agentId.slice(0, 8)}`,
    tags: params.role ? [params.role] : [],
  });
}

export function touchSession(id: string): void {
  getDb().prepare('UPDATE mem_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export function endSession(id: string, summary?: string): void {
  const now = Date.now();
  if (summary !== undefined) {
    getDb()
      .prepare('UPDATE mem_sessions SET summary = ?, ended_at = ?, updated_at = ? WHERE id = ?')
      .run(summary, now, now, id);
  } else {
    getDb()
      .prepare('UPDATE mem_sessions SET ended_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, id);
  }
}

export function listSessions(opts?: { kind?: MemSessionKind; limit?: number }): MemSessionRow[] {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 500);
  if (opts?.kind) {
    return getDb()
      .prepare('SELECT * FROM mem_sessions WHERE kind = ? ORDER BY updated_at DESC LIMIT ?')
      .all(opts.kind, limit) as MemSessionRow[];
  }
  return getDb()
    .prepare('SELECT * FROM mem_sessions ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as MemSessionRow[];
}

/** Resolve the set of session IDs that a query should search. For a chat session
 *  this is itself + its direct children (if any). For a team_meta session this
 *  is itself + all agent children. For a team_agent session this is itself + parent. */
export function resolveSessionScope(sessionId: string): string[] {
  const db = getDb();
  const root = getMemSession(sessionId);
  if (!root) return [sessionId];
  const ids = new Set<string>([sessionId]);
  if (root.parent_session_id) ids.add(root.parent_session_id);
  const kids = db
    .prepare('SELECT id FROM mem_sessions WHERE parent_session_id = ?')
    .all(sessionId) as Array<{ id: string }>;
  for (const k of kids) ids.add(k.id);
  return Array.from(ids);
}
