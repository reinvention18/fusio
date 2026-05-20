/**
 * Mission runner — orchestrates Luke's three-role architecture end-to-end.
 *
 * Differences from autopilot.ts (which this builds on, doesn't replace):
 *   1. FRESH WORKER CONTEXT per phase. Each phase spawns a NEW Claude session
 *      (sessionKey = `mission:<id>:p<N>:a<A>`) so accumulated context from
 *      prior phases doesn't bias the worker.
 *   2. STRUCTURED HANDOFF schema. Workers must emit JSON conforming to
 *      Handoff; freeform summaries fail audit.
 *   3. VALIDATION CONTRACT. Phases reference assertion ids; audits verify
 *      claimed-satisfied assertions against the diff.
 *   4. PER-ROLE MODELS. Orchestrator/worker/scrutiny each have their own
 *      model setting (Opus / Sonnet / Codex by default).
 *   5. SELF-HEALING (Phase 3 hook): when audits flag uncovered assertions,
 *      orchestrator can scope follow-up phases.
 *
 * The mission runner reuses claude-chat-bridge for streaming + codex-consult
 * for scrutiny; the missions concept is the COORDINATION layer on top.
 */

import 'server-only';
import { spawnClaudeStream, sseChunk, sseStatus, sseDone } from '../claude-chat-bridge';
import { runCodexConsult } from '../teams/codex-consult';
import { spawn } from 'node:child_process';
import type {
  Mission,
  MissionPhase,
  Handoff,
  MilestoneAudit,
  AuditVerdict,
  AssertionCheck,
  HandoffIssue,
  MissionRoleConfig,
  Assertion,
} from './types';
import {
  extractHandoff,
  validateHandoff,
  HANDOFF_PROMPT_INSTRUCTIONS,
  renderHandoffForAudit,
} from './handoff';
import {
  assertionsForPhase,
  renderAssertionsForWorker,
  checkCoverage,
} from './contract';
import { DEFAULT_ROLE_CONFIG } from './types';
import { runUserTestingValidation } from './validators/user-testing';
import { selfHeal } from './self-heal';
import type { BehavioralCheck } from './types';

// ─── Public entry ─────────────────────────────────────────────────────────

export interface MissionRunOptions {
  mission: Mission;
  /** Recent chat history for context. */
  messages?: any[];
  /** Per-mission overrides — replaces fields in mission.roles. */
  role_overrides?: Partial<MissionRoleConfig>;
  /** Override rework cap (e.g. when retrying after stuck). */
  override_rework_cap?: number;
  /** Resume hints. */
  resume_from_phase?: number;
  resume_from_attempt?: number;
  /** User answer to a prior paused-question. */
  pendingUserAnswer?: { phase_index: number; answer: string };
  /** Cross-tab broadcast / persistence ids. */
  chatId?: string;
  clientId?: string;
  requestId?: string;
  /** Phase 4: abort signal for cooperative cancellation. The background
   *  runtime aborts this when a user pauses the mission; runner.ts plumbs
   *  it through to streamClaudeTurn / runCodexConsult so in-flight API
   *  calls can return early. Optional for legacy SSE callers. */
  abortSignal?: AbortSignal;
}

export interface MissionRunResult {
  stream: ReadableStream;
}

