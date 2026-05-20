/**
 * mem/compress — AI compression of raw observations into durable learnings.
 *
 * Takes batched queue rows (tool uses, tool results, user/assistant text) and
 * asks Claude (via the already-installed Agent SDK) to distill them into
 * typed observations: decision | pattern | blocker | fact | skill | finding.
 *
 * Safe to no-op when the SDK isn't reachable (network down, no key) — in that
 * case we emit a minimal heuristic summary so search still has content.
 */

import 'server-only';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  createObservation,
  drainQueue,
  type MemObservationType,
  type QueuedRow,
} from './observations';
import { endSession, getMemSession } from './sessions';

interface Distilled {
  type: MemObservationType;
  title: string;
  content: string;
  tags?: string[];
  files?: string[];
}

const TYPES: MemObservationType[] = [
  'decision', 'pattern', 'blocker', 'fact', 'skill', 'finding', 'summary',
];

function compactQueue(rows: QueuedRow[], cap = 12_000): string {
  const lines: string[] = [];
  for (const r of rows) {
    const when = new Date(r.created_at).toISOString();
    let payload: any = {};
    try { payload = JSON.parse(r.payload); } catch {}
    if (r.kind === 'tool_use') {
      lines.push(`[${when}] tool_use ${r.tool_name ?? '?'} ${JSON.stringify(payload.input ?? payload).slice(0, 800)}`);
    } else if (r.kind === 'tool_result') {
      const txt = typeof payload.content === 'string'
        ? payload.content
        : JSON.stringify(payload).slice(0, 800);
      lines.push(`[${when}] tool_result ${r.tool_name ?? '?'} ${txt.slice(0, 600)}${payload.is_error ? ' [ERROR]' : ''}`);
    } else if (r.kind === 'user') {
      lines.push(`[${when}] user: ${String(payload.text ?? payload).slice(0, 800)}`);
    } else if (r.kind === 'assistant') {
      lines.push(`[${when}] assistant: ${String(payload.text ?? payload).slice(0, 800)}`);
    } else {
      lines.push(`[${when}] ${r.kind}: ${JSON.stringify(payload).slice(0, 600)}`);
    }
  }
  let joined = lines.join('\n');
  if (joined.length > cap) joined = joined.slice(-cap);
  return joined;
}

const COMPRESS_SYSTEM = `You are a memory distillation subsystem. Input: a chronological log of an AI agent's session (tool calls, results, user and assistant turns). Output: durable observations a future session would find useful.

Rules:
- Return ONLY a single JSON object: {"observations":[{type,title,content,tags?,files?}, ...]}
- Each observation type must be one of: decision, pattern, blocker, fact, skill, finding, summary.
- title ≤ 120 chars, single line.
- content: 1–4 sentences, self-contained, no pronouns referring to "this session".
- Prefer 3–8 observations total. Skip if nothing is worth remembering (return {"observations":[]}).
- Include file paths in "files" when specific files were central.
- Tags: short lowercase tokens (e.g. ["auth","supabase","migration"]).
- Never include credentials, secrets, or full tool outputs.`;

