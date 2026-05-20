/**
 * Validation contract — synth, parse, coverage check.
 *
 * The contract is the heart of Luke's "validation contract" concept:
 * assertions written at planning time, before any code, that define
 * correctness independently of implementation. Each phase is responsible
 * for satisfying ≥1 assertion; the union of all phases must satisfy every
 * assertion in the contract.
 *
 * If coverage is incomplete, the orchestrator must either add an assertion
 * to a phase or scope a follow-up phase. The mission cannot complete with
 * unsatisfied assertions.
 */

import type {
  Assertion,
  AssertionType,
  ValidationContract,
  MissionPhase,
} from './types';

// ─── Coverage ────────────────────────────────────────────────────────────

export interface CoverageReport {
  total_assertions: number;
  covered: number;
  uncovered: string[];                      // assertion ids with no phase
  orphaned_phase_ids: number[];             // phases with no assertions assigned
  per_phase: Array<{ phase_index: number; assertion_ids: string[] }>;
}

export function checkCoverage(contract: ValidationContract, phases: MissionPhase[]): CoverageReport {
  const allAssertionIds = new Set(contract.assertions.map(a => a.id));
  const coveredIds = new Set<string>();
  const orphans: number[] = [];
  const perPhase: CoverageReport['per_phase'] = [];

  for (const p of phases) {
    perPhase.push({ phase_index: p.index, assertion_ids: p.assertion_ids });
    if (!p.assertion_ids.length) orphans.push(p.index);
    for (const aid of p.assertion_ids) {
      if (allAssertionIds.has(aid)) coveredIds.add(aid);
    }
  }

  const uncovered: string[] = [];
  for (const aid of allAssertionIds) {
    if (!coveredIds.has(aid)) uncovered.push(aid);
  }

  return {
    total_assertions: allAssertionIds.size,
    covered: coveredIds.size,
    uncovered,
    orphaned_phase_ids: orphans,
    per_phase: perPhase,
  };
}

export function isFullyCovered(contract: ValidationContract, phases: MissionPhase[]): boolean {
  const r = checkCoverage(contract, phases);
  return r.uncovered.length === 0 && r.orphaned_phase_ids.length === 0;
}

// ─── Parse ───────────────────────────────────────────────────────────────

/**
 * Parse a contract from synthesized JSON. Tolerant — fills in defaults,
 * normalizes ids, validates assertion types. Throws only on truly malformed
 * input (no assertions array, etc).
 */
export function parseContract(raw: any): ValidationContract {
  if (!raw || !Array.isArray(raw.assertions)) {
    throw new Error('Validation contract must have an `assertions` array');
  }
  const seenIds = new Set<string>();
  const assertions: Assertion[] = raw.assertions.map((a: any, i: number): Assertion => {
    let id = String(a?.id || '').trim();
    if (!id || seenIds.has(id)) id = `A${String(i + 1).padStart(3, '0')}`;
    seenIds.add(id);
    const type: AssertionType = a?.type === 'behavioral' ? 'behavioral' : 'static';
    const severity = (['critical', 'high', 'medium', 'low'] as const).includes(a?.severity)
      ? a.severity as 'critical' | 'high' | 'medium' | 'low'
      : 'medium';
    return {
      id,
      statement: String(a?.statement || a?.description || `Assertion ${id}`),
      type,
      severity,
      verification_command: typeof a?.verification_command === 'string' ? a.verification_command : undefined,
      behavior: a?.behavior && typeof a.behavior === 'object' && Array.isArray(a.behavior.flow_steps)
        ? {
            flow_steps: a.behavior.flow_steps.map((s: any) => String(s)),
            expected_outcome: String(a.behavior.expected_outcome || ''),
          }
        : undefined,
    };
  });
  return { assertions };
}

// ─── Synth helpers ───────────────────────────────────────────────────────

/**
 * The instruction block we append to the orchestrator's synth prompt so it
 * produces a contract + phases-mapped-to-assertions in a parseable shape.
 */
