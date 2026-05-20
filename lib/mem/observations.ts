/**
 * mem/observations — storage + search over AI-compressed learnings.
 *
 * The 3-layer progressive disclosure API (claude-mem style):
 *   1. search(q)                 → title + 1-line summary (~50 tok/hit)
 *   2. timeline(obs_id | query)  → surrounding ordered summaries (~150 tok/hit)
 *   3. getObservation(id)        → full content + source turn snippets
 *
 * This is deliberately separate from `turns`/`episodes` (raw chat history).
 * Observations are small, durable, cross-session nuggets.
 */

import 'server-only';
import { getDb } from '../memory-db';
import { embedText, vectorToBuffer, bufferToVector, cosineSim } from '../memory-embed';
import { resolveSessionScope, touchSession } from './sessions';

export type MemObservationType =
  | 'decision'
  | 'pattern'
  | 'blocker'
  | 'fact'
  | 'skill'
  | 'finding'
  | 'summary';

export interface MemObservationRow {
  id: number;
  session_id: string;
  type: MemObservationType;
  title: string;
  content: string;
  tags: string; // JSON
  source_turn_ids: string; // JSON
  files_involved: string; // JSON
  embedding: Buffer | null;
  embedding_model: string | null;
  created_at: number;
  compressed_from: string | null;
}

export interface CreateObservationInput {
  sessionId: string;
  type: MemObservationType;
  title: string;
  content: string;
  tags?: string[];
  sourceTurnIds?: string[];
  filesInvolved?: string[];
  compressedFrom?: string;
  skipEmbedding?: boolean;
}

export interface SearchHit {
  id: number;
  sessionId: string;
  type: MemObservationType;
  title: string;
  excerpt: string;
  tags: string[];
  score: number;
  createdAt: number;
}

export interface TimelineEntry {
  id: number;
  sessionId: string;
  type: MemObservationType;
  title: string;
  summary: string;
  createdAt: number;
}

