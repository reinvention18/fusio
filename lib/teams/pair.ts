/**
 * Pair Orchestrator — runs the chat as a duo (Claude + Codex) using one of
 * three protocols: 'consult', 'debate', 'pair-build'.
 *
 * Design contract:
 *   • Single output ReadableStream (SSE) — drop-in compatible with the existing
 *     /api/chat stream consumer in components/ChatPanel.tsx. Adds two new event
 *     types the client recognizes:
 *         { type: 'agent', agent, phase }   — voice marker (flips the bubble)
 *         { type: 'plan-card', card }       — render the synthesized Plan Card
 *   • Text output continues to use the existing OpenAI-shaped chunk:
 *         { choices: [{ delta: { content } }] }
 *   • Only ONE voice writes/edits files (Claude). Codex critiques/proposes.
 *     This guarantees a single coherent diff, never a patchwork.
 *   • No cost guards or budget caps — the user is on subscription plans.
 *
 * Auth: Codex CLI uses the existing `codex login` on this machine.
 */

import 'server-only';
import { spawnClaudeStream, sseChunk, sseStatus, sseDone } from '../claude-chat-bridge';
import { runCodexConsult, type ConsultResult, type ConsultConcern } from './codex-consult';

export type PairMode = 'consult' | 'debate' | 'pair-build' | 'autopilot';
export type Voice = 'claude' | 'codex' | 'orchestrator';
export type Phase =
  | 'plan'
  | 'critique'
  | 'rebuttal'
  | 'synth'
  | 'plan-a'
  | 'plan-b'
  | 'diff'
  | 'review'
  | 'patch'
  | 'final';

export interface PlanCardPhase {
  index: number;
  name: string;
  spec: string;
  exit_criteria: string[];
  expected_files?: string[];
}

export interface PlanCard {
  goal: string;
  approach: string;
  claude_points: string[];
  codex_points: string[];
  resolution: string;
  open_questions: string[];
  signed_off: { claude: boolean; codex: boolean };
  /** Where this plan came from, for transparency. */
  protocol: PairMode;
  /** When set, this plan is phased and can run on Autopilot. */
  phases?: PlanCardPhase[];
  /** Per-phase rework cap for autopilot. Default 3. */
  rework_cap?: number;
}

export interface PairRunOptions {
  mode: PairMode;
  /** The user's most recent message + earlier transcript. */
  messages: any[];
  sessionKey?: string;
  workspace?: string;
  model?: string;
  permissionMode?: string;
  requestId?: string;
  chatId?: string;
  clientId?: string;
  /** Domains to weight Codex's critique heavier on (race, prod-env, types, etc.). */
  focus?: string[];
}

export interface PairRunResult {
  stream: ReadableStream;
}

// ─── Public entry ─────────────────────────────────────────────────────────

export function runPair(opts: PairRunOptions): PairRunResult {
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string) => {
        try { controller.enqueue(enc.encode(chunk)); } catch { /* client gone */ }
      };
      const sendVoice = (voice: Voice, phase: Phase) => {
        send(`data: ${JSON.stringify({ type: 'agent', agent: voice, phase })}\n\n`);
      };
      const sendCard = (card: PlanCard) => {
        send(`data: ${JSON.stringify({ type: 'plan-card', card })}\n\n`);
      };
      const sendStatus = (s: string) => send(sseStatus(s));
      const sendText = (txt: string) => send(sseChunk(txt));

      try {
        switch (opts.mode) {
          case 'consult':
            await runConsult(opts, { sendVoice, sendCard, sendStatus, sendText });
            break;
          case 'debate':
            await runDebate(opts, { sendVoice, sendCard, sendStatus, sendText });
            break;
          case 'pair-build':
            await runPairBuild(opts, { sendVoice, sendCard, sendStatus, sendText });
            break;
          case 'autopilot':
            await runAutopilotSynth(opts, { sendVoice, sendCard, sendStatus, sendText });
            break;
        }
      } catch (err: any) {
        const msg = err?.message || String(err);
        sendVoice('orchestrator', 'final');
        sendText(`\n\n⚠️ Pair orchestrator error: ${msg}\n`);
      } finally {
        send(sseDone());
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return { stream };
}

// ─── Helpers shared by all protocols ──────────────────────────────────────

interface Emitters {
  sendVoice: (voice: Voice, phase: Phase) => void;
  sendCard: (card: PlanCard) => void;
  sendStatus: (s: string) => void;
  sendText: (txt: string) => void;
}

