/**
 * Self-healing — Phase 3 of missions architecture.
 *
 * Per Luke (Factory): "the errors get caught at milestone boundaries.
 * Corrective work gets scoped and the mission sort of pulls itself back on
 * track. Not by hoping that agents remember what happened but by forcing them
 * to write it down and then actually address issues."
 *
 * When a phase completes but assertions remain unsatisfied — OR when the
 * full mission completes with unsatisfied assertions — the orchestrator
 * spawns follow-up phases that target ONLY the unsatisfied assertions. The
 * mission "self-heals" by adding work, not by dropping requirements.
 *
 * Follow-up phases carry `parent_phase_index` lineage so the dashboard can
 * indent them under their cause; commit messages use the same lineage.
 *
 * Cap: if the orchestrator generates >5 follow-ups for a single boundary,
 * pause for user review — that's a sign the assertion set is too coarse or
 * the worker isn't capable, and continued auto-scoping would just spin.
 */

import 'server-only';
import { runCodexConsult } from '../teams/codex-consult';
import type {
  Assertion,
  AssertionCheck,
  BehavioralCheck,
  Mission,
  MissionPhase,
  MissionRoleConfig,
} from './types';

export interface SelfHealOptions {
  mission: Mission;
  /** The phase that just completed (or the final phase, for end-of-mission heal). */
  parent_phase_index: number;
  /** Assertion ids that are still unsatisfied at this boundary. */
  unsatisfied_assertion_ids: string[];
  /** Per-assertion check results from scrutiny + user-testing — provides evidence. */
  assertion_checks: AssertionCheck[];
  behavioral_checks: BehavioralCheck[];
  /** Roles to use for the healer (defaults to mission.roles.orchestrator). */
  roles: MissionRoleConfig;
  /** Cap before pausing for user review. */
  max_followups?: number;
}

export interface SelfHealResult {
  /** Newly-scoped follow-up phases. May be empty if the orchestrator decides
   *  the failures are out-of-scope or unfixable without user input. */
  followup_phases: MissionPhase[];
  /** If non-empty: the orchestrator wants the user to weigh in instead of
   *  auto-scoping. Surfaces as a paused-question. */
  user_question?: string;
  /** Explanation for the user — always populated. */
  reasoning: string;
}

const DEFAULT_MAX_FOLLOWUPS = 5;

export async function selfHeal(opts: SelfHealOptions): Promise<SelfHealResult> {
  const cap = opts.max_followups ?? DEFAULT_MAX_FOLLOWUPS;
  const m = opts.mission;

  // Gather full Assertion objects for the unsatisfied ids.
  const unsatisfied: Assertion[] = m.contract.assertions.filter(a =>
    opts.unsatisfied_assertion_ids.includes(a.id)
  );
  if (unsatisfied.length === 0) {
    return { followup_phases: [], reasoning: 'No unsatisfied assertions — nothing to heal.' };
  }

  const brief = buildHealBrief(m, opts.parent_phase_index, unsatisfied, opts.assertion_checks, opts.behavioral_checks);

  let result: any;
  try {
    result = await runCodexConsult({
      brief,
      role: 'planner',
      cwd: m.cwd,
      model: opts.roles.orchestrator.model,
      timeoutMs: 10 * 60 * 1000,
    });
  } catch (e: any) {
    return {
      followup_phases: [],
      reasoning: `Self-healing planner unreachable: ${e.message}. Surface to user.`,
      user_question: `Self-healing failed (${e.message}). ${unsatisfied.length} assertion(s) remain unsatisfied: ${unsatisfied.slice(0,5).map(a => a.id).join(', ')}. Skip them, retry the parent phase, or abort the mission?`,
    };
  }

  const parsed = parseHealResponse(result.raw || '');
  if (!parsed) {
    return {
      followup_phases: [],
      reasoning: 'Self-healing returned no parseable plan. Surfacing to user.',
      user_question: `Self-healing couldn't propose follow-up phases for ${unsatisfied.length} unsatisfied assertion(s). Skip them, retry the parent phase, or abort?`,
    };
  }

  // If the planner says "user-input-needed", route to the user instead of auto-scoping.
  if (parsed.user_question && parsed.user_question.trim()) {
    return {
      followup_phases: [],
      reasoning: parsed.reasoning || 'Planner deferred to user.',
      user_question: parsed.user_question,
    };
  }

  // Cap check.
  if (parsed.phases.length > cap) {
    return {
      followup_phases: [],
      reasoning: `Planner proposed ${parsed.phases.length} follow-ups (> cap ${cap}). Likely a deeper architectural problem — pausing for user review.`,
      user_question: `Self-healing wants to add ${parsed.phases.length} follow-up phases to address ${unsatisfied.length} unsatisfied assertion(s). That's above the safety cap (${cap}). Probably a sign of an architectural issue. Review proposed follow-ups and decide: accept all, pick a subset, or abort?`,
    };
  }

  // Reindex follow-ups so they slot in after existing phases (caller will renumber if needed).
  const baseIndex = m.phases.length + 1;
  const followups: MissionPhase[] = parsed.phases.map((p: any, i: number): MissionPhase => ({
    index: baseIndex + i,
    name: String(p?.name || `Follow-up ${i + 1}`),
    spec: String(p?.spec || ''),
    expected_files: Array.isArray(p?.expected_files) ? p.expected_files.map((x: any) => String(x)) : undefined,
    assertion_ids: Array.isArray(p?.assertion_ids)
      ? p.assertion_ids.map((x: any) => String(x)).filter((id: string) => opts.unsatisfied_assertion_ids.includes(id))
      : [],
    rework_cap: typeof p?.rework_cap === 'number' ? p.rework_cap : undefined,
    parent_phase_index: opts.parent_phase_index,
    origin: 'self-heal',
  }));

  return {
    followup_phases: followups,
    reasoning: parsed.reasoning || `Auto-scoped ${followups.length} follow-up phase(s) for ${unsatisfied.length} unsatisfied assertion(s).`,
  };
}

