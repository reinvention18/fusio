/**
 * Codex Consult — synchronous, structured one-shot wrapper around `codex exec`
 * for the chat-pair orchestrator (lib/teams/pair.ts).
 *
 * Different from lib/teams/codex.ts (which is the constellation review wrapper):
 *   - This one is for IN-CHAT pair mode, not team review.
 *   - It accepts a *brief* (compressed task context) instead of the whole repo state.
 *   - It returns a structured shape: { verdict, summary, concerns[], suggestions[], patches[] }.
 *   - No DB persistence; the chat handler owns transcript storage.
 *
 * Auth: relies on an existing `codex login` on this machine (subscription).
 */

import 'server-only';
import { spawn } from 'node:child_process';

export type ConsultRole = 'critic' | 'planner' | 'reviewer';

export interface ConsultInput {
  /** Compressed task brief written by the orchestrator (≤ a few KB is ideal,
   *  but no hard cap — long heavy contexts are explicitly supported). */
  brief: string;
  /** What we want Codex to do: critique a draft, propose its own plan, review a diff, etc. */
  role: ConsultRole;
  /** Optional focus hints — domains where Codex's view is weighted heavier. */
  focus?: string[];
  /** Working directory. Codex needs a real cwd to read files when relevant. */
  cwd: string;
  /** Hard timeout. Default 15 min — long deployments need room. */
  timeoutMs?: number;
  /** Optional model override. Default: codex CLI's configured default. */
  model?: string;
  /** Phase 4: cancellation. When this signal aborts, the codex subprocess is
   *  SIGTERM'd and the promise rejects with an abort error. The mission
   *  runtime uses this to surface user-pause requests within seconds instead
   *  of waiting for the 15-min timeout. */
  signal?: AbortSignal;
}

export interface ConsultPatch {
  file?: string;
  line_start?: number;
  line_end?: number;
  rationale?: string;
  /** Suggested replacement (text) or describe-the-change. */
  suggestion: string;
}

export interface ConsultConcern {
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  body?: string;
  file?: string;
  /** Which axis: race-condition, prod-env, types, perf, security, convention, etc. */
  axis?: string;
}

export interface ConsultResult {
  verdict: 'agree' | 'agree-with-concerns' | 'disagree' | 'needs-info';
  summary: string;
  concerns: ConsultConcern[];
  suggestions: string[];
  patches: ConsultPatch[];
  /** Codex's own counter-proposal when asked as a planner. Free-form markdown. */
  proposal?: string;
  /** Raw stdout for debugging. */
  raw: string;
  duration_ms: number;
}

const SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['agree', 'agree-with-concerns', 'disagree', 'needs-info'] },
    summary: { type: 'string' },
    concerns: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'title'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string' },
          body: { type: 'string' },
          file: { type: 'string' },
          axis: { type: 'string' },
        },
      },
    },
    suggestions: { type: 'array', items: { type: 'string' } },
    patches: {
      type: 'array',
      items: {
        type: 'object',
        required: ['suggestion'],
        properties: {
          file: { type: 'string' },
          line_start: { type: 'integer' },
          line_end: { type: 'integer' },
          rationale: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
    proposal: { type: 'string' },
  },
} as const;

function buildPrompt(input: ConsultInput): string {
  const focusBlock = input.focus && input.focus.length
    ? `\n\nWeight your critique heavily on these axes (Claude is known to be weaker here): ${input.focus.join(', ')}.`
    : '';

  const roleInstruction = (() => {
    switch (input.role) {
      case 'critic':
        return [
          'You are the second voice in a pair-programming chat.',
          'Claude (the first voice) has produced a plan or draft below.',
          'Your job: surface what she missed. Be sharp, specific, and concise.',
          'Disagree if you genuinely disagree. Agree fast if the plan is sound — do not invent concerns to look useful.',
          'Prefer one critical concern over five mediocre ones.',
        ].join(' ');
      case 'planner':
        return [
          'You are the second voice in a pair-programming chat.',
          'Produce your OWN plan for the task in the brief, independently.',
          'Claude will produce hers in parallel; the orchestrator will reconcile.',
          'Do NOT try to predict or copy Claude. Reason from first principles.',
        ].join(' ');
      case 'reviewer':
        return [
          'You are reviewing a unified diff or set of file changes Claude is about to apply.',
          'Catch real bugs: race conditions, env-divergent behavior, broken types, security issues, regressions.',
          'Skip style nits unless they will cause runtime/test failures.',
          'Return patches[] with concrete fixes when you can; concerns[] when you cannot.',
        ].join(' ');
    }
  })();

  return [
    roleInstruction + focusBlock,
    '',
    'Return ONLY a JSON object matching the provided schema. No prose outside the JSON.',
    '',
    '--- BRIEF ---',
    input.brief,
    '--- END BRIEF ---',
  ].join('\n');
}

export async function runCodexConsult(input: ConsultInput): Promise<ConsultResult> {
  const started = Date.now();

  // We intentionally do NOT pass --output-schema. Codex's API requires every
  // nested object in the schema to set additionalProperties:false, which is
  // brittle to maintain for our shape (it includes optional fields and free-
  // form arrays). Instead we instruct JSON output via the prompt and parse
  // tolerantly with extractFinalAssistantJson() below.
  const prompt = buildPrompt(input) + '\n\nReturn the JSON object now and nothing else.';

  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-s', 'read-only',
  ];
  // Skip `-m` when the caller asks for the account default. Codex CLI then
  // uses whatever model the user's account is authorized for. Hardcoded
  // model names like `gpt-5-codex` fail with "model not supported" on
  // ChatGPT-account users, so 'default' is the safe sentinel.
  if (input.model && input.model !== 'default') args.push('-m', input.model);

  // Pass prompt via stdin to avoid arg-length limits and shell escaping.
  const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const proc = spawn('codex', args, {
      cwd: input.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', code => resolve({ stdout, stderr, code: code ?? -1 }));
    proc.on('error', reject);

    proc.stdin.write(prompt);
    proc.stdin.end();

    const timeoutMs = input.timeoutMs ?? 15 * 60 * 1000;
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      reject(new Error(`codex exec timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    proc.on('close', () => clearTimeout(timer));

    // Phase 4: honor the runtime's abort signal so a paused mission shuts
    // down Codex within a few hundred ms instead of waiting up to 15 min.
    // SIGTERM gives Codex a chance to flush any pending stdout before the
    // 'close' event fires, at which point the promise resolves with the
    // partial output. Resume continues from the next attempt.
    const onAbort = () => {
      try { proc.kill('SIGTERM'); } catch {}
      // Note: we don't reject here — let the proc.on('close') resolve with
      // the partial output. The runner sees the (truncated) result and
      // throws AbortError on its next yield to the abort-aware loop.
    };
    if (input.signal) {
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener('abort', onAbort, { once: true });
        proc.on('close', () => input.signal?.removeEventListener('abort', onAbort));
      }
    }
  });

  // If the runtime told us to abort, surface that AS abort (not as a normal
  // result) so the runner's for-loop sees a clean throw and persists a
  // checkpoint. Without this, the runner would treat the partial output as
  // a Codex response and try to extract JSON from it.
  if (input.signal?.aborted) {
    const reason = (input.signal as AbortSignal & { reason?: unknown }).reason;
    const err = new Error(typeof reason === 'string' ? `codex aborted: ${reason}` : 'codex aborted');
    (err as Error & { name: string }).name = 'AbortError';
    throw err;
  }

  if (result.code !== 0) {
    throw new Error(`codex exec exited ${result.code}: ${result.stderr.slice(-1500) || result.stdout.slice(-1500)}`);
  }

  // codex --json emits one JSON object per line for events. The final
  // assistant message is what carries our schema-conformant payload.
  const payload = extractFinalAssistantJson(result.stdout);

  if (!payload || typeof payload !== 'object') {
    return {
      verdict: 'needs-info',
      summary: `Codex returned non-JSON output. Raw last-200-chars: ${result.stdout.slice(-200)}`,
      concerns: [],
      suggestions: [],
      patches: [],
      raw: result.stdout,
      duration_ms: Date.now() - started,
    };
  }

  return {
    verdict: payload.verdict ?? 'needs-info',
    summary: payload.summary ?? '',
    concerns: Array.isArray(payload.concerns) ? payload.concerns : [],
    suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : [],
    patches: Array.isArray(payload.patches) ? payload.patches : [],
    proposal: typeof payload.proposal === 'string' ? payload.proposal : undefined,
    raw: result.stdout,
    duration_ms: Date.now() - started,
  };
}

/**
 * codex --json streams events line-by-line. Each line is a JSON object; the
 * final assistant message we care about is on a line whose `msg.type` is
 * "agent_message" (or similar). We're tolerant: scan all lines, parse what
 * we can, and look for our schema fields.
 */
function extractFinalAssistantJson(stdout: string): any {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);

  // Strategy A: walk lines bottom-up. Pull `msg.message` (assistant text) from
  // each. Try to JSON.parse it. The first one that parses to a schema-shaped
  // object wins. This handles codex putting our payload inside an event.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }

    const candidates: string[] = [];
    if (typeof evt === 'object') {
      // codex CLI ≥ 0.128 emits {"type":"item.completed","item":{"type":"agent_message","text":"..."}}.
      if (evt.item && typeof evt.item.text === 'string') candidates.push(evt.item.text);
      if (evt.item && typeof evt.item.content === 'string') candidates.push(evt.item.content);
      // Older / alternate shapes:
      if (typeof evt.message === 'string') candidates.push(evt.message);
      if (evt.msg && typeof evt.msg.message === 'string') candidates.push(evt.msg.message);
      if (evt.msg && typeof evt.msg.content === 'string') candidates.push(evt.msg.content);
      if (typeof evt.content === 'string') candidates.push(evt.content);
      if (typeof evt.text === 'string') candidates.push(evt.text);
      if (Array.isArray(evt.content)) {
        for (const c of evt.content) {
          if (typeof c === 'string') candidates.push(c);
          else if (c && typeof c.text === 'string') candidates.push(c.text);
        }
      }
    }

    for (const text of candidates) {
      const obj = tryParseJsonOrFenced(text);
      if (obj && typeof obj === 'object' && (obj.verdict || obj.summary || obj.concerns || obj.proposal)) {
        return obj;
      }
    }

    // Strategy B fallback: maybe the event itself is the payload.
    if (evt && typeof evt === 'object' && (evt.verdict || (evt.summary && evt.concerns))) return evt;
  }

  // Strategy C: try the entire stdout as a single JSON blob.
  return tryParseJsonOrFenced(stdout);
}

function tryParseJsonOrFenced(text: string): any {
  if (!text) return null;
  const trimmed = text.trim();
  // Strip ```json fences if present.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  try { return JSON.parse(candidate); } catch {}
  // Last-ditch: find first { and last } and parse that span.
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(candidate.slice(first, last + 1)); } catch {}
  }
  return null;
}