export const CONTRACT_SYNTH_INSTRUCTIONS = `
## VALIDATION CONTRACT — required output

You MUST produce a validation contract — typed assertions written before any
code, that define correctness independently of implementation. The contract
is what validators will check; phases must collectively satisfy every assertion.

Rules for assertions:
- Every assertion has: \`id\` (e.g. "A001"), \`statement\` (verifiable English),
  \`type\` ("static" or "behavioral"), \`severity\` ("critical"|"high"|"medium"|"low").
- "static" assertions are checkable from the diff/code/tests. Add a
  \`verification_command\` field with the exact command (e.g. "npx tsc --noEmit").
- "behavioral" assertions are checkable by exercising the running app. Add a
  \`behavior\` field with \`flow_steps: string[]\` and \`expected_outcome: string\`.
- Aim for 50–200 assertions on a substantial mission. Smaller missions: 10–30.
- Each assertion MUST be satisfiable by code/behavior. Avoid "high quality",
  "good UX", "no regressions". Prefer "POST /api/X with payload Y returns 200
  and creates row in table Z" or "user can submit form X without errors visible".
- Critical assertions guard data integrity, security, irreversible actions.
- If you can't make an assertion verifiable, drop it.

Then for each phase, set \`assertion_ids\`: which assertion ids this phase is
responsible for satisfying. The UNION of all phase assertion_ids MUST equal
the full contract — orphaned assertions (covered by no phase) are forbidden.

End your message with a fenced JSON block: \`\`\`missionPlan
{
  "goal": "...",
  "preface": "...",
  "rework_cap": 5,
  "target_url": "http://localhost:3000",  // optional — required if any behavioral assertions exist; the URL the QA validator will navigate to
  "phases": [
    {
      "index": 1, "name": "...", "spec": "...",
      "expected_files": ["..."],
      "assertion_ids": ["A001","A002","A005"]
    },
    ...
  ],
  "contract": {
    "assertions": [
      { "id": "A001", "statement": "...", "type": "static", "severity": "high",
        "verification_command": "npx tsc --noEmit" },
      { "id": "A007", "statement": "...", "type": "behavioral", "severity": "critical",
        "behavior": { "flow_steps": ["...","..."], "expected_outcome": "..." } },
      ...
    ]
  }
}
\`\`\`

Stop after the fence. The user will review the plan + contract and approve.
`;

/**
 * Extract the missionPlan JSON block from a synth message. Returns null on
 * miss; tolerant of partial parses.
 */
export function extractMissionPlan(text: string): {
  goal?: string;
  preface?: string;
  rework_cap?: number;
  target_url?: string;
  phases?: any[];
  contract?: any;
} | null {
  const fence = text.match(/```missionPlan\s*([\s\S]*?)```/);
  if (!fence) return null;
  try {
    return JSON.parse(fence[1].trim());
  } catch {
    return null;
  }
}

// ─── Per-assertion subset (for worker prompts) ───────────────────────────

/** Select the assertions a given phase must satisfy. Used to bound a worker's
 *  prompt to just the assertions in scope, keeping token cost predictable. */
export function assertionsForPhase(contract: ValidationContract, phase: MissionPhase): Assertion[] {
  const ids = new Set(phase.assertion_ids);
  return contract.assertions.filter(a => ids.has(a.id));
}

/** Render the phase's owned assertions as a brief block for the worker. */
export function renderAssertionsForWorker(assertions: Assertion[]): string {
  if (!assertions.length) return '(no assertions assigned to this phase — orphaned, this is a synth bug)';
  const lines: string[] = [];
  lines.push('## Assertions YOU must satisfy this phase (PINNED)');
  lines.push('Each one will be verified after you submit your handoff. Cite file:line where each is satisfied.');
  for (const a of assertions) {
    const sev = `[${a.severity.toUpperCase()}]`;
    const kind = a.type === 'behavioral' ? '(behavioral)' : '(static)';
    lines.push(`- **${a.id}** ${sev} ${kind} ${a.statement}`);
    if (a.verification_command) {
      lines.push(`  → verify with: \`${a.verification_command}\``);
    }
    if (a.behavior) {
      lines.push(`  → flow: ${a.behavior.flow_steps.join(' → ')}`);
      lines.push(`  → expect: ${a.behavior.expected_outcome}`);
    }
  }
  return lines.join('\n');
}