// ─── Brief builder ───────────────────────────────────────────────────────

function buildHealBrief(
  mission: Mission,
  parent_phase_index: number,
  unsatisfied: Assertion[],
  scrutinyChecks: AssertionCheck[],
  behavioralChecks: BehavioralCheck[],
): string {
  const lines: string[] = [];
  lines.push(`# Mission self-healing — phase ${parent_phase_index} boundary`);
  lines.push('');
  lines.push(`Mission goal: ${mission.goal}`);
  lines.push(`Total phases so far: ${mission.phases.length}`);
  lines.push('');
  lines.push(`## Why we're here`);
  lines.push(`${unsatisfied.length} assertion(s) are unsatisfied after phase ${parent_phase_index} completed. Your job: scope follow-up phase(s) that will satisfy them. Don't drop assertions — fix them.`);
  lines.push('');
  lines.push('## Unsatisfied assertions');
  for (const a of unsatisfied) {
    const sev = `[${a.severity.toUpperCase()}]`;
    const kind = a.type === 'behavioral' ? '(behavioral)' : '(static)';
    lines.push(`- **${a.id}** ${sev} ${kind} ${a.statement}`);
    if (a.verification_command) lines.push(`  → command: \`${a.verification_command}\``);
    if (a.behavior) {
      lines.push(`  → flow: ${a.behavior.flow_steps.join(' → ')}`);
      lines.push(`  → expect: ${a.behavior.expected_outcome}`);
    }
    // Cite the most recent evidence.
    const sc = scrutinyChecks.find(c => c.assertion_id === a.id);
    if (sc) lines.push(`  → scrutiny said: ${sc.status}${sc.evidence ? ` — ${sc.evidence}` : ''}`);
    const bc = behavioralChecks.find(c => c.assertion_id === a.id);
    if (bc) lines.push(`  → user-testing said: ${bc.status}${bc.evidence ? ` — ${bc.evidence}` : ''}`);
  }
  lines.push('');
  lines.push('## What you must produce');
  lines.push('Return JSON. Two paths:');
  lines.push('');
  lines.push('### Path A — auto-scope follow-up phases (preferred)');
  lines.push('```json');
  lines.push('{');
  lines.push('  "phases": [');
  lines.push('    {');
  lines.push('      "name": "Fix N",');
  lines.push('      "spec": "What this follow-up delivers; cite the assertions it targets and the prior failure evidence.",');
  lines.push('      "expected_files": ["..."],');
  lines.push('      "assertion_ids": ["A012","A015"],');
  lines.push('      "rework_cap": 3');
  lines.push('    }');
  lines.push('  ],');
  lines.push('  "reasoning": "1-2 sentences explaining why these phases close the gap."');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('### Path B — escalate to user');
  lines.push('Use this ONLY when you genuinely cannot scope follow-ups (assertion is impossible without business-policy decision or credentials). Return:');
  lines.push('```json');
  lines.push('{');
  lines.push('  "user_question": "ONE clear question for the user",');
  lines.push('  "reasoning": "Why follow-up scoping isn\'t possible without user input."');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('## Rules');
  lines.push('- 1–3 follow-up phases is normal. >5 should escalate to user.');
  lines.push('- Each follow-up phase MUST list the specific assertion_ids it addresses (subset of the unsatisfied list).');
  lines.push('- Don\'t re-introduce work the prior phase already finished — focus narrowly on what failed.');
  lines.push('- If multiple unsatisfied assertions share a root cause, group them in one phase.');
  lines.push('- Don\'t use Path B for engineering trivia (lint scope, file org, commit strategy). Take defaults and scope a phase.');
  return lines.join('\n');
}

// ─── Parse ───────────────────────────────────────────────────────────────

function parseHealResponse(rawOut: string): { phases: any[]; reasoning?: string; user_question?: string } | null {
  // Find the JSON in codex's stdout (same shape as audit extraction).
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
      if (p && (Array.isArray(p.phases) || typeof p.user_question === 'string')) {
        return {
          phases: Array.isArray(p.phases) ? p.phases : [],
          reasoning: typeof p.reasoning === 'string' ? p.reasoning : undefined,
          user_question: typeof p.user_question === 'string' ? p.user_question : undefined,
        };
      }
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
