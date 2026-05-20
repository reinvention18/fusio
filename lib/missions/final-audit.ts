/**
 * Final audit — Full Force workflow's end-of-mission single-pass check.
 *
 * Distinct from MilestoneAudit (per-phase, runs during the mission). Final
 * audit asks "did the WHOLE thing actually deliver the goal?" by sending
 * the validation contract, every handoff, every per-phase audit, and the
 * full git diff to Codex in one comprehensive brief. Returns pass / fail /
 * concerns plus specific findings.
 *
 * Why have it on top of per-phase scrutiny: per-phase scrutiny verifies
 * each phase against its own assertions. The final audit catches:
 *   • Drift: assertion A001 was satisfied at phase 1, but a later phase
 *     accidentally reverted it.
 *   • Cross-phase contradictions: phase 2 implemented thing X, phase 4
 *     implemented X' that doesn't compose with X.
 *   • The "looks right phase-by-phase but doesn't actually achieve the
 *     stated goal in aggregate" case.
 */

import 'server-only';
import { runCodexConsult } from '../teams/codex-consult';
import type { MissionState, FinalAudit, HandoffIssue } from './types';

export interface FinalAuditOptions {
  state: MissionState;
  cwd: string;
  /** Codex model. Pass 'default' to let the codex CLI pick. */
  scrutiny_model?: string;
  /** Optional full diff (mission baseline → HEAD). When omitted we still
   *  audit but with less evidence — Codex sees handoffs + per-phase audits
   *  but not the actual code change. */
  diff?: string;
  signal?: AbortSignal;
}

export async function runFinalAudit(opts: FinalAuditOptions): Promise<FinalAudit> {
  const started = Date.now();
  const brief = buildFinalAuditBrief(opts.state, opts.diff);
  const result = await runCodexConsult({
    brief,
    role: 'reviewer',
    cwd: opts.cwd,
    model: opts.scrutiny_model,
    timeoutMs: 25 * 60 * 1000,
    signal: opts.signal,
  });
  return {
    verdict: mapVerdict(result.verdict),
    summary: result.summary || '',
    findings: (result.concerns || []).map((c: any): HandoffIssue => ({
      severity: validSeverity(c.severity) ? c.severity : 'medium',
      title: c.title || '(no title)',
      body: c.body,
      file: c.file,
    })),
    raw: result.raw || '',
    duration_ms: Date.now() - started,
    ran_at: new Date().toISOString(),
  };
}

function mapVerdict(v: string): FinalAudit['verdict'] {
  if (v === 'agree') return 'pass';
  if (v === 'agree-with-concerns') return 'concerns';
  // 'disagree' and 'needs-info' both map to fail at the mission level —
  // mission audit shouldn't dangle on "needs more info" because the user
  // already drove all the work. If Codex genuinely can't tell, that's
  // a fail and the user can review the findings.
  return 'fail';
}

function validSeverity(s: any): s is HandoffIssue['severity'] {
  return s === 'critical' || s === 'high' || s === 'medium' || s === 'low';
}

function buildFinalAuditBrief(state: MissionState, diff?: string): string {
  const m = state.mission;
  const lines: string[] = [];
  lines.push('# Final mission audit');
  lines.push('');
  lines.push('You are auditing a completed multi-phase mission as a single comprehensive review. This is DIFFERENT from per-phase scrutiny: phase-level scrutiny already ran for each phase and you can see those verdicts below. Your job here is the aggregate question: **did the whole mission deliver the stated goal?**');
  lines.push('');
  lines.push(`## Mission goal`);
  lines.push(m.goal);
  if (m.preface) {
    lines.push('');
    lines.push(`## Preface`);
    lines.push(m.preface);
  }
  lines.push('');
  lines.push(`## Validation contract (PINNED)`);
  for (const a of m.contract.assertions) {
    lines.push(`- **${a.id}** [${a.severity}] (${a.type}): ${a.statement}`);
    if (a.verification_command) lines.push(`  → \`${a.verification_command}\``);
    if (a.behavior?.expected_outcome) lines.push(`  → expect: ${a.behavior.expected_outcome}`);
  }
  lines.push('');
  lines.push(`## Phases (in execution order)`);
  for (const p of m.phases) {
    lines.push(`### Phase ${p.index} — ${p.name}`);
    lines.push(`Spec: ${p.spec}`);
    lines.push(`Owns assertions: ${p.assertion_ids.join(', ') || '(none)'}`);
    if (p.expected_files?.length) lines.push(`Expected files: ${p.expected_files.join(', ')}`);
  }
  lines.push('');

  lines.push(`## Worker handoffs (every attempt, chronological)`);
  if (state.handoffs.length === 0) {
    lines.push(`_(none — runner emitted no handoffs)_`);
  } else {
    for (const h of state.handoffs) {
      lines.push(`### Phase ${h.phase_index} attempt ${h.attempt}`);
      if (h.completed.length > 0) lines.push(`Completed: ${h.completed.join('; ')}`);
      if (h.satisfied_assertions.length > 0) lines.push(`Satisfied (claimed): ${h.satisfied_assertions.join(', ')}`);
      if (h.undone.length > 0) lines.push(`Undone: ${h.undone.join('; ')}`);
      if (h.commands_run.length > 0) {
        lines.push(`Commands run:`);
        for (const c of h.commands_run.slice(0, 8)) {
          lines.push(`- \`${c.cmd}\` exit=${c.exit_code}${c.output_summary ? ' — ' + c.output_summary.slice(0, 200) : ''}`);
        }
      }
      if (h.summary) lines.push(`Summary: ${h.summary.slice(0, 500)}`);
    }
  }
  lines.push('');

  lines.push(`## Per-phase audit history`);
  if (state.audits.length === 0) {
    lines.push(`_(none)_`);
  } else {
    for (const a of state.audits) {
      lines.push(`- Phase ${a.phase_index} attempt ${a.attempt}: **${a.verdict}** — ${(a.summary || '').slice(0, 280)}`);
    }
  }
  lines.push('');

  if (diff) {
    lines.push(`## Full mission diff (baseline → HEAD)`);
    lines.push('```diff');
    lines.push(diff.length > 100_000 ? diff.slice(0, 100_000) + '\n…[truncated]' : diff);
    lines.push('```');
    lines.push('');
  } else {
    lines.push(`## Full mission diff`);
    lines.push(`_(not available — cwd is non-git or diff capture failed; rely on the handoffs + audits above)_`);
    lines.push('');
  }

  lines.push(`## Your task`);
  lines.push(`Single audit verdict for the WHOLE mission. Use the consult schema:`);
  lines.push(``);
  lines.push(`- \`agree\` → mission accomplished. Every contract assertion is verifiably satisfied in the final state. No scope drift. Code is shippable.`);
  lines.push(`- \`agree-with-concerns\` → goal achieved but with documented caveats: TODO leftovers, suboptimal patterns, missing behavioral coverage, etc. Ship-able with eyes open.`);
  lines.push(`- \`disagree\` → goal NOT really achieved. Possibilities: a critical assertion was only nominally satisfied (worker said yes; you can verify it didn't), per-phase audits passed but the AGGREGATE doesn't deliver the goal, regression introduced.`);
  lines.push(`- \`needs-info\` → reserved for true blockers (cwd diff missing AND no useful handoffs). Use sparingly.`);
  lines.push(``);
  lines.push(`Concerns: cite specific assertion ids, file:line, or the phase + attempt where the problem is. Severity is critical / high / medium / low.`);
  lines.push(``);
  lines.push(`Be honest. The user is making a ship-or-iterate decision based on this verdict.`);
  return lines.join('\n');
}