/**
 * Run a Claude turn through the existing chat bridge and forward its content
 * chunks into our outer stream, prefixed with a voice marker. Returns the
 * concatenated assistant text once the inner stream finishes.
 *
 * The bridge handles skills, MCP, mem, sessions, file tools — we don't need
 * to re-implement any of that. We just consume its SSE and re-emit text.
 */
async function streamClaudeTurn(
  promptOrMessages: { prompt: string; freshFallbackPrompt?: string },
  voiceLabel: { voice: Voice; phase: Phase },
  emit: Emitters,
  base: PairRunOptions,
): Promise<string> {
  emit.sendVoice(voiceLabel.voice, voiceLabel.phase);

  const { stream } = spawnClaudeStream({
    prompt: promptOrMessages.prompt,
    freshFallbackPrompt: promptOrMessages.freshFallbackPrompt,
    sessionKey: base.sessionKey,
    workspace: base.workspace,
    model: base.model,
    permissionMode: base.permissionMode,
    requestId: base.requestId,
    chatId: base.chatId,
    clientId: base.clientId,
  });

  const reader = stream.getReader();
  const dec = new TextDecoder();
  let carry = '';
  let collected = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    carry += chunk;

    // SSE frames are separated by blank line. Process complete frames.
    let idx;
    while ((idx = carry.indexOf('\n\n')) >= 0) {
      const frame = carry.slice(0, idx);
      carry = carry.slice(idx + 2);
      const lines = frame.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue; // we emit our own [DONE] at the very end
        try {
          const parsed = JSON.parse(payload);
          // Forward content chunks; pass through status events too so the
          // existing UI keeps showing tool activity. Skip the inner stream's
          // own type='heartbeat' to reduce noise.
          if (parsed.choices?.[0]?.delta?.content) {
            const t = parsed.choices[0].delta.content;
            collected += t;
            emit.sendText(t);
          } else if (parsed.type === 'status') {
            emit.sendStatus(parsed.status || '');
          } else if (parsed.type === 'heartbeat') {
            // ignore
          } else {
            // Forward through other event types untouched (tool-use, sub-agent)
            emit.sendText('');
            // Re-encode raw event so client still gets it
            // (sendText with empty string is a no-op, do raw here)
            // We bypass via a small dedicated emit.
            (emit as any)._raw?.(`data: ${JSON.stringify(parsed)}\n\n`);
          }
        } catch { /* incomplete JSON, ignore */ }
      }
    }
  }

  return collected.trim();
}

/**
 * Build a compressed brief of the chat history + a header that frames what
 * Codex is being asked to do. No hard cap — long heavy contexts are explicitly
 * supported per project requirements — but we trim the very oldest turns first
 * if the brief grows past ~12KB just to keep Codex's first-token latency sane.
 */
function buildBrief(args: {
  task: string;
  history: any[];
  claudeOutput?: string;
  diff?: string;
  focus?: string[];
  ask: string;
}): string {
  const parts: string[] = [];
  parts.push(`# Task`);
  parts.push(args.task);
  parts.push('');

  if (args.history.length > 0) {
    parts.push(`# Recent chat (compressed)`);
    const slice = args.history.slice(-12); // last 6 turns
    for (const m of slice) {
      const who = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'CLAUDE' : (m.role || 'OTHER').toUpperCase();
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n')
          : '';
      if (!text.trim()) continue;
      parts.push(`### ${who}`);
      parts.push(text.length > 1500 ? text.slice(0, 1500) + '\n…[truncated]' : text);
      parts.push('');
    }
  }

  if (args.claudeOutput) {
    parts.push(`# Claude's current proposal`);
    parts.push(args.claudeOutput);
    parts.push('');
  }

  if (args.diff) {
    parts.push(`# Diff under review`);
    parts.push('```diff');
    parts.push(args.diff);
    parts.push('```');
    parts.push('');
  }

  if (args.focus && args.focus.length) {
    parts.push(`# Weighted focus axes`);
    parts.push(args.focus.join(', '));
    parts.push('');
  }

  parts.push(`# What we want from you`);
  parts.push(args.ask);

  let brief = parts.join('\n');
  // Soft cap: trim oldest history if > 14KB.
  if (brief.length > 14_000) {
    brief = brief.replace(
      /# Recent chat \(compressed\)[\s\S]*?(?=# (Claude's|Diff|Weighted|What))/,
      '# Recent chat (omitted for length)\n\n',
    );
  }
  return brief;
}

