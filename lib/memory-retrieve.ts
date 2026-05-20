import 'server-only';
import { getDb } from './memory-db';
import { embedText, bufferToVector, cosineSim } from './memory-embed';

export interface RetrievedTurn {
  chatId: string;
  turnIndex: number;
  tsStart: number;
  source: string;
  excerpt: string;
  truncated: boolean;
  score: number;
  tokens: number;
}

export interface RetrievedEpisode {
  chatId: string;
  startTurn: number;
  endTurn: number;
  tsStart: number;
  source: string;
  title: string;
  summary: string;
  score: number;
  tokens: number;
}

export interface RetrievalResult {
  mode: 'semantic' | 'temporal' | 'empty';
  turns: RetrievedTurn[];
  episodes: RetrievedEpisode[];
  totalTokens: number;
  query: string;
}

export interface RetrieveOpts {
  attachedChatIds?: string[];
  k?: number;
  budgetTokens?: number;
  ceilingTokens?: number;
  timeoutMs?: number;
  /** When true, skip turns newer than minAgeSec (default 1 hour) to avoid
   *  duplicating context the --resume window already provides. */
  excludeRecent?: boolean;
  /** Minimum age in seconds for turns to be eligible (default 3600 = 1 hour). */
  minAgeSec?: number;
}

export interface ChatStats {
  chatId: string;
  turnCount: number;
  episodeCount: number;
  lastIndexedTurn: number;
  lastEpisodeEndTurn: number;
  lastError: string | null;
  lastRunAt: number | null;
  jsonlBytes: number | null;
  dbBytes: number;
  disabled: boolean;
}

const TEMPORAL_RE = /\b(continue|continuing|pick(ed)?\s+up|where\s+we\s+left\s+off|last\s+(time|week|night|session)|yesterday|earlier|previously|resume)\b/i;

// Rough chars-per-token multiplier used for budgeting truncation.
const CHARS_PER_TOKEN = 3.8;
const MAX_TRUNCATED_TOKENS = 2000;

