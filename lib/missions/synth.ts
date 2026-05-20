/**
 * Mission synth — Claude (orchestrator role) + Codex (independent planner)
 * collaborate on producing a phased plan WITH a validation contract.
 *
 * Output: a Mission object embedded in a `missionPlan` JSON fence the user
 * sees in the Plan Card. Approve → run.
 */

import 'server-only';
import { spawnClaudeStream, sseChunk, sseStatus, sseDone } from '../claude-chat-bridge';
import { runCodexConsult } from '../teams/codex-consult';
import { CONTRACT_SYNTH_INSTRUCTIONS, extractMissionPlan, parseContract, checkCoverage } from './contract';
import type {
  Mission,
  MissionPhase,
  ValidationContract,
  MissionRoleConfig,
} from './types';
import { DEFAULT_ROLE_CONFIG } from './types';
import { randomUUID } from 'node:crypto';

export interface MissionSynthOptions {
  messages: any[];
  sessionKey?: string;
  workspace?: string;
  model?: string;
  permissionMode?: string;
  requestId?: string;
  chatId?: string;
  clientId?: string;
  roles?: Partial<MissionRoleConfig>;
}

export interface MissionSynthResult {
  stream: ReadableStream;
}

export function runMissionSynth(opts: MissionSynthOptions): MissionSynthResult {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (frame: string) => { try { controller.enqueue(enc.encode(frame)); } catch {} };
      const sendVoice = (v: 'claude'|'codex'|'orchestrator', p: string) =>
        send(`data: ${JSON.stringify({ type: 'agent', agent: v, phase: p })}\n\n`);
      const sendCard = (card: any) =>
        send(`data: ${JSON.stringify({ type: 'plan-card', card })}\n\n`);
      const sendText = (t: string) => send(sseChunk(t));
      const sendStatus = (s: string) => send(sseStatus(s));

      try {
        await runMissionSynthInner(opts, { sendVoice, sendCard, sendText, sendStatus });
      } catch (err: any) {
        sendVoice('orchestrator', 'final');
        sendText(`\n\n⚠️ Mission synth error: ${err?.message || String(err)}\n`);
      } finally {
        send(sseDone());
        try { controller.close(); } catch {}
      }
    },
  });
  return { stream };
}

