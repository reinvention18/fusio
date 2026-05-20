/**
 * Plan negotiation — Full Force workflow's pre-flight stage.
 *
 * Two agents (Opus via the agent-SDK + Codex via the codex CLI) read the
 * same source material and propose Mission JSONs. They then iterate:
 *   • Round 1: parallel kickoff, neither sees the other's draft.
 *   • Round 2..N: each agent sees the other's prior view + their own,
 *     refines, and either ACCEPTs the other's plan or REVISEs.
 *   • Convergence = both agents emit `ACCEPT` in the same round.
 *   • Cap at `max_rounds` (default 4). If max hit without convergence,
 *     return whichever Mission JSON was last produced and let the user
 *     decide.
 *
 * Why two providers: training-data independence on the planning side, same
 * principle Luke argued for on validation. Anthropic and OpenAI have
 * different blind spots; the negotiation surfaces them.
 *
 * Output: a single Mission JSON ready to POST /api/missions, plus a
 * trace of every round so the user can see the back-and-forth.
 */

import 'server-only';
import { spawnClaudeStream } from '../claude-chat-bridge';
import { runCodexConsult } from '../teams/codex-consult';
import type { Mission, MissionRoleConfig } from './types';
import { DEFAULT_ROLE_CONFIG } from './types';

export interface NegotiationEmit {
  text: (s: string) => void;
  status: (s: string) => void;
  voice: (agent: 'opus' | 'codex' | 'orchestrator', phase: string) => void;
  /** Raw SSE escape — used to ship round events the dashboard can dispatch on. */
  raw?: (frame: string) => void;
  round?: (info: { round: number; opus_view: string; codex_view: string; converged: boolean }) => void;
}

export interface NegotiationOptions {
  /** What we're planning from — pasted chat, prose goal, prior plan, or
   *  any free-form description of the work. */
  source: string;
  /** Working directory the resulting mission will run in. */
  cwd: string;
  /** Optional URL the user-testing validator will navigate to. */
  target_url?: string;
  /** Per-role model config. Default uses Opus orchestrator + Codex scrutiny
   *  which is the right pair for negotiation. Worker is irrelevant here —
   *  no work is done during negotiation. */
  roles?: MissionRoleConfig;
  /** How many rounds to run before giving up on convergence. Default 4. */
  max_rounds?: number;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
  /** Optional emitter — when the caller wants to stream rounds to a UI. */
  emit?: NegotiationEmit;
}

export interface NegotiationResult {
  /** The agreed-upon (or last-produced) Mission JSON. Null if neither agent
   *  ever produced a parseable one. */
  mission: Mission | null;
  /** Every round's full text from both agents. */
  rounds: Array<{ round: number; opus_view: string; codex_view: string; converged: boolean }>;
  converged: boolean;
  /** Why we stopped. */
  reason: 'converged' | 'max-rounds' | 'extraction-failed' | 'aborted';
}

const DEFAULT_MAX_ROUNDS = 4;

export async function negotiatePlan(opts: NegotiationOptions): Promise<NegotiationResult> {
  const roles = opts.roles ?? DEFAULT_ROLE_CONFIG;
  const max = Math.max(2, Math.min(8, opts.max_rounds ?? DEFAULT_MAX_ROUNDS));
  const emit = opts.emit;

  let opusView = '';
  let codexView = '';
  const rounds: NegotiationResult['rounds'] = [];

  for (let round = 1; round <= max; round++) {
    if (opts.signal?.aborted) {
      return { mission: null, rounds, converged: false, reason: 'aborted' };
    }
    emit?.status(`🤝 Plan negotiation round ${round}/${max}`);
    emit?.text(`\n\n### Negotiation round ${round}/${max}\n\n`);

    const opusPrompt = round === 1
      ? buildKickoffPrompt('opus', opts.source, opts.cwd, opts.target_url)
      : buildRefinePrompt('opus', opts.source, opusView, codexView, round, max, opts.cwd, opts.target_url);
    const codexPrompt = round === 1
      ? buildKickoffPrompt('codex', opts.source, opts.cwd, opts.target_url)
      : buildRefinePrompt('codex', opts.source, opusView, codexView, round, max, opts.cwd, opts.target_url);

    // Both calls run in parallel — they're truly independent within a round.
    const [newOpus, newCodex] = await Promise.all([
      callOpus(opusPrompt, roles.orchestrator.model, opts.cwd, opts.signal),
      callCodex(codexPrompt, roles.scrutiny.model, opts.cwd, opts.signal),
    ]);

    opusView = newOpus;
    codexView = newCodex;

    const opusAccepted = isAccepted(opusView);
    const codexAccepted = isAccepted(codexView);
    const converged = opusAccepted && codexAccepted;

    rounds.push({ round, opus_view: opusView, codex_view: codexView, converged });
    emit?.round?.({ round, opus_view: opusView, codex_view: codexView, converged });

    if (emit) {
      emit.voice('opus', `negotiate-round-${round}`);
      emit.text(`**Opus (Anthropic):**\n\n${truncate(opusView, 4000)}\n\n`);
      emit.voice('codex', `negotiate-round-${round}`);
      emit.text(`**Codex (OpenAI):**\n\n${truncate(codexView, 4000)}\n\n`);
      emit.raw?.(`data: ${JSON.stringify({ type: 'negotiation-round', round, opus_accepted: opusAccepted, codex_accepted: codexAccepted, converged })}\n\n`);
    }

    if (converged) {
      emit?.status(`✅ Plan converged in round ${round}`);
      // Whichever view ACCEPTed should reference the canonical plan. Try
      // both — the converged mission can come from either.
      const mission = extractMission(opusView) ?? extractMission(codexView);
      return {
        mission,
        rounds,
        converged: true,
        reason: mission ? 'converged' : 'extraction-failed',
      };
    }
  }

  // Max rounds hit. Use the latest Opus mission JSON as the "winner" since
  // Opus is the configured orchestrator and will be the one running it; if
  // Opus didn't produce a valid block, fall back to Codex's.
  emit?.status(`⚠️ Plan negotiation hit max rounds (${max}) without convergence`);
  emit?.text(`\n\n_Negotiation reached round ${max} without both agents emitting ACCEPT in the same round. Using Opus's latest plan as the working draft — review the rounds above and edit the JSON if needed._\n`);
  const mission = extractMission(opusView) ?? extractMission(codexView);
  return {
    mission,
    rounds,
    converged: false,
    reason: mission ? 'max-rounds' : 'extraction-failed',
  };
}