function buildMatchQuery(q: string): string {
  const tokens = q.match(/[\w./\-]{3,}/g) ?? [];
  if (tokens.length === 0) return '';
  return tokens
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' OR ');
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function toIso(ts: number): string {
  try {
    return new Date(ts).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function turnSource(chatId: string, turnIndex: number, tsStart: number): string {
  return `chat:${chatId}#turn-${turnIndex} @ ${toIso(tsStart)}`;
}

function episodeSource(chatId: string, startTurn: number, endTurn: number, tsStart: number): string {
  return `chat:${chatId}#episode-turns-${startTurn}-${endTurn} @ ${toIso(tsStart)}`;
}

function filterDisabled(db: ReturnType<typeof getDb>, chatIds: string[]): string[] {
  if (chatIds.length === 0) return [];
  const placeholders = chatIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT chat_id, disabled FROM index_state WHERE chat_id IN (${placeholders})`)
    .all(...chatIds) as Array<{ chat_id: string; disabled: number }>;
  const disabled = new Set(rows.filter((r) => r.disabled === 1).map((r) => r.chat_id));
  return chatIds.filter((id) => !disabled.has(id));
}

function isChatDisabled(db: ReturnType<typeof getDb>, chatId: string): boolean {
  const row = db
    .prepare('SELECT disabled FROM index_state WHERE chat_id = ?')
    .get(chatId) as { disabled?: number } | undefined;
  return row?.disabled === 1;
}

function truncateExcerpt(text: string): { excerpt: string; truncated: boolean } {
  const maxChars = Math.floor(MAX_TRUNCATED_TOKENS * CHARS_PER_TOKEN);
  if (text.length <= maxChars) return { excerpt: text, truncated: false };
  return { excerpt: text.slice(0, maxChars), truncated: true };
}

interface RawTurnRow {
  id: number;
  chat_id: string;
  turn_index: number;
  ts_start: number;
  user_text: string | null;
  assistant_text: string | null;
  tool_summary: string | null;
  content_text: string | null;
  token_count: number | null;
  raw_score: number;
}

interface RawEpisodeRow {
  id: number;
  chat_id: string;
  start_turn: number;
  end_turn: number;
  ts_start: number;
  title: string | null;
  summary: string | null;
  raw_score: number;
}

function normalizeBm25(raw: number): number {
  return 1 / (1 + Math.abs(raw));
}

function applyRecency(tsStart: number, normalized: number): number {
  const ageDays = (Date.now() - tsStart) / 86_400_000;
  const recency = Math.exp(-Math.max(0, ageDays) / 30);
  return normalized * (1 + 0.3 * recency);
}

function runTemporal(
  db: ReturnType<typeof getDb>,
  chatIds: string[],
  query: string,
): RetrievalResult {
  if (chatIds.length === 0) {
    return { mode: 'temporal', turns: [], episodes: [], totalTokens: 0, query };
  }
  const placeholders = chatIds.map(() => '?').join(',');

  // Last 2 episodes per chat, union'd, then take top 4 by ts_start DESC.
  const episodeRows: RawEpisodeRow[] = [];
  for (const cid of chatIds) {
    const rows = db
      .prepare(
        `SELECT id, chat_id, start_turn, end_turn, ts_start, title, summary, 0 AS raw_score
         FROM episodes WHERE chat_id = ? ORDER BY ts_start DESC LIMIT 2`,
      )
      .all(cid) as RawEpisodeRow[];
    episodeRows.push(...rows);
  }
  episodeRows.sort((a, b) => b.ts_start - a.ts_start);
  const topEpisodes = episodeRows.slice(0, 4);

  const turnRows = db
    .prepare(
      `SELECT id, chat_id, turn_index, ts_start, user_text, assistant_text, tool_summary,
              content_text, token_count, 0 AS raw_score
       FROM turns WHERE chat_id IN (${placeholders})
       ORDER BY ts_start DESC LIMIT 6`,
    )
    .all(...chatIds) as RawTurnRow[];

  const turns: RetrievedTurn[] = turnRows.map((r) => {
    const contentText = r.content_text ?? '';
    const { excerpt, truncated } = truncateExcerpt(contentText);
    return {
      chatId: r.chat_id,
      turnIndex: r.turn_index,
      tsStart: r.ts_start,
      source: turnSource(r.chat_id, r.turn_index, r.ts_start),
      excerpt,
      truncated,
      score: 1,
      tokens: r.token_count ?? estimateTokens(excerpt),
    };
  });

  const episodes: RetrievedEpisode[] = topEpisodes.map((e) => {
    const title = e.title ?? '';
    const summary = e.summary ?? '';
    return {
      chatId: e.chat_id,
      startTurn: e.start_turn,
      endTurn: e.end_turn,
      tsStart: e.ts_start,
      source: episodeSource(e.chat_id, e.start_turn, e.end_turn, e.ts_start),
      title,
      summary,
      score: 1,
      tokens: estimateTokens(title + ' ' + summary),
    };
  });

  const totalTokens = turns.reduce((a, t) => a + t.tokens, 0) + episodes.reduce((a, e) => a + e.tokens, 0);
  return { mode: 'temporal', turns, episodes, totalTokens, query };
}

function packByBudget(
  turns: RetrievedTurn[],
  episodes: RetrievedEpisode[],
  budgetTokens: number,
  ceilingTokens: number,
): { turns: RetrievedTurn[]; episodes: RetrievedEpisode[]; totalTokens: number } {
  // Sort turns DESC by score. Episodes always included (small).
  const sortedTurns = [...turns].sort((a, b) => b.score - a.score);
  const sortedEpisodes = [...episodes].sort((a, b) => b.score - a.score);

  const pickedTurns: RetrievedTurn[] = [];
  let used = sortedEpisodes.reduce((a, e) => a + e.tokens, 0);

  // Always include at least 2 turns, truncated to MAX_TRUNCATED_TOKENS.
  const forcedCount = Math.min(2, sortedTurns.length);
  for (let i = 0; i < forcedCount; i++) {
    const t = sortedTurns[i];
    const { excerpt, truncated } = truncateExcerpt(t.excerpt);
    const tokens = estimateTokens(excerpt);
    const forced: RetrievedTurn = { ...t, excerpt, truncated: t.truncated || truncated, tokens };
    pickedTurns.push(forced);
    used += tokens;
  }

  // Greedy pack remaining turns within budget.
  for (let i = forcedCount; i < sortedTurns.length; i++) {
    const t = sortedTurns[i];
    if (used + t.tokens > budgetTokens) continue;
    pickedTurns.push(t);
    used += t.tokens;
  }

  // Enforce hard ceiling: drop lowest scored first (from combined list).
  const combined: Array<{ kind: 'turn' | 'episode'; score: number; tokens: number; idx: number }> = [
    ...pickedTurns.map((t, idx) => ({ kind: 'turn' as const, score: t.score, tokens: t.tokens, idx })),
    ...sortedEpisodes.map((e, idx) => ({ kind: 'episode' as const, score: e.score, tokens: e.tokens, idx })),
  ];
  let total = combined.reduce((a, c) => a + c.tokens, 0);
  if (total > ceilingTokens) {
    combined.sort((a, b) => a.score - b.score); // lowest first
    while (total > ceilingTokens && combined.length > 0) {
      const dropped = combined.shift()!;
      total -= dropped.tokens;
      if (dropped.kind === 'turn') {
        pickedTurns.splice(
          pickedTurns.findIndex((t) => t.score === dropped.score && t.tokens === dropped.tokens),
          1,
        );
      } else {
        const idx = sortedEpisodes.findIndex((e) => e.score === dropped.score && e.tokens === dropped.tokens);
        if (idx >= 0) sortedEpisodes.splice(idx, 1);
      }
    }
  }

  const totalTokens =
    pickedTurns.reduce((a, t) => a + t.tokens, 0) + sortedEpisodes.reduce((a, e) => a + e.tokens, 0);
  return { turns: pickedTurns, episodes: sortedEpisodes, totalTokens };
}

export function retrieve(chatId: string, query: string, opts?: RetrieveOpts): RetrievalResult {
  const emptyResult = (q: string, mode: 'empty' = 'empty'): RetrievalResult => ({
    mode,
    turns: [],
    episodes: [],
    totalTokens: 0,
    query: q,
  });

  try {
    const db = getDb();

    // Early return if primary chat disabled.
    if (isChatDisabled(db, chatId)) {
      return emptyResult(query);
    }

    const attached = opts?.attachedChatIds ?? [];
    const rawChatIds = [chatId, ...attached];
    const chatIds = filterDisabled(db, rawChatIds);
    if (chatIds.length === 0) {
      return emptyResult(query);
    }

    // Temporal short-circuit.
    if (TEMPORAL_RE.test(query)) {
      return runTemporal(db, chatIds, query);
    }

    const matchQuery = buildMatchQuery(query);
    if (matchQuery === '') {
      return emptyResult(matchQuery);
    }

    const k = opts?.k ?? 15;
    const budgetTokens = opts?.budgetTokens ?? 8192;
    const ceilingTokens = opts?.ceilingTokens ?? 16384;

    const placeholders = chatIds.map(() => '?').join(',');

    // When excludeRecent is set, skip turns newer than minAgeSec to avoid
    // duplicating what the --resume context window already provides.
    const minAgeMs = opts?.excludeRecent
      ? (opts?.minAgeSec ?? 3600) * 1000
      : 0;
    const cutoffTs = minAgeMs > 0 ? Date.now() - minAgeMs : Number.MAX_SAFE_INTEGER;
    const ageFilter = minAgeMs > 0 ? ' AND t.ts_start < ?' : '';

    const turnSql = `
      SELECT
        t.id, t.chat_id, t.turn_index, t.ts_start, t.user_text, t.assistant_text,
        t.tool_summary, t.content_text, t.token_count,
        bm25(turns_fts) AS raw_score
      FROM turns_fts
      JOIN turns t ON t.id = turns_fts.rowid
      WHERE turns_fts MATCH ? AND t.chat_id IN (${placeholders})${ageFilter}
      ORDER BY raw_score
      LIMIT ?`;
    const turnParams = minAgeMs > 0
      ? [matchQuery, ...chatIds, cutoffTs, k]
      : [matchQuery, ...chatIds, k];
    const turnRows = db.prepare(turnSql).all(...turnParams) as RawTurnRow[];

    const episodeSql = `
      SELECT
        e.id, e.chat_id, e.start_turn, e.end_turn, e.ts_start, e.title, e.summary,
        bm25(episodes_fts) AS raw_score
      FROM episodes_fts
      JOIN episodes e ON e.id = episodes_fts.rowid
      WHERE episodes_fts MATCH ? AND e.chat_id IN (${placeholders})
      ORDER BY raw_score
      LIMIT 5`;
    const episodeRows = db.prepare(episodeSql).all(matchQuery, ...chatIds) as RawEpisodeRow[];

    const turns: RetrievedTurn[] = turnRows.map((r) => {
      const normalized = normalizeBm25(r.raw_score);
      const finalScore = applyRecency(r.ts_start, normalized);
      const contentText = r.content_text ?? '';
      const { excerpt, truncated } = truncateExcerpt(contentText);
      return {
        chatId: r.chat_id,
        turnIndex: r.turn_index,
        tsStart: r.ts_start,
        source: turnSource(r.chat_id, r.turn_index, r.ts_start),
        excerpt,
        truncated,
        score: finalScore,
        tokens: r.token_count ?? estimateTokens(excerpt),
      };
    });

    const episodes: RetrievedEpisode[] = episodeRows.map((e) => {
      const normalized = normalizeBm25(e.raw_score);
      const finalScore = applyRecency(e.ts_start, normalized);
      const title = e.title ?? '';
      const summary = e.summary ?? '';
      return {
        chatId: e.chat_id,
        startTurn: e.start_turn,
        endTurn: e.end_turn,
        tsStart: e.ts_start,
        source: episodeSource(e.chat_id, e.start_turn, e.end_turn, e.ts_start),
        title,
        summary,
        score: finalScore,
        tokens: estimateTokens(title + ' ' + summary),
      };
    });

    const packed = packByBudget(turns, episodes, budgetTokens, ceilingTokens);

    return {
      mode: 'semantic',
      turns: packed.turns,
      episodes: packed.episodes,
      totalTokens: packed.totalTokens,
      query: matchQuery,
    };
  } catch {
    return emptyResult(query);
  }
}

export async function retrieveHybrid(
  chatId: string,
  query: string,
  opts?: RetrieveOpts,
): Promise<RetrievalResult> {
  // 1. BM25 baseline (sync, fast)
  const bm25 = retrieve(chatId, query, opts);
  if (bm25.mode !== 'semantic') return bm25;

  // 2. Embed the query
  let qVec: Float32Array;
  try {
    qVec = await embedText(query);
  } catch {
    return bm25; // embedder failed → fall back to BM25 only
  }

  try {
    // 3. Vector search across chat ids (current + attached)
    const db = getDb();
    const rawChatIds = [chatId, ...(opts?.attachedChatIds ?? [])];
    const chatIds = filterDisabled(db, rawChatIds);
    if (chatIds.length === 0) return bm25;
    const placeholders = chatIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id, chat_id, turn_index, ts_start, content_text, token_count, embedding
         FROM turns WHERE chat_id IN (${placeholders}) AND embedding IS NOT NULL`,
      )
      .all(...chatIds) as Array<{
        id: number;
        chat_id: string;
        turn_index: number;
        ts_start: number;
        content_text: string | null;
        token_count: number | null;
        embedding: Buffer;
      }>;

    const scored: Array<{ id: number; score: number; row: typeof rows[number] }> = [];
    for (const r of rows) {
      try {
        const v = bufferToVector(r.embedding);
        scored.push({ id: r.id, score: cosineSim(qVec, v), row: r });
      } catch {
        // ignore bad embedding
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const topVec = scored.slice(0, 50);

    // 4. RRF merge (k = 60 standard)
    const RRF_K = 60;
    interface MergedEntry {
      rrf: number;
      turnRef: { chatId: string; turnIndex: number; tsStart: number; contentText: string; tokenCount: number | null };
      bm25Rank: number;
      vecRank: number;
    }
    const ranks = new Map<number, MergedEntry>();

    // Map BM25 turns → db id via lookup
    bm25.turns.forEach((t, idx) => {
      const idRow = db
        .prepare('SELECT id, content_text, token_count FROM turns WHERE chat_id = ? AND turn_index = ?')
        .get(t.chatId, t.turnIndex) as { id: number; content_text: string | null; token_count: number | null } | undefined;
      if (!idRow) return;
      ranks.set(idRow.id, {
        rrf: 1 / (RRF_K + idx + 1),
        turnRef: {
          chatId: t.chatId,
          turnIndex: t.turnIndex,
          tsStart: t.tsStart,
          contentText: idRow.content_text ?? t.excerpt,
          tokenCount: idRow.token_count,
        },
        bm25Rank: idx + 1,
        vecRank: -1,
      });
    });

    topVec.forEach((v, idx) => {
      const existing = ranks.get(v.id);
      if (existing) {
        existing.rrf += 1 / (RRF_K + idx + 1);
        existing.vecRank = idx + 1;
      } else {
        ranks.set(v.id, {
          rrf: 1 / (RRF_K + idx + 1),
          turnRef: {
            chatId: v.row.chat_id,
            turnIndex: v.row.turn_index,
            tsStart: v.row.ts_start,
            contentText: v.row.content_text ?? '',
            tokenCount: v.row.token_count,
          },
          bm25Rank: -1,
          vecRank: idx + 1,
        });
      }
    });

    // 5. Sort merged by RRF score (with recency), take top K
    const k = opts?.k ?? 15;
    const merged = Array.from(ranks.values())
      .map((e) => {
        const ageDays = (Date.now() - e.turnRef.tsStart) / 86_400_000;
        const recency = Math.exp(-Math.max(0, ageDays) / 30);
        const finalScore = e.rrf * (1 + 0.3 * recency);
        return { ...e, finalScore };
      })
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, k);

    // 6. Build RetrievedTurn objects
    const hybridTurns: RetrievedTurn[] = merged.map((m) => {
      const contentText = m.turnRef.contentText || '';
      const { excerpt, truncated } = truncateExcerpt(contentText);
      return {
        chatId: m.turnRef.chatId,
        turnIndex: m.turnRef.turnIndex,
        tsStart: m.turnRef.tsStart,
        source: turnSource(m.turnRef.chatId, m.turnRef.turnIndex, m.turnRef.tsStart),
        excerpt,
        truncated,
        score: m.finalScore,
        tokens: m.turnRef.tokenCount ?? estimateTokens(excerpt),
      };
    });

    // Reuse budget packer from BM25 path; keep BM25 episodes (cheap and complementary)
    const budgetTokens = opts?.budgetTokens ?? 8192;
    const ceilingTokens = opts?.ceilingTokens ?? 16384;
    const packed = packByBudget(hybridTurns, bm25.episodes, budgetTokens, ceilingTokens);

    return {
      mode: 'semantic',
      turns: packed.turns,
      episodes: packed.episodes,
      totalTokens: packed.totalTokens,
      query: bm25.query,
    };
  } catch {
    return bm25;
  }
}

export function retrieveForPrompt(
  chatId: string,
  query: string,
  opts?: RetrieveOpts,
): Promise<RetrievalResult> {
  const timeout = opts?.timeoutMs ?? 500;
  return new Promise<RetrievalResult>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      // On timeout, attempt synchronous BM25 fallback so we don't lose all context
      try {
        const fallback = retrieve(chatId, query, opts);
        resolve(fallback);
      } catch {
        resolve({ mode: 'empty', turns: [], episodes: [], totalTokens: 0, query });
      }
    }, timeout);
    retrieveHybrid(chatId, query, opts)
      .then((result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          resolve(retrieve(chatId, query, opts));
        } catch {
          resolve({ mode: 'empty', turns: [], episodes: [], totalTokens: 0, query });
        }
      });
  });
}