export function runMission(opts: MissionRunOptions): MissionRunResult {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = makeEmitter(controller, enc);
      try {
        await runMissionInner(opts, emit);
      } catch (err: any) {
        emit.voice('orchestrator', 'final');
        emit.text(`\n\n⚠️ Mission runner error: ${err?.message || String(err)}\n`);
      } finally {
        emit.raw(sseDone());
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return { stream };
}

// ─── Emitter ──────────────────────────────────────────────────────────────

interface Emit {
  voice: (agent: 'claude' | 'codex' | 'orchestrator', phase: string) => void;
  text: (t: string) => void;
  status: (s: string) => void;
  raw: (frame: string) => void;
  phaseEvt: (
    index: number,
    total: number,
    name: string,
    status: 'start' | 'audit' | 'rework' | 'complete' | 'stuck' | 'followup',
    extra?: Record<string, unknown>,
  ) => void;
  question: (index: number, question: string, audit_summary: string, audit?: unknown) => void;
  finish: (summary: string) => void;
  audit: (a: MilestoneAudit) => void;
  contract_progress: (covered: number, total: number) => void;
}

function makeEmitter(controller: ReadableStreamDefaultController, enc: TextEncoder): Emit {
  const send = (frame: string) => { try { controller.enqueue(enc.encode(frame)); } catch {} };
  return {
    voice: (agent, phase) => send(`data: ${JSON.stringify({ type: 'agent', agent, phase })}\n\n`),
    text: (t) => send(sseChunk(t)),
    status: (s) => send(sseStatus(s)),
    raw: (frame) => send(frame),
    phaseEvt: (index, total, name, status, extra) => send(
      `data: ${JSON.stringify({ type: 'mission-phase', index, total, name, status, ...(extra || {}) })}\n\n`,
    ),
    question: (index, question, audit_summary, audit) => send(
      `data: ${JSON.stringify({ type: 'mission-question', index, question, audit_summary, audit })}\n\n`,
    ),
    finish: (summary) => send(`data: ${JSON.stringify({ type: 'mission-finish', summary })}\n\n`),
    audit: (a) => send(`data: ${JSON.stringify({ type: 'mission-audit', audit: a })}\n\n`),
    contract_progress: (covered, total) => send(`data: ${JSON.stringify({ type: 'mission-coverage', covered, total })}\n\n`),
  };
}

/** Phase 4: persistent emitter. Writes every event to the mission's
 *  append-only log. Sync→async race: the Emit interface is sync (the
 *  runner doesn't await every emit mid-loop) but appendEvent is async.
 *  We chain each call onto a per-mission tail promise so callers that
 *  need a consistent log view — namely the runtime's terminal-status
 *  decision logic — can `await drainEmitterPending(missionId)` first. */
const PENDING_PER_MISSION = new Map<string, Promise<unknown>>();

export async function drainEmitterPending(missionId: string): Promise<void> {
  const p = PENDING_PER_MISSION.get(missionId);
  if (p) await p.catch(() => undefined);
}

export function makeLogEmitter(missionId: string): Emit {
  // Lazy-import to keep the module graph for SSE-only callers small.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { appendEvent } = require('./event-log') as typeof import('./event-log');
  // Each call serializes behind any prior pending append for this mission,
  // so once drainEmitterPending() resolves the log is fully flushed.
  const fire = (type: string, payload: unknown) => {
    const prev = PENDING_PER_MISSION.get(missionId) ?? Promise.resolve();
    const next = prev.then(() => appendEvent(missionId, { type: type as any, payload })).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[mission ${missionId}] event-log append failed:`, err);
    });
    PENDING_PER_MISSION.set(missionId, next);
  };
  return {
    voice: (agent, phase) => fire('voice', { agent, phase }),
    text: (t) => fire('text', { text: t }),
    status: (s) => fire('status', { status: s }),
    // 'raw' is an SSE-specific escape hatch for pre-formatted frames coming
    // out of streamClaudeTurn. In the log world we capture them as text
    // events with a marker so the SSE subscriber knows to pass them through.
    raw: (frame) => fire('text', { text: frame, raw_sse: true }),
    phaseEvt: (index, total, name, status, extra) => fire(`phase.${status}`, { index, total, name, ...(extra || {}) }),
    question: (index, question, audit_summary, audit) => fire('question', { index, question, audit_summary, audit }),
    finish: (summary) => fire('finish', { summary }),
    audit: (a) => fire('audit', { audit: a }),
    contract_progress: (covered, total) => fire('contract_progress', { covered, total }),
  };
}

// ─── Inner ────────────────────────────────────────────────────────────────

/** Phase 4: exported so the background runtime (runtime.ts) can run a
 *  mission with a custom Emit (log-backed) instead of the SSE-stream path.
 *  The legacy `runMission(opts)` wrapper above stays for direct SSE use. */
export async function runMissionWithEmit(opts: MissionRunOptions, emit: Emit): Promise<void> {
  return runMissionInner(opts, emit);
}

async function runMissionInner(opts: MissionRunOptions, emit: Emit): Promise<void> {
  const m = opts.mission;
  const roles = { ...DEFAULT_ROLE_CONFIG, ...m.roles, ...opts.role_overrides };

  // Phase 9: surface role-config warnings (e.g. scrutiny on same provider as
  // worker = correlation bias). Non-blocking — the user can ignore them, but
  // they show up at mission start so they're impossible to miss.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const roleConfig = require('./role-config') as typeof import('./role-config');
  const resolved = roleConfig.resolveRoleConfig(m, opts.role_overrides);
  for (const w of resolved.warnings) {
    emit.text(`\n⚠️ ${w}\n`);
  }
  const total = m.phases.length;
  const reworkCap = opts.override_rework_cap ?? m.rework_cap ?? 5;
  const cwd = m.cwd;
  const startFromIdx = Math.max(1, opts.resume_from_phase ?? 1);
  const isResume = !!opts.resume_from_phase;

  // Coverage sanity at run-start — if synth produced an under-covered plan,
  // surface it before we burn worker cycles. Doesn't block; informational.
  const coverage = checkCoverage(m.contract, m.phases);
  emit.contract_progress(0, coverage.total_assertions);

  emit.voice('orchestrator', 'final');
  if (isResume) {
    emit.text(`\n↻ **Mission resuming** — Phase ${startFromIdx}/${total}${opts.resume_from_attempt ? ` (attempt ${opts.resume_from_attempt + 1})` : ''}.\n\n`);
  } else {
    emit.text(`\n🛰️ **Mission starting** — "${m.goal}"\n\n`);
    emit.text(`**Plan:** ${total} phase${total === 1 ? '' : 's'} · **Contract:** ${m.contract.assertions.length} assertion${m.contract.assertions.length === 1 ? '' : 's'} · **Rework cap:** ${reworkCap}/phase\n\n`);
    emit.text(`**Roles:**\n- Orchestrator: \`${roles.orchestrator.model}\`\n- Worker: \`${roles.worker.model}\` (fresh session per phase)\n- Scrutiny: \`${roles.scrutiny.model}\` (different provider — adversarial)\n\n`);
    if (coverage.uncovered.length > 0) {
      emit.text(`⚠️ **Coverage gap:** ${coverage.uncovered.length} assertion(s) are not assigned to any phase: ${coverage.uncovered.slice(0, 8).join(', ')}${coverage.uncovered.length > 8 ? '…' : ''}. Self-healing will scope follow-ups for these.\n\n`);
    }
    if (coverage.orphaned_phase_ids.length > 0) {
      emit.text(`⚠️ **Orphan phases:** ${coverage.orphaned_phase_ids.join(', ')} have no assertions assigned. They will execute but won't move the contract forward.\n\n`);
    }
  }

  let satisfiedSoFar = new Set<string>();

  for (let i = startFromIdx; i <= total; i++) {
    const phase = m.phases[i - 1];
    if (!phase) continue;

    emit.phaseEvt(phase.index, total, phase.name, 'start', {
      assertion_ids: phase.assertion_ids,
      worker_model: roles.worker.model,
    });
    emit.status(`🚦 Phase ${phase.index}/${total}: ${phase.name}`);

    // Carryover commit (auto-baseline the working tree before this phase).
    await carryoverCommit(cwd, phase.index, phase.name, i === 1 && !isResume, emit);

    const headBefore = await readGitHead(cwd);
    const phaseAssertions = assertionsForPhase(m.contract, phase);
    const phaseCap = phase.rework_cap ?? reworkCap;

    let attempt = isResume && i === opts.resume_from_phase && typeof opts.resume_from_attempt === 'number'
      ? Math.max(0, opts.resume_from_attempt)
      : 0;
    const auditHistory: string[] = [];
    let priorConcerns: string[] = opts.pendingUserAnswer && opts.pendingUserAnswer.phase_index === phase.index
      ? [`User answered an outstanding question: "${opts.pendingUserAnswer.answer}". Use this to proceed.`]
      : [];
    if (opts.pendingUserAnswer?.phase_index === phase.index) opts.pendingUserAnswer = undefined;

    let phaseDone = false;
    while (!phaseDone) {
      attempt++;
      if (attempt > phaseCap) {
        emit.phaseEvt(phase.index, total, phase.name, 'stuck', {
          rework_cap: phaseCap,
          attempts_used: attempt - 1,
          resume_attempt: attempt - 1,
          audit_history: auditHistory,
          last_concerns: priorConcerns,
        });
        emit.voice('orchestrator', 'final');
        emit.text(`\n\n⛔ **Phase ${phase.index} stuck** — exceeded ${phaseCap} attempts. Pausing for your call.\n`);
        return;
      }

      // ── Worker turn — FRESH SESSION ──
      // This is the critical missions discipline: a new sessionKey means a
      // Phase-10 prompt caching: session key is per-PHASE, not per-attempt.
      // The agent-SDK resumes the same session for attempts 2-N, which lets
      // Anthropic's API auto-cache the stable system-prompt + skill bundle
      // + mission goal/contract — only the new priorConcerns + handoff are
      // fresh-billed. Cuts cost on rework rounds by ~70-90%. Per-phase
      // isolation is preserved (phase 2 starts a new session) so Luke's
      // "fresh context per phase" principle is intact; only the
      // attempt-level "fresh per attempt" is traded for the cache hit.
      // The trade is strictly informational: a rework worker now SEES its
      // own prior attempt and Codex's verdict in context, which is more
      // signal, not less.
      const workerSessionKey = `mission:${m.id}:p${phase.index}`;
      emit.status(`🛠 Phase ${phase.index} — worker starting (attempt ${attempt}/${phaseCap}${attempt > 1 ? ', cached prefix' : ''})`);
      emit.voice('claude', `phase-${phase.index}-impl-a${attempt}`);

      const workerPrompt = await buildWorkerPrompt(m, phase, phaseAssertions, attempt, priorConcerns);
      // Phase 11: pair-worker mode. When the phase asks for it, Worker A
      // (Anthropic, the configured worker model) runs in parallel with a
      // Codex consultant ("Worker B") that produces a read-only alternative
      // approach + critique of the spec. Both fire concurrently. Codex
      // can't edit files (read-only sandbox by design) so there's no
      // conflict between the two. Worker B's output is captured as
      // `handoff.codex_perspective` and surfaced to scrutiny.
      const isPair = phase.worker_concurrency === 'pair';
      let pairCodexPerspective: string | undefined;
      let pairCodexError: string | undefined;
      const workerAPromise = streamClaudeTurn({
        prompt: workerPrompt,
        sessionKey: workerSessionKey,
        cwd,
        chatId: opts.chatId,
        clientId: opts.clientId,
        requestId: opts.requestId,
        emit,
        worker_model: roles.worker.model,
        signal: opts.abortSignal,
        // Phase 10: accumulate per-mission token usage. Best-effort: if the
        // claude bridge stops emitting usage frames the counter just stops
        // moving — we never block on it.
        onUsage: ({ usage, cost }) => {
          accumulateMissionUsage(m.id, usage, cost).catch(() => undefined);
          // Surface a small status pulse so the dashboard's coverage row
          // can update to "Tokens used: X.X k" without an extra API call.
          (emit as { raw?: (frame: string) => void }).raw?.(
            `data: ${JSON.stringify({ type: 'mission-usage', usage, cost })}\n\n`,
          );
        },
      });

      const workerBPromise = isPair
        ? (async () => {
            emit.voice('codex', `phase-${phase.index}-coworker-a${attempt}`);
            emit.text(`\n\n🤝 **Pair-worker mode** — Codex co-worker analyzing the same brief in parallel (read-only)…\n`);
            (emit as { raw?: (frame: string) => void }).raw?.(
              `data: ${JSON.stringify({ type: 'pair-worker-fanout', phase: phase.index, attempt })}\n\n`,
            );
            try {
              const coworkerBrief = buildCoworkerBrief(m, phase, phaseAssertions, attempt, priorConcerns);
              const result = await runCodexConsult({
                brief: coworkerBrief,
                // 'planner' is the closest existing role — produces alternative
                // approach + risks rather than reviewing a finished diff.
                role: 'planner',
                cwd,
                model: roles.scrutiny.model, // reuse scrutiny model — both are Codex
                timeoutMs: 15 * 60 * 1000,
                signal: opts.abortSignal,
              });
              return result.summary || result.proposal || result.raw || '(no perspective returned)';
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              return `__codex_error__:${message}`;
            }
          })()
        : Promise.resolve<string | undefined>(undefined);

      // Wait for both. Worker A is the canonical implementation; Worker B
      // is informational. If Worker B errors, we surface that to the user
      // but DO NOT block the mission — Worker A continues either way.
      const [workerOutput, coworkerOutput] = await Promise.all([workerAPromise, workerBPromise]);
      if (typeof coworkerOutput === 'string') {
        if (coworkerOutput.startsWith('__codex_error__:')) {
          pairCodexError = coworkerOutput.slice('__codex_error__:'.length);
          emit.text(`\n⚠️ Codex co-worker errored: ${pairCodexError}. Mission continues with Worker A only.\n`);
        } else {
          pairCodexPerspective = coworkerOutput;
          emit.text(`\n📑 **Codex co-worker perspective** (will be attached to the handoff for scrutiny):\n\n${coworkerOutput.slice(0, 4000)}${coworkerOutput.length > 4000 ? '\n…[truncated]' : ''}\n\n`);
        }
      }

      // Phase 4: if the runtime aborted while we were waiting on the worker,
      // the streamClaudeTurn call would have already thrown. Just in case
      // (e.g., abort fires between the await and the next statement), bail
      // here so we don't run scrutiny on a partial handoff.
      if (opts.abortSignal?.aborted) {
        emit.text(`\n\n⏸️ Mission aborted during Phase ${phase.index} attempt ${attempt}. Persisting checkpoint.\n`);
        emit.phaseEvt(phase.index, total, phase.name, 'stuck', { reason: 'aborted' });
        return;
      }

      // ── Parse + pre-validate the handoff ──
      const handoff = extractHandoff(workerOutput);
      // Phase 11 pair mode: attach Codex's co-worker perspective so the
      // audit brief has both viewpoints. Field is optional on Handoff.
      if (handoff && pairCodexPerspective) {
        handoff.codex_perspective = pairCodexPerspective;
      }
      const handoffCheck = validateHandoff(handoff, phase.index);
      if (!handoffCheck.valid) {
        emit.voice('orchestrator', 'final');
        emit.text(`\n\n🟡 Handoff invalid — rework forced without burning a scrutiny cycle:\n`);
        for (const b of handoffCheck.blockers) emit.text(`- ${b}\n`);
        emitOrchestratorDecision(
          emit, phase.index, attempt, 'reject-handoff',
          `Worker handoff failed schema validation (${handoffCheck.blockers.length} blockers).`,
          'Loop back to worker for re-emit; no scrutiny cycle burned.',
          { blockers: handoffCheck.blockers },
        );
        priorConcerns = [
          'Re-emit a valid `\`\`\`handoff` JSON block per the schema. Specifically:',
          ...handoffCheck.blockers,
        ];
        continue;
      }

      // ── Phase 11: wait on declared child missions ──
      // If this phase was authored to spawn child missions, the parent's
      // worker phase ends here and we block until every child reaches a
      // terminal status. Children must be created + started by the worker
      // (e.g. via POST /api/missions). We just wait + judge.
      if (phase.blocks_on_child_missions?.length) {
        emit.status(`👶 Phase ${phase.index} — waiting on ${phase.blocks_on_child_missions.length} child mission(s)`);
        emit.text(`\n\n👶 Awaiting child missions: ${phase.blocks_on_child_missions.map(id => `\`${id.slice(0, 8)}\``).join(', ')}\n\n`);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const rt = require('./runtime') as typeof import('./runtime');
        const childResults = await rt.waitForChildMissions(phase.blocks_on_child_missions, { signal: opts.abortSignal }).catch((err: any) => {
          if (err?.name === 'AbortError' || opts.abortSignal?.aborted) return null;
          throw err;
        });
        if (childResults === null) {
          emit.text(`\n\n⏸️ Mission aborted while waiting on children.\n`);
          emit.phaseEvt(phase.index, total, phase.name, 'stuck', { reason: 'aborted' });
          return;
        }
        const failed = childResults.filter(r => r.status !== 'completed');
        if (failed.length > 0) {
          emit.text(`\n\n⚠️ Child mission(s) ended non-success: ${failed.map(f => `${f.id.slice(0, 8)}=${f.status}`).join(', ')}\n`);
          emitOrchestratorDecision(
            emit, phase.index, attempt, 'broker-conflict',
            `${failed.length} child mission(s) did not complete.`,
            `Parent phase paused; user decides whether to discard children, retry, or rescope.`,
            { failed_children: failed },
          );
          emit.question(phase.index, `Child mission(s) ${failed.map(f => f.id).join(', ')} ended in non-success status. Discard, retry, or rescope?`, 'Phase 11 child-mission orchestration', { failed_children: failed });
          return;
        }
        emit.text(`\n\n✅ All ${childResults.length} child mission(s) completed.\n`);
      }
      if (handoffCheck.warnings.length) {
        for (const w of handoffCheck.warnings) emit.text(`\n_${w}_\n`);
      }

      // ── Scrutiny audit ──
      emit.phaseEvt(phase.index, total, phase.name, 'audit', { attempt });
      emit.status(`⚖️ Phase ${phase.index} — scrutiny audit`);
      emit.voice('codex', `phase-${phase.index}-audit-a${attempt}`);
      emit.text('_Scrutiny validator running…_\n\n');

      const cwdIsGit = await isGitRepo(cwd);
      const diff = cwdIsGit ? await readGitDiff(cwd, headBefore || 'HEAD') : '';
      // Phase-9 fix: independently run each static assertion's
      // verification_command and feed exit codes + tail of stdout/stderr
      // to scrutiny as ground truth. This is what makes the audit work
      // for non-git cwds AND for cases where the diff alone (e.g.
      // "vitest run" passes/fails) doesn't tell the whole story.
      const verificationRuns = await runVerificationCommands(phaseAssertions, cwd, opts.abortSignal);
      if (verificationRuns.length > 0) {
        const failedRuns = verificationRuns.filter(r => r.exit_code !== 0);
        emit.text(`_Verification commands: ${verificationRuns.length} run, ${failedRuns.length} non-zero exit. Codex will see exit codes + output excerpts._\n`);
      }
      const lanes = planScrutinyLanes(m, phase, phaseAssertions, handoff!, diff, attempt, auditHistory, verificationRuns, cwdIsGit);

      let codexResult: any;
      try {
        if (lanes.length > 1) {
          // Phase 6: surface the fan-out so the dashboard renders "N parallel
          // reviewers" instead of one silent multi-minute Codex call.
          emit.text(`_Scrutiny fan-out: **${lanes.length} parallel reviewers** auditing in parallel…_\n\n`);
          (emit as any).raw?.(`data: ${JSON.stringify({ type: 'scrutiny-fanout', count: lanes.length, phase: phase.index, attempt })}\n\n`);
        }
        const fan = await runScrutinyFanout({
          lanes,
          cwd,
          model: roles.scrutiny.model,
          timeoutMs: 20 * 60 * 1000,
          signal: opts.abortSignal,
        });
        if (!fan.merged) {
          // Every lane failed. Treat as scrutiny-unreachable.
          throw new Error(fan.per_lane.map(l => `${l.label}: ${l.error || 'no result'}`).join(' · '));
        }
        codexResult = fan.merged;
        // Surface partial-failure transparency: if some lanes errored but the
        // merged result is usable, log the lanes that didn't complete.
        const failedLanes = fan.per_lane.filter(l => !l.result);
        if (failedLanes.length > 0 && lanes.length > 1) {
          emit.text(`\n⚠️ ${failedLanes.length}/${lanes.length} scrutiny lane(s) failed; merged verdict from the rest. Failed: ${failedLanes.map(l => l.label).join(', ')}.\n`);
        }
      } catch (err: any) {
        if (err?.name === 'AbortError' || opts.abortSignal?.aborted) {
          emit.text(`\n\n⏸️ Mission aborted during scrutiny on Phase ${phase.index}. Persisting checkpoint.\n`);
          emit.phaseEvt(phase.index, total, phase.name, 'stuck', { reason: 'aborted' });
          return;
        }
        emit.text(`\n⚠️ Scrutiny unreachable: ${err.message}. Pausing.\n`);
        emit.phaseEvt(phase.index, total, phase.name, 'stuck', { reason: 'scrutiny-unreachable' });
        return;
      }

      const audit = synthesizeAudit(handoff!, codexResult, phaseAssertions, phase, attempt);
      emit.audit(audit);
      emit.text(renderAuditBubble(audit));

      auditHistory.push(`Attempt ${attempt}: ${audit.verdict} — ${audit.summary.slice(0, 200)}`);

      // ── Decide next step ──
      if (audit.verdict === 'phase-complete') {
        // ── Phase 2: user-testing validator ──
        // Scrutiny passed the static side. Now exercise the running app
        // against any behavioral assertions this phase owns. Failures send
        // the phase back to rework with directives that cite which behavioral
        // assertion failed and what the QA agent observed.
        const behavioralAssertions = phaseAssertions.filter(a => a.type === 'behavioral');
        let behavioralChecks: BehavioralCheck[] = [];
        if (behavioralAssertions.length > 0) {
          emit.status(`🌐 Phase ${phase.index} — user-testing validator (${behavioralAssertions.length} behavioral)`);
          behavioralChecks = await runUserTestingValidation({
            mission: m,
            phase,
            assertions: behavioralAssertions,
            worker_session_id: workerSessionKey,
            qa_model: roles.user_testing.model,
            signal: opts.abortSignal,
            emit: {
              voice: emit.voice,
              text: emit.text,
              status: emit.status,
              raw: emit.raw,
            },
          });
          // Annotate the audit with behavioral results so downstream UI sees them.
          audit.behavioral_checks = behavioralChecks;

          // Any unsatisfied (or inconclusive on a critical/high assertion)
          // behavioral check forces rework. Skipped checks are tolerated
          // because they're a configuration gap, not a code bug.
          const failed = behavioralChecks.filter(b =>
            b.status === 'unsatisfied' ||
            (b.status === 'inconclusive' && (() => {
              const a = behavioralAssertions.find(x => x.id === b.assertion_id);
              return a?.severity === 'critical' || a?.severity === 'high';
            })())
          );
          if (failed.length > 0) {
            emit.text(`\n🔁 User-testing flagged ${failed.length} behavioral assertion(s) — sending phase back.\n`);
            audit.verdict = 'needs-rework';
            audit.summary = (audit.summary ? audit.summary + ' · ' : '')
              + `User-testing failed: ${failed.map(f => f.assertion_id).join(', ')}`;
            const directives = failed.map(f => {
              const a = behavioralAssertions.find(x => x.id === f.assertion_id);
              return `Behavioral [${f.assertion_id}] failed in user-testing: ${a?.statement}. QA observed: ${f.evidence || '(no evidence captured)'}. Fix the underlying behavior; the static diff was clean but the running flow doesn\'t satisfy the expected outcome.`;
            });
            audit.rework_directive = [...directives, ...audit.rework_directive];
            // Re-emit the audit with the updated verdict.
            emit.audit(audit);

            priorConcerns = [
              ...directives,
              ...(audit.concerns || []).map(c => `[${c.severity}] ${c.title}${c.body ? ': ' + c.body : ''}`),
            ];
            emit.phaseEvt(phase.index, total, phase.name, 'rework', { attempt, reason: 'user-testing-failed' });
            emit.voice('orchestrator', 'final');
            emit.text(`\n\n🔁 Rework attempt ${attempt}/${phaseCap} for Phase ${phase.index}. ${priorConcerns.length} item(s) to address (including behavioral failures).\n\n`);
            // Loop back — don't commit, don't advance.
            continue;
          }
        }

        // Update mission-level satisfied set (now includes behavioral passes).
        for (const c of audit.assertion_checks) {
          if (c.status === 'satisfied') satisfiedSoFar.add(c.assertion_id);
        }
        for (const b of behavioralChecks) {
          if (b.status === 'satisfied') satisfiedSoFar.add(b.assertion_id);
        }
        emit.contract_progress(satisfiedSoFar.size, m.contract.assertions.length);

        const commitResult = await autopilotCommit(
          cwd,
          `[mission:${m.id}] phase ${phase.index}: ${phase.name} (${attempt} attempt${attempt === 1 ? '' : 's'})`,
        );
        emit.phaseEvt(phase.index, total, phase.name, 'complete', {
          attempts: attempt,
          commit_hash: commitResult.hash,
          satisfied_assertions: handoff!.satisfied_assertions,
          behavioral_checks: behavioralChecks,
        });
        // Phase 10: write a milestone checkpoint so a crash mid-mission
        // can resume from this exact spot without replaying the event log.
        // Best-effort — failure to checkpoint doesn't fail the phase.
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const ckpt = require('./checkpoints') as typeof import('./checkpoints');
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const persistence = require('./persistence') as typeof import('./persistence');
          const liveState = await persistence.loadMission(m.id);
          if (liveState) {
            await ckpt.writeCheckpoint(m.id, liveState, `after-phase-${phase.index}-${phase.name}`).catch(() => undefined);
          }
        } catch { /* checkpointing is opportunistic */ }
        emitOrchestratorDecision(
          emit, phase.index, attempt, 'advance',
          `Handoff valid + every assertion satisfied (scrutiny + ${behavioralChecks.length} behavioral check${behavioralChecks.length === 1 ? '' : 's'}).`,
          phase.index < total ? `Advance to Phase ${phase.index + 1}.` : `Mission complete — final coverage check next.`,
          {
            satisfied_assertions: handoff!.satisfied_assertions,
            coverage: { covered: satisfiedSoFar.size, total: m.contract.assertions.length },
            commit_hash: commitResult.hash,
          },
        );
        const commitLine = commitResult.hash
          ? `\n📦 Phase ${phase.index} committed as \`${commitResult.hash.slice(0, 8)}\`. Coverage: ${satisfiedSoFar.size}/${m.contract.assertions.length} assertions.\n`
          : `\n_(no file changes to commit)_\n`;
        emit.text(`\n\n✓ Phase ${phase.index} complete. Proceeding to Phase ${phase.index + 1}.\n${commitLine}\n`);
        phaseDone = true;
        break;
      }

      if (audit.verdict === 'needs-user-input') {
        emit.phaseEvt(phase.index, total, phase.name, 'rework', {
          attempt,
          reason: 'needs-user-input',
          resume_attempt: attempt,
          audit_history: auditHistory,
        });
        emit.question(phase.index, audit.user_question || 'Codex needs your input.', audit.summary, {
          ...audit,
          resume_attempt: attempt,
          audit_history: auditHistory,
        });
        emitOrchestratorDecision(
          emit, phase.index, attempt, 'pause-for-user',
          audit.summary || 'Scrutiny escalated to needs-user-input.',
          'Mission paused. Resume via /api/missions/<id>/resume with `user_answer` in the body.',
          { user_question: audit.user_question, audit_concerns_count: audit.concerns?.length ?? 0 },
        );
        emit.text(`\n\n⏸️ **Mission paused** — needs your input on Phase ${phase.index}.\n`);
        return;
      }

      // verdict = needs-rework — continue with a directive
      emit.phaseEvt(phase.index, total, phase.name, 'rework', { attempt });
      priorConcerns = [
        ...audit.rework_directive,
        ...(audit.concerns || []).map(c => `[${c.severity}] ${c.title}${c.body ? ': ' + c.body : ''}`),
      ];
      emitOrchestratorDecision(
        emit, phase.index, attempt, 'rework',
        audit.summary || `Scrutiny flagged ${priorConcerns.length} item(s) for rework.`,
        `Worker re-attempts with ${priorConcerns.length} directive(s); cap remaining: ${phaseCap - attempt}.`,
        { directive_count: priorConcerns.length, attempts_remaining: phaseCap - attempt },
      );
      emit.text(`\n\n🔁 Rework attempt ${attempt}/${phaseCap} for Phase ${phase.index}. ${priorConcerns.length} item(s) to address.\n\n`);
    }
  }

  // ── End-of-mission: self-heal any remaining unsatisfied assertions ──
  // The mission iterator (the for-loop above) operates over m.phases. Each
  // self-heal pass appends new phases AND extends `total` so the loop picks
  // them up. We bound the number of healing rounds to prevent infinite churn.
  const finalCoverage = checkCoverage(m.contract, m.phases);
  emit.contract_progress(satisfiedSoFar.size, m.contract.assertions.length);

  const allMissionAssertionIds = m.contract.assertions.map(a => a.id);
  let missingFromExecution = allMissionAssertionIds.filter(id =>
    !satisfiedSoFar.has(id) && !finalCoverage.uncovered.includes(id)
  );

  let healRounds = 0;
  const MAX_HEAL_ROUNDS = 3;
  // Aggregate the most recent assertion + behavioral checks for evidence.
  // (A future PhaseRunHistory persistence layer would replace this.)
  while (missingFromExecution.length > 0 && healRounds < MAX_HEAL_ROUNDS) {
    healRounds++;
    emit.voice('orchestrator', 'final');
    emit.text(`\n\n🌱 **Self-healing round ${healRounds}** — ${missingFromExecution.length} assertion(s) unsatisfied. Scoping follow-up phase(s)…\n`);
    emit.status(`🌱 Self-heal round ${healRounds}`);

    const healResult = await selfHeal({
      mission: m,
      parent_phase_index: m.phases.length, // last phase that ran
      unsatisfied_assertion_ids: missingFromExecution,
      assertion_checks: [],            // TODO Phase 4: persist + load full history
      behavioral_checks: [],
      roles: { ...DEFAULT_ROLE_CONFIG, ...m.roles },
    });

    // If the planner deferred to user, surface a question and stop.
    if (healResult.user_question) {
      emit.voice('orchestrator', 'final');
      emit.text(`\n\n⏸️ **Self-healing paused** — ${healResult.reasoning}\n`);
      emit.question(m.phases.length, healResult.user_question, healResult.reasoning, {
        unsatisfied: missingFromExecution,
        proposed_followups: healResult.followup_phases,
      });
      return;
    }

    if (healResult.followup_phases.length === 0) {
      emit.voice('orchestrator', 'final');
      emit.text(`\n\n🟡 Self-healing round ${healRounds} produced no follow-ups. ${missingFromExecution.length} assertion(s) remain unsatisfied: ${missingFromExecution.slice(0, 6).join(', ')}${missingFromExecution.length > 6 ? '…' : ''}\n`);
      break;
    }

    // Append the new phases and keep going. Each follow-up emits as a normal
    // phase event so the UI can render the lineage.
    for (const fp of healResult.followup_phases) {
      m.phases.push(fp);
      emit.phaseEvt(fp.index, m.phases.length, fp.name, 'followup', {
        parent_phase_index: fp.parent_phase_index,
        assertion_ids: fp.assertion_ids,
      });
    }
    emit.text(`\n${healResult.reasoning}\n→ Added ${healResult.followup_phases.length} follow-up phase(s) (P${healResult.followup_phases[0].index}–P${healResult.followup_phases[healResult.followup_phases.length - 1].index}). Running them now.\n\n`);

    // Run the new follow-ups by re-entering the mission loop. Easiest impl:
    // call back into the runner inner with resume_from_phase set to the first
    // new follow-up. This re-uses all the worker/audit/heal plumbing.
    // We do this with a sub-call rather than a goto-style restructure.
    await runFollowupRange(opts, emit, m, satisfiedSoFar, healResult.followup_phases[0].index);

    // After the follow-ups, recompute coverage.
    missingFromExecution = allMissionAssertionIds.filter(id =>
      !satisfiedSoFar.has(id) && !checkCoverage(m.contract, m.phases).uncovered.includes(id)
    );
  }

  emit.contract_progress(satisfiedSoFar.size, m.contract.assertions.length);
  emit.phaseEvt(m.phases.length, m.phases.length, m.phases[m.phases.length - 1]?.name || '', 'complete', { all_phases_done: true });

  if (missingFromExecution.length > 0) {
    emit.voice('orchestrator', 'final');
    emit.text(`\n\n🟡 Mission completed with ${missingFromExecution.length} assertion(s) still unsatisfied after ${healRounds} self-heal round(s): ${missingFromExecution.slice(0, 6).join(', ')}${missingFromExecution.length > 6 ? '…' : ''}\n`);
  }

  // ── Full Force workflow: end-of-mission single-pass Codex audit ──
  // Distinct from the per-phase scrutiny that already ran. Gives an
  // aggregate ship/no-ship verdict against the contract + every handoff.
  if (m.workflow_mode === 'full-force') {
    emit.voice('codex', 'final-audit');
    emit.status('🔍 Final mission audit (Full Force workflow)');
    emit.text('\n\n🔍 **Final mission audit** — Codex reviewing every handoff + per-phase audit + the full diff against the contract…\n\n');
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const persistence = require('./persistence') as typeof import('./persistence');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const finalAudit = require('./final-audit') as typeof import('./final-audit');
      const liveState = await persistence.loadMission(m.id);
      if (liveState) {
        const cwdIsGitFinal = await isGitRepo(cwd);
        const fullDiff = cwdIsGitFinal ? await readGitDiff(cwd, 'HEAD~' + Math.max(1, m.phases.length)) : '';
        const result = await finalAudit.runFinalAudit({
          state: liveState,
          cwd,
          scrutiny_model: roles.scrutiny.model,
          diff: fullDiff,
          signal: opts.abortSignal,
        });
        // Persist the final audit on the mission state.
        await persistence.updateMission(m.id, (s) => { s.final_audit = result; });
        // Surface in the chat + emit a structured event for the dashboard.
        const verdictBadge = result.verdict === 'pass' ? '✅ PASS' : result.verdict === 'concerns' ? '🟡 CONCERNS' : '❌ FAIL';
        emit.text(`\n${verdictBadge} — Final audit (${result.duration_ms}ms): ${result.summary}\n`);
        if (result.findings.length > 0) {
          emit.text(`\n**Findings:**\n`);
          for (const f of result.findings.slice(0, 12)) {
            const where = f.file ? ` _(${f.file})_` : '';
            emit.text(`- [${f.severity.toUpperCase()}] ${f.title}${where}${f.body ? '\n  ' + f.body.slice(0, 400) : ''}\n`);
          }
          if (result.findings.length > 12) emit.text(`_…and ${result.findings.length - 12} more findings._\n`);
        }
        (emit as { raw?: (frame: string) => void }).raw?.(
          `data: ${JSON.stringify({ type: 'final-audit', verdict: result.verdict, summary: result.summary, finding_count: result.findings.length, duration_ms: result.duration_ms })}\n\n`,
        );
      } else {
        emit.text(`⚠️ Final audit skipped — could not reload mission state from disk.\n`);
      }
    } catch (err: any) {
      emit.text(`⚠️ Final audit failed: ${err?.message || err}. Mission still completes.\n`);
    }
  }

  emit.finish(`Mission complete — ${satisfiedSoFar.size}/${m.contract.assertions.length} assertions verified across ${m.phases.length} phase${m.phases.length === 1 ? '' : 's'} (${m.phases.filter(p => p.origin === 'self-heal').length} self-healed).`);
  emit.voice('orchestrator', 'final');
  emit.text(`\n🏁 **Mission complete.** ${satisfiedSoFar.size}/${m.contract.assertions.length} assertions verified across ${m.phases.length} phase${m.phases.length === 1 ? '' : 's'}.\n`);
}

