/**
 * Claude Chat Bridge — Agent SDK version
 *
 * Uses @anthropic-ai/claude-agent-sdk instead of raw CLI spawning.
 * The SDK handles subprocess management, JSON parsing, session persistence,
 * and error recovery internally.
 *
 * Exports are backward-compatible with the old CLI-spawn bridge.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { recordStart as recordSubagentStart, recordFinish as recordSubagentFinish } from './mc-subagents-store';
import { indexChatIncremental } from './memory-indexer';
import {
  GLOBAL_WORKSPACE as SHARED_GLOBAL_WORKSPACE,
  loadSessionMap as sharedLoadSessionMap,
  saveSessionMap as sharedSaveSessionMap,
  getClaudeSessionId as sharedGetClaudeSessionId,
  setClaudeSessionId as sharedSetClaudeSessionId,
  deleteClaudeSessionId as sharedDeleteClaudeSessionId,
  loadSkillsContext as sharedLoadSkillsContext,
  getBrowserInstructions as sharedGetBrowserInstructions,
  getSubagentStrategy as sharedGetSubagentStrategy,
  isTeamSessionKey,
  isSeoSessionKey,
} from './claude-sdk-session';
import { toolStatusLabel as sharedToolStatusLabel } from './claude-sdk-render';
import { createCommanderMcpServer } from './teams/commander-tools';
import { listTeams } from './teams/schema';
import { createMemMcpServer, MEM_TOOL_NAMES } from './mem/mcp-tools';
import { createVaultMcpServer, VAULT_TOOL_NAMES } from './vault/mcp-tools';
import { createSkillsMcpServer, SKILLS_TOOL_NAMES, loadSkillsIndex, loadMatchedSkillsBundle } from './skills-mcp';
import { createAgentsMcpServer, AGENTS_TOOL_NAMES, loadAgentsIndex, loadMatchedAgentsBundle } from './agents-mcp';
import { createDesignSystemsMcpServer, DESIGN_SYSTEMS_TOOL_NAMES, loadDesignSystemsIndex, loadMatchedDesignSystemsBundle } from './design-systems-mcp';
import { createRemoteMcpServer, REMOTE_TOOL_NAMES } from './remote/mcp-tools';
import { listHosts as listRemoteHosts } from './remote/config';
import { createDocsMcpServer, DOCS_TOOL_NAMES } from './docs/mcp-tools';
import { createEditsMcpServer, EDITS_TOOL_NAMES } from './edits/mcp-tools';
import { commitAssistantMessageIfMissing } from './chat-storage';
import { bufferEdit, flushTurn } from './edit-log';
import { makeCanUseTool, cancelApprovalsForSession, type PendingApproval } from './approval-gate';
import * as broadcast from './chat-broadcast';
import { ensureChatSession, captureToolUse as memCaptureToolUse, captureToolResult as memCaptureToolResult, captureAssistantText as memCaptureAssistantText, compressPendingForSession, timeline as memTimeline } from './mem/api';

// ─── Active queries (keyed by MC sessionKey) ───────────────────────
// We store the Query object so /api/stop can call .interrupt()
const activeQueries = new Map<string, Query>();

// Graceful shutdown — when PM2 sends SIGTERM, give in-flight queries time
// to finish before the process exits. Combined with kill_timeout: 60000
// in ecosystem.config.js, this prevents the "session went stale during
// MC restart" pattern that lost Chat 20's 14-minute sub-agent fanout.
let shuttingDown = false;
// HMR-safe install — Next dev hot-reload re-executes this module on every
// server-side file change. Without the global guard, each reload added a
// fresh process.on('SIGTERM', ...) handler. Over 24h of dev work that
// accumulated 10+ listeners and triggered the MaxListenersExceededWarning
// we saw in the wedge-pattern error log. The Symbol guard idempotents the
// install across reloads in the same Node process.
const INSTALL_KEY = Symbol.for('mc.bridge.gracefulShutdownInstalled');
function installGracefulShutdown(): void {
  if ((globalThis as any)[INSTALL_KEY]) return;
  (globalThis as any)[INSTALL_KEY] = true;
  const onSignal = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const inFlight = activeQueries.size;
    console.log('[shutdown] %s received — %d in-flight queries; draining (max 50s)', signal, inFlight);
    if (inFlight === 0) {
      process.exit(0);
      return;
    }
    const deadline = Date.now() + 50_000;
    const interval = setInterval(() => {
      const remaining = activeQueries.size;
      if (remaining === 0) {
        clearInterval(interval);
        console.log('[shutdown] all queries drained, exiting cleanly');
        process.exit(0);
      } else if (Date.now() > deadline) {
        clearInterval(interval);
        console.warn('[shutdown] deadline reached with %d queries still running — exiting anyway', remaining);
        process.exit(0);
      }
    }, 500);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}
// Install once on first module load.
installGracefulShutdown();

// ─── MCP server caches ─────────────────────────────────────────────
// MCP server objects are tiny (tool descriptions + closures) and their
// underlying state lives in DB/filesystem, so it's safe to reuse them
// across turns. Previously createCommanderMcpServer/createMemMcpServer/
// createVaultMcpServer ran on every spawn — wasted CPU + listener churn.
// Cached here keyed by their scoping identity.
//
// LRU-bounded: each cache caps at MCP_CACHE_MAX entries. Without this the
// Maps grew unbounded over 12-24h (one entry per chat session ever opened
// in the lifetime of the process), each holding closures + listener refs.
// Together with the SSE-listener leak this contributed to the daily wedge.
const MCP_CACHE_MAX = 50;
let cachedVaultServer: ReturnType<typeof createVaultMcpServer> | null = null;
const cachedMemServers = new Map<string, ReturnType<typeof createMemMcpServer>>();
const cachedCommanderServers = new Map<string, ReturnType<typeof createCommanderMcpServer>>();

/** LRU touch + evict-oldest helper. Map's insertion order IS the LRU order
 *  when we delete + re-set on hit, so we lean on that instead of a separate
 *  list. Cheap. */
function lruTouch<K, V>(m: Map<K, V>, key: K): V | undefined {
  const v = m.get(key);
  if (v === undefined) return undefined;
  m.delete(key);
  m.set(key, v);
  return v;
}
function lruCap<K, V>(m: Map<K, V>, max: number): void {
  while (m.size > max) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) return;
    m.delete(oldest);
  }
}

function getVaultServer() {
  if (!cachedVaultServer) cachedVaultServer = createVaultMcpServer();
  return cachedVaultServer;
}
function getMemServer(sessionId: string, label: string) {
  const hit = lruTouch(cachedMemServers, sessionId);
  if (hit) return hit;
  const srv = createMemMcpServer({ sessionId, label });
  cachedMemServers.set(sessionId, srv);
  lruCap(cachedMemServers, MCP_CACHE_MAX);
  return srv;
}
function getCommanderServer(sessionKey: string) {
  const hit = lruTouch(cachedCommanderServers, sessionKey);
  if (hit) return hit;
  const srv = createCommanderMcpServer(sessionKey);
  cachedCommanderServers.set(sessionKey, srv);
  lruCap(cachedCommanderServers, MCP_CACHE_MAX);
  return srv;
}

// Backward compat: some consumers import activeProcesses for stop
// We'll expose a compatible interface
export const activeProcesses = new Map<string, { kill: (sig?: string) => void }>();

// ─── Session ID mapping ─────────────────────────────────────────────
// Re-exports from lib/claude-sdk-session.ts to preserve backward compat with
// existing consumers (/api/chat, /api/session-reset, etc.) after the Phase 1
// refactor. The actual implementation now lives in the shared module so the
// Phase 2 team runner can reuse it.
export const loadSessionMap = sharedLoadSessionMap;
export const saveSessionMap = sharedSaveSessionMap;
export const getClaudeSessionId = sharedGetClaudeSessionId;
export const setClaudeSessionId = sharedSetClaudeSessionId;
export const deleteClaudeSessionId = sharedDeleteClaudeSessionId;

// ─── Pending-response buffer (crash-recovery polling) ───────────────
export interface PendingResponse {
  content: string;
  done: boolean;
  error?: string;
  startedAt: number;
  updatedAt: number;
  /** Session key of the active query, if any. The stuck-recovery sweep uses
   *  this to skip buffers whose query is still alive in `activeQueries` —
   *  long tool-call pauses or model thinking shouldn't trigger a recovery
   *  that would later block the legit completion's commit (the false-recovery
   *  bug that ate Chat 20's full reply on 2026-05-04). */
  sessionKey?: string;
}