function lastUserText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n');
    }
  }
  return '';
}

function renderConsultBubble(r: ConsultResult, header: string): string {
  const lines: string[] = [];
  lines.push(`### ${header}`);
  lines.push('');
  const verdictBadge = ({
    'agree': '✅ AGREE',
    'agree-with-concerns': '🟡 AGREE WITH CONCERNS',
    'disagree': '🔴 DISAGREE',
    'needs-info': '❓ NEEDS INFO',
  } as const)[r.verdict] || r.verdict;
  lines.push(`**Verdict:** ${verdictBadge}`);
  lines.push('');
  if (r.summary) {
    lines.push(r.summary);
    lines.push('');
  }
  if (r.concerns.length) {
    lines.push(`**Concerns**`);
    for (const c of r.concerns) {
      const sev = c.severity ? `[${c.severity.toUpperCase()}]` : '';
      const where = c.file ? ` _(${c.file})_` : '';
      lines.push(`- ${sev} **${c.title}**${where}`);
      if (c.body) lines.push(`  ${c.body}`);
    }
    lines.push('');
  }
  if (r.suggestions.length) {
    lines.push(`**Suggestions**`);
    for (const s of r.suggestions) lines.push(`- ${s}`);
    lines.push('');
  }
  if (r.patches.length) {
    lines.push(`**Proposed patches** (${r.patches.length})`);
    for (const p of r.patches) {
      const where = p.file ? ` \`${p.file}${p.line_start ? `:${p.line_start}` : ''}\`` : '';
      lines.push(`-${where} — ${p.rationale || 'change'}`);
      if (p.suggestion) {
        lines.push('```');
        lines.push(p.suggestion.length > 600 ? p.suggestion.slice(0, 600) + '…' : p.suggestion);
        lines.push('```');
      }
    }
    lines.push('');
  }
  if (r.proposal) {
    lines.push(`**Codex's counter-proposal**`);
    lines.push('');
    lines.push(r.proposal);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Protocol 1: CONSULT ──────────────────────────────────────────────────
// Claude drafts → Codex critiques (single round) → Claude (optionally) revises.

async function runConsult(opts: PairRunOptions, emit: Emitters): Promise<void> {
  const userTask = lastUserText(opts.messages);

  // ─ Round 1: Claude proposes ─
  emit.sendStatus('🤝 Pair: consult — Claude drafting…');
  const claudePrompt = [
    'You are working in PAIR mode with Codex (a second model who will critique your proposal).',
    'For this turn: produce a clear, concrete plan or draft for the task below. Make your reasoning explicit',
    'so Codex can spot what you missed. Cite files when relevant. Do NOT edit files yet — propose first.',
    '',
    '--- TASK ---',
    userTask,
  ].join('\n');

  const claudeOutput = await streamClaudeTurn(
    { prompt: claudePrompt },
    { voice: 'claude', phase: 'plan' },
    emit,
    opts,
  );

  // ─ Round 2: Codex critiques ─
  emit.sendStatus('🤝 Pair: consult — Codex reviewing…');
  emit.sendVoice('codex', 'critique');
  emit.sendText('_Codex is reviewing Claude\'s proposal…_\n\n');

  const brief = buildBrief({
    task: userTask,
    history: opts.messages,
    claudeOutput,
    focus: opts.focus,
    ask: 'Critique Claude\'s proposal above. Surface real gaps; agree fast if it\'s sound. Return JSON per schema.',
  });

  let codexResult: ConsultResult;
  try {
    codexResult = await runCodexConsult({
      brief,
      role: 'critic',
      focus: opts.focus,
      cwd: opts.workspace || process.cwd(),
    });
  } catch (e: any) {
    emit.sendText(`\n\n⚠️ Codex unreachable: ${e.message}. Proceeding with Claude's plan only.\n`);
    return;
  }

  emit.sendText(renderConsultBubble(codexResult, '⚡ Codex'));

  // ─ Round 3: Claude finalizes (only if there are concerns or patches) ─
  if (codexResult.verdict !== 'agree' && (codexResult.concerns.length > 0 || codexResult.patches.length > 0)) {
    emit.sendStatus('🤝 Pair: consult — Claude finalizing…');
    const finalPrompt = [
      'Codex reviewed your proposal. Now finalize.',
      '',
      'Codex verdict: ' + codexResult.verdict,
      'Codex summary: ' + codexResult.summary,
      'Codex concerns:',
      ...codexResult.concerns.map(c => `- [${c.severity}] ${c.title}${c.body ? ': ' + c.body : ''}`),
      codexResult.patches.length ? 'Codex patch suggestions:' : '',
      ...codexResult.patches.map(p => `- ${p.file ? p.file + ': ' : ''}${p.rationale || p.suggestion}`),
      '',
      'Decide: which concerns to incorporate, which to push back on, and produce the final answer/plan.',
      'If concerns are valid, integrate them. If not, explain why briefly and proceed.',
      'You may now edit files if appropriate.',
    ].join('\n');

    await streamClaudeTurn(
      { prompt: finalPrompt },
      { voice: 'claude', phase: 'final' },
      emit,
      opts,
    );
  }
}

// ─── Protocol 2: DEBATE ────────────────────────────────────────────────────
// Both produce a position → Claude rebuts/integrates → Plan Card → user approves.
// Used for design / architecture decisions, NOT for fast bugfixes.

async function runDebate(opts: PairRunOptions, emit: Emitters): Promise<void> {
  const userTask = lastUserText(opts.messages);

  // ─ Round 1A: Claude's position ─
  emit.sendStatus('🤝 Pair: debate — Claude position…');
  const claudePrompt = [
    'PAIR DEBATE MODE. Codex is producing an independent position in parallel.',
    'Write your strongest argument and approach for the task. Do NOT hedge to look balanced —',
    'the orchestrator wants two distinct positions to compare. Cite trade-offs you accept.',
    'Do NOT edit files yet.',
    '',
    '--- TASK ---',
    userTask,
  ].join('\n');

  const claudePosition = await streamClaudeTurn(
    { prompt: claudePrompt },
    { voice: 'claude', phase: 'plan-a' },
    emit,
    opts,
  );

  // ─ Round 1B: Codex's position (independent) ─
  emit.sendStatus('🤝 Pair: debate — Codex position…');
  emit.sendVoice('codex', 'plan-b');
  emit.sendText('_Codex drafting an independent plan…_\n\n');

  const codexBrief = buildBrief({
    task: userTask,
    history: opts.messages,
    focus: opts.focus,
    ask: 'Produce YOUR own plan for this task. Do NOT defer to Claude — reason from first principles. Return JSON; put your plan in the `proposal` field.',
  });

  let codexPlan: ConsultResult;
  try {
    codexPlan = await runCodexConsult({
      brief: codexBrief,
      role: 'planner',
      focus: opts.focus,
      cwd: opts.workspace || process.cwd(),
    });
  } catch (e: any) {
    emit.sendText(`\n\n⚠️ Codex unreachable: ${e.message}. Falling back to solo Claude.\n`);
    return;
  }

  if (codexPlan.proposal) {
    emit.sendText(`### ⚡ Codex's plan\n\n${codexPlan.proposal}\n\n`);
  } else {
    emit.sendText(`### ⚡ Codex's plan\n\n${codexPlan.summary || '(no proposal returned)'}\n\n`);
  }

  // ─ Round 2: Claude rebuts/synthesizes ─
  emit.sendStatus('🤝 Pair: debate — synthesizing…');
  const synthPrompt = [
    'Both you and Codex have produced positions. Now synthesize.',
    '',
    '## Your position (recap)',
    claudePosition,
    '',
    '## Codex\'s position',
    codexPlan.proposal || codexPlan.summary,
    '',
    'Tasks:',
    '1. Identify where you and Codex AGREE — that\'s the strong core.',
    '2. Identify where you DISAGREE and pick a winner with explicit reasoning.',
    '   When the disagreement involves: race conditions, prod-vs-dev divergence, concurrent state,',
    '   external auth, or anything Codex specifically flagged — Codex\'s view wins ties.',
    '   When it involves: project conventions, multi-file refactors, or long-context coherence — yours wins ties.',
    '3. Output a concrete plan that integrates the merged result.',
    '4. End with a JSON block in a ```planCard fence with these fields:',
    '   { "goal", "approach", "claude_points":[...], "codex_points":[...], "resolution", "open_questions":[...] }',
    'Do NOT edit files yet — produce the plan only. The user will approve before we write code.',
  ].join('\n');

  const synthOutput = await streamClaudeTurn(
    { prompt: synthPrompt },
    { voice: 'claude', phase: 'synth' },
    emit,
    opts,
  );

  // Extract Plan Card JSON from synthOutput.
  const card = extractPlanCard(synthOutput, 'debate');
  if (card) emit.sendCard(card);
}

// ─── Protocol 3: PAIR-BUILD ────────────────────────────────────────────────
// Plan A (Claude) → Plan B (Codex) → diff → synth → Plan Card → user approves
// → Claude writes diff → Codex reviews diff → Claude patches.

async function runPairBuild(opts: PairRunOptions, emit: Emitters): Promise<void> {
  const userTask = lastUserText(opts.messages);

  // ─ Plan A ─
  emit.sendStatus('🤝 Pair-build — plan A…');
  const planAPrompt = [
    'PAIR-BUILD MODE. You will produce a plan, then Codex produces an independent plan.',
    'After both plans land, you\'ll synthesize a single plan, the user approves, then you write the code',
    'and Codex reviews your diff. Be precise: file paths, function names, contracts.',
    'Do NOT edit files yet.',
    '',
    '--- TASK ---',
    userTask,
  ].join('\n');

  const planA = await streamClaudeTurn(
    { prompt: planAPrompt },
    { voice: 'claude', phase: 'plan-a' },
    emit,
    opts,
  );

  // ─ Plan B ─
  emit.sendStatus('🤝 Pair-build — plan B…');
  emit.sendVoice('codex', 'plan-b');
  emit.sendText('_Codex producing an independent plan…_\n\n');

  const codexBrief = buildBrief({
    task: userTask,
    history: opts.messages,
    focus: opts.focus,
    ask: 'Produce YOUR own concrete implementation plan with file paths and contracts. Return JSON; put plan markdown in `proposal`.',
  });

  let codexPlanB: ConsultResult;
  try {
    codexPlanB = await runCodexConsult({
      brief: codexBrief,
      role: 'planner',
      focus: opts.focus,
      cwd: opts.workspace || process.cwd(),
    });
  } catch (e: any) {
    emit.sendText(`\n\n⚠️ Codex unreachable: ${e.message}. Falling back to Claude solo.\n`);
    return;
  }

  emit.sendText(`### ⚡ Codex plan B\n\n${codexPlanB.proposal || codexPlanB.summary || '(empty)'}\n\n`);

  // ─ Synth ─
  emit.sendStatus('🤝 Pair-build — synthesizing plan…');
  const synthPrompt = [
    'You have two plans now. Synthesize a single coherent plan.',
    '',
    '## Plan A (yours)',
    planA,
    '',
    '## Plan B (Codex)',
    codexPlanB.proposal || codexPlanB.summary,
    '',
    'Produce the merged plan. End with a ```planCard JSON fence:',
    '{ "goal", "approach", "claude_points":[...], "codex_points":[...], "resolution", "open_questions":[...] }',
    'Stop after the plan card — the user must approve before any code is written.',
  ].join('\n');

  const synth = await streamClaudeTurn(
    { prompt: synthPrompt },
    { voice: 'claude', phase: 'synth' },
    emit,
    opts,
  );

  const card = extractPlanCard(synth, 'pair-build');
  if (card) emit.sendCard(card);

  // The actual code-write + review happens on the FOLLOW-UP turn, when the
  // user clicks Approve. That sends a new message ("approved: implement plan
  // X") with mode 'pair-build-execute' which is handled separately. This
  // keeps each turn cleanly bounded and gives the user a hard gate.
}

// ─── Protocol 4: AUTOPILOT (synthesize phased plan, surface for approval) ──
// Both produce a phased plan → Claude synthesizes → Plan Card with phases →
// user approves → autopilot route runs each phase end-to-end.

async function runAutopilotSynth(opts: PairRunOptions, emit: Emitters): Promise<void> {
  const userTask = lastUserText(opts.messages);

  // ─ Plan A (Claude) ─
  emit.sendStatus('🚦 Autopilot — Claude breaking the work into phases…');
  const claudePrompt = [
    'AUTOPILOT MODE. The user wants you and Codex to execute a phased plan end-to-end without their intervention between phases.',
    'Your job RIGHT NOW: produce a phased plan for the task below. Do NOT start coding yet.',
    '',
    'Each phase MUST have:',
    '- A short name.',
    '- A concrete spec (what the phase delivers).',
    '- An `exit_criteria` array — DIFF-VERIFIABLE items Codex can check by inspecting the phase\'s git diff alone, or by running a specific named command and checking its output.',
    '- (optional) expected_files list — concrete file paths or globs the phase is expected to modify.',
    '',
    '## Rules for exit_criteria (CRITICAL — moving criteria is the #1 cause of rework loops)',
    '',
    'Every criterion MUST be:',
    '  ✓ Specific: name the file, command, table, function, contract.',
    '  ✓ Bounded: include a scope qualifier ("for files in src/proposals/**", "for migration 2026_05_06_proposals").',
    '  ✓ Testable from the diff or a single named command.',
    '',
    'GOOD examples (diff-verifiable, can\'t be reinterpreted):',
    '  - "`npx tsc --noEmit` returns exit code 0 with zero errors"',
    '  - "Migration `2026_05_06_proposals.sql` applies cleanly with `psql -f`"',
    '  - "`npx jest src/services/proposalService` exits 0 with all tests passing"',
    '  - "Files in src/proposals/** have zero React Hooks lint warnings (`eslint --rule react-hooks/* src/proposals/**`)"',
    '  - "`grep -rn TODO src/proposals` returns 0 lines"',
    '  - "RLS policies on table `proposals` include both USING and WITH CHECK clauses (verified by SELECT from pg_policies)"',
    '',
    'BAD examples (reinterpretable across rounds — reject these):',
    '  ✗ "Lint clean" (clean for what files? what rules? globally? owned files?)',
    '  ✗ "Tests pass" (which tests? added new ones?)',
    '  ✗ "Production-ready" (subjective)',
    '  ✗ "No regressions" (impossible to verify from a diff)',
    '  ✗ "High quality code" (vibes)',
    '',
    '## Other rules for good phases',
    '- Each phase should be self-contained — no "we\'ll add tests later".',
    '- If a phase needs a CREDENTIAL or IRREVERSIBLE BUSINESS DECISION (drop prod data, etc.), list it in the criteria. Otherwise, decide it yourself.',
    '- Prefer 3-7 phases for a substantial task. Smaller tasks: 1-2 phases.',
    '- Tests/checks belong IN the phase that introduces the code, not as a final phase.',
    '- expected_files SHOULD be set when possible — Mission Control uses it to flag scope drift.',
    '- **No deploy phases** unless the user explicitly asked for deployment in the task. Phase work = code + commits only. Deployment to Vercel/EAS/OTA happens manually after the entire plan completes.',
    '',
    '## Pre-resolve trivia in the plan, not in audit',
    '',
    'The user has explicitly told us: STOP ASKING THEM QUESTIONS THE AGENTS CAN ANSWER. So:',
    '',
    '- **Lint scope**: default to per-glob rule overrides for new files (enforce on owned files; leave legacy alone). Don\'t bundle a repo-wide cleanup into a feature phase.',
    '- **Migrations**: default to forward-only patches. Never edit applied migrations.',
    '- **Pre-session uncommitted work**: MC auto-commits as baseline. Plan doesn\'t need to address it.',
    '- **Tests already deployed to staging**: keep them, don\'t revert.',
    '- **File organization / naming / structure**: pick a sensible convention (match existing repo) and move on.',
    '- **"Should we do A or B?"** where one is obviously the safer default: bake the safer default into the plan, don\'t defer to audit.',
    '',
    'If the plan is going to need a decision, EITHER:',
    '  (a) make the call now in the spec — write "this phase will use X" — so Codex audits against that specific choice, OR',
    '  (b) reserve a `needs-user-input` ONLY for: missing credentials, irreversible destructive choices, or conflicting BUSINESS requirements only the user can resolve.',
    '',
    'Do NOT defer routine engineering decisions to audit-time questions. Audit-time questions to the user are an emergency escape hatch, not a planning tool.',
    '',
    '## What Mission Control will do automatically',
    '- Pre-flight: any uncommitted working-tree changes are auto-committed as a baseline before Phase 1 starts.',
    '- Per-phase carryover: at the start of every phase (resume too), dirty work is auto-committed.',
    '- Per-phase complete: MC auto-commits the phase\'s work as `[autopilot] phase N: <name>`.',
    '- Codex audits each phase against ONLY that phase\'s own diff, not cumulative work.',
    '- Criteria are PINNED: Codex cannot add new criteria or move goalposts mid-phase.',
    '- No deploys unless the plan explicitly says so.',
    '',
    '--- TASK ---',
    userTask,
  ].join('\n');

  const claudePlan = await streamClaudeTurn(
    { prompt: claudePrompt },
    { voice: 'claude', phase: 'plan-a' },
    emit,
    opts,
  );

  // ─ Plan B (Codex) — independent phasing ─
  emit.sendStatus('🚦 Autopilot — Codex producing an independent phased plan…');
  emit.sendVoice('codex', 'plan-b');
  emit.sendText('_Codex producing an independent phased plan…_\n\n');

  const codexBrief = buildBrief({
    task: userTask,
    history: opts.messages,
    focus: opts.focus,
    ask: 'Produce YOUR own phased plan for autopilot execution. Each phase needs a name, spec, and exit_criteria array. Aim for 3-7 phases on substantial work. Include exit_criteria items that catch deferred work. Return JSON; put your full plan markdown in `proposal`.',
  });

  let codexPlan: import('./codex-consult').ConsultResult;
  try {
    codexPlan = await runCodexConsult({
      brief: codexBrief,
      role: 'planner',
      focus: opts.focus,
      cwd: opts.workspace || process.cwd(),
    });
  } catch (e: any) {
    emit.sendText(`\n\n⚠️ Codex unreachable: ${e.message}. Falling back to Claude\'s plan only.\n`);
    return;
  }
  emit.sendText(`### ⚡ Codex's phased plan\n\n${codexPlan.proposal || codexPlan.summary || '(empty)'}\n\n`);

  // ─ Synth — Claude merges both into a single phased Plan Card ─
  emit.sendStatus('🚦 Autopilot — synthesizing a single plan…');
  const synthPrompt = [
    'You and Codex have produced phased plans. Merge them.',
    '',
    '## Your phased plan (recap)',
    claudePlan,
    '',
    "## Codex's phased plan",
    codexPlan.proposal || codexPlan.summary,
    '',
    'Now produce the FINAL merged phased plan for autopilot execution.',
    'End your message with a ```planCard fenced JSON block with these fields:',
    '{ "goal", "approach", "claude_points":[...], "codex_points":[...], "resolution", "open_questions":[...],',
    '  "phases":[ { "index":1, "name":"…", "spec":"…", "exit_criteria":["…","…"], "expected_files":["…"] }, … ],',
    '  "rework_cap": 5 }',
    'Stop after the plan card. The user will click Autopilot to start execution.',
  ].join('\n');

  const synth = await streamClaudeTurn(
    { prompt: synthPrompt },
    { voice: 'claude', phase: 'synth' },
    emit,
    opts,
  );

  const card = extractPlanCard(synth, 'autopilot');
  if (card) emit.sendCard(card);
}

// ─── Plan Card extraction ─────────────────────────────────────────────────

function extractPlanCard(text: string, protocol: PairMode): PlanCard | null {
  const fenceMatch = text.match(/```planCard\s*([\s\S]*?)```/);
  if (!fenceMatch) return null;
  try {
    const obj = JSON.parse(fenceMatch[1].trim());
    const phases: PlanCardPhase[] | undefined = Array.isArray(obj.phases)
      ? obj.phases.map((p: any, i: number) => ({
          index: typeof p?.index === 'number' ? p.index : i + 1,
          name: String(p?.name || `Phase ${i + 1}`),
          spec: String(p?.spec || ''),
          exit_criteria: Array.isArray(p?.exit_criteria) ? p.exit_criteria.map((x: any) => String(x)) : [],
          expected_files: Array.isArray(p?.expected_files) ? p.expected_files.map((x: any) => String(x)) : undefined,
        }))
      : undefined;
    return {
      goal: obj.goal || '',
      approach: obj.approach || '',
      claude_points: Array.isArray(obj.claude_points) ? obj.claude_points : [],
      codex_points: Array.isArray(obj.codex_points) ? obj.codex_points : [],
      resolution: obj.resolution || '',
      open_questions: Array.isArray(obj.open_questions) ? obj.open_questions : [],
      signed_off: { claude: true, codex: false }, // Codex signs off via review on next turn
      protocol,
      phases,
      rework_cap: typeof obj.rework_cap === 'number' ? obj.rework_cap : undefined,
    };
  } catch {
    return null;
  }
}

// ─── Pair-Build EXECUTE phase (called on user approval of Plan Card) ──────

export async function runPairBuildExecute(opts: PairRunOptions & { approvedPlan: PlanCard }): Promise<PairRunResult> {
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string) => {
        try { controller.enqueue(enc.encode(chunk)); } catch {}
      };
      const sendVoice = (v: Voice, p: Phase) => send(`data: ${JSON.stringify({ type: 'agent', agent: v, phase: p })}\n\n`);
      const sendText = (t: string) => send(sseChunk(t));
      const sendStatus = (s: string) => send(sseStatus(s));
      const emit: Emitters = {
        sendVoice,
        sendCard: (c) => send(`data: ${JSON.stringify({ type: 'plan-card', card: c })}\n\n`),
        sendStatus,
        sendText,
      };

      try {
        // ── Claude implements the approved plan ──
        sendStatus('🤝 Pair-build — Claude implementing…');
        const implementPrompt = [
          'The user has APPROVED the following plan. Implement it now — edit files, run commands as needed.',
          'Be thorough. After your work, briefly summarize the diff: which files changed and why.',
          '',
          '## Approved plan',
          '```json',
          JSON.stringify(opts.approvedPlan, null, 2),
          '```',
        ].join('\n');

        const claudeWork = await streamClaudeTurn(
          { prompt: implementPrompt },
          { voice: 'claude', phase: 'patch' },
          emit,
          opts,
        );

        // ── Codex reviews the diff ──
        sendStatus('🤝 Pair-build — Codex reviewing diff…');
        sendVoice('codex', 'review');
        sendText('_Codex reviewing changes…_\n\n');

        // Pull the actual git diff so Codex sees real code, not Claude's summary.
        const diff = await readGitDiff(opts.workspace || process.cwd());

        const reviewBrief = buildBrief({
          task: lastUserText(opts.messages),
          history: opts.messages,
          claudeOutput: claudeWork,
          diff: diff.slice(0, 60_000),
          focus: opts.focus,
          ask: 'Review this diff. Catch real bugs (race, prod-env, types, security, regressions). Skip style nits.',
        });

        let review: ConsultResult;
        try {
          review = await runCodexConsult({
            brief: reviewBrief,
            role: 'reviewer',
            focus: opts.focus,
            cwd: opts.workspace || process.cwd(),
          });
        } catch (e: any) {
          sendText(`\n\n⚠️ Codex review unreachable: ${e.message}. Diff is unreviewed.\n`);
          send(sseDone());
          try { controller.close(); } catch {}
          return;
        }

        sendText(renderConsultBubble(review, '⚡ Codex review'));

        // ── If Codex flagged anything, Claude patches or contests ──
        if (review.verdict !== 'agree' && (review.concerns.length > 0 || review.patches.length > 0)) {
          sendStatus('🤝 Pair-build — Claude patching…');
          const patchPrompt = [
            'Codex reviewed your diff and flagged issues. Address them.',
            '',
            'Codex verdict: ' + review.verdict,
            'Codex concerns:',
            ...review.concerns.map(c => `- [${c.severity}] ${c.title}${c.body ? ': ' + c.body : ''}`),
            review.patches.length ? 'Codex patch suggestions:' : '',
            ...review.patches.map(p => `- ${p.file ? p.file + ': ' : ''}${p.rationale || p.suggestion}`),
            '',
            'For each: incorporate it (edit the file), or push back with reasoning. Then summarize the final state.',
          ].join('\n');

          await streamClaudeTurn(
            { prompt: patchPrompt },
            { voice: 'claude', phase: 'final' },
            emit,
            opts,
          );
        } else {
          sendVoice('orchestrator', 'final');
          sendText('\n\n✓ Codex approved Claude\'s diff. Pair-build complete.\n');
        }
      } catch (err: any) {
        sendVoice('orchestrator', 'final');
        sendText(`\n\n⚠️ Pair-build error: ${err.message}\n`);
      } finally {
        send(sseDone());
        try { controller.close(); } catch {}
      }
    },
  });

  return { stream };
}

async function readGitDiff(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const { spawn } = require('node:child_process');
    const proc = spawn('git', ['diff', '--no-color', '--unified=3'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', () => resolve(out));
    proc.on('error', () => resolve(''));
    setTimeout(() => { try { proc.kill(); } catch {}; resolve(out); }, 8000);
  });
}

// ─── Concerns helper for callers ──────────────────────────────────────────

export function summarizeConcerns(concerns: ConsultConcern[]): string {
  if (!concerns.length) return 'no concerns';
  const sev = concerns.reduce((acc: Record<string, number>, c) => {
    acc[c.severity] = (acc[c.severity] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(sev).map(([s, n]) => `${n} ${s}`).join(', ');
}