/**
 * Run a contiguous range of follow-up phases starting at `fromIndex` through
 * the end of `mission.phases`. This is invoked by the self-heal loop after
 * appending new follow-ups; it reuses the same audit + commit + behavioral
 * machinery via a delegation back into the runner inner core.
 *
 * Implemented as a thin wrapper that re-enters the main loop logic for just
 * the new range. Keeps the self-heal flow shippable without a deeper
 * refactor of the inner; in Phase 4 (persistence) we'll restructure the
 * inner around a phase-iterator that consumes mission.phases dynamically.
 */
async function runFollowupRange(
  opts: MissionRunOptions,
  emit: Emit,
  m: Mission,
  satisfiedSoFar: Set<string>,
  fromIndex: number,
): Promise<void> {
  // Re-call runMissionInner with resume hints pointing at the first new phase.
  // We're inside an existing runMissionInner already, so we can't simply
  // call it (would re-emit the preface). Instead: extract the per-phase loop
  // body into a helper. For v1 we duplicate the minimal worker→audit→heal
  // pipeline here. Future refactor: extract `runOnePhase()` into shared util.
  //
  // For now, the range runs by recursing into runMissionInner with a marker
  // that suppresses preface + final emission.
  await runMissionRange(m, fromIndex, satisfiedSoFar, emit, opts);
}