// ─── Prompt builders ──────────────────────────────────────────────────────

function buildKickoffPrompt(role: 'opus' | 'codex', source: string, cwd: string, targetUrl?: string): string {
  const otherRole = role === 'opus' ? 'Codex' : 'Opus';
  const myProvider = role === 'opus' ? 'Anthropic Claude Opus 4.7' : 'OpenAI Codex';
  return [
    `# Plan Negotiation — Round 1 (kickoff)`,
    ``,
    `You are ${myProvider}. You are the **${role.toUpperCase()}** half of a pair-planning negotiation.`,
    `The **${otherRole}** half is reading the same source material right now in parallel and producing its own draft. Neither of you sees the other's draft yet — that comes in round 2.`,
    ``,
    `## Working directory`,
    '`' + cwd + '`',
    targetUrl ? `\n## Target URL for behavioral assertions\n\`${targetUrl}\`` : '',
    ``,
    `## Source material — what we're planning from`,
    source,
    ``,
    `## Your task this round`,
    `Read the source. Produce a mission plan you'd be happy to ship.`,
    ``,
    `Your response MUST contain these sections, in order:`,
    ``,
    `### 1. Analysis (1 paragraph)`,
    `What you understand the goal to be. Tradeoffs, risks, scope.`,
    ``,
    `### 2. Proposed phases`,
    `2-5 phases. Each phase: index, name, spec (1-2 sentences), assertion ids, origin: "plan".`,
    ``,
    `### 3. Validation contract`,
    `5-15 typed assertions. Each: id (A001, A002...), statement, type (static/behavioral), severity, verification_command (when static and obvious how to check).`,
    ``,
    `### 4. Mission JSON`,
    `A complete \`\`\`json fenced block with this Mission shape:`,
    '```json',
    `{`,
    `  "id": "TBD",`,
    `  "goal": "<one sentence>",`,
    `  "preface": "<optional 1-2 sentences of global context>",`,
    `  "phases": [`,
    `    {"index": 1, "name": "...", "spec": "...", "assertion_ids": ["A001"], "origin": "plan"}`,
    `  ],`,
    `  "contract": {`,
    `    "assertions": [`,
    `      {"id": "A001", "statement": "...", "type": "static", "severity": "high", "verification_command": "..."}`,
    `    ]`,
    `  },`,
    `  "cwd": "${cwd}",`,
    targetUrl ? `  "target_url": "${targetUrl}",` : '',
    `  "rework_cap": 5,`,
    `  "status": "approved"`,
    `}`,
    '```',
    ``,
    `### 5. Agreement`,
    `Leave this section EMPTY this round. You haven't seen the other agent's draft yet — there's nothing to accept or reject.`,
    ``,
    `Be specific. Cite files when you can. Prefer 2-4 phases over 5+; smaller plans converge faster.`,
  ].join('\n');
}