export const pendingResponses = new Map<string, PendingResponse>();

/**
 * 429 cooldown gate — when the SDK reports a rate limit for a sessionKey,
 * we mark it here for COOLDOWN_MS so /api/chat short-circuits subsequent
 * sends instead of hammering the same throttled session. Prevents the
 * "user clicks send → 429 → resends → 429" loop that was visible on Chat 19.
 *
 * Per-machine state. Anthropic's 5-hour rolling window is server-side and
 * shared across all machines using the same account, but a 60s local
 * cooldown is enough to break a tight retry loop and let the user see
 * the rate-limit banner.
 */
const RATE_LIMIT_COOLDOWN_MS = 60_000;
interface RateLimitGate {
  until: number;
  reason: string;
  hitCount: number;
  firstHitAt: number;
}
const rateLimitedSessions = new Map<string, RateLimitGate>();

export function markRateLimited(sessionKey: string, reason = '429'): void {
  if (!sessionKey) return;
  const existing = rateLimitedSessions.get(sessionKey);
  rateLimitedSessions.set(sessionKey, {
    until: Date.now() + RATE_LIMIT_COOLDOWN_MS,
    reason,
    hitCount: (existing?.hitCount || 0) + 1,
    firstHitAt: existing?.firstHitAt || Date.now(),
  });
}

export function getRateLimitGate(sessionKey: string): { active: boolean; secondsRemaining: number; hitCount: number; reason: string } {
  if (!sessionKey) return { active: false, secondsRemaining: 0, hitCount: 0, reason: '' };
  const gate = rateLimitedSessions.get(sessionKey);
  if (!gate) return { active: false, secondsRemaining: 0, hitCount: 0, reason: '' };
  const remaining = gate.until - Date.now();
  if (remaining <= 0) {
    rateLimitedSessions.delete(sessionKey);
    return { active: false, secondsRemaining: 0, hitCount: 0, reason: '' };
  }
  return {
    active: true,
    secondsRemaining: Math.ceil(remaining / 1000),
    hitCount: gate.hitCount,
    reason: gate.reason,
  };
}

export function clearRateLimitGate(sessionKey: string): void {
  rateLimitedSessions.delete(sessionKey);
}

// GC stale gate entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitedSessions) {
    if (v.until < now) rateLimitedSessions.delete(k);
  }
}, 5 * 60_000);

// ─── Disk-backed persistence for pendingResponses ───────────────────
// In-memory Map alone gets wiped on every server restart. Long tasks that
// were mid-stream when the server died used to come back as `{found:false}`
// from the GET poll, making the user think the work vanished. We now flush
// the Map to disk every 2s and rehydrate on boot, so a deploy or crash
// during a long task is recoverable.
const PENDING_DIR = path.join(process.cwd(), 'data', 'pending');
const PENDING_TTL_MS = 60 * 60 * 1000; // 1h — same as the in-memory cleanup

function ensurePendingDir() {
  if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
}

export function loadPendingFromDisk(requestId: string): PendingResponse | undefined {
  try {
    const raw = fs.readFileSync(path.join(PENDING_DIR, `${requestId}.json`), 'utf-8');
    const v = JSON.parse(raw) as PendingResponse;
    // Ignore disk entries past TTL
    if (Date.now() - v.updatedAt > PENDING_TTL_MS) return undefined;
    return v;
  } catch { return undefined; }
}

// Hydrate from disk on module init so a server restart doesn't lose
// in-flight responses the client is still polling for.
try {
  if (fs.existsSync(PENDING_DIR)) {
    for (const f of fs.readdirSync(PENDING_DIR)) {
      if (!f.endsWith('.json')) continue;
      const rid = f.slice(0, -5);
      const v = loadPendingFromDisk(rid);
      if (v) pendingResponses.set(rid, v);
    }
    console.log(`[pending] Hydrated ${pendingResponses.size} responses from disk`);
  }
} catch (e) {
  console.warn('[pending] Hydrate failed:', (e as Error).message);
}

// Flush the entire Map to disk every 2s. With ~5 active requests at most,
// this is a handful of tiny writes per second — negligible IO.
setInterval(() => {
  if (pendingResponses.size === 0) return;
  try {
    ensurePendingDir();
    for (const [rid, v] of pendingResponses) {
      try {
        fs.writeFileSync(path.join(PENDING_DIR, `${rid}.json`), JSON.stringify(v));
      } catch {}
    }
  } catch {}
}, 2_000);

// Cleanup stale entries every 5 min — drop from memory AND disk
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingResponses) {
    if (now - val.updatedAt > PENDING_TTL_MS) {
      pendingResponses.delete(key);
      try { fs.unlinkSync(path.join(PENDING_DIR, `${key}.json`)); } catch {}
    }
  }
  // Also sweep orphan files on disk (e.g. from a crash before in-memory cleanup)
  try {
    if (!fs.existsSync(PENDING_DIR)) return;
    for (const f of fs.readdirSync(PENDING_DIR)) {
      const fp = path.join(PENDING_DIR, f);
      try {
        const st = fs.statSync(fp);
        if (now - st.mtimeMs > PENDING_TTL_MS) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}
}, 300_000);

// ─── Stuck-turn recovery sweep ──────────────────────────────────────
// When a turn dies mid-stream (orphan kill, server crash, SDK timeout) the
// assistant content lives in `data/pending/req-<chatId>-<ts>.json` with
// `done: false` and never commits to the chat file. Without this sweep the
// user has to ask for it back manually (we did this for Chat 20 on 2026-05-04
// after killing two day-old orphan claude.exe processes).
//
// Every minute, walk pending entries. For any that's been silent for the
// recovery threshold AND has no still-active SDK query, commit it as a
// banner-prefixed assistant message and mark `done: true`.
//
// HARD-LEARNED: a 5-minute threshold was too aggressive. On 2026-05-04 a
// chat 20 turn paused 5+ minutes mid-stream (model thinking + tool-call
// chain), the sweep grabbed a 2k-char partial as "recovered", then when the
// real 10k-char completion fired the dedupe in `commitAssistantMessageIfMissing`
// rejected it because a stub was already in the chat. Net effect: user got
// a truncated reply and lost 8k chars of content. Now:
//   1. Threshold raised to 20 min — long tool chains finish in under 20 min;
//      anything past that is genuinely dead.
//   2. Skip if the buffer's sessionKey is still in activeQueries — a live
//      query means the SDK is still working on this turn, recovery would
//      race the legit completion.
const STUCK_RECOVERY_MIN_AGE_MS = 20 * 60_000;
const STUCK_RECOVERY_MIN_CONTENT_CHARS = 100;
const REQ_ID_RE = /^req-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-\d+$/i;

function buildRecoveryBanner(originalLen: number): string {
  return `[recovered partial reply | turn was interrupted before completion | original ${originalLen} chars]\n\n---\n\n`;
}

