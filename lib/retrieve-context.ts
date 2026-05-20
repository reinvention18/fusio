/**
 * retrieve-context — one call, one budget, three sources.
 *
 * Replaces the three independent injection paths in /api/chat:
 *   - retrieveForPrompt (memory-retrieve.ts)      — chat-specific turns + episodes
 *   - mem/api.injectContext                       — cross-session observations
 *   - vault.searchVault                           — Obsidian notes
 *
 * Each source got its own opaque token budget before, with no awareness of
 * the others. On a long chat like Chat 11 the three together could add 20+ K
 * tokens to the input context. This wrapper shares a single budget and emits
 * one XML block, so you can tune the cap and know where it lands.
 */

import 'server-only';
import { retrieveForPrompt, type RetrievalResult } from './memory-retrieve';
import { formatRecalledContext } from './memory-format';
import { ensureChatSession, injectContext } from './mem/api';
import { searchVault, formatVaultHits, isConfigured as vaultConfigured } from './vault/service';
import { getRecentDownRanks, downRankMultiplier } from './memory-down-ranks';

export interface UnifiedRetrieveOpts {
  sessionKey: string;
  query: string;
  attachedChatIds?: string[];
  /** Total token budget across all sources. Default: 7000. */
  budgetTokens?: number;
  /** True when the chat is resumed — defer to active window, trim older. */
  resumed?: boolean;
  /** Milliseconds before we give up on any single source. Default: 500. */
  timeoutMs?: number;
}

export interface UnifiedRetrieveResult {
  block: string;
  bytes: number;
  hits: {
    turns: number;
    episodes: number;
    observations: number;
    vault: number;
  };
}

const CHARS_PER_TOKEN = 3.8;
const EMPTY: UnifiedRetrieveResult = { block: '', bytes: 0, hits: { turns: 0, episodes: 0, observations: 0, vault: 0 } };

/**
 * Fan out across the three retrievers with split budgets, then join into a
 * single XML-ish context block. Budget is enforced per-source so an overly
 * eager observation layer can't starve vault or turns.
 */
export async function retrieveCombined(opts: UnifiedRetrieveOpts): Promise<UnifiedRetrieveResult> {
  const query = (opts.query || '').trim();
  if (!query || query.length < 3) return EMPTY;

  const total = Math.max(2000, opts.budgetTokens ?? 7000);
  // Allocation: turns 50%, observations 25%, vault 20%, episodes share turns' slice.
  const turnsBudget = Math.floor(total * 0.50);
  const obsBudget = Math.floor(total * 0.25);
  const vaultBudget = Math.floor(total * 0.20);

  const turnsP = safe(
    retrieveForPrompt(opts.sessionKey, query, {
      attachedChatIds: opts.attachedChatIds ?? [],
      budgetTokens: turnsBudget,
      ceilingTokens: Math.min(total, turnsBudget * 2),
      timeoutMs: opts.timeoutMs ?? 500,
      ...(opts.resumed ? { excludeRecent: true, minAgeSec: 3600 } : {}),
    }),
    null as RetrievalResult | null,
  );

  const obsP = safe((async () => {
    try {
      const s = ensureChatSession(opts.sessionKey);
      return await injectContext({ sessionId: s.id, query, maxObservations: 8, maxTokens: obsBudget });
    } catch {
      return null;
    }
  })(), null as { block: string; observationCount: number } | null);

  const vaultP = safe(Promise.resolve().then(() => {
    if (!vaultConfigured()) return null;
    const hits = searchVault(query, { limit: 12 });
    if (hits.length === 0) return null;
    const block = formatVaultHits(hits, Math.floor(vaultBudget * CHARS_PER_TOKEN));
    return { block, count: hits.length };
  }), null as { block: string; count: number } | null);

  const [turns, obs, vault] = await Promise.all([turnsP, obsP, vaultP]);

  // Apply user-provided down-rank signals against each source. Hits that
  // heavily overlap with previously-rejected material are dropped; weaker
  // matches get their scores reduced so lower-priority items from other
  // sources can take their place.
  const downRanks = getRecentDownRanks(opts.sessionKey, 50);

  const parts: string[] = [];
  let turnCount = 0;
  let episodeCount = 0;
  let obsCount = 0;
  let vaultCount = 0;

  if (turns && (turns.turns.length + turns.episodes.length) > 0) {
    if (downRanks.length > 0) {
      turns.turns = turns.turns
        .map(t => ({ ...t, _m: downRankMultiplier(t.excerpt || '', downRanks) }))
        .filter((t: any) => t._m > 0.4)
        .map((t: any) => ({ ...t, score: t.score * t._m })) as any;
      turns.episodes = turns.episodes
        .map(e => ({ ...e, _m: downRankMultiplier(`${e.title}\n${e.summary}`, downRanks) }))
        .filter((e: any) => e._m > 0.4)
        .map((e: any) => ({ ...e, score: e.score * e._m })) as any;
    }
    if (turns.turns.length + turns.episodes.length > 0) {
      parts.push(formatRecalledContext(turns, { supplementary: !!opts.resumed }));
    }
    turnCount = turns.turns.length;
    episodeCount = turns.episodes.length;
  }
  if (obs && obs.block) {
    // Block-level down-rank: if the whole observation bundle strongly
    // overlaps with a rejected approach, skip it rather than polluting the
    // context. Finer-grained filtering inside the XML would require re-
    // parsing; not worth the code for marginal recall.
    const mult = downRanks.length > 0 ? downRankMultiplier(obs.block, downRanks) : 1;
    if (mult > 0.5) {
      parts.push(obs.block);
      obsCount = obs.observationCount;
    }
  }
  if (vault && vault.block) {
    const mult = downRanks.length > 0 ? downRankMultiplier(vault.block, downRanks) : 1;
    if (mult > 0.5) {
      parts.push(vault.block);
      vaultCount = vault.count;
    }
  }

  const block = parts.filter(Boolean).join('\n\n');
  return {
    block,
    bytes: block.length,
    hits: { turns: turnCount, episodes: episodeCount, observations: obsCount, vault: vaultCount },
  };
}

async function safe<T, D>(p: Promise<T>, fallback: D): Promise<T | D> {
  try { return await p; } catch { return fallback; }
}