const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function toFtsQuery(q: string): string {
  const tokens = q.match(/[\w./\-]{3,}/g) ?? [];
  if (tokens.length === 0) return '';
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

export async function createObservation(input: CreateObservationInput): Promise<MemObservationRow> {
  const db = getDb();
  const now = Date.now();

  let embedBuf: Buffer | null = null;
  let embedModel: string | null = null;
  if (!input.skipEmbedding) {
    try {
      const vec = await embedText(`${input.title}\n\n${input.content}`.slice(0, 2000));
      embedBuf = vectorToBuffer(vec);
      embedModel = EMBED_MODEL;
    } catch (e) {
      console.warn('[mem.observations] embed failed, storing without vector:', (e as Error).message);
    }
  }

  const info = db.prepare(
    `INSERT INTO mem_observations
       (session_id, type, title, content, tags, source_turn_ids, files_involved,
        embedding, embedding_model, created_at, compressed_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.sessionId,
    input.type,
    input.title.slice(0, 400),
    input.content,
    JSON.stringify(input.tags ?? []),
    JSON.stringify(input.sourceTurnIds ?? []),
    JSON.stringify(input.filesInvolved ?? []),
    embedBuf,
    embedModel,
    now,
    input.compressedFrom ?? null,
  );

  touchSession(input.sessionId);
  return db.prepare('SELECT * FROM mem_observations WHERE id = ?')
    .get(info.lastInsertRowid) as MemObservationRow;
}

export function getObservation(id: number): MemObservationRow | undefined {
  return getDb()
    .prepare('SELECT * FROM mem_observations WHERE id = ?')
    .get(id) as MemObservationRow | undefined;
}

export async function search(params: {
  query: string;
  sessionId?: string;
  includeScope?: boolean; // default true; pulls parent + siblings
  type?: MemObservationType;
  limit?: number;
}): Promise<SearchHit[]> {
  const db = getDb();
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 100);

  const sessionIds = params.sessionId
    ? (params.includeScope === false ? [params.sessionId] : resolveSessionScope(params.sessionId))
    : null;

  // Layer 1: FTS5 hits
  const fts = toFtsQuery(params.query);
  const ftsRows: Array<{ id: number; rank: number }> = [];
  if (fts) {
    try {
      const rows = db.prepare(
        `SELECT rowid as id, rank FROM mem_observations_fts
         WHERE mem_observations_fts MATCH ?
         ORDER BY rank LIMIT ?`
      ).all(fts, limit * 3) as Array<{ id: number; rank: number }>;
      ftsRows.push(...rows);
    } catch (e) {
      // FTS query parse error — fall through to semantic-only
    }
  }

  // Layer 2: semantic
  let semanticRows: Array<{ id: number; score: number }> = [];
  try {
    const qVec = await embedText(params.query);
    const candidates = db.prepare(
      `SELECT id, embedding FROM mem_observations
       WHERE embedding IS NOT NULL
       ORDER BY created_at DESC LIMIT 2000`
    ).all() as Array<{ id: number; embedding: Buffer }>;
    semanticRows = candidates
      .map(r => ({ id: r.id, score: cosineSim(qVec, bufferToVector(r.embedding)) }))
      .filter(r => r.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit * 3);
  } catch {
    // embedder unavailable
  }

  // Blend: normalize + sum. FTS rank is lower=better; flip it.
  const ftsScores = new Map<number, number>();
  const maxFts = ftsRows.length > 0 ? ftsRows[ftsRows.length - 1].rank : 1;
  for (const r of ftsRows) {
    ftsScores.set(r.id, 1 - (r.rank / (maxFts + 1)));
  }
  const semScores = new Map<number, number>();
  for (const r of semanticRows) semScores.set(r.id, r.score);

  const allIds = new Set<number>([...ftsScores.keys(), ...semScores.keys()]);
  if (allIds.size === 0) return [];

  const placeholders = Array.from(allIds).map(() => '?').join(',');
  let rows = db.prepare(
    `SELECT id, session_id, type, title, content, tags, created_at
     FROM mem_observations WHERE id IN (${placeholders})`
  ).all(...Array.from(allIds)) as Array<{
    id: number; session_id: string; type: MemObservationType;
    title: string; content: string; tags: string; created_at: number;
  }>;

  if (sessionIds) {
    const allow = new Set(sessionIds);
    rows = rows.filter(r => allow.has(r.session_id));
  }
  if (params.type) rows = rows.filter(r => r.type === params.type);

  const scored = rows.map(r => {
    const s = (ftsScores.get(r.id) ?? 0) * 0.55 + (semScores.get(r.id) ?? 0) * 0.45;
    return {
      id: r.id,
      sessionId: r.session_id,
      type: r.type,
      title: r.title,
      excerpt: r.content.slice(0, 240),
      tags: parseJson<string[]>(r.tags, []),
      score: s,
      createdAt: r.created_at,
    } as SearchHit;
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function timeline(params: {
  sessionId?: string;
  observationId?: number;
  windowBefore?: number;
  windowAfter?: number;
  limit?: number;
}): TimelineEntry[] {
  const db = getDb();
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const before = params.windowBefore ?? 5;
  const after = params.windowAfter ?? 5;

  if (params.observationId != null) {
    const pivot = getObservation(params.observationId);
    if (!pivot) return [];
    const earlier = db.prepare(
      `SELECT id, session_id, type, title, content, created_at
       FROM mem_observations
       WHERE session_id = ? AND created_at < ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(pivot.session_id, pivot.created_at, before) as any[];
    const later = db.prepare(
      `SELECT id, session_id, type, title, content, created_at
       FROM mem_observations
       WHERE session_id = ? AND created_at >= ?
       ORDER BY created_at ASC LIMIT ?`
    ).all(pivot.session_id, pivot.created_at, after + 1) as any[];
    return [...earlier.reverse(), ...later].map(toTimelineEntry);
  }

  if (params.sessionId) {
    const scope = resolveSessionScope(params.sessionId);
    const placeholders = scope.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, session_id, type, title, content, created_at
       FROM mem_observations
       WHERE session_id IN (${placeholders})
       ORDER BY created_at DESC LIMIT ?`
    ).all(...scope, limit) as any[];
    return rows.reverse().map(toTimelineEntry);
  }

  const rows = db.prepare(
    `SELECT id, session_id, type, title, content, created_at
     FROM mem_observations ORDER BY created_at DESC LIMIT ?`
  ).all(limit) as any[];
  return rows.reverse().map(toTimelineEntry);
}

function toTimelineEntry(r: any): TimelineEntry {
  return {
    id: r.id,
    sessionId: r.session_id,
    type: r.type,
    title: r.title,
    summary: (r.content as string).slice(0, 160),
    createdAt: r.created_at,
  };
}

export function logPrompt(sessionId: string, content: string): void {
  if (!content?.trim()) return;
  getDb()
    .prepare('INSERT INTO mem_prompts (session_id, content, created_at) VALUES (?, ?, ?)')
    .run(sessionId, content.slice(0, 20_000), Date.now());
  touchSession(sessionId);
}

export interface QueueItem {
  sessionId: string;
  kind: 'tool_use' | 'tool_result' | 'assistant' | 'user' | 'event';
  toolName?: string;
  payload: unknown;
}

export function enqueueObservation(item: QueueItem): void {
  getDb().prepare(
    `INSERT INTO mem_obs_queue (session_id, kind, tool_name, payload, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    item.sessionId,
    item.kind,
    item.toolName ?? null,
    JSON.stringify(item.payload ?? {}).slice(0, 50_000),
    Date.now(),
  );
}

export interface QueuedRow {
  id: number;
  session_id: string;
  kind: string;
  tool_name: string | null;
  payload: string;
  created_at: number;
}

export function drainQueue(sessionId: string, max = 100): QueuedRow[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM mem_obs_queue
     WHERE session_id = ? AND processed_at IS NULL
     ORDER BY created_at ASC LIMIT ?`
  ).all(sessionId, max) as QueuedRow[];
  if (rows.length === 0) return [];
  const now = Date.now();
  const upd = db.prepare('UPDATE mem_obs_queue SET processed_at = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of rows) upd.run(now, r.id);
  });
  tx();
  return rows;
}

export function pendingObservationCount(sessionId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) as n FROM mem_obs_queue WHERE session_id = ? AND processed_at IS NULL')
    .get(sessionId) as { n: number };
  return row?.n ?? 0;
}

export function listRecentObservations(sessionId: string, limit = 20): MemObservationRow[] {
  return getDb()
    .prepare('SELECT * FROM mem_observations WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(sessionId, limit) as MemObservationRow[];
}