function recoverStuckPending(): void {
  const now = Date.now();
  let recovered = 0;
  for (const [requestId, val] of pendingResponses) {
    if (val.done) continue;
    if (now - val.updatedAt < STUCK_RECOVERY_MIN_AGE_MS) continue;
    // Don't ambush an actively-streaming turn. If its sessionKey is still
    // tracked in activeQueries the SDK hasn't given up; let it finish (or
    // until the next sweep, if it really is stuck and the query gets cleaned
    // up by error handlers).
    if (val.sessionKey && activeQueries.has(val.sessionKey)) continue;
    const content = (val.content || '').trim();
    if (content.length < STUCK_RECOVERY_MIN_CONTENT_CHARS) continue;
    const m = REQ_ID_RE.exec(requestId);
    if (!m) continue;
    const chatId = m[1];

    // SAFETY: if the chat file mtime is newer than this pending buffer
    // started, the user has explicitly touched the chat after the turn
    // began (edited, deleted a message, etc). DON'T resurrect content
    // they might have intentionally deleted. Drop the buffer instead.
    try {
      const chatFile = path.join(process.cwd(), 'data', 'chats', `${chatId}.json`);
      if (fs.existsSync(chatFile)) {
        const stat = fs.statSync(chatFile);
        if (stat.mtimeMs > val.startedAt + 1000) {
          // User edited/saved the chat after the turn started — treat their
          // version as authoritative. Drop the buffer.
          val.done = true;
          val.updatedAt = now;
          try { fs.unlinkSync(path.join(PENDING_DIR, `${requestId}.json`)); } catch {}
          pendingResponses.delete(requestId);
          continue;
        }
      } else {
        // Chat file doesn't exist — user deleted the whole chat OR it was
        // a server-only session (test, probe, etc) that never had a real
        // chat record. Either way, don't materialize a "Chat (recovered …)".
        try { fs.unlinkSync(path.join(PENDING_DIR, `${requestId}.json`)); } catch {}
        pendingResponses.delete(requestId);
        continue;
      }
    } catch { /* fall through to normal recovery */ }

    const body =
      buildRecoveryBanner(content.length) +
      content +
      `\n\n---\n[end of recovered content — turn did not finish, content beyond this point is lost]`;
    try {
      const r = commitAssistantMessageIfMissing({
        chatId,
        content: body,
        messageId: `recovered-${requestId.split('-').pop()}`,
      });
      // Mark as done either way so we don't loop on entries that the dedupe
      // helper rejects (already-committed by client, etc).
      val.done = true;
      val.updatedAt = now;
      try { fs.writeFileSync(path.join(PENDING_DIR, `${requestId}.json`), JSON.stringify(val)); } catch {}
      if (r.appended) {
        recovered++;
        console.log('[stuck-recovery] committed chat=%s chars=%d (silent for %ds)',
          chatId, content.length, Math.round((now - val.updatedAt + STUCK_RECOVERY_MIN_AGE_MS) / 1000));
      }
    } catch (e: any) {
      console.warn('[stuck-recovery] commit failed for %s: %s', requestId, e?.message);
    }
  }
  if (recovered > 0) console.log('[stuck-recovery] recovered %d stuck turn(s)', recovered);
}

setInterval(recoverStuckPending, 60_000);
// Also run once on module init so a server restart immediately recovers any
// pending buffers from chats that were interrupted by the restart itself.
setTimeout(recoverStuckPending, 10_000);