async function runMissionRange(
  mission: Mission,
  fromIndex: number,
  satisfiedSoFar: Set<string>,
  emit: Emit,
  opts: MissionRunOptions,
): Promise<void> {
  // Minimal duplicated phase loop — subset of runMissionInner. Keeps each
  // follow-up's audit/healing/commit identical to original phases.
  const m = mission;
  const cwd = m.cwd;
  const reworkCap = opts.override_rework_cap ?? m.rework_cap ?? 5;
  const total = m.phases.length;
  const roles = { ...DEFAULT_ROLE_CONFIG, ...m.roles, ...opts.role_overrides };

  for (let i = fromIndex; i <= total; i++) {
    const phase = m.phases[i - 1];
    if (!phase) continue;
    emit.phaseEvt(phase.index, total, phase.name, 'start', {
      assertion_ids: phase.assertion_ids,
      origin: phase.origin,
      parent_phase_index: phase.parent_phase_index,
    });
    emit.status(`🚦 ${phase.origin === 'self-heal' ? 'Follow-up ' : ''}Phase ${phase.index}/${total}: ${phase.name}`);

    await carryoverCommit(cwd, phase.index, phase.name, false, emit);
    const headBefore = await readGitHead(cwd);
    const phaseAssertions = assertionsForPhase(m.contract, phase);
    const phaseCap = phase.rework_cap ?? reworkCap;

    let attempt = 0;
    const auditHistory: string[] = [];
    let priorConcerns: string[] = [];
    let phaseDone = false;

    while (!phaseDone) {
      attempt++;
      if (attempt > phaseCap) {
        emit.phaseEvt(phase.index, total, phase.name, 'stuck', { rework_cap: phaseCap, attempts_used: attempt - 1 });
        return;
      }
      // Phase-10 prompt caching: session key is per-PHASE, not per-attempt.
      // See the matching comment in the main runner; same rationale applies
      // to the self-heal followup runner.
      const workerSessionKey = `mission:${m.id}:p${phase.index}`;
      emit.status(`🛠 Phase ${phase.index} — worker (attempt ${attempt}/${phaseCap}${attempt > 1 ? ', cached prefix' : ''})`);
      emit.voice('claude', `phase-${phase.index}-impl-a${attempt}`);
      const workerPrompt = await buildWorkerPrompt(m, phase, phaseAssertions, attempt, priorConcerns);
      const workerOutput = await streamClaudeTurn({
        prompt: workerPrompt,
        sessionKey: workerSessionKey,
        cwd,
        chatId: opts.chatId,
        clientId: opts.clientId,
        requestId: opts.requestId,
        emit,
        worker_model: roles.worker.model,
        signal: opts.abortSignal,
        // Phase 10: accumulate per-mission token usage. Best-effort: if the
        // claude bridge stops emitting usage frames the counter just stops
        // moving — we never block on it.
        onUsage: ({ usage, cost }) => {
          accumulateMissionUsage(m.id, usage, cost).catch(() => undefined);
          // Surface a small status pulse so the dashboard's coverage row
          // can update to "Tokens used: X.X k" without an extra API call.
          (emit as { raw?: (frame: string) => void }).raw?.(
            `data: ${JSON.stringify({ type: 'mission-usage', usage, cost })}\n\n`,
          );
        },
      });
      if (opts.abortSignal?.aborted) {
        emit.phaseEvt(phase.index, total, phase.name, 'stuck', { reason: 'aborted' });
        return;
      }
      const handoff = extractHandoff(workerOutput);
      const handoffCheck = validateHandoff(handoff, phase.index);
      if (!handoffCheck.valid) {
        priorConcerns = ['Re-emit a valid `\`\`\`handoff` JSON block per the schema.', ...handoffCheck.blockers];
        continue;
      }

      emit.phaseEvt(phase.index, total, phase.name, 'audit', { attempt });
      emit.voice('codex', `phase-${phase.index}-audit-a${attempt}`);
      emit.text('_Scrutiny validator running…_\n\n');
      const cwdIsGit = await isGitRepo(cwd);
      const diff = cwdIsGit ? await readGitDiff(cwd, headBefore || 'HEAD') : '';
      const verificationRuns = await runVerificationCommands(phaseAssertions, cwd, opts.abortSignal);
      const lanes = planScrutinyLanes(m, phase, phaseAssertions, handoff!, diff, attempt, auditHistory, verificationRuns, cwdIsGit);
      let codexResult: any;
      try {
        if (lanes.length > 1) {
          emit.text(`_Scrutiny fan-out: **${lanes.length} parallel reviewers**…_\n\n`);
          (emit as any).raw?.(`data: ${JSON.stringify({ type: 'scrutiny-fanout', count: lanes.length, phase: phase.index, attempt })}\n\n`);
        }
        const fan = await runScrutinyFanout({
          lanes, cwd, model: roles.scrutiny.model, timeoutMs: 20 * 60 * 1000,
          signal: opts.abortSignal,
        });
        if (!fan.merged) throw new Error(fan.per_lane.map(l => `${l.label}: ${l.error}`).join(' · '));
        codexResult = fan.merged;
      } catch (err: any) {
        if (err?.name === 'AbortError' || opts.abortSignal?.aborted) {
          emit.phaseEvt(phase.index, total, phase.name, 'stuck', { reason: 'aborted' });
          return;
        }
        emit.text(`\n⚠️ Scrutiny unreachable: ${err.message}.\n`);
        return;
      }
      const audit = synthesizeAudit(handoff!, codexResult, phaseAssertions, phase, attempt);
      emit.audit(audit);
      emit.text(renderAuditBubble(audit));
      auditHistory.push(`Attempt ${attempt}: ${audit.verdict} — ${audit.summary.slice(0, 200)}`);

      if (audit.verdict === 'phase-complete') {
        const behavioralAssertions = phaseAssertions.filter(a => a.type === 'behavioral');
        let behavioralChecks: BehavioralCheck[] = [];
        if (behavioralAssertions.length > 0) {
          behavioralChecks = await runUserTestingValidation({
            mission: m, phase, assertions: behavioralAssertions,
            worker_session_id: workerSessionKey, qa_model: roles.user_testing.model,
            signal: opts.abortSignal,
            emit: { voice: emit.voice, text: emit.text, status: emit.status, raw: emit.raw },
          });
          audit.behavioral_checks = behavioralChecks;
          const failed = behavioralChecks.filter(b => b.status === 'unsatisfied' ||
            (b.status === 'inconclusive' && (() => {
              const a = behavioralAssertions.find(x => x.id === b.assertion_id);
              return a?.severity === 'critical' || a?.severity === 'high';
            })()));
          if (failed.length > 0) {
            priorConcerns = failed.map(f => `Behavioral [${f.assertion_id}] failed: ${f.evidence || '(no evidence)'}`);
            emit.phaseEvt(phase.index, total, phase.name, 'rework', { attempt, reason: 'user-testing-failed' });
            continue;
          }
        }
        for (const c of audit.assertion_checks) if (c.status === 'satisfied') satisfiedSoFar.add(c.assertion_id);
        for (const b of behavioralChecks) if (b.status === 'satisfied') satisfiedSoFar.add(b.assertion_id);
        emit.contract_progress(satisfiedSoFar.size, m.contract.assertions.length);
        const commitResult = await autopilotCommit(
          cwd,
          `[mission:${m.id}] ${phase.origin === 'self-heal' ? 'follow-up ' : ''}phase ${phase.index}: ${phase.name} (${attempt} attempt${attempt === 1 ? '' : 's'})`
        );
        emit.phaseEvt(phase.index, total, phase.name, 'complete', { attempts: attempt, commit_hash: commitResult.hash });
        phaseDone = true;
        break;
      }
      if (audit.verdict === 'needs-user-input') {
        emit.question(phase.index, audit.user_question || 'Codex needs your input.', audit.summary, audit);
        return;
      }
      priorConcerns = [
        ...audit.rework_directive,
        ...(audit.concerns || []).map(c => `[${c.severity}] ${c.title}${c.body ? ': ' + c.body : ''}`),
      ];
      emit.phaseEvt(phase.index, total, phase.name, 'rework', { attempt });
    }
  }
}

