/**
 * mem/api — the memory facade.
 *
 * This is the thin service layer the Phase-2 design calls for:
 *   memoryService.injectContext(sessionId)
 *   memoryService.captureObservation(sessionId, toolName, input, output)
 *   memoryService.generateSummary(sessionId)
 *   memoryService.search(query, filters)
 *
 * No port 37777 worker — we reuse MC's in-process SQLite + embedding pipeline.
 */

import 'server-only';
import {
  search as obsSearch,
  timeline as obsTimeline,
  getObservation,
  createObservation,
  enqueueObservation,
  logPrompt,
  listRecentObservations,
  pendingObservationCount,
  type MemObservationType,
  type SearchHit,
  type TimelineEntry,
} from './observations';
import {
  ensureChatSession,
  ensureAgentSession,
  ensureTeamMetaSession,
  getMemSession,
  resolveSessionScope,
  touchSession,
  listSessions,
  type MemSessionRow,
} from './sessions';
import { compressPendingForSession, generateSessionSummary } from './compress';

export interface InjectContextResult {
  block: string; // XML block to splice into the prompt
  observationCount: number;
  sessionId: string;
}

/** Claude-mem-style context injection: top-N observations formatted for prompt. */
export async function injectContext(params: {
  sessionId: string;
  query?: string;
  maxObservations?: number;
  maxTokens?: number;
}): Promise<InjectContextResult> {
  const max = Math.min(Math.max(params.maxObservations ?? 8, 1), 30);
  const tokenCap = params.maxTokens ?? 3500;

  let hits: SearchHit[] = [];
  if (params.query && params.query.trim().length > 3) {
    hits = await obsSearch({
      query: params.query,
      sessionId: params.sessionId,
      limit: max,
    });
  }

  // Fall back to recent scope observations if search yields nothing.
  if (hits.length === 0) {
    const scope = resolveSessionScope(params.sessionId);
    const entries = obsTimeline({ sessionId: params.sessionId, limit: max });
    hits = entries.map(e => ({
      id: e.id,
      sessionId: e.sessionId,
      type: e.type,
      title: e.title,
      excerpt: e.summary,
      tags: [],
      score: 0.5,
      createdAt: e.createdAt,
    } as SearchHit));
    void scope;
  }

  if (hits.length === 0) {
    return { block: '', observationCount: 0, sessionId: params.sessionId };
  }

  const lines: string[] = ['<mem_observations>'];
  lines.push(`  <note>Durable learnings from this and related sessions. Call mem_get(id) to expand any observation. Call mem_search(query) for more.</note>`);
  let used = 0;
  for (const h of hits) {
    const snippet = `  <obs id="${h.id}" type="${h.type}" score="${h.score.toFixed(2)}"><title>${escapeXml(h.title)}</title><text>${escapeXml(h.excerpt)}</text></obs>`;
    used += Math.ceil(snippet.length / 3.8);
    if (used > tokenCap) break;
    lines.push(snippet);
  }
  lines.push('</mem_observations>');

  return {
    block: lines.join('\n'),
    observationCount: Math.min(hits.length, Math.floor(tokenCap / 40)),
    sessionId: params.sessionId,
  };
}

function escapeXml(s: string): string {
  return (s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Throttle for memory-write warnings — historically these caught exceptions
 *  with empty blocks, so when the SQLite path broke (corrupted db, schema drift)
 *  observations vanished silently and /api/mem/timeline slowly emptied without
 *  warning. Now we warn — but throttled, so a persistent failure doesn't spam
 *  the log on every turn. */
let lastMemWarnAt = 0;
const MEM_WARN_INTERVAL_MS = 30_000; // at most one warning per 30s
function warnMemWrite(where: string, e: unknown): void {
  const now = Date.now();
  if (now - lastMemWarnAt < MEM_WARN_INTERVAL_MS) return;
  lastMemWarnAt = now;
  const msg = e instanceof Error ? e.message : String(e);
  console.warn('[mem] write failed at %s: %s (further warnings suppressed for %ds)',
    where, msg, MEM_WARN_INTERVAL_MS / 1000);
}

/** Queue a raw tool-use / tool-result observation. Non-blocking; compressed later. */
export function captureToolUse(params: {
  sessionId: string;
  toolName: string;
  input: unknown;
}): void {
  try {
    enqueueObservation({
      sessionId: params.sessionId,
      kind: 'tool_use',
      toolName: params.toolName,
      payload: { input: params.input },
    });
  } catch (e) {
    warnMemWrite('captureToolUse', e);
  }
}

export function captureToolResult(params: {
  sessionId: string;
  toolName: string;
  output: string;
  isError?: boolean;
}): void {
  try {
    enqueueObservation({
      sessionId: params.sessionId,
      kind: 'tool_result',
      toolName: params.toolName,
      payload: { content: params.output.slice(0, 4000), is_error: !!params.isError },
    });
  } catch (e) { warnMemWrite('captureToolResult', e); }
}

export function captureUserMessage(sessionId: string, text: string): void {
  if (!text) return;
  try {
    logPrompt(sessionId, text);
    enqueueObservation({
      sessionId,
      kind: 'user',
      payload: { text: text.slice(0, 4000) },
    });
  } catch (e) { warnMemWrite('captureUserMessage', e); }
}

export function captureAssistantText(sessionId: string, text: string): void {
  if (!text) return;
  try {
    enqueueObservation({
      sessionId,
      kind: 'assistant',
      payload: { text: text.slice(0, 4000) },
    });
  } catch (e) { warnMemWrite('captureAssistantText', e); }
}

/** Write a new observation directly (bypass the queue). */
export async function putObservation(input: {
  sessionId: string;
  type: MemObservationType;
  title: string;
  content: string;
  tags?: string[];
  filesInvolved?: string[];
}) {
  return createObservation(input);
}

/** 3-layer progressive disclosure — search + timeline + get. */
export const search = obsSearch;
export const timeline = obsTimeline;
export const get = getObservation;

export {
  ensureChatSession,
  ensureAgentSession,
  ensureTeamMetaSession,
  getMemSession,
  listSessions,
  touchSession,
  listRecentObservations,
  pendingObservationCount,
  compressPendingForSession,
  generateSessionSummary,
};

export type { SearchHit, TimelineEntry, MemSessionRow, MemObservationType };