export function getStats(chatId: string): ChatStats {
  const db = getDb();
  const turnCount = (
    db.prepare('SELECT COUNT(*) AS n FROM turns WHERE chat_id = ?').get(chatId) as { n: number }
  ).n;
  const episodeCount = (
    db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE chat_id = ?').get(chatId) as { n: number }
  ).n;
  const stateRow = db
    .prepare('SELECT * FROM index_state WHERE chat_id = ?')
    .get(chatId) as
    | {
        chat_id: string;
        claude_session_id?: string | null;
        last_indexed_turn?: number | null;
        last_episode_end_turn?: number | null;
        last_error?: string | null;
        last_run_at?: number | null;
        disabled?: number | null;
      }
    | undefined;
  const dbBytes = (
    db
      .prepare('SELECT COALESCE(SUM(LENGTH(content_text)), 0) AS n FROM turns WHERE chat_id = ?')
      .get(chatId) as { n: number }
  ).n;

  let jsonlBytes: number | null = null;
  if (stateRow?.claude_session_id) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os');
    const root = path.join(os.homedir(), '.claude/projects');
    try {
      for (const p of fs.readdirSync(root)) {
        const f = path.join(root, p, stateRow.claude_session_id + '.jsonl');
        if (fs.existsSync(f)) {
          jsonlBytes = fs.statSync(f).size;
          break;
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    chatId,
    turnCount,
    episodeCount,
    lastIndexedTurn: stateRow?.last_indexed_turn ?? -1,
    lastEpisodeEndTurn: stateRow?.last_episode_end_turn ?? -1,
    lastError: stateRow?.last_error ?? null,
    lastRunAt: stateRow?.last_run_at ?? null,
    jsonlBytes,
    dbBytes,
    disabled: stateRow?.disabled === 1,
  };
}

export function disableChat(chatId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO index_state (chat_id, claude_session_id, disabled)
     VALUES (?, ?, 1)
     ON CONFLICT(chat_id) DO UPDATE SET disabled = 1`,
  ).run(chatId, '');
}

export function enableChat(chatId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO index_state (chat_id, claude_session_id, disabled)
     VALUES (?, ?, 0)
     ON CONFLICT(chat_id) DO UPDATE SET disabled = 0`,
  ).run(chatId, '');
}