// ─── Helper: stream a Claude turn ─────────────────────────────────────────

async function streamClaudeTurn(args: {
  prompt: string;
  sessionKey: string;
  cwd: string;
  chatId?: string;
  clientId?: string;
  requestId?: string;
  emit: Emit;
  worker_model?: string;
  /** Phase 4: cancellation. When aborted, we cancel the underlying stream
   *  reader (which terminates the upstream Claude turn) and throw an
   *  AbortError with whatever text we've collected so far attached for
   *  observability. */
  signal?: AbortSignal;
  /** Phase 10: usage callback. claude-chat-bridge already emits a
   *  `type: 'usage'` SSE frame with `{ usage, cost }`; we forward the
   *  payload to the caller so the mission state can accumulate token
   *  counters per turn. */
  onUsage?: (info: { usage: Record<string, unknown>; cost?: number }) => void;
}): Promise<string> {
  const { stream } = spawnClaudeStream({
    prompt: args.prompt,
    sessionKey: args.sessionKey,
    workspace: args.cwd,
    model: args.worker_model && args.worker_model !== 'default' ? args.worker_model : undefined,
    requestId: args.requestId,
    chatId: args.chatId,
    clientId: args.clientId,
  });

  const reader = stream.getReader();
  // Wire the abort signal to the reader so when the user aborts, the read
  // loop unblocks within a single tick.
  const onAbort = () => { try { reader.cancel(); } catch { /* ignore */ } };
  if (args.signal) {
    if (args.signal.aborted) onAbort();
    else args.signal.addEventListener('abort', onAbort, { once: true });
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
              args.emit.text(t);
            } else if (parsed.type === 'status') {
              args.emit.status(parsed.status || '');
            } else if (parsed.type === 'usage' && args.onUsage) {
              args.onUsage({ usage: parsed.usage || {}, cost: parsed.cost });
            }
          } catch {}
        }
      }
    }
  } finally {
    args.signal?.removeEventListener('abort', onAbort);
  }
  if (args.signal?.aborted) {
    const reason = (args.signal as AbortSignal & { reason?: unknown }).reason;
    const err = new Error(typeof reason === 'string' ? `worker aborted: ${reason}` : 'worker aborted') as Error & { name: string; partial?: string };
    err.name = 'AbortError';
    err.partial = collected;
    throw err;
  }
  return collected.trim();
}

// ─── Worker prompt builder ───────────────────────────────────────────────

/** Phase 10 prompt-caching contract: workers receive their prompt as
 *  three labeled regions in this order:
 *    1. STABLE — role skill + mission-specific skills (changes only when
 *       the orchestrator writes a new skill or the role file is updated)
 *    2. MISSION — goal, preface, contract (changes only across missions)
 *    3. PHASE — phase index, attempt, prior concerns (changes every turn)
 *
 *  When the claude-chat-bridge is later upgraded to forward
 *  `cache_control: { type: 'ephemeral' }` markers to the Anthropic SDK,
 *  the bridge will look for the literal strings `<<<MC_CACHE_BREAKPOINT>>>`
 *  and split the prompt at those points, attaching cache_control to each
 *  prefix. Today the breakpoints are inert markdown — caching is a no-op
 *  but the prompt structure is correct. */
const MC_CACHE_BREAKPOINT = '\n<!-- <<<MC_CACHE_BREAKPOINT>>> -->\n';