interface SynthEmit {
  sendVoice: (v: 'claude'|'codex'|'orchestrator', p: string) => void;
  sendCard: (card: any) => void;
  sendText: (t: string) => void;
  sendStatus: (s: string) => void;
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

async function runMissionSynthInner(opts: MissionSynthOptions, emit: SynthEmit): Promise<void> {
  const userTask = lastUserText(opts.messages);
  const roles = { ...DEFAULT_ROLE_CONFIG, ...opts.roles };

  // ─ Claude (orchestrator role) drafts a phased plan WITH contract ─
  emit.sendStatus('🛰️ Mission synth — orchestrator drafting plan + validation contract…');
  const orchestratorPrompt = [
    'MISSION MODE — you are the ORCHESTRATOR.',
    '',
    'Your job RIGHT NOW: produce a phased plan AND a validation contract for the task below. Do NOT start coding.',
    '',
    '## What missions do',
    'A mission is a multi-phase build executed end-to-end without user intervention between phases.',
    '- Each phase spawns a FRESH worker (new Claude session, no inherited context drift).',
    '- After each phase, two validators run: scrutiny (static, code review) and user-testing (browser-driven QA, behavioral).',
    '- Validators check the phase\'s diff against the validation contract.',
    '- Mission Control auto-commits at every phase boundary; you don\'t need to plan commits.',
    '- Workers receive ONLY their phase\'s assigned assertions, not the full contract — keeps them focused.',
    '',
    '## Plan rules',
    '- 3–8 phases for substantial work; 1–2 for small.',
    '- Each phase has: name, spec, expected_files (when knowable), assertion_ids (the assertions THIS phase satisfies).',
    '- The UNION of all phase assertion_ids must equal the contract — no orphaned assertions.',
    '- Tests / verification commands belong IN the phase that introduces the code.',
    '- Don\'t bundle repo-wide hygiene cleanup into a feature phase. If it must happen, give it its own phase.',
    '',
    '## Contract rules — these are the ENTIRE definition of "done"',
    '- 50–200 assertions for substantial work; 10–30 for small.',
    '- Every assertion must be checkable: a `verification_command` (static) or a `behavior` flow (behavioral).',
    '- Mix static and behavioral. Behavioral catches what static can\'t (UX flow, integration, data persistence).',
    '- Critical assertions guard data integrity, security, irreversible actions.',
    '- AVOID vague: "lint clean", "tests pass", "no regressions", "production-ready".',
    '- PREFER specific: "`npx tsc --noEmit` exits 0", "POST /api/proposals returns 201 and creates a row in `proposals`", "submitting form X with valid data shows success toast within 2s".',
    '',
    '## Pre-resolve trivia in the plan',
    'Bake these defaults in directly — don\'t pause workers to ask:',
    '- Lint scope: per-glob override on owned files; don\'t demand repo-wide cleanup.',
    '- Migrations: forward-only; never edit applied migrations.',
    '- Pre-existing uncommitted work: MC auto-baselines. Don\'t plan around it.',
    '- Deployment: NO deploy phases unless the task explicitly asks for them. Deployment is post-mission.',
    '- File organization / naming: pick a sensible default matching existing code; don\'t ask.',
    '',
    CONTRACT_SYNTH_INSTRUCTIONS,
    '',
    '--- TASK ---',
    userTask,
  ].join('\n');

  const orchestratorPlan = await streamClaudePassthrough({
    prompt: orchestratorPrompt,
    sessionKey: opts.sessionKey,
    workspace: opts.workspace,
    model: roles.orchestrator.model,
    permissionMode: opts.permissionMode,
    requestId: opts.requestId,
    chatId: opts.chatId,
    clientId: opts.clientId,
    voice: { agent: 'claude', phase: 'mission-plan' },
    emit,
  });

  // ─ Codex independently produces a counter-plan focusing on contract critique ─
  emit.sendStatus('🛰️ Mission synth — Codex reviewing the contract…');
  emit.sendVoice('codex', 'mission-review');
  emit.sendText('_Codex auditing the proposed plan + contract for coverage gaps and assertion quality…_\n\n');

  const codexBrief = [
    'MISSION CONTRACT REVIEW.',
    '',
    'The orchestrator (Claude) just produced a phased mission plan WITH a validation contract.',
    'Your job: critique it for the four most common problems:',
    '1. UNVERIFIABLE assertions ("high quality", "no regressions", "tests pass") — flag and propose specific replacements.',
    '2. COVERAGE gaps — assertions in the contract that no phase claims to satisfy, or phases with no assertions assigned.',
    '3. SCOPE creep — phases bundling unrelated work (e.g. lint cleanup mixed into a feature phase).',
    '4. MISSING behavioral coverage — assertions that should be `behavioral` but were marked `static`.',
    '',
    'Return JSON: { verdict: "agree"|"agree-with-concerns"|"disagree", summary, concerns: [...], suggestions: [...] }.',
    '',
    `## Task: ${userTask}`,
    '',
    '## Orchestrator\'s draft',
    orchestratorPlan.length > 12000 ? orchestratorPlan.slice(0, 12000) + '\n…[truncated]' : orchestratorPlan,
  ].join('\n');

  let codexResult: any;
  try {
    codexResult = await runCodexConsult({
      brief: codexBrief,
      role: 'critic',
      cwd: opts.workspace || process.cwd(),
      model: roles.scrutiny.model,
    });
  } catch (e: any) {
    emit.sendText(`\n\n⚠️ Codex unreachable: ${e.message}. Proceeding with orchestrator's plan only.\n`);
    return finalizeFromText(orchestratorPlan, opts, emit, 'Mission plan (Codex review skipped)');
  }

  // Render Codex's review for visibility.
  emit.sendText(`\n### ⚡ Codex contract review\n\n**Verdict:** ${codexResult.verdict}\n\n${codexResult.summary || ''}\n\n`);
  if (codexResult.concerns?.length) {
    emit.sendText('**Concerns:**\n');
    for (const c of codexResult.concerns.slice(0, 8)) emit.sendText(`- ${c.title}${c.body ? ': ' + c.body : ''}\n`);
    emit.sendText('\n');
  }

  // ─ Orchestrator integrates Codex's feedback and produces final plan ─
  if (codexResult.verdict === 'agree') {
    return finalizeFromText(orchestratorPlan, opts, emit, 'Mission plan (Codex agreed)');
  }

  emit.sendStatus('🛰️ Mission synth — orchestrator integrating Codex feedback…');
  const integratePrompt = [
    'MISSION FINAL PLAN.',
    '',
    'You produced a draft. Codex reviewed it and raised concerns:',
    '',
    `Verdict: ${codexResult.verdict}`,
    `Summary: ${codexResult.summary}`,
    'Concerns:',
    ...(codexResult.concerns || []).map((c: any) => `- ${c.title}${c.body ? ': ' + c.body : ''}`),
    'Suggestions:',
    ...(codexResult.suggestions || []).map((s: any) => `- ${s}`),
    '',
    'Now produce the FINAL plan + contract. Address legitimate concerns. Push back on incorrect ones briefly.',
    'End with the SAME `missionPlan` JSON fence as before.',
    'Stop after the fence.',
  ].join('\n');

  const finalPlan = await streamClaudePassthrough({
    prompt: integratePrompt,
    sessionKey: opts.sessionKey,
    workspace: opts.workspace,
    model: roles.orchestrator.model,
    permissionMode: opts.permissionMode,
    requestId: opts.requestId,
    chatId: opts.chatId,
    clientId: opts.clientId,
    voice: { agent: 'claude', phase: 'mission-final' },
    emit,
  });

  return finalizeFromText(finalPlan, opts, emit, 'Mission plan (final)');
}

// ─── Finalize: extract missionPlan JSON and emit Plan Card ────────────────

function finalizeFromText(text: string, opts: MissionSynthOptions, emit: SynthEmit, label: string): void {
  const parsed = extractMissionPlan(text);
  if (!parsed) {
    emit.sendText(`\n\n⚠️ Could not find a \`missionPlan\` JSON fence in the synth output. Treating as freeform — will not be runnable as a mission until re-synthesized.\n`);
    return;
  }

  let contract: ValidationContract;
  try {
    contract = parseContract(parsed.contract);
  } catch (e: any) {
    emit.sendText(`\n\n⚠️ Contract malformed: ${e.message}. Mission cannot run.\n`);
    return;
  }

  const phases: MissionPhase[] = (Array.isArray(parsed.phases) ? parsed.phases : []).map((p: any, i: number): MissionPhase => ({
    index: typeof p?.index === 'number' ? p.index : i + 1,
    name: String(p?.name || `Phase ${i + 1}`),
    spec: String(p?.spec || ''),
    expected_files: Array.isArray(p?.expected_files) ? p.expected_files.map((x: any) => String(x)) : undefined,
    assertion_ids: Array.isArray(p?.assertion_ids) ? p.assertion_ids.map((x: any) => String(x)) : [],
    rework_cap: typeof p?.rework_cap === 'number' ? p.rework_cap : undefined,
    origin: 'plan',
  }));

  // Re-index 1..N for safety.
  phases.forEach((p, i) => { p.index = i + 1; });

  const mission: Mission = {
    id: `m-${randomUUID().slice(0, 8)}`,
    goal: String(parsed.goal || lastUserText(opts.messages).slice(0, 120)),
    preface: typeof parsed.preface === 'string' ? parsed.preface : undefined,
    phases,
    contract,
    roles: { ...DEFAULT_ROLE_CONFIG, ...opts.roles },
    rework_cap: typeof parsed.rework_cap === 'number' ? parsed.rework_cap : 5,
    cwd: opts.workspace || process.cwd(),
    target_url: typeof parsed.target_url === 'string' ? parsed.target_url : undefined,
    status: 'draft',
    created_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
  };

  // Surface coverage in the plan card.
  const coverage = checkCoverage(contract, phases);

  // Emit a Plan Card the existing client UI knows how to render. Use the
  // same shape as the autopilot Plan Card (PlanCardData) but include the
  // mission fields the client may use for an extended view.
  const card = {
    goal: mission.goal,
    approach: mission.preface || '',
    claude_points: [],
    codex_points: [],
    resolution: '',
    open_questions: [],
    signed_off: { claude: true, codex: false },
    protocol: 'mission' as const,
    phases: phases.map(p => ({
      index: p.index,
      name: p.name,
      spec: p.spec,
      exit_criteria: p.assertion_ids.map(aid => {
        const a = contract.assertions.find(x => x.id === aid);
        return a ? `[${a.id}] ${a.statement}${a.verification_command ? ` — \`${a.verification_command}\`` : ''}` : `[${aid}]`;
      }),
      expected_files: p.expected_files,
    })),
    rework_cap: mission.rework_cap,
    // Mission-specific extras the new UI can use:
    mission: {
      id: mission.id,
      contract,
      roles: mission.roles,
      target_url: mission.target_url,
      coverage: {
        total: coverage.total_assertions,
        covered: coverage.covered,
        uncovered: coverage.uncovered,
        orphaned_phase_ids: coverage.orphaned_phase_ids,
      },
    },
  };
  emit.sendCard(card);
  emit.sendText(`\n\n_${label} ready. ${phases.length} phase(s), ${contract.assertions.length} assertion(s). Click Approve to launch._\n`);
}

// ─── Streaming passthrough that reuses the bridge ────────────────────────

async function streamClaudePassthrough(args: {
  prompt: string;
  sessionKey?: string;
  workspace?: string;
  model?: string;
  permissionMode?: string;
  requestId?: string;
  chatId?: string;
  clientId?: string;
  voice: { agent: 'claude'|'codex'|'orchestrator'; phase: string };
  emit: SynthEmit;
}): Promise<string> {
  args.emit.sendVoice(args.voice.agent, args.voice.phase);
  const { stream } = spawnClaudeStream({
    prompt: args.prompt,
    sessionKey: args.sessionKey,
    workspace: args.workspace,
    model: args.model && args.model !== 'default' ? args.model : undefined,
    permissionMode: args.permissionMode,
    requestId: args.requestId,
    chatId: args.chatId,
    clientId: args.clientId,
  });

  const reader = stream.getReader();
  const dec = new TextDecoder();
  let carry = '';
  let collected = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    carry += dec.decode(value, { stream: true });
    let idx;
    while ((idx = carry.indexOf('\n\n')) >= 0) {
      const frame = carry.slice(0, idx);
      carry = carry.slice(idx + 2);
      const lines = frame.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.choices?.[0]?.delta?.content) {
            const t = parsed.choices[0].delta.content;
            collected += t;
            args.emit.sendText(t);
          } else if (parsed.type === 'status') {
            args.emit.sendStatus(parsed.status || '');
          }
        } catch {}
      }
    }
  }
  return collected.trim();
}