function extractJsonObject(text: string): string | null {
  // Strip markdown code fences first (```json ... ```) since Haiku often wraps
  // JSON responses in them.
  const stripped = text.replace(/```(?:json)?/gi, '');
  // Find the first balanced {...} — scan for the first { and find its matching }
  const start = stripped.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return stripped.slice(start, i + 1);
    }
  }
  return null;
}

function parseDistilled(text: string): Distilled[] {
  const json = extractJsonObject(text);
  if (!json) return [];
  try {
    const obj = JSON.parse(json);
    const arr = Array.isArray(obj?.observations) ? obj.observations : [];
    return arr
      .filter((o: any) => o && typeof o.title === 'string' && typeof o.content === 'string')
      .map((o: any) => ({
        type: TYPES.includes(o.type) ? o.type : 'finding',
        title: String(o.title).slice(0, 400),
        content: String(o.content).slice(0, 4000),
        tags: Array.isArray(o.tags) ? o.tags.filter((t: any) => typeof t === 'string').slice(0, 10) : [],
        files: Array.isArray(o.files) ? o.files.filter((t: any) => typeof t === 'string').slice(0, 20) : [],
      })) as Distilled[];
  } catch {
    return [];
  }
}

// The Claude Code CLI path that the Agent SDK needs to find to authenticate.
// Must match the path the rest of mission-control uses (runner.ts). When the
// next-server process doesn't have claude on PATH, this is the only way to
// reach it.
const CLAUDE_CODE_CLI = '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js';

async function distillWithClaude(log: string): Promise<Distilled[]> {
  try {
    const q = query({
      prompt: `Distill this session log into observations.\n\n---\n${log}\n---`,
      options: {
        pathToClaudeCodeExecutable: CLAUDE_CODE_CLI,
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: { type: 'preset', preset: 'claude_code', append: COMPRESS_SYSTEM },
        // Load user settings so the Claude Code auth file is discovered.
        // Empty settingSources caused silent auth failures on Linux.
        settingSources: ['user'] as any,
        allowedTools: [],
        includePartialMessages: false,
        permissionMode: 'bypassPermissions' as any,
      },
    });
    // 60s safety budget for a single distill — enough for Haiku, protects
    // the tick from wedging when auth/network is flaky.
    const timer = setTimeout(() => { try { (q as any).interrupt?.(); } catch {} }, 60_000);
    // Collect assistant text and result separately; the SDK emits both for
    // the same response, so concatenating is a double-counting bug.
    let assistantText = '';
    let resultText = '';
    for await (const msg of q) {
      if ((msg as any).type === 'result' && typeof (msg as any).result === 'string') {
        resultText = (msg as any).result;
      } else if ((msg as any).type === 'assistant') {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              assistantText += block.text;
            }
          }
        }
      }
    }
    // Prefer `result` (the final turn) — falls back to assistant deltas if empty.
    const acc = resultText || assistantText;
    clearTimeout(timer);
    const parsed = parseDistilled(acc);
    if (parsed.length === 0 && acc.length > 0) {
      console.warn('[mem.compress] distill returned un-parseable output (first 200):', acc.slice(0, 200));
    } else if (acc.length === 0) {
      console.warn('[mem.compress] distill produced no output — falling back to heuristic');
    }
    return parsed;
  } catch (e) {
    console.warn('[mem.compress] distill failed:', (e as Error).message);
    return [];
  }
}

function heuristicFallback(rows: QueuedRow[]): Distilled[] {
  const tools = new Map<string, number>();
  const files = new Set<string>();
  for (const r of rows) {
    if (r.tool_name) tools.set(r.tool_name, (tools.get(r.tool_name) ?? 0) + 1);
    try {
      const p = JSON.parse(r.payload);
      const fp = p?.input?.file_path ?? p?.input?.path;
      if (typeof fp === 'string') files.add(fp);
    } catch {}
  }
  const toolList = Array.from(tools.entries())
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, v]) => `${k}×${v}`).join(', ');
  const fileList = Array.from(files).slice(0, 8).join(', ');
  if (!toolList && !fileList) return [];
  return [{
    type: 'summary',
    title: 'Heuristic session summary',
    content: `Tools: ${toolList || 'none'}. Files touched: ${fileList || 'none'}.`,
    tags: ['heuristic'],
    files: Array.from(files).slice(0, 20),
  }];
}

/** Process all pending queue items for a session and write observations.
 *  Returns the count of observations written. */
export async function compressPendingForSession(sessionId: string, opts?: {
  maxItems?: number;
  useFallback?: boolean;
}): Promise<number> {
  const rows = drainQueue(sessionId, opts?.maxItems ?? 200);
  if (rows.length === 0) return 0;

  const log = compactQueue(rows);
  let distilled = await distillWithClaude(log);
  if (distilled.length === 0 && (opts?.useFallback ?? true)) {
    distilled = heuristicFallback(rows);
  }
  if (distilled.length === 0) return 0;

  let written = 0;
  for (const d of distilled) {
    try {
      await createObservation({
        sessionId,
        type: d.type,
        title: d.title,
        content: d.content,
        tags: d.tags,
        filesInvolved: d.files,
        sourceTurnIds: rows.map(r => String(r.id)),
        compressedFrom: `queue:${rows[0].id}-${rows[rows.length - 1].id}`,
      });
      written++;
    } catch (e) {
      console.warn('[mem.compress] createObservation failed:', (e as Error).message);
    }
  }
  return written;
}

/** End-of-session summary. Runs compression + writes a final `summary` observation. */
export async function generateSessionSummary(sessionId: string): Promise<{
  observationsWritten: number;
  summary: string;
}> {
  const s = getMemSession(sessionId);
  if (!s) return { observationsWritten: 0, summary: '' };

  const written = await compressPendingForSession(sessionId, { maxItems: 500 });

  // Build a short rollup from most recent observations.
  const recent = drainQueue(sessionId, 0); // drained to [] already; no-op
  void recent;

  // Summary = concat of top-N recent observation titles/content.
  const { listRecentObservations } = await import('./observations');
  const latest = listRecentObservations(sessionId, 10);
  const summary = latest
    .reverse()
    .map(o => `- [${o.type}] ${o.title}`)
    .join('\n');

  endSession(sessionId, summary);
  return { observationsWritten: written, summary };
}