async function buildWorkerPrompt(
  mission: Mission,
  phase: MissionPhase,
  assertions: ReturnType<typeof assertionsForPhase>,
  attempt: number,
  priorConcerns: string[],
): Promise<string> {
  // Phase-10 prompt caching: on attempts 2+, the worker is in a RESUMED
  // session that already has attempt 1's full prompt + worker response in
  // its cached context. Sending the entire skills/mission/phase preamble
  // again as a new user message would balloon the bill — Anthropic caches
  // the system prompt + prior turns but each NEW user message is fresh-billed.
  // So for rework attempts we emit a slim "rework directive" message that
  // references the prior context implicitly.
  if (attempt > 1) {
    const lines: string[] = [];
    lines.push(`# Rework — Phase ${phase.index} attempt ${attempt}/${(phase.rework_cap ?? mission.rework_cap ?? 5)}`);
    lines.push('');
    lines.push(`Codex audited your prior attempt and returned **needs-rework**. The full audit is in the conversation above; the actionable items are:`);
    lines.push('');
    if (priorConcerns.length === 0) {
      lines.push('- (no specific directives — see the audit summary in your prior turn)');
    } else {
      for (const c of priorConcerns) lines.push(`- ${c}`);
    }
    lines.push('');
    lines.push('## Your task this turn');
    lines.push('1. Apply the directives. Stay scoped to the same phase + assertions you were given originally; do not pull in adjacent work.');
    lines.push('2. Re-run any `verification_command` on assertions you changed and capture the results in `commands_run`.');
    lines.push('3. Re-emit the structured `handoff` JSON block (same schema as last time) with the updated `satisfied_assertions`, `completed`, `commands_run`, etc.');
    lines.push('');
    lines.push('Do not repeat the contract or mission preface — they are already in your context. Just do the work and emit the handoff.');
    return lines.join('\n');
  }

  // Attempt 1: full preamble. Sets up everything the worker needs in its
  // first turn so subsequent rework attempts can rely on conversation
  // history for context.
  const lines: string[] = [];
  // Phase 8: prepend the worker role skill + any mission-specific skills the
  // orchestrator wrote. Empty string is fine — `workerSkillBundle` returns ''
  // when no files are present and we fall back to the original hardcoded
  // prompt logic below for full backwards compatibility.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const skills = require('./skills') as typeof import('./skills');
  const skillBundle = await skills.workerSkillBundle(mission.id);
  // ── REGION 1: STABLE (cacheable forever per mission-skill-version) ──
  if (skillBundle) {
    lines.push(skillBundle);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  lines.push(MC_CACHE_BREAKPOINT);
  // ── REGION 2: MISSION (cacheable per mission) ──
  lines.push(`# Mission worker — Phase ${phase.index}/${mission.phases.length}: ${phase.name}`);
  lines.push('');
  lines.push(`Mission goal: ${mission.goal}`);
  if (mission.preface) {
    lines.push('');
    lines.push('## Mission preface');
    lines.push(mission.preface);
  }
  lines.push('');
  // ── REGION 3 boundary: PHASE-specific (rebuilt every turn) ──
  // Anything below this is unique to the current phase + attempt and
  // must not be cached. Anything above is cacheable per mission.
  lines.push(MC_CACHE_BREAKPOINT);
  lines.push(`Attempt ${attempt}.`);
  lines.push('');
  lines.push('## You have FRESH context');
  lines.push('You are a worker spawned with no prior conversation memory. Read the spec, look at the code, and DO the work. Don\'t hedge based on assumptions about prior phases — what\'s in git is the source of truth.');
  lines.push('');
  lines.push('## Phase spec');
  lines.push(phase.spec || '(no spec)');
  if (phase.expected_files?.length) {
    lines.push('');
    lines.push('## Expected files (work should be SCOPED to these)');
    for (const f of phase.expected_files) lines.push(`- \`${f}\``);
  }
  lines.push('');
  lines.push(renderAssertionsForWorker(assertions));
  if (priorConcerns.length) {
    lines.push('');
    lines.push('## Prior audit concerns to address');
    for (const c of priorConcerns) lines.push(`- ${c}`);
  }
  lines.push('');
  lines.push('## Rules');
  lines.push('- DO the full work. No "I\'ll handle this later", no TODO/FIXME, no stubs unless the spec calls for them.');
  lines.push('- Stay in scope. Don\'t fix repo-wide hygiene issues unless an assertion requires it.');
  lines.push('- Mission control auto-commits at phase boundaries — don\'t worry about leaving uncommitted work.');
  lines.push('- Do NOT deploy unless an assertion explicitly calls for it.');
  lines.push('- For each assertion, run its `verification_command` (when present) and include the result in `commands_run`.');
  lines.push('');
  lines.push('## Read-only parallelism (Phase 6)');
  lines.push('When a step is read-only — searching the codebase for callers, reading several files to understand a pattern, mapping dependencies, researching an API, or running independent test suites — fan out **parallel sub-agents** instead of doing it serially. Patterns that pay off:');
  lines.push('- Search: spawn one sub-agent per query/glob and merge results');
  lines.push('- Read: spawn one sub-agent per file family (e.g. `lib/foo/`, `app/bar/`) when you need to read 5+ files');
  lines.push('- Verify: when multiple `verification_command`s are independent, run them in parallel');
  lines.push('Serial execution stays the default for **writing** work — never parallel-edit the same file. Within one feature, search/research can be parallel; between features, stay serial.');
  lines.push('');
  lines.push(HANDOFF_PROMPT_INSTRUCTIONS);
  return lines.join('\n');
}

// ─── Audit brief builder ─────────────────────────────────────────────────

/** Phase 11 pair-worker mode: brief for the Codex co-worker. Different
 *  shape than the audit brief — Codex isn't reviewing finished code, it's
 *  proposing an alternative implementation approach AND surfacing
 *  blockers/risks the worker should consider before they start cutting code.
 *
 *  Output is a markdown document, not JSON. The runner attaches it to
 *  the handoff verbatim; scrutiny later sees it alongside the worker's
 *  actual implementation. */
function buildCoworkerBrief(
  mission: Mission,
  phase: MissionPhase,
  assertions: ReturnType<typeof assertionsForPhase>,
  attempt: number,
  priorConcerns: string[],
): string {
  const lines: string[] = [];
  lines.push(`# Pair-worker co-pilot — Phase ${phase.index}: ${phase.name}`);
  lines.push('');
  lines.push('You are the Codex half of a pair-worker setup. The Anthropic worker is implementing this phase RIGHT NOW in parallel. Your job is to produce an alternative perspective that scrutiny can use to judge the worker\'s approach. You are READ-ONLY by design — do not propose file edits, just analysis.');
  lines.push('');
  lines.push(`## Mission goal`);
  lines.push(mission.goal);
  if (mission.preface) {
    lines.push('');
    lines.push('## Mission preface');
    lines.push(mission.preface);
  }
  lines.push('');
  lines.push(`## Phase spec`);
  lines.push(phase.spec || '(no spec)');
  if (phase.expected_files?.length) {
    lines.push('');
    lines.push(`## Expected files`);
    for (const f of phase.expected_files) lines.push(`- \`${f}\``);
  }
  lines.push('');
  lines.push('## Assertions this phase owns');
  for (const a of assertions) {
    lines.push(`- **${a.id}** [${a.severity}]: ${a.statement}`);
    if (a.verification_command) lines.push(`  → verify: \`${a.verification_command}\``);
  }
  if (priorConcerns.length) {
    lines.push('');
    lines.push(`## Prior audit concerns (attempt ${attempt})`);
    for (const c of priorConcerns) lines.push(`- ${c}`);
  }
  lines.push('');
  lines.push('## What I want from you');
  lines.push('Produce a brief markdown document with these sections:');
  lines.push('');
  lines.push('### 1. Alternative implementation approach');
  lines.push('The 2-4 sentence sketch of how YOU would solve this phase. Cite files, function shapes, library choices.');
  lines.push('');
  lines.push('### 2. Risks the worker should know about');
  lines.push('Things that look easy but aren\'t — race conditions, hidden coupling, edge cases the spec doesn\'t mention, places the verification commands could be gamed.');
  lines.push('');
  lines.push('### 3. Disagreements with the spec or assertions');
  lines.push('If any pinned criterion is ambiguous, untestable, or sets up a recursion trap (criterion references runtime-changing state like HEAD), flag it here. Scrutiny will see this.');
  lines.push('');
  lines.push('### 4. What I expect to see in the diff');
  lines.push('Concrete: file paths + function signatures + what the change should look like at a glance. Scrutiny uses this to spot scope drift.');
  lines.push('');
  lines.push('Keep total output ≤ 1500 words. Be specific. Cite line numbers when you can.');
  return lines.join('\n');
}

function buildAuditBrief(
  mission: Mission,
  phase: MissionPhase,
  assertions: ReturnType<typeof assertionsForPhase>,
  handoff: Handoff,
  diff: string,
  attempt: number,
  history: string[],
  /** Phase-9 fix: ground-truth verification results from runner-executed
   *  shell commands, when assertions specified `verification_command`.
   *  Non-git cwds + commands like `vitest run` need this evidence; pure
   *  git diffs aren't enough on their own. Optional for backwards compat. */
  verificationRuns?: VerificationRunResult[],
  /** True if `mission.cwd` is inside a git work tree. Lets us tell Codex
   *  honestly whether the diff section is meaningful or "(empty because
   *  this isn't a git repo)" — a real distinction. */
  cwdIsGit?: boolean,
): string {
  const lines: string[] = [];
  // Phase 8: prepend the scrutiny role skill (cache-only sync read so we
  // don't have to make this whole helper async — the cache is warmed at
  // startup by warmRoleSkillCache(). Mission-specific skills are NOT
  // included for scrutiny: the validator should be model-agnostic and
  // resistant to mission-specific bias.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const skills = require('./skills') as typeof import('./skills');
  const roleSkill = skills.loadRoleSkillSync('scrutiny');
  if (roleSkill) {
    lines.push(roleSkill);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  lines.push(`# Mission scrutiny audit — Phase ${phase.index}: ${phase.name}`);
  lines.push(`Mission: ${mission.goal}`);
  lines.push(`Attempt ${attempt}. Cap: ${phase.rework_cap ?? mission.rework_cap ?? 5}.`);
  lines.push('');
  lines.push('## Phase spec (PINNED)');
  lines.push(phase.spec);
  lines.push('');
  lines.push('## Assertions THIS PHASE owns (verify each)');
  for (const a of assertions) {
    const sev = `[${a.severity.toUpperCase()}]`;
    const kind = a.type === 'behavioral' ? '(behavioral)' : '(static)';
    lines.push(`- **${a.id}** ${sev} ${kind} ${a.statement}`);
    if (a.verification_command) lines.push(`  → command: \`${a.verification_command}\``);
    if (a.behavior) {
      lines.push(`  → flow: ${a.behavior.flow_steps.join(' → ')}`);
      lines.push(`  → expect: ${a.behavior.expected_outcome}`);
    }
  }
  lines.push('');
  lines.push('## Worker structured handoff');
  lines.push(renderHandoffForAudit(handoff));
  lines.push('');

  // Diff section — honest about what's there. If cwdIsGit is false, say so
  // explicitly so Codex doesn't penalize the worker for an empty diff
  // when the cwd isn't tracked.
  lines.push('## Git diff since phase start (this phase ONLY)');
  if (cwdIsGit === false) {
    lines.push('_(cwd is NOT a git repository — there is no git diff to consider. Use the verification-command results below as primary evidence.)_');
  } else {
    lines.push('```diff');
    lines.push(diff.length > 60_000 ? diff.slice(0, 60_000) + '\n…[truncated]' : diff || '(no diff — handoff should cite existing code)');
    lines.push('```');
  }

  // Phase-9 fix: independently-executed verification commands. Codex sees
  // exit codes + truncated stdout/stderr that the runner produced AFTER
  // the worker finished. This is ground truth — the worker can't fake it.
  // For non-git cwds this is the PRIMARY evidence; for git cwds it's
  // complementary to the diff.
  if (verificationRuns && verificationRuns.length > 0) {
    lines.push('');
    lines.push('## Verification command results (runner-executed, ground truth)');
    lines.push(cwdIsGit === false
      ? '_The runner ran each assertion\'s `verification_command` independently and captured the result below. Use these to judge satisfaction._'
      : '_Each assertion\'s `verification_command` was executed by the runner. Use both this AND the diff to judge satisfaction._');
    for (const vr of verificationRuns) {
      lines.push('');
      lines.push(`### ${vr.assertion_id} — exit ${vr.exit_code === null ? 'n/a' : vr.exit_code}${vr.timed_out ? ' (TIMED OUT)' : ''} (${vr.duration_ms}ms)`);
      lines.push('Command:');
      lines.push('```sh');
      lines.push(vr.command);
      lines.push('```');
      if (vr.stdout_excerpt) {
        lines.push('Stdout:');
        lines.push('```');
        lines.push(vr.stdout_excerpt);
        lines.push('```');
      }
      if (vr.stderr_excerpt) {
        lines.push('Stderr:');
        lines.push('```');
        lines.push(vr.stderr_excerpt);
        lines.push('```');
      }
    }
  }
  if (history.length) {
    lines.push('');
    lines.push('## Audit history (prior attempts on this phase)');
    for (const h of history) lines.push(`- ${h}`);
  }
  lines.push('');
  lines.push('## Your task');
  lines.push('Return JSON with `verdict`, `summary`, `concerns`, `rework_directive`, `user_question`, `assertion_checks`.');
  lines.push('For EACH assertion the worker claims `satisfied`: verify it. Return `assertion_checks: [{ assertion_id, status: "satisfied"|"unsatisfied"|"inconclusive", evidence }]`.');
  lines.push('');
  lines.push('Verdict policy:');
  lines.push('- `phase-complete` ONLY when EVERY phase-owned assertion is verified satisfied AND the handoff has no `undone` items.');
  lines.push('- `needs-rework` when assertions are unsatisfied or the handoff is incomplete. Cite specific assertion ids in `rework_directive`.');
  lines.push('- `needs-user-input` ONLY for: missing credentials, irreversible/destructive choices, or conflicting BUSINESS requirements only the user can resolve. NOT engineering trivia (commits, lint, migrations, deploy timing — take the safer default).');
  lines.push('');
  lines.push('Pinned criteria. No goalpost moving across attempts.');
  return lines.join('\n');
}

// ─── Phase 10: token accumulator ────────────────────────────────────────
//
// claude-chat-bridge emits a `type: 'usage'` SSE frame near the end of every
// turn with `{ usage: { input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens }, cost: <number> }`. We add the values into
// the mission's persistent state so a 16-day mission can show its running
// token + cost totals. updateMission is async + locked, so concurrent
// accumulator calls (rare — only if two phases ran their workers at exactly
// the same moment) serialize cleanly.

async function accumulateMissionUsage(missionId: string, usage: Record<string, unknown>, cost?: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const persistence = require('./persistence') as typeof import('./persistence');
  await persistence.updateMission(missionId, (s) => {
    const inc = (key: string) => {
      const raw = (usage as any)[key];
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    };
    s.tokens_used = {
      input: (s.tokens_used?.input ?? 0) + inc('input_tokens'),
      cache_read: (s.tokens_used?.cache_read ?? 0) + inc('cache_read_input_tokens'),
      cache_creation: (s.tokens_used?.cache_creation ?? 0) + inc('cache_creation_input_tokens'),
      output: (s.tokens_used?.output ?? 0) + inc('output_tokens'),
    };
    if (typeof cost === 'number' && Number.isFinite(cost)) {
      // Costs accumulate on a top-level `cost_usd` we add ad-hoc. Keep the
      // existing shape pristine — only set when we have a real value.
      const existing = (s.mission as { cost_usd?: number }).cost_usd ?? 0;
      (s.mission as { cost_usd?: number }).cost_usd = existing + cost;
    }
  });
}

// ─── Phase 7: orchestrator decisions (negotiation at milestones) ─────────
//
// Luke: "Negotiation shows up at milestone boundaries, where the orchestrator
// defines does this handoff summary look correct? Do we need to create
// follow-up features, rescope, etc."
//
// Today the orchestrator's decision logic is implicit in synthesizeAudit +
// the verdict handling. We make it EXPLICIT by emitting a structured
// `orchestrator-decision` SSE event at each branch, naming what was decided
// and why. The dashboard can render these as a decision timeline; downstream
// missions (multi-mission orchestration) can subscribe and react.

export type OrchestratorDecision =
  | 'advance'              // handoff valid + assertions covered → next phase
  | 'scope-followups'      // assertions failed → auto-scope follow-up phases
  | 'reject-handoff'       // worker handoff is malformed; redo without burning scrutiny
  | 'rework'               // legitimate rework round; worker re-attempts
  | 'pause-for-user'       // genuine human-only blocker
  | 'broker-conflict'      // concurrent worker outputs conflict; orchestrator picks (Phase 11)
  | 'auto-accept-disputed' // dispute escape valve fired (autopilot.ts already does this)
;

function emitOrchestratorDecision(
  emit: Emit,
  phase: number,
  attempt: number,
  decision: OrchestratorDecision,
  reasoning: string,
  next_action: string,
  details?: Record<string, unknown>,
): void {
  emit.voice('orchestrator', `phase-${phase}-decision-a${attempt}`);
  // Raw SSE so the dashboard can dispatch on `type: 'orchestrator-decision'`
  // without us extending the typed Emit interface for what is otherwise a
  // pure annotation event.
  (emit as { raw?: (frame: string) => void }).raw?.(
    `data: ${JSON.stringify({
      type: 'orchestrator-decision',
      phase, attempt, decision, reasoning, next_action,
      ...(details || {}),
    })}\n\n`
  );
  emit.text(`\n🧭 **Orchestrator (Phase ${phase}, attempt ${attempt}):** ${decision} — ${reasoning}\n→ Next: ${next_action}\n`);
}

// ─── Phase 6: parallel scrutiny ──────────────────────────────────────────
//
// "Within validators: parallelize per-feature code review." When a phase owns
// many assertions, splitting the audit into N parallel Codex consults — each
// reviewing a subset of assertions against the same diff — gives Codex a
// shorter, more focused prompt per consult AND cuts wall-clock time roughly
// linearly with the lane count.
//
// We only fan out when it actually helps: ≥4 assertions in the phase. Below
// that, the single-consult path is already short enough that splitting just
// adds coordination overhead. Verdicts merge with strict semantics — if any
// lane says "needs-rework" the merged verdict is needs-rework; if any lane
// says "needs-user-input" the merged is needs-user-input. We never override
// a stricter lane verdict with a more permissive one.

interface ScrutinyLane { label: string; brief: string; }

async function runScrutinyFanout(args: {
  lanes: ScrutinyLane[];
  cwd: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ merged: any; per_lane: Array<{ label: string; result: any | null; error?: string }> }> {
  const { lanes, cwd, model, timeoutMs, signal } = args;
  // Run all consults in parallel. A failure in one lane does not abort the
  // others — we collect per-lane errors and merge whatever succeeded. If
  // every lane failed, the merge returns null and the caller treats it the
  // same as a single-consult failure (mission paused with "scrutiny-unreachable").
  const settled = await Promise.allSettled(
    lanes.map((lane) =>
      runCodexConsult({ brief: lane.brief, role: 'reviewer', cwd, model, timeoutMs, signal })
    ),
  );
  const per_lane = settled.map((r, i) => {
    if (r.status === 'fulfilled') return { label: lanes[i].label, result: r.value };
    return { label: lanes[i].label, result: null, error: String((r.reason as any)?.message || r.reason) };
  });
  const successes = per_lane.filter(l => l.result).map(l => l.result!);
  if (successes.length === 0) return { merged: null, per_lane };
  return { merged: mergeScrutinyResults(successes), per_lane };
}

function mergeScrutinyResults(results: any[]): any {
  if (results.length === 1) return results[0];
  const verdict = pickStrictestVerdict(results.map(r => r.verdict));
  const seenTitles = new Set<string>();
  const concerns: any[] = [];
  for (const r of results) {
    for (const c of (r.concerns || [])) {
      const key = `${c.severity || 'medium'}::${c.title || ''}`;
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      concerns.push(c);
    }
  }
  const suggestions = Array.from(new Set(results.flatMap((r: any) => r.suggestions || [])));
  const patches = results.flatMap((r: any) => r.patches || []);
  const summary = results
    .map((r: any, i: number) => `[lane ${i + 1}] ${r.summary || '(no summary)'}`)
    .join('\n');
  // Propagate a per-lane assertion_check union — synthesizeAudit re-derives
  // checks per assertion id, so dupes here are tolerated.
  const raw = results.map((r: any, i: number) => `=== lane ${i + 1} ===\n${r.raw || ''}`).join('\n\n');
  return {
    verdict,
    summary,
    concerns,
    suggestions,
    patches,
    proposal: results.find((r: any) => r.proposal)?.proposal,
    raw,
    duration_ms: Math.max(...results.map((r: any) => r.duration_ms || 0)),
  };
}

function pickStrictestVerdict(verdicts: string[]): string {
  // Higher number = stricter outcome (more user/worker intervention required).
  const rank: Record<string, number> = {
    'disagree': 4,
    'needs-info': 3,
    'agree-with-concerns': 2,
    'agree': 1,
  };
  return verdicts.sort((a, b) => (rank[b] || 0) - (rank[a] || 0))[0] || 'agree';
}

/** Decide how to split a phase's assertions into scrutiny lanes. Returns
 *  exactly one lane (no fanout) for small phases. For larger phases, splits
 *  into 2-3 lanes balanced by assertion count. Each lane gets its own brief
 *  built from the FULL diff but a SUBSET of assertions — Codex still sees
 *  every change, just focuses its verdict on its slice. */
function planScrutinyLanes(
  mission: Mission,
  phase: MissionPhase,
  assertions: ReturnType<typeof assertionsForPhase>,
  handoff: Handoff,
  diff: string,
  attempt: number,
  history: string[],
  verificationRuns?: VerificationRunResult[],
  cwdIsGit?: boolean,
): ScrutinyLane[] {
  // Single-lane fast path. Below the fanout threshold the orchestration
  // overhead exceeds the wall-clock savings.
  if (assertions.length < 4) {
    return [{
      label: 'audit',
      brief: buildAuditBrief(mission, phase, assertions, handoff, diff, attempt, history, verificationRuns, cwdIsGit),
    }];
  }
  // Split into 2 lanes for 4-7 assertions, 3 lanes for 8+. Keeps each lane's
  // assertion list short enough to fit a focused review prompt.
  const laneCount = assertions.length >= 8 ? 3 : 2;
  const chunks = chunkRoughlyEven(assertions, laneCount);
  return chunks.map((chunk, i) => {
    // Pass each lane only the verification results for assertions in its
    // bucket — keeps the brief short.
    const chunkIds = new Set(chunk.map(a => a.id));
    const laneRuns = verificationRuns?.filter(r => chunkIds.has(r.assertion_id));
    return {
      label: `lane-${i + 1}-of-${laneCount}`,
      brief: buildAuditBrief(mission, phase, chunk, handoff, diff, attempt, history, laneRuns, cwdIsGit) +
        `\n\n## Fan-out lane ${i + 1}/${laneCount}\n` +
        `You are one of ${laneCount} parallel scrutiny reviewers for this phase. ` +
        `Focus your verdict on the ${chunk.length} assertion(s) listed above; the other ` +
        `lanes are auditing the rest. The diff you see is the WHOLE phase diff — that's ` +
        `intentional, so you can spot scope creep — but only judge the ` +
        `assertions in your bucket.`,
    };
  });
}

function chunkRoughlyEven<T>(arr: T[], n: number): T[][] {
  if (n <= 1) return [arr];
  const out: T[][] = Array.from({ length: n }, () => []);
  arr.forEach((item, i) => out[i % n].push(item));
  return out.filter(c => c.length > 0);
}

// ─── Audit synthesis (combine handoff + codex result into a typed audit) ─

function synthesizeAudit(
  handoff: Handoff,
  codexResult: any,
  assertions: ReturnType<typeof assertionsForPhase>,
  phase: MissionPhase,
  attempt: number,
): MilestoneAudit {
  // Pull verdict + structured fields from codex's stdout.
  const raw = extractAuditJson(codexResult.raw || '');
  const verdict: AuditVerdict = (raw?.verdict === 'phase-complete' || raw?.verdict === 'needs-rework' || raw?.verdict === 'needs-user-input' || raw?.verdict === 'needs-followup')
    ? raw.verdict
    : codexResult.verdict === 'agree' ? 'phase-complete'
    : codexResult.verdict === 'needs-info' ? 'needs-user-input'
    : 'needs-rework';

  // Per-assertion checks.
  let assertion_checks: AssertionCheck[] = Array.isArray(raw?.assertion_checks)
    ? raw.assertion_checks.map((c: any) => ({
        assertion_id: String(c?.assertion_id || ''),
        status: c?.status === 'satisfied' || c?.status === 'unsatisfied' || c?.status === 'inconclusive' ? c.status : 'inconclusive',
        evidence: typeof c?.evidence === 'string' ? c.evidence : undefined,
      }))
    : [];

  // If codex didn't return per-assertion checks, fall back to "claimed === verified" if verdict is phase-complete.
  if (assertion_checks.length === 0) {
    const claimed = new Set(handoff.satisfied_assertions);
    assertion_checks = assertions.map(a => ({
      assertion_id: a.id,
      status: verdict === 'phase-complete' && claimed.has(a.id) ? 'satisfied' as const : 'inconclusive' as const,
    }));
  }

  // Block phase-complete if any owned assertion is unsatisfied or inconclusive.
  if (verdict === 'phase-complete') {
    const anyMissing = assertions.some(a => {
      const c = assertion_checks.find(x => x.assertion_id === a.id);
      return !c || c.status !== 'satisfied';
    });
    if (anyMissing) {
      // Force a rework — the auditor said complete but the per-assertion check disagrees.
      return {
        phase_index: phase.index,
        attempt,
        verdict: 'needs-rework',
        summary: 'Auditor returned phase-complete but per-assertion verification has gaps. Forcing rework.',
        assertion_checks,
        rework_directive: assertions
          .filter(a => {
            const c = assertion_checks.find(x => x.assertion_id === a.id);
            return !c || c.status !== 'satisfied';
          })
          .map(a => `Verify or fix: ${a.id} — ${a.statement}`),
        concerns: [],
      };
    }
  }

  const concerns: HandoffIssue[] = Array.isArray(raw?.concerns)
    ? raw.concerns.map((c: any) => ({
        severity: (['critical','high','medium','low'] as const).includes(c?.severity) ? c.severity : 'medium',
        title: String(c?.title || 'concern'),
        body: typeof c?.body === 'string' ? c.body : undefined,
        file: typeof c?.file === 'string' ? c.file : undefined,
        blocks_assertion: typeof c?.blocks_assertion === 'string' ? c.blocks_assertion : undefined,
      }))
    : (codexResult.concerns || []);

  const rework_directive: string[] = Array.isArray(raw?.rework_directive)
    ? raw.rework_directive.map((s: any) => String(s))
    : (codexResult.suggestions || []);

  return {
    phase_index: phase.index,
    attempt,
    verdict,
    summary: typeof raw?.summary === 'string' ? raw.summary : (codexResult.summary || ''),
    assertion_checks,
    rework_directive,
    user_question: verdict === 'needs-user-input' && typeof raw?.user_question === 'string' ? raw.user_question : undefined,
    concerns,
  };
}

function extractAuditJson(rawOut: string): any {
  const lines = rawOut.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let evt: any;
    try { evt = JSON.parse(lines[i]); } catch { continue; }
    const candidates: string[] = [];
    if (evt?.item?.text) candidates.push(evt.item.text);
    if (typeof evt?.message === 'string') candidates.push(evt.message);
    if (typeof evt?.text === 'string') candidates.push(evt.text);
    for (const text of candidates) {
      const p = parseJsonish(text);
      if (p && (p.verdict || p.assertion_checks || p.summary)) return p;
    }
  }
  return null;
}

function parseJsonish(text: string): any {
  if (!text) return null;
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : trimmed;
  try { return JSON.parse(body); } catch {}
  const f = body.indexOf('{'); const l = body.lastIndexOf('}');
  if (f >= 0 && l > f) { try { return JSON.parse(body.slice(f, l + 1)); } catch {} }
  return null;
}

function renderAuditBubble(a: MilestoneAudit): string {
  const lines: string[] = [];
  const badge = a.verdict === 'phase-complete' ? '✅ PHASE COMPLETE'
    : a.verdict === 'needs-rework' ? '🔁 NEEDS REWORK'
    : a.verdict === 'needs-user-input' ? '❓ NEEDS YOUR INPUT'
    : '🌱 NEEDS FOLLOWUP';
  lines.push(`### ⚡ Mission audit — Phase ${a.phase_index}, attempt ${a.attempt}`);
  lines.push('');
  lines.push(`**Verdict:** ${badge}`);
  lines.push('');
  if (a.summary) lines.push(a.summary);
  lines.push('');
  if (a.assertion_checks.length > 0) {
    lines.push('**Assertion checks**');
    for (const c of a.assertion_checks) {
      const icon = c.status === 'satisfied' ? '✓' : c.status === 'unsatisfied' ? '✗' : '·';
      lines.push(`- ${icon} ${c.assertion_id}${c.evidence ? ` — ${c.evidence}` : ''}`);
    }
    lines.push('');
  }
  if (a.rework_directive?.length) {
    lines.push('**Rework directive**');
    for (const d of a.rework_directive) lines.push(`- ${d}`);
    lines.push('');
  }
  if (a.user_question) {
    lines.push('**Question for you**');
    lines.push(`> ${a.user_question}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Git helpers (reused style from autopilot) ───────────────────────────

async function readGitHead(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', () => resolve(out.trim() || null));
    proc.on('error', () => resolve(null));
    setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 4000);
  });
}

async function readGitDiff(cwd: string, base: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['diff', '--no-color', '--unified=3', base], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', () => resolve(out));
    proc.on('error', () => resolve(''));
    setTimeout(() => { try { proc.kill(); } catch {} resolve(out); }, 8000);
  });
}

/** Is `cwd` inside a git work tree? Used to decide between a diff-based
 *  audit (working tree changes) and a verification-command-based audit
 *  (run each assertion's check, feed exit code + tail of stdout to Codex).
 *  Non-git cwds are real — `/tmp` for smoke tests, ad-hoc data-only
 *  workspaces, scratchpads — and were a hard fail in the v1 runner because
 *  the empty diff gave Codex nothing to verify against. */
async function isGitRepo(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', () => resolve(out.trim() === 'true'));
    proc.on('error', () => resolve(false));
    setTimeout(() => { try { proc.kill(); } catch {} resolve(false); }, 4000);
  });
}

/** Independently execute each assertion's `verification_command` so Codex
 *  has ground-truth evidence (exit code + stdout/stderr tail) on top of —
 *  or in place of — the git diff. Critical for non-git cwds and for
 *  assertions whose verification involves running tests or shell checks
 *  the diff alone can't reflect (e.g., "the new endpoint returns 200",
 *  "vitest passes", "no TypeScript errors").
 *
 *  Per-command timeout is 60s by default and short-circuited on abort.
 *  Output is truncated to 2KB head + 2KB tail to keep the audit brief
 *  bounded — if the worker piped a 50MB build log, Codex doesn't need
 *  every byte. */
export interface VerificationRunResult {
  assertion_id: string;
  command: string;
  exit_code: number | null;
  stdout_excerpt: string;
  stderr_excerpt: string;
  duration_ms: number;
  /** True if the command timed out before completing. Distinguishes "test
   *  failed" (exit_code = 1) from "infrastructure problem" (timeout). */
  timed_out?: boolean;
}

async function runVerificationCommands(
  assertions: Assertion[],
  cwd: string,
  signal?: AbortSignal,
): Promise<VerificationRunResult[]> {
  const out: VerificationRunResult[] = [];
  for (const a of assertions) {
    if (!a.verification_command || a.type !== 'static') continue;
    if (signal?.aborted) {
      out.push({
        assertion_id: a.id,
        command: a.verification_command,
        exit_code: null,
        stdout_excerpt: '',
        stderr_excerpt: 'aborted before run',
        duration_ms: 0,
      });
      continue;
    }
    const r = await runShell(a.verification_command, cwd, 60_000, signal);
    out.push({
      assertion_id: a.id,
      command: a.verification_command,
      exit_code: r.exit_code,
      stdout_excerpt: tailExcerpt(r.stdout),
      stderr_excerpt: tailExcerpt(r.stderr),
      duration_ms: r.duration_ms,
      timed_out: r.timed_out,
    });
  }
  return out;
}

function tailExcerpt(s: string, headBytes = 2000, tailBytes = 2000): string {
  if (!s) return '';
  if (s.length <= headBytes + tailBytes + 64) return s;
  return s.slice(0, headBytes) + `\n…[truncated ${s.length - headBytes - tailBytes} bytes]…\n` + s.slice(-tailBytes);
}

async function runShell(cmd: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ exit_code: number | null; stdout: string; stderr: string; duration_ms: number; timed_out?: boolean }> {
  const started = Date.now();
  return new Promise((resolve) => {
    // /bin/sh -c so $-substitution + pipes + && all work as authored.
    const proc = spawn('/bin/sh', ['-c', cmd], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let stdout = '', stderr = '';
    let timedOut = false;
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const onAbort = () => { try { proc.kill('SIGTERM'); } catch {} };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch {}
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ exit_code: code, stdout, stderr, duration_ms: Date.now() - started, timed_out: timedOut || undefined });
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ exit_code: null, stdout, stderr: stderr || 'spawn failed', duration_ms: Date.now() - started });
    });
  });
}

async function runGit(cwd: string, args: string[], timeoutMs = 10000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
    proc.on('error', () => resolve({ ok: false, stdout: '', stderr: '' }));
    setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: false, stdout, stderr: 'timeout' }); }, timeoutMs);
  });
}

async function workingTreeChangeCount(cwd: string): Promise<number> {
  const r = await runGit(cwd, ['status', '--porcelain']);
  if (!r.ok) return 0;
  return r.stdout.split('\n').filter(l => l.trim().length > 0).length;
}

async function autopilotCommit(cwd: string, message: string): Promise<{ ok: boolean; hash: string | null; nothingToCommit: boolean }> {
  const add = await runGit(cwd, ['add', '-A']);
  if (!add.ok) return { ok: false, hash: null, nothingToCommit: false };
  const diff = await runGit(cwd, ['diff', '--cached', '--quiet']);
  if (diff.ok) return { ok: true, hash: null, nothingToCommit: true };
  const commit = await runGit(cwd, [
    '-c', 'user.email=missions@mission-control.local',
    '-c', 'user.name=Mission Runner (MC)',
    'commit', '--no-verify', '-m', message,
  ], 30_000);
  if (!commit.ok) return { ok: false, hash: null, nothingToCommit: false };
  const hash = await readGitHead(cwd);
  return { ok: true, hash, nothingToCommit: false };
}

async function carryoverCommit(
  cwd: string,
  phaseIndex: number,
  phaseName: string,
  isFirstPhaseFreshRun: boolean,
  emit: Emit,
): Promise<void> {
  const dirty = await workingTreeChangeCount(cwd);
  if (dirty === 0) return;
  const label = isFirstPhaseFreshRun
    ? `pre-mission baseline — ${dirty} pre-existing file(s)`
    : `carryover before phase ${phaseIndex} (${phaseName}) — ${dirty} file(s) from prior work`;
  emit.status(`📦 Auto-commit: ${label}`);
  const r = await autopilotCommit(cwd, `[mission] ${label}`);
  if (r.ok && r.hash) {
    emit.text(`📦 Auto-committed ${dirty} file${dirty === 1 ? '' : 's'} as \`${r.hash.slice(0, 8)}\` — ${label}.\n\n`);
  } else if (!r.ok) {
    emit.text(`⚠️ Could not auto-commit ${dirty} dirty file${dirty === 1 ? '' : 's'} before Phase ${phaseIndex}.\n\n`);
  }
}