function buildRefinePrompt(role: 'opus' | 'codex', source: string, opusView: string, codexView: string, round: number, max: number, cwd: string, targetUrl?: string): string {
  const otherRole = role === 'opus' ? 'Codex' : 'Opus';
  const myView = role === 'opus' ? opusView : codexView;
  const otherView = role === 'opus' ? codexView : opusView;
  return [
    `# Plan Negotiation — Round ${round}/${max}`,
    ``,
    `You are the **${role.toUpperCase()}** half of a pair-planning negotiation. Below: the source material, your prior view, and the OTHER agent's prior view.`,
    ``,
    `## Source material`,
    source,
    ``,
    `## Your prior view (round ${round - 1})`,
    truncate(myView, 8000),
    ``,
    `## ${otherRole}'s view (round ${round - 1})`,
    truncate(otherView, 8000),
    ``,
    `## Your task this round`,
    `1. Read the other agent's plan honestly.`,
    `2. If their plan is **better than or equal to yours**: emit \`ACCEPT\` in your Agreement section AND copy THEIR Mission JSON as your final.`,
    `3. If you disagree with parts: refine your plan to incorporate the best of both. Emit \`REVISING\` in Agreement.`,
    `4. Convergence is the goal. Don't dig in for ego — credit good ideas, drop weaker ones.`,
    ``,
    `Round ${round} of ${max}. If both agents emit ACCEPT in the same round, negotiation completes. If we hit round ${max} without convergence, the user picks.`,
    ``,
    `## Output format`,
    `Your response MUST contain these sections:`,
    ``,
    `### 1. Analysis of the other agent's plan`,
    `What they got right. What they missed. (Be specific — phase ids, assertion ids.)`,
    ``,
    `### 2. Disagreements (or "none — accepting their plan")`,
    `Concrete and actionable. If you have none, say so and accept.`,
    ``,
    `### 3. Refined Mission JSON`,
    `A complete \`\`\`json block with the Mission shape (same shape as round 1). This is your accepted-or-revised plan. Whatever you put here is what the next round (or convergence) will use.`,
    ``,
    `### 4. Agreement`,
    `Write exactly one of these tokens (no other text on the line):`,
    `- \`ACCEPT\` — you accept the converged plan as-is. The Mission JSON above is final.`,
    `- \`REVISING\` — you're still iterating. The Mission JSON above is your latest proposal.`,
  ].join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Detect whether a view explicitly accepted convergence. We look for the
 *  literal token `ACCEPT` inside a `## Agreement` section, not anywhere
 *  else in the text — agents may mention "accepting" in prose without
 *  meaning convergence. */
function isAccepted(view: string): boolean {
  const m = view.match(/##?\s+Agreement[\s\S]*?(\bACCEPT\b|\bREVISING\b)/i);
  if (!m) return false;
  return m[1].toUpperCase() === 'ACCEPT';
}

function extractMission(view: string): Mission | null {
  // Same brace-counter as in /api/missions/author. Tolerant of surrounding
  // prose; finds the first balanced { … } that parses + has the required
  // mission shape.
  const fence = view.match(/```(?:json)?\s*([\s\S]*?)```/);
  let body: string | null = fence ? fence[1].trim() : null;
  if (!body) {
    const start = view.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < view.length; i++) {
      const c = view[i];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { body = view.slice(start, i + 1); break; } }
    }
  }
  if (!body) return null;
  let parsed: any;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (parsed?.error || !parsed?.goal || !Array.isArray(parsed?.phases)) return null;
  return parsed as Mission;
}

function truncate(s: string, n: number): string {
  if (!s || s.length <= n) return s;
  return s.slice(0, n) + `\n…[truncated ${s.length - n} chars]`;
}

// ─── Per-agent invocation ─────────────────────────────────────────────────

async function callOpus(prompt: string, model: string | undefined, cwd: string, signal?: AbortSignal): Promise<string> {
  const { stream } = spawnClaudeStream({
    prompt,
    sessionKey: `negotiation-opus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    workspace: cwd,
    model: model && model !== 'default' ? model : undefined,
  });
  const reader = stream.getReader();
  const onAbort = () => { try { reader.cancel(); } catch { /* ignore */ } };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const dec = new TextDecoder();
  let carry = '';
  let collected = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      carry += dec.decode(value, { stream: true });
      let idx;
      while ((idx = carry.indexOf('\n\n')) >= 0) {
        const frame = carry.slice(0, idx);
        carry = carry.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            if (parsed.choices?.[0]?.delta?.content) collected += parsed.choices[0].delta.content;
          } catch { /* skip non-content frames */ }
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return collected;
}

async function callCodex(prompt: string, model: string | undefined, cwd: string, signal?: AbortSignal): Promise<string> {
  const result = await runCodexConsult({
    brief: prompt,
    role: 'planner',
    cwd,
    model,
    timeoutMs: 10 * 60 * 1000,
    signal,
  });
  // runCodexConsult returns structured fields; for negotiation we want the
  // full text the agent produced. The `raw` field has it; everything else is
  // the consult layer's tolerant parse of the JSON-shaped response. Prefer
  // raw because the negotiation prompt asks for prose sections, not the
  // verdict-shaped JSON the consult layer expects.
  if (result.raw && result.raw.length > 200) return result.raw;
  // Fallback: assemble from the parsed bits.
  const parts: string[] = [];
  if (result.summary) parts.push(`## Summary\n${result.summary}`);
  if (result.proposal) parts.push(`## Proposal\n${result.proposal}`);
  if (result.suggestions?.length) parts.push(`## Suggestions\n${result.suggestions.map(s => `- ${s}`).join('\n')}`);
  return parts.join('\n\n').slice(0, 50_000);
}