// ─── SSE helpers ────────────────────────────────────────────────────
export function sseChunk(content: string, id?: string): string {
  return `data: ${JSON.stringify({
    id: id || `cc-${Date.now()}`,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

export function sseStatus(status: string): string {
  return `data: ${JSON.stringify({ type: 'status', status })}\n\n`;
}

export function sseDone(): string {
  return 'data: [DONE]\n\n';
}

// ─── Constants ──────────────────────────────────────────────────────
// Re-exported from lib/claude-sdk-session.ts so team runner and chat share.
export const GLOBAL_WORKSPACE = SHARED_GLOBAL_WORKSPACE;

// ─── Shared spawn helper ────────────────────────────────────────────
export interface SpawnClaudeOptions {
  prompt: string;
  /** Full-history-seeded prompt used on stale-session retry. When the Agent
   *  SDK reports the resumed session no longer exists, the retry fires a
   *  fresh session with this richer prompt so context isn't lost. */
  freshFallbackPrompt?: string;
  sessionKey?: string;
  workspace?: string;
  model?: string;
  permissionMode?: string;
  requestId?: string;
  /** Chat id used for cross-device broadcast. Every event this stream
   *  emits is also fan-out to listeners on /api/chat/listen?chatId=X so
   *  other tabs/devices viewing the same chat see the reply live. */
  chatId?: string;
  /** Browser identity of the initiator. The broadcast layer suppresses
   *  re-sending content events back to this client so it doesn't double
   *  render its own stream. */
  clientId?: string;
}

export interface SpawnClaudeResult {
  stream: ReadableStream;
  process: { kill: (sig?: string) => void };
}

// Skills now use lazy-load MCP tools (mc_list_skills / mc_load_skill) — the
// system-prompt appendix ships only a one-line index per skill. This replaces
// the ~30 KB dump that loadSkillsContext() used to produce.
const loadSkillsContext = loadSkillsIndex;
// Preserve reference so unused-import checks don't bite (shared version is
// still exported for backwards compat with other callers).
void sharedLoadSkillsContext;
const getBrowserInstructions = sharedGetBrowserInstructions;
const toolStatusLabel = sharedToolStatusLabel;

/**
 * Spawn a Claude Agent SDK query and return an SSE ReadableStream.
 * Backward-compatible with the old CLI-spawn interface.
 */
export function spawnClaudeStream(opts: SpawnClaudeOptions): SpawnClaudeResult {
  const { sessionKey, workspace, model, permissionMode, requestId } = opts;

  // Per-turn skill auto-loader. Match the user's prompt text against
  // SKILL_TRIGGERS (see skills-mcp.ts) and inline the full SKILL.md body of
  // any matched skills. Works for both new and resumed sessions — the
  // system-prompt appendix only fires on session start, so we have to
  // attach matched skills to the prompt text itself for them to take
  // effect on every turn. Bounded at ~6KB per turn so token cost stays
  // predictable. Matching is regex-based against the FULL prompt (which
  // ends in the user's last message); a few stray matches against
  // chat-history context is acceptable noise.
  let prompt = opts.prompt;
  // Per-turn diagnostic so we can prove auto-loading is reaching the actual
  // chat path (not just the standalone probe). Keep it cheap — one log per
  // turn with name lists + byte counts.
  const _dbg = { skills: [] as string[], agents: [] as string[], design: [] as string[], skillsBytes: 0, agentsBytes: 0, designBytes: 0, memBytes: 0, memCount: 0 };
  try {
    const matched = loadMatchedSkillsBundle(prompt);
    if (matched) { prompt = prompt + matched; _dbg.skillsBytes = matched.length; }
  } catch { /* skill matching is best-effort; never block a turn */ }
  // Same pattern for agent personas — when the user's message smells like
  // a specialist task (security review, architecture, perf, db, etc.),
  // inline the matching persona body. The main agent can then call the
  // Task tool with that body as the prompt to spawn the specialist.
  try {
    const agentBundle = loadMatchedAgentsBundle(prompt);
    if (agentBundle) { prompt = prompt + agentBundle; _dbg.agentsBytes = agentBundle.length; }
  } catch { /* agent matching is best-effort */ }
  // Same pattern for brand design systems — when the user names a brand
  // ("design like Stripe", "Apple-style settings"), inline that brand's
  // DESIGN.md (trimmed) so the agent has the visual grammar in-context
  // without an extra mc_load_design_system round-trip.
  try {
    const dsBundle = loadMatchedDesignSystemsBundle(prompt);
    if (dsBundle) { prompt = prompt + dsBundle; _dbg.designBytes = dsBundle.length; }
  } catch { /* design-system matching is best-effort */ }
  // Per-turn memory injection. Historically the bridge captured observations
  // every turn (writes) but never injected them back (reads). The agent had to
  // call mc_mem_search itself — which it didn't always do — so past-session
  // context was effectively invisible. Now we surface the most recent
  // observations from this session inline. Bounded at ~2.5KB so token cost
  // stays predictable; the agent can still call mem_search/mem_get for deeper
  // history. Uses sync timeline (not semantic search) because spawnClaudeStream
  // is sync; semantic search needs an async refactor we'll do later.
  if (sessionKey) {
    try {
      const memSession = ensureChatSession(sessionKey);
      const entries = memTimeline({ sessionId: memSession.id, limit: 8 });
      if (entries && entries.length > 0) {
        const escapeXml = (s: string) =>
          (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const lines = ['<mem_observations>'];
        lines.push('  <note>Recent observations from this chat session. Call mc_mem_search(query) for semantic search across all sessions, or mc_mem_observations for the full session timeline.</note>');
        let used = 0;
        const TOKEN_CAP = 2500;
        for (const e of entries) {
          const snippet = `  <obs id="${e.id}" type="${e.type}"><title>${escapeXml(e.title || '')}</title><text>${escapeXml(e.summary || '')}</text></obs>`;
          used += Math.ceil(snippet.length / 3.8);
          if (used > TOKEN_CAP) break;
          lines.push(snippet);
        }
        lines.push('</mem_observations>');
        const block = lines.join('\n');
        prompt = prompt + '\n\n' + block;
        _dbg.memBytes = block.length;
        _dbg.memCount = entries.length;
      }
    } catch (e: any) {
      // Surface failures — historically these were silent (empty catch) and
      // memory broke without warning. One warn per turn is acceptable noise.
      console.warn('[chat-autoload] mem injection failed sessionKey=%s err=%s',
        sessionKey?.slice(0, 16), e?.message ?? String(e));
    }
  }
  // One log line per turn so we can grep the live chat to confirm auto-load
  // is actually firing on real user messages (not just the standalone probe).
  if (_dbg.skillsBytes || _dbg.agentsBytes || _dbg.designBytes || _dbg.memBytes) {
    try {
      // Re-derive name lists for the log without re-loading bodies.
      const { matchSkillsForText } = require('./skills-mcp');
      const { matchAgentsForText } = require('./agents-mcp');
      const { matchDesignSystemsForText } = require('./design-systems-mcp');
      _dbg.skills = matchSkillsForText(opts.prompt);
      _dbg.agents = matchAgentsForText(opts.prompt);
      _dbg.design = matchDesignSystemsForText(opts.prompt);
      console.log('[chat-autoload] skills=[%s] agents=[%s] design=[%s] bytes=skills:%d/agents:%d/design:%d/mem:%d memObs=%d sessionKey=%s',
        _dbg.skills.join(','), _dbg.agents.join(','), _dbg.design.join(','),
        _dbg.skillsBytes, _dbg.agentsBytes, _dbg.designBytes, _dbg.memBytes, _dbg.memCount,
        sessionKey?.slice(0, 16) || 'no-session');
    } catch { /* logging is best-effort */ }
  }

  const claudeSessionId = sessionKey ? getClaudeSessionId(sessionKey) : undefined;

  // Kill existing query for this session.
  // NB: team sessions (prefix `team:`) are owned by `lib/teams/runner.ts` and
  // must NEVER be killed by the chat path — the team runner keeps them alive
  // across multiple task turns. Only chat sessions get reset-on-re-entry.
  if (sessionKey && !isTeamSessionKey(sessionKey) && activeQueries.has(sessionKey)) {
    try { activeQueries.get(sessionKey)!.close(); } catch {}
    activeQueries.delete(sessionKey);
    activeProcesses.delete(sessionKey);
  }

  const cwd = workspace || GLOBAL_WORKSPACE;
  const resolvedCwd = (cwd && fs.existsSync(cwd)) ? cwd : os.homedir();

  // Build system prompt appendix for new sessions
  let appendPrompt: string | undefined;
  if (!claudeSessionId) {
    const skillsCtx = loadSkillsContext();
    const agentsCtx = loadAgentsIndex();
    const designCtx = loadDesignSystemsIndex();
    const browserCtx = getBrowserInstructions();
    const subagentCtx = sharedGetSubagentStrategy();
    const appendix = [skillsCtx, agentsCtx, designCtx, subagentCtx, browserCtx].filter(Boolean).join('\n');
    if (appendix) appendPrompt = appendix;
  }

  // Init pending response buffer
  if (requestId) {
    pendingResponses.set(requestId, { content: '', done: false, startedAt: Date.now(), updatedAt: Date.now(), sessionKey });
  }

  // Build SDK options
  const sdkOptions: any = {
    cwd: resolvedCwd,
    model: (model && model !== 'default') ? model : undefined,
    includePartialMessages: true,
    agentProgressSummaries: true, // Get ~30s progress summaries for subagents
    ...(claudeSessionId ? { resume: claudeSessionId } : {}),
    systemPrompt: appendPrompt
      ? { type: 'preset' as const, preset: 'claude_code' as const, append: appendPrompt }
      : { type: 'preset' as const, preset: 'claude_code' as const },
    settingSources: ['project' as const, 'user' as const],
  };

  if (permissionMode === 'plan') {
    sdkOptions.permissionMode = 'plan';
    sdkOptions.allowedTools = ['WebSearch', 'WebFetch'];
  } else {
    // Keep the fast-path for everyday tools, but layer a canUseTool
    // callback on top that blocks destructive Bash until the user
    // approves it. The callback auto-allows anything non-destructive
    // so latency stays effectively zero.
    sdkOptions.permissionMode = 'default';
  }

  // Queue of approval events emitted by canUseTool before the SSE stream
  // opens. The stream's start() handler flushes them on first tick so no
  // request is lost even if approval fires before consumers subscribe.
  const pendingApprovalEvents: PendingApproval[] = [];
  let approvalPush: ((p: PendingApproval) => void) = (p) => pendingApprovalEvents.push(p);
  sdkOptions.canUseTool = makeCanUseTool({
    sessionKey,
    onRequest: (ap) => approvalPush(ap),
  });

  // ── Commander / mem / vault MCP tools ───────────────────────────────
  // Always register: Commander (team control), mc-memory (3-layer mem),
  // and mc-vault (Obsidian). sessionKey-scoped so tools resolve to this chat.
  let chatMemSessionId: string | null = null;
  if (sessionKey) {
    try {
      // SEO chat sessions do NOT get the commander/constellation tools — they
      // run a focused SEO workflow. They still get mem + vault for memory and
      // note access. Regular MC chats get everything.
      const isSeo = isSeoSessionKey(sessionKey);
      const memSession = ensureChatSession(sessionKey);
      chatMemSessionId = memSession.id;
      const memServer = getMemServer(memSession.id, `${isSeo ? 'seo' : 'chat'}:${sessionKey.slice(0, 8)}`);
      const vaultServer = getVaultServer();
      const skillsServer = createSkillsMcpServer();
      // Subagent personas from ruvnet/ruflo + affaan-m/everything-claude-code.
      // Exposed as mc_list_agents / mc_load_agent so the main chat agent
      // can pull a persona body on demand and hand it to the Task tool.
      const agentsServer = createAgentsMcpServer();
      // 150+ brand-grade design systems from nexu-io/open-design.
      // Exposed as mc_list_design_systems / mc_load_design_system so the
      // agent can pull a brand's DESIGN.md + tokens.css + components.html
      // when the user wants UI styled after that brand.
      const designServer = createDesignSystemsMcpServer();
      // Cross-MC bridge — only register if any peer hosts are configured;
      // single-machine setups skip it cleanly so the agent isn't told it has
      // a tool that has nothing to talk to.
      const hasRemotePeers = listRemoteHosts().length > 0;
      // Thread the parent chatId into the remote MCP server so mc_remote_ask
      // can broadcast progress events into this chat's live stream — the UI
      // sees the peer call kick off, stream, and finish without having to
      // wait for the tool's final result block.
      const remoteServer = hasRemotePeers ? createRemoteMcpServer(opts.chatId) : null;
      // mc-docs: shared notes & plans. Always registered — the tools default
      // to local-only when no peers exist, but still expose the doc store.
      const docsServer = createDocsMcpServer();
      // mc-edits: cross-machine edit log so agents see what the peer just touched.
      const editsServer = createEditsMcpServer();

      const extraToolNames: string[] = [...MEM_TOOL_NAMES, ...VAULT_TOOL_NAMES, ...SKILLS_TOOL_NAMES, ...AGENTS_TOOL_NAMES, ...DESIGN_SYSTEMS_TOOL_NAMES, ...DOCS_TOOL_NAMES, ...EDITS_TOOL_NAMES];
      if (hasRemotePeers) extraToolNames.push(...REMOTE_TOOL_NAMES);

      // gitnexus — code-intelligence MCP (knowledge graph, blast radius, exec
      // flow, augmented search). Stdio process; npx caches it at user-level
      // after first run. The 7 `gitnexus-*` skills (loaded via the workspace
      // skills index) tell the agent when/how to call these tools.
      const gitnexusServer: any = { type: 'stdio', command: 'npx', args: ['-y', 'gitnexus@latest', 'mcp'] };
      const GITNEXUS_TOOL_GLOB = 'mcp__gitnexus__*';

      if (isSeo) {
        sdkOptions.mcpServers = {
          'mc-memory': memServer,
          'mc-vault': vaultServer,
          'mc-skills': skillsServer,
          'mc-agents': agentsServer,
          'mc-design': designServer,
          'mc-docs': docsServer,
          'mc-edits': editsServer,
          gitnexus: gitnexusServer,
          ...(remoteServer ? { 'mc-remote': remoteServer } : {}),
        };
        extraToolNames.push(GITNEXUS_TOOL_GLOB);
      } else {
        const commanderServer = getCommanderServer(sessionKey);
        sdkOptions.mcpServers = {
          'mc-commander': commanderServer,
          'mc-memory': memServer,
          'mc-vault': vaultServer,
          'mc-skills': skillsServer,
          'mc-agents': agentsServer,
          'mc-design': designServer,
          'mc-docs': docsServer,
          'mc-edits': editsServer,
          gitnexus: gitnexusServer,
          ...(remoteServer ? { 'mc-remote': remoteServer } : {}),
        };
        extraToolNames.push(GITNEXUS_TOOL_GLOB);
        extraToolNames.unshift(
          'mcp__mc-commander__mc_create_team',
          'mcp__mc-commander__mc_list_teams',
          'mcp__mc-commander__mc_team_status',
          'mcp__mc-commander__mc_list_tasks',
          'mcp__mc-commander__mc_diff_task',
          'mcp__mc-commander__mc_approve_task',
          'mcp__mc-commander__mc_halt_team',
          'mcp__mc-commander__mc_send_to_agent',
          'mcp__mc-commander__mc_merge_all_approved',
          'mcp__mc-commander__mc_add_tasks',
        );
      }

      if (sdkOptions.allowedTools) {
        sdkOptions.allowedTools = [...sdkOptions.allowedTools, ...extraToolNames];
      } else {
        sdkOptions.allowedTools = extraToolNames;
      }
    } catch (e: any) {
      console.warn('[MCP] Failed to register commander/mem/vault MCP:', e.message);
    }
  }

  // Launch query
  const q = query({ prompt, options: sdkOptions });

  // Announce turn start on the cross-device broadcast. All tabs/devices
  // viewing this chat will receive a `sync-start` and begin fresh buffers.
  if (opts.chatId) {
    broadcast.startTurn(opts.chatId, opts.clientId);
  }

  if (sessionKey) {
    activeQueries.set(sessionKey, q);
    activeProcesses.set(sessionKey, { kill: () => { try { q.close(); } catch {} } });
  }

  // Build SSE stream
  let fullContent = '';
  let capturedSessionId: string | null = null;
  let clientDead = false;

  // Activity tracking so we can (a) emit periodic heartbeats while the agent
  // is silent and (b) synthesize a summary if the turn ends without text.
  const streamStartedAt = Date.now();
  let lastActivityAt = Date.now();
  // Track which assistant message ids have already had text streamed via
  // content_block_delta. Final assistant messages whose text never streamed
  // (happens after long tool chains / sub-agent fanout) get force-emitted
  // by the fallback below — otherwise the parent's synthesis is silently
  // dropped and the user sees "the agent never picked back up".
  const streamedAsstMsgIds = new Set<string>();
  const toolUsesMade: Array<{ name: string; at: number; input?: any }> = [];
  const subagentActivity = new Map<string, {
    desc: string;
    status: 'started' | 'progress' | 'completed' | 'failed';
    startedAt: number;
    endedAt?: number;
    /** First ~800 chars of the sub-agent's result — used to build a usable
     *  fallback reply when the parent ends its turn without synthesizing. */
    resultPreview?: string;
    /** tool_use_id on the parent — so we can match back to the `Task` call. */
    toolUseId?: string;
  }>();

  function registerActivity(reason: string): void {
    lastActivityAt = Date.now();
    void reason; // for future debug
  }

  function buildSyntheticTurnSummary(): string {
    const elapsed = Math.round((Date.now() - streamStartedAt) / 1000);
    // De-dupe entries that are double-keyed (task_id + tool_use_id both
    // point to the same object) so the recap doesn't repeat them.
    const seen = new Set<any>();
    const subagents: Array<{ desc: string; status: string; resultPreview?: string; }> = [];
    for (const v of subagentActivity.values()) {
      if (seen.has(v)) continue;
      seen.add(v);
      subagents.push(v);
    }
    const completedSubs = subagents.filter(s => s.status === 'completed');
    const runningSubs = subagents.filter(s => s.status === 'started' || s.status === 'progress');
    const failedSubs = subagents.filter(s => s.status === 'failed');

    const lines: string[] = [];
    lines.push(`_The agent ended its turn without synthesizing its own reply. Here are the raw results from ${subagents.length} sub-agent${subagents.length === 1 ? '' : 's'} (${elapsed}s elapsed):_`);
    lines.push('');

    // Emit full result previews for completed sub-agents — this is the
    // content the user was actually waiting for. Each gets its own block.
    if (completedSubs.length > 0) {
      for (let i = 0; i < completedSubs.length; i++) {
        const s = completedSubs[i];
        lines.push(`### ${i + 1}. ✓ ${s.desc.slice(0, 120)}`);
        if (s.resultPreview) {
          lines.push('');
          lines.push(s.resultPreview.trim());
          lines.push('');
        } else {
          lines.push('_(no result captured — the sub-agent returned without text)_');
          lines.push('');
        }
      }
    }
    if (failedSubs.length > 0) {
      lines.push(`**Failed (${failedSubs.length}):**`);
      for (const s of failedSubs) lines.push(`- ✗ ${s.desc.slice(0, 120)}${s.resultPreview ? ` — ${s.resultPreview.slice(0, 200)}` : ''}`);
      lines.push('');
    }
    if (runningSubs.length > 0) {
      lines.push(`**Still running (${runningSubs.length}):** ${runningSubs.map(s => s.desc.slice(0, 60)).join(' · ')}`);
      lines.push('');
    }
    if (toolUsesMade.length > 0) {
      const counts = new Map<string, number>();
      for (const t of toolUsesMade) counts.set(t.name, (counts.get(t.name) || 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      lines.push(`**Parent tool calls:** ${top.map(([n, c]) => `${n}×${c}`).join(', ')}`);
      lines.push('');
    }
    lines.push('---');
    lines.push('_Ask me to "synthesize the findings" or pick a specific result to dig into._');
    return lines.join('\n');
  }

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();

      // Flush the approval-event queue that may have accumulated before the
      // stream opened, then wire the live push to the controller.
      const emitApproval = (ap: PendingApproval) => {
        if (clientDead) return;
        const payload = {
          type: 'tool_approval_required',
          id: ap.id,
          toolName: ap.toolName,
          input: ap.input,
          reason: ap.reason,
          title: ap.title,
          createdAt: ap.createdAt,
        };
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`)); } catch { clientDead = true; }
      };
      for (const ap of pendingApprovalEvents) emitApproval(ap);
      pendingApprovalEvents.length = 0;
      approvalPush = emitApproval;

      // Keepalive
      const keepalive = setInterval(() => {
        if (clientDead) { clearInterval(keepalive); return; }
        try { controller.enqueue(enc.encode(': keepalive\n\n')); } catch { clientDead = true; clearInterval(keepalive); }
      }, 15_000);

      // Heartbeat — emits `type: 'heartbeat'` SSE events every 15s so the
      // ChatPanel can keep the thinking indicator labeled. Fires even when
      // the agent is silent mid-tool-use or waiting on subagents.
      const heartbeatTimer = setInterval(() => {
        if (clientDead) { clearInterval(heartbeatTimer); return; }
        const elapsedSec = Math.round((Date.now() - streamStartedAt) / 1000);
        const silentSec = Math.round((Date.now() - lastActivityAt) / 1000);
        const subs = Array.from(subagentActivity.values());
        const running = subs.filter(s => s.status === 'started' || s.status === 'progress');
        const completed = subs.filter(s => s.status === 'completed' || s.status === 'failed');
        let status: string;
        if (running.length > 0) {
          const newestDesc = running[running.length - 1].desc.slice(0, 80);
          status = `Waiting on ${running.length} subagent${running.length === 1 ? '' : 's'} — "${newestDesc}"`;
        } else if (completed.length > 0 && silentSec > 5) {
          status = `${completed.length} subagent${completed.length === 1 ? '' : 's'} finished — synthesizing reply…`;
        } else if (toolUsesMade.length > 0) {
          const recent = toolUsesMade[toolUsesMade.length - 1];
          status = `Working with tools — last: ${recent.name}`;
        } else {
          status = `Thinking…`;
        }
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({
            type: 'heartbeat',
            status,
            elapsedSec,
            silentSec,
            toolsUsed: toolUsesMade.length,
            subagentsRunning: running.length,
            subagentsDone: completed.length,
          })}\n\n`));
        } catch { clientDead = true; clearInterval(heartbeatTimer); }
      }, 15_000);

      // Consume the async generator
      (async () => {
        try {
          for await (const msg of q) {
            // ─── System init: capture session ID (PARENT ONLY) ─────
            // CRITICAL: sub-agents emit their own system-init messages
            // with their own session_id. Saving a sub-agent's id as the
            // parent's was the actual root cause of "agent doesn't pick
            // back up after sub-agents finish" — next turn tried to
            // resume the sub-agent's ephemeral session, got "no
            // conversation found", cascaded into stale-retry storms.
            if (msg.type === 'system' && (msg as any).subtype === 'init') {
              const fromSubagent = !!(msg as any).parent_tool_use_id;
              if (fromSubagent) {
                console.log('[Agent SDK] Skipping sub-agent init session_id (would have overwritten parent): %s',
                  ((msg as any).session_id || '').slice(0, 8));
                continue;
              }
              capturedSessionId = (msg as any).session_id;
              if (capturedSessionId && sessionKey) {
                console.log('[Agent SDK] Captured PARENT session_id: %s for %s',
                  capturedSessionId.slice(0, 8), sessionKey);
                setClaudeSessionId(sessionKey, capturedSessionId);
              }
              continue;
            }

            // ─── Streaming text deltas ─────────────────────────────
            if (msg.type === 'stream_event') {
              const evt = (msg as any).event;
              const parentToolId = (msg as any).parent_tool_use_id;
              // Track which assistant message we're currently streaming text for
              if (evt?.type === 'message_start' && evt?.message?.id) {
                streamedAsstMsgIds.add(evt.message.id);
              }
              if (evt?.type === 'content_block_delta' && evt?.delta?.type === 'text_delta' && evt?.delta?.text) {
                const delta = evt.delta.text;
                if (parentToolId) {
                  // This text is from a SUBAGENT — send as subagent progress
                  if (!clientDead) {
                    const evt = `data: ${JSON.stringify({
                      type: 'subagent', action: 'progress',
                      key: parentToolId, text: delta,
                    })}\n\n`;
                    try { controller.enqueue(enc.encode(evt)); } catch { clientDead = true; }
                  }
                } else {
                  // This is parent agent text — normal content
                  fullContent += delta;
                  registerActivity('text');
                  if (opts.chatId) broadcast.appendDelta(opts.chatId, delta);
                  if (requestId) {
                    const p = pendingResponses.get(requestId);
                    if (p) { p.content = fullContent; p.updatedAt = Date.now(); }
                  }
                  if (!clientDead) {
                    try { controller.enqueue(enc.encode(sseChunk(delta))); } catch { clientDead = true; }
                  }
                  if (chatMemSessionId && delta.length > 60) {
                    memCaptureAssistantText(chatMemSessionId, delta);
                  }
                }
              }
              continue;
            }

            // ─── Task lifecycle (subagent start/progress/complete) ──
            if (msg.type === 'system') {
              const sub = (msg as any).subtype;

              if (sub === 'task_started') {
                const m = msg as any;
                console.log('[Subagent] task_started: %s — %s', m.task_id, m.description);
                // Key by BOTH task_id and tool_use_id so the finish path
                // (keyed on tool_use_id) can reliably look up this entry.
                const taskKey = m.task_id || m.tool_use_id;
                const entry = {
                  desc: m.description || 'subagent',
                  status: 'started' as const,
                  startedAt: Date.now(),
                  toolUseId: m.tool_use_id,
                };
                subagentActivity.set(taskKey, entry);
                if (m.tool_use_id && m.tool_use_id !== taskKey) {
                  subagentActivity.set(m.tool_use_id, entry);
                }
                registerActivity('subagent_start');
                if (!clientDead) {
                  const evt = `data: ${JSON.stringify({
                    type: 'subagent', action: 'task_started',
                    taskId: m.task_id, toolUseId: m.tool_use_id,
                    description: m.description,
                  })}\n\n`;
                  try { controller.enqueue(enc.encode(evt)); } catch { clientDead = true; }
                }
                continue;
              }

              if (sub === 'task_progress') {
                const m = msg as any;
                const summary = m.summary || m.description || '';
                const usage = m.usage || {};
                if (summary && !clientDead) {
                  // Show progress summary as status + send to subagent dropdown
                  try { controller.enqueue(enc.encode(sseStatus(`🔄 ${summary.slice(0, 120)}`))); } catch { clientDead = true; }
                  const evt = `data: ${JSON.stringify({
                    type: 'subagent', action: 'task_progress',
                    taskId: m.task_id, toolUseId: m.tool_use_id,
                    summary, toolUses: usage.tool_uses, durationMs: usage.duration_ms,
                  })}\n\n`;
                  try { controller.enqueue(enc.encode(evt)); } catch { clientDead = true; }
                }
                continue;
              }

              if (sub === 'task_updated') {
                const m = msg as any;
                const patch = m.patch || {};
                console.log('[Subagent] task_updated: %s — status=%s', m.task_id, patch.status);
                const existing = subagentActivity.get(m.task_id || m.tool_use_id);
                if (existing) {
                  if (patch.status === 'completed' || patch.status === 'failed') {
                    existing.status = patch.status;
                    existing.endedAt = Date.now();
                  } else if (patch.status === 'running' || patch.status === 'in_progress') {
                    existing.status = 'progress';
                  }
                }
                registerActivity('subagent_update');
                if (patch.status === 'completed' || patch.status === 'failed') {
                  if (!clientDead) {
                    const evt = `data: ${JSON.stringify({
                      type: 'subagent', action: 'task_completed',
                      taskId: m.task_id, status: patch.status,
                    })}\n\n`;
                    try { controller.enqueue(enc.encode(evt)); } catch { clientDead = true; }
                  }
                }
                continue;
              }

              if (sub === 'task_notification') {
                const m = msg as any;
                console.log('[Subagent] task_notification: %s — %s', m.task_id, m.status);
                if (!clientDead) {
                  const evt = `data: ${JSON.stringify({
                    type: 'subagent', action: 'task_notification',
                    taskId: m.task_id, toolUseId: m.tool_use_id,
                    status: m.status, summary: m.summary,
                  })}\n\n`;
                  try { controller.enqueue(enc.encode(evt)); } catch { clientDead = true; }
                  // Also show as a status update
                  if (m.summary) {
                    try { controller.enqueue(enc.encode(sseStatus(`✅ Agent done: ${m.summary.slice(0, 100)}`))); } catch { clientDead = true; }
                  }
                }
                continue;
              }

              // init already handled above, skip other system messages
              continue;
            }

            // ─── Assistant messages: tool use activity + text fallback ──
            if (msg.type === 'assistant' && (msg as any).message?.content) {
              const m = msg as any;
              const content = m.message.content;
              const asstMsgId = m.message?.id;
              const isFromSubagent = !!m.parent_tool_use_id;
              const alreadyStreamed = asstMsgId ? streamedAsstMsgIds.has(asstMsgId) : false;
              for (const block of content) {
                // PARENT-AGENT TEXT FALLBACK: if this assistant message
                // wasn't streamed via content_block_delta (the symptom that
                // looks like "parent never picks back up after sub-agents"),
                // emit its text blocks now so the user actually sees the
                // reply. Skip if already streamed (avoid double-emission)
                // or if the message belongs to a sub-agent (those are
                // routed through the subagent progress events instead).
                if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0
                    && !isFromSubagent && !alreadyStreamed) {
                  const delta = block.text;
                  fullContent += delta;
                  registerActivity('text-fallback');
                  if (asstMsgId) streamedAsstMsgIds.add(asstMsgId);
                  if (opts.chatId) broadcast.appendDelta(opts.chatId, delta);
                  if (requestId) {
                    const p = pendingResponses.get(requestId);
                    if (p) { p.content = fullContent; p.updatedAt = Date.now(); }
                  }
                  if (!clientDead) {
                    try { controller.enqueue(enc.encode(sseChunk(delta))); } catch { clientDead = true; }
                  }
                  if (chatMemSessionId && delta.length > 60) {
                    memCaptureAssistantText(chatMemSessionId, delta);
                  }
                  console.log('[Agent SDK] Recovered un-streamed parent text (%d chars) for msg %s',
                    delta.length, asstMsgId || '?');
                }
                if (block?.type === 'tool_use') {
                  const name = block.name || 'Unknown';
                  const input = block.input || {};
                  const status = toolStatusLabel(name, input);
                  toolUsesMade.push({ name, at: Date.now(), input });
                  registerActivity('tool_use');

                  // Stream status to client
                  if (!clientDead) {
                    try { controller.enqueue(enc.encode(sseStatus(status))); } catch { clientDead = true; }
                  }

                  if (chatMemSessionId) {
                    memCaptureToolUse({ sessionId: chatMemSessionId, toolName: name, input });
                  }

                  // edit-log: capture file edits for cross-machine awareness.
                  // Buffered per-turn (deduped by file path); flushed to disk
                  // at end-of-turn so we log final state, not iterations.
                  bufferEdit({
                    chatId: opts.chatId,
                    sessionKey,
                    agent: isFromSubagent ? 'subagent' : 'parent',
                    op: name,
                    input,
                  });

                  // Track subagent launches + push real-time event to client
                  if (sessionKey && (name === 'Task' || name === 'Agent') && block.id) {
                    const label = (input.description || '').slice(0, 120) || 'Subagent';
                    try {
                      recordSubagentStart({
                        toolUseId: block.id,
                        sessionKey,
                        parentSessionId: capturedSessionId || undefined,
                        subagentType: input.subagent_type || 'general-purpose',
                        label,
                        task: typeof input.prompt === 'string' ? input.prompt : JSON.stringify(input.prompt || ''),
                      });
                    } catch (e) {
                      console.error('[MC subagents] recordStart failed:', e);
                    }
                    // Push real-time subagent event so client doesn't have to wait for poll
                    if (!clientDead) {
                      const evt = `data: ${JSON.stringify({
                        type: 'subagent', action: 'start',
                        key: block.id, label, subagentType: input.subagent_type || 'general-purpose',
                      })}\n\n`;
                      try { controller.enqueue(enc.encode(evt)); } catch { clientDead = true; }
                    }
                  }
                }
              }
              continue;
            }

            // ─── User messages: tool results (subagent tracking) ────
            if (msg.type === 'user' && (msg as any).message?.content) {
              const content = (msg as any).message.content;
              // Debug: log user message structure to understand SDK format
              if (Array.isArray(content)) {
                const toolResults = content.filter((b: any) => b?.type === 'tool_result');
                if (toolResults.length > 0) {
                  console.log('[MC subagents] Found %d tool_results in user msg', toolResults.length,
                    toolResults.map((t: any) => ({ id: t.tool_use_id?.slice(0,12), hasContent: !!(t.content) })));
                }
              }
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block?.type === 'tool_result' && block.tool_use_id && sessionKey) {
                    let resultText = '';
                    if (typeof block.content === 'string') {
                      resultText = block.content;
                    } else if (Array.isArray(block.content)) {
                      resultText = block.content
                        .filter((c: any) => c?.type === 'text')
                        .map((c: any) => c.text)
                        .join('\n');
                    }
                    if (chatMemSessionId) {
                      memCaptureToolResult({
                        sessionId: chatMemSessionId,
                        toolName: 'tool_result',
                        output: resultText,
                        isError: !!block.is_error,
                      });
                    }
                    try {
                      // Attach the result text to in-memory subagent activity
                      // so buildSyntheticTurnSummary can include real content,
                      // not just status chrome.
                      const sa = subagentActivity.get(block.tool_use_id);
                      if (sa) {
                        sa.resultPreview = (resultText || '').slice(0, 800);
                        sa.status = block.is_error ? 'failed' : 'completed';
                        sa.endedAt = Date.now();
                      }
                      recordSubagentFinish(block.tool_use_id, {
                        resultFull: resultText,
                        isError: !!block.is_error,
                      });
                      // Push real-time finish event to client
                      if (!clientDead) {
                        const evt = `data: ${JSON.stringify({
                          type: 'subagent', action: 'finish',
                          key: block.tool_use_id,
                          resultPreview: resultText.slice(0, 200),
                          isError: !!block.is_error,
                        })}\n\n`;
                        try { controller.enqueue(enc.encode(evt)); } catch { clientDead = true; }
                      }
                    } catch (e) {
                      console.error('[MC subagents] recordFinish failed:', e);
                    }
                  }
                }
              }
              continue;
            }

            // ─── Tool progress (heartbeat during long tool calls) ───
            if (msg.type === 'tool_progress') {
              const tp = msg as any;
              const elapsed = Math.round(tp.elapsed_time_seconds || 0);
              const toolName = tp.tool_name || 'Tool';
              if (!clientDead) {
                if (toolName === 'Agent' || toolName === 'Task') {
                  // Subagent heartbeat — send as subagent progress event
                  const evt = `data: ${JSON.stringify({
                    type: 'subagent', action: 'heartbeat',
                    key: tp.tool_use_id, elapsed,
                  })}\n\n`;
                  try { controller.enqueue(enc.encode(evt)); } catch { clientDead = true; }
                  if (elapsed > 3) {
                    try { controller.enqueue(enc.encode(sseStatus(`🚀 Agent working (${elapsed}s)...`))); } catch { clientDead = true; }
                  }
                } else if (elapsed > 5) {
                  const status = `⏳ ${toolName} running (${elapsed}s)...`;
                  try { controller.enqueue(enc.encode(status)); } catch { clientDead = true; }
                }
              }
              continue;
            }

            // ─── Tool use summary ───────────────────────────────────
            if (msg.type === 'tool_use_summary') {
              const summary = (msg as any).summary;
              if (summary && !clientDead) {
                try { controller.enqueue(enc.encode(sseStatus(`📋 ${summary.slice(0, 120)}`))); } catch { clientDead = true; }
              }
              continue;
            }

            // ─── Result ─────────────────────────────────────────────
            if (msg.type === 'result') {
              const r = msg as any;
              const fromSubagent = !!r.parent_tool_use_id;
              if (r.session_id && !fromSubagent) {
                capturedSessionId = r.session_id;
                if (sessionKey) {
                  console.log('[Agent SDK] Result from PARENT — saving session_id %s for %s (turns=%d)',
                    r.session_id.slice(0, 8), sessionKey, r.num_turns || 0);
                  setClaudeSessionId(sessionKey, r.session_id);
                }
              } else if (fromSubagent) {
                console.log('[Agent SDK] Skipping sub-agent result session_id %s (would have overwritten parent)',
                  (r.session_id || '').slice(0, 8));
              }

              // Handle errors
              if (r.is_error && fullContent.length === 0) {
                const errMsgs: string[] = Array.isArray(r.errors) ? r.errors : [];
                const isStaleSession = errMsgs.some((e: string) => /no conversation found/i.test(e));
                const isRateLimit = errMsgs.some((e: string) => /\b429\b|rate.?limit|request rejected/i.test(e));

                // 429 short-circuit: do NOT auto-retry on rate limits.
                // Each retry burns another API call against the limited
                // window, leaves another half-dead session, and stacks
                // "stale session" cascades behind it. Surface clearly
                // and stop. This was Chat 20's actual failure mode.
                if (isRateLimit) {
                  console.warn('[Agent SDK] Rate-limit 429 for %s — NOT retrying. Surface to user.', sessionKey);
                  // Mark this sessionKey so /api/chat refuses subsequent sends
                  // for COOLDOWN_MS — breaks the user's compulsive-retry loop.
                  if (sessionKey) markRateLimited(sessionKey, errMsgs[0]?.slice(0, 200) || '429');
                  const errText = '⚠️ **Rate-limited (429)** — Anthropic denied the next API call. Your subscription\'s rolling window is full. Wait for the reset (typically 5 hours from your first hit), or switch to a less-loaded model (`/sonnet` or `/haiku`). Auto-retry was suppressed to avoid burning more quota on doomed requests.';
                  fullContent = errText;
                  if (requestId) {
                    const p = pendingResponses.get(requestId);
                    if (p) { p.content = fullContent; p.error = '429 rate limit'; p.updatedAt = Date.now(); }
                  }
                  if (!clientDead) {
                    try { controller.enqueue(enc.encode(sseChunk(errText))); } catch { clientDead = true; }
                  }
                  break;
                }

                if (isStaleSession && sessionKey) {
                  // Clear stale mapping and auto-retry
                  console.warn('[Agent SDK] Stale session for %s — auto-retrying fresh', sessionKey);
                  deleteClaudeSessionId(sessionKey);

                  try {
                    // Build a "subagent recap" of work that already finished
                    // in this turn before the stale hit. This is the Chat 20
                    // failure mode: 14 minutes of sub-agent work was wiped
                    // when the parent's resume failed because the fresh
                    // fallback prompt only carried conversation history, not
                    // sub-agent results. Splicing them in here means the new
                    // session continues from the findings instead of redoing
                    // the work.
                    const completedSubs: string[] = [];
                    const seen = new Set<any>();
                    for (const sa of subagentActivity.values()) {
                      if (seen.has(sa)) continue;
                      seen.add(sa);
                      if (sa.status === 'completed' && sa.resultPreview) {
                        completedSubs.push(`### ${sa.desc}\n\n${sa.resultPreview.trim()}`);
                      }
                    }
                    const subRecap = completedSubs.length > 0
                      ? `\n\n──── SUB-AGENT WORK ALREADY COMPLETED IN THIS TURN ────\n_The session was just re-initialised mid-flight; these sub-agents finished BEFORE the reset and their output is preserved here so you can synthesise from them rather than re-running the work. Treat these as authoritative findings, not as new tool input._\n\n${completedSubs.join('\n\n---\n\n')}\n\n──── END OF PRESERVED SUB-AGENT OUTPUT ────\n`
                      : '';

                    let retryPrompt = opts.freshFallbackPrompt || opts.prompt;
                    if (subRecap) retryPrompt = retryPrompt + subRecap;

                    if (opts.freshFallbackPrompt || subRecap) {
                      console.log('[Agent SDK] Stale retry: prompt %d → %d chars (subagents preserved: %d)',
                        opts.prompt.length, retryPrompt.length, completedSubs.length);
                    }
                    const retry = spawnClaudeStream({
                      ...opts,
                      prompt: retryPrompt,
                      // The stale path is already on a fresh session; don't
                      // chain another fallback or we loop forever if both
                      // fail the same way.
                      freshFallbackPrompt: undefined,
                    });
                    const retryReader = retry.stream.getReader();
                    while (true) {
                      const { done: rDone, value: rVal } = await retryReader.read();
                      if (rDone) break;
                      if (!clientDead) {
                        try { controller.enqueue(rVal); } catch { clientDead = true; }
                      }
                    }
                  } catch (retryErr: any) {
                    console.error('[Agent SDK] Retry failed:', retryErr);
                    const errText = '⚠️ Session expired. Please send your message again.';
                    if (!clientDead) {
                      try { controller.enqueue(enc.encode(sseChunk(errText))); } catch { clientDead = true; }
                    }
                  }
                  break;
                }

                // Non-stale error
                const errText = errMsgs.length > 0
                  ? `⚠️ ${errMsgs.join('; ')}`
                  : '⚠️ Claude session error.';
                fullContent = errText;
                if (requestId) {
                  const p = pendingResponses.get(requestId);
                  if (p) { p.content = fullContent; p.error = errMsgs.join('; '); p.updatedAt = Date.now(); }
                }
                if (!clientDead) {
                  try { controller.enqueue(enc.encode(sseChunk(errText))); } catch { clientDead = true; }
                }
              } else if (fullContent.length === 0 && r.result) {
                // CLI returned result but no streaming deltas were captured
                const text = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
                fullContent = text;
                if (requestId) {
                  const p = pendingResponses.get(requestId);
                  if (p) { p.content = fullContent; p.updatedAt = Date.now(); }
                }
                if (!clientDead) {
                  try { controller.enqueue(enc.encode(sseChunk(text))); } catch { clientDead = true; }
                }
              } else if (fullContent.length === 0 && !r.is_error) {
                // Silent turn: the model ran tools and/or spawned subagents but
                // never emitted assistant text before the turn closed. Synthesize
                // a recap so the user isn't left staring at a blank message.
                const recap = buildSyntheticTurnSummary();
                fullContent = recap;
                if (requestId) {
                  const p = pendingResponses.get(requestId);
                  if (p) { p.content = fullContent; p.updatedAt = Date.now(); }
                }
                if (!clientDead) {
                  try {
                    // Send a marker event first so the client knows this is synthesized
                    controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'synthetic_recap', tools: toolUsesMade.length, subagents: subagentActivity.size })}\n\n`));
                    controller.enqueue(enc.encode(sseChunk(recap)));
                  } catch { clientDead = true; }
                }
                console.warn('[Agent SDK] Empty turn — synthesized recap. tools=%d subagents=%d',
                  toolUsesMade.length, subagentActivity.size);
              }

              // Usage event
              if (r.total_cost_usd !== undefined || r.usage) {
                const usageEvent = `data: ${JSON.stringify({
                  type: 'usage', usage: r.usage || {}, cost: r.total_cost_usd,
                  session_id: r.session_id, num_turns: r.num_turns, modelUsage: r.modelUsage,
                })}\n\n`;
                if (!clientDead) {
                  try { controller.enqueue(enc.encode(usageEvent)); } catch { clientDead = true; }
                }
                console.log('[Agent SDK] session=%s cost=$%s turns=%d',
                  r.session_id?.slice(0, 8), r.total_cost_usd?.toFixed(4), r.num_turns || 0);
              }
              continue;
            }

            // ─── Rate limit ─────────────────────────────────────────
            if (msg.type === 'rate_limit_event') {
              const info = (msg as any).rate_limit_info;
              if (info?.status === 'throttled' || info?.status === 'blocked') {
                const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : 'soon';
                const warning = `\n\n⚠️ **Rate limited** — resets at ${resetsAt}.\n\n`;
                fullContent += warning;
                if (!clientDead) {
                  try { controller.enqueue(enc.encode(sseChunk(warning))); } catch { clientDead = true; }
                }
              }
              continue;
            }
          }
        } catch (err: any) {
          console.error('[Agent SDK] Stream error:', err);
          if (fullContent.length === 0 && !clientDead) {
            const errText = `⚠️ Agent error: ${err.message || 'Unknown error'}`;
            try { controller.enqueue(enc.encode(sseChunk(errText))); } catch { clientDead = true; }
          }
        } finally {
          clearInterval(keepalive);
          clearInterval(heartbeatTimer);

          // Tell every other tab/device the turn is over. The broadcast
          // entry lingers ~30s so a late subscriber still sees 'sync-done'.
          if (opts.chatId) broadcast.endTurn(opts.chatId);

          // Memory indexing
          if (sessionKey) {
            indexChatIncremental(sessionKey).catch((e) => {
              console.error('[Memory] indexChatIncremental failed:', e);
            });
          }

          // mem/api: compress pending observations for this chat session (non-blocking).
          if (chatMemSessionId) {
            compressPendingForSession(chatMemSessionId).catch((e: any) => {
              console.warn('[mem] compressPendingForSession failed:', e?.message);
            });
          }

          // Cleanup
          if (sessionKey) {
            activeQueries.delete(sessionKey);
            activeProcesses.delete(sessionKey);
          }
          if (requestId) {
            const p = pendingResponses.get(requestId);
            if (p) { p.done = true; p.updatedAt = Date.now(); }
          }
          if (!clientDead) {
            try {
              controller.enqueue(enc.encode(sseDone()));
              controller.close();
            } catch {}
          }

          // edit-log: flush this turn's buffered edits to disk + broadcast
          // them via the cross-tab/device SSE so live ACTIVITY UIs update.
          if (opts.chatId) {
            const flushed = flushTurn(opts.chatId);
            if (flushed.length && !clientDead) {
              try {
                const evt = `data: ${JSON.stringify({ type: 'edits_flushed', edits: flushed })}\n\n`;
                controller.enqueue(enc.encode(evt));
              } catch { /* client dead */ }
            }
          }

          // Server-side persistence fallback: if the client never came back
          // to claim this stream, the chat file would otherwise be missing
          // the agent's reply. We wait 30s (let the normal client-side path
          // win when it works) then check the chat file and append our own
          // record if the assistant text isn't there yet. Idempotent —
          // duplicate writes are detected by content prefix match.
          //
          // This is what closes the gap the user saw in Chat 33: agent's
          // audit-done reply was in the SDK transcript but never made it
          // into data/chats/<id>.json because the tab dropped the SSE.
          if (opts.chatId && fullContent.trim().length > 0) {
            const turnStartedAt = streamStartedAt;
            setTimeout(() => {
              try {
                const r = commitAssistantMessageIfMissing({
                  chatId: opts.chatId!,
                  content: fullContent,
                  expectedLatestUserAt: turnStartedAt,
                });
                if (r.appended) {
                  console.log('[chat-storage] server-side fallback commit: chat=%s chars=%d',
                    opts.chatId!.slice(0, 8), fullContent.length);
                } else if (r.reason && !r.reason.includes('already committed')) {
                  console.log('[chat-storage] fallback skipped (%s): chat=%s',
                    r.reason, opts.chatId!.slice(0, 8));
                }
              } catch (e: any) {
                console.warn('[chat-storage] fallback commit failed:', e?.message);
              }
            }, 30_000);
          }
        }
      })();
    },
    cancel() {
      clientDead = true;
      cancelApprovalsForSession(sessionKey);
    },
  });

  return {
    stream,
    process: { kill: () => { try { q.close(); } catch {} } },
  };
}

// ─── Auth helper (for /api/agent) ───────────────────────────────────
export function getGatewayToken(): string {
  try {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config?.gateway?.auth?.token || '';
  } catch {
    return '';
  }
}
