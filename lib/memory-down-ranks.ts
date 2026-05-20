/**
 * memory-down-ranks — user-driven signal that an approach or suggestion was
 * rejected. Consumed by the retriever so rejected material stops surfacing
 * in future turns.
 *
 * Persisted in SQLite via the shared memory.db. Lazy table creation keeps
 * this outside the main memory-schema migration list so the feature can
 * land without bumping the versioned schema.
 */

import 'server-only';
import { getDb } from './memory-db';

let tableReady = false;
function ensureTable(): void {
  if (tableReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_down_ranks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      hint TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dr_session ON memory_down_ranks(session_key, created_at);
  `);
  tableReady = true;
}

export function addDownRank(sessionKey: string, hint: string): void {
  if (!sessionKey || !hint || hint.length < 8) return;
  ensureTable();
  const db = getDb();
  db.prepare('INSERT INTO memory_down_ranks (session_key, hint, created_at) VALUES (?, ?, ?)')
    .run(sessionKey, hint.slice(0, 4000), Date.now());
  // Cap per-session history at 100 rows so old negatives don't dominate
  // retrieval forever. We delete the oldest rows when over cap.
  const row = db.prepare('SELECT COUNT(*) as n FROM memory_down_ranks WHERE session_key = ?')
    .get(sessionKey) as { n: number };
  if (row.n > 100) {
    db.prepare(`
      DELETE FROM memory_down_ranks
      WHERE id IN (
        SELECT id FROM memory_down_ranks
        WHERE session_key = ?
        ORDER BY created_at ASC
        LIMIT ?
      )
    `).run(sessionKey, row.n - 100);
  }
}

export interface DownRank {
  hint: string;
  createdAt: number;
  tokens: string[];
}

const TOKEN_RE = /[a-z0-9_/.\-]{4,}/gi;
function tokenize(s: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of s.toLowerCase().matchAll(TOKEN_RE)) {
    const t = m[0];
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 40) break;
  }
  return out;
}

export function getRecentDownRanks(sessionKey: string, limit = 50): DownRank[] {
  if (!sessionKey) return [];
  ensureTable();
  const db = getDb();
  const rows = db.prepare(
    'SELECT hint, created_at FROM memory_down_ranks WHERE session_key = ? ORDER BY created_at DESC LIMIT ?'
  ).all(sessionKey, limit) as Array<{ hint: string; created_at: number }>;
  return rows.map(r => ({
    hint: r.hint,
    createdAt: r.created_at,
    tokens: tokenize(r.hint),
  }));
}

/**
 * Compute a multiplier to apply against a hit's score. 1.0 = no change,
 * closer to 0 = strongly down-ranked. Matching uses token-overlap ratio
 * against the hit's text — cheap, good enough.
 */
export function downRankMultiplier(text: string, downRanks: DownRank[]): number {
  if (downRanks.length === 0 || !text) return 1;
  const hitTokens = tokenize(text);
  if (hitTokens.length === 0) return 1;
  const hitSet = new Set(hitTokens);
  let worst = 1;
  for (const dr of downRanks) {
    if (dr.tokens.length === 0) continue;
    let overlap = 0;
    for (const t of dr.tokens) if (hitSet.has(t)) overlap++;
    const ratio = overlap / Math.max(8, dr.tokens.length);
    if (ratio <= 0.18) continue;
    // 0.18 → ~1.0 (untouched); 0.5+ → 0.35 (strong penalty)
    const penalty = Math.max(0.35, 1 - (ratio - 0.18) * 2.2);
    if (penalty < worst) worst = penalty;
  }
  return worst;
}

/**
 * Filter helper: drop hits whose multiplier falls below `dropBelow`.
 */
export function filterByDownRanks<T extends { excerpt?: string; summary?: string; title?: string; score: number }>(
  items: T[],
  downRanks: DownRank[],
  dropBelow = 0.4,
): T[] {
  if (downRanks.length === 0) return items;
  return items
    .map(item => {
      const text = [item.title, item.excerpt, item.summary].filter(Boolean).join('\n');
      const mult = downRankMultiplier(text, downRanks);
      return { ...item, score: item.score * mult, _drMult: mult } as T & { _drMult: number };
    })
    .filter(item => (item as any)._drMult > dropBelow);
}
