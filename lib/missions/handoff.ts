/**
 * Structured handoff — the JSON shape every worker MUST return at the end of
 * a phase attempt. Replaces the freeform Claude summary that audits previously
 * had to interpret.
 *
 * Why structured: Luke's missions architecture catches issues at milestone
 * boundaries by FORCING workers to write down what was completed, what's
 * undone, what commands ran (with exit codes), what issues were discovered,
 * and whether procedures were followed. Without this, an audit has to guess.
 *
 * Worker prompt explicitly demands this shape; this module parses it back.
 */

import type { Handoff, CommandRun, HandoffIssue } from './types';

// ─── Worker prompt block (instructs Claude what JSON to emit) ────────────

export const HANDOFF_PROMPT_INSTRUCTIONS = `
## END-OF-PHASE HANDOFF — required output

After you finish (or cannot finish) the phase work, emit a fenced JSON block
exactly matching the shape below. This is what the auditor will read; freeform
text outside the JSON is fine for narrative but the audit ONLY uses the JSON.

\`\`\`handoff
{
  "phase_index": <int>,
  "attempt": <int>,
  "completed": [
    "Implemented createProposal() in src/services/proposalService.ts:12-89",
    "Added migration supabase/migrations/20260507_proposals_v3.sql",
    "..."
  ],
  "undone": [
    "(empty if everything in scope was finished — leaving items here means the phase is incomplete)"
  ],
  "commands_run": [
    { "cmd": "npx tsc --noEmit", "exit_code": 0, "duration_ms": 4200 },
    { "cmd": "npx jest src/services/proposalService", "exit_code": 0, "output_summary": "21 passed" },
    { "cmd": "...", "exit_code": <int> }
  ],
  "issues": [
    { "severity": "low", "title": "Type narrowing edge case at line 47", "body": "Workaround: ts-expect-error on the cast", "file": "src/services/proposalService.ts" }
  ],
  "procedures_followed": true,
  "procedures_notes": "(only when procedures_followed is false — explain the deviation)",
  "satisfied_assertions": ["A001","A002","A005"],
  "summary": "One-paragraph wrap-up, max 500 chars."
}
\`\`\`

Strict rules:
- \`completed\` cites file:line whenever possible. Vague entries fail audit.
- \`undone\` MUST be empty for the phase to advance. Don't leave anything for "next phase".
- \`commands_run\` includes EVERY non-trivial command you ran (tsc, jest, lint,
  migrations, scripts). Exit codes matter; the auditor reads them.
- \`satisfied_assertions\` lists the assertion ids you believe you satisfied.
  The auditor verifies each; lying here gets you sent back.
- \`procedures_followed\` is false if you deviated from the orchestrator's
  per-mission skills. Note the deviation in \`procedures_notes\`.

After this JSON block, you may add a short prose summary if useful, but the
audit only consumes the JSON.
`;

// ─── Parse ───────────────────────────────────────────────────────────────

export function extractHandoff(text: string): Handoff | null {
  const fence = text.match(/```handoff\s*([\s\S]*?)```/);
  if (!fence) return null;
  let raw: any;
  try { raw = JSON.parse(fence[1].trim()); } catch { return null; }
  return normalizeHandoff(raw);
}

export function normalizeHandoff(raw: any): Handoff | null {
  if (!raw || typeof raw !== 'object') return null;
  const phase_index = Number(raw.phase_index);
  const attempt = Number(raw.attempt);
  if (!Number.isFinite(phase_index) || !Number.isFinite(attempt)) return null;

  const completed = Array.isArray(raw.completed) ? raw.completed.map((x: any) => String(x)) : [];
  const undone = Array.isArray(raw.undone) ? raw.undone.map((x: any) => String(x)) : [];

  const commands_run: CommandRun[] = Array.isArray(raw.commands_run)
    ? raw.commands_run
        .filter((c: any) => c && typeof c === 'object' && typeof c.cmd === 'string')
        .map((c: any) => ({
          cmd: String(c.cmd),
          exit_code: Number.isFinite(Number(c.exit_code)) ? Number(c.exit_code) : -1,
          output_summary: typeof c.output_summary === 'string' ? c.output_summary : undefined,
          duration_ms: Number.isFinite(Number(c.duration_ms)) ? Number(c.duration_ms) : undefined,
        }))
    : [];

  const issues: HandoffIssue[] = Array.isArray(raw.issues)
    ? raw.issues
        .filter((i: any) => i && typeof i === 'object' && typeof i.title === 'string')
        .map((i: any) => ({
          severity: (['critical','high','medium','low'] as const).includes(i.severity) ? i.severity : 'medium',
          title: String(i.title),
          body: typeof i.body === 'string' ? i.body : undefined,
          file: typeof i.file === 'string' ? i.file : undefined,
          blocks_assertion: typeof i.blocks_assertion === 'string' ? i.blocks_assertion : undefined,
        }))
    : [];

  const satisfied_assertions = Array.isArray(raw.satisfied_assertions)
    ? raw.satisfied_assertions.map((x: any) => String(x))
    : [];

  return {
    phase_index,
    attempt,
    worker_session_id: typeof raw.worker_session_id === 'string' ? raw.worker_session_id : undefined,
    completed,
    undone,
    commands_run,
    issues,
    procedures_followed: raw.procedures_followed !== false,  // default true
    procedures_notes: typeof raw.procedures_notes === 'string' ? raw.procedures_notes : undefined,
    satisfied_assertions,
    summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 600) : '',
  };
}

// ─── Validation gates ────────────────────────────────────────────────────

export interface HandoffValidation {
  valid: boolean;
  blockers: string[];
  warnings: string[];
}

/**
 * Pre-audit check on the handoff itself — does it meet the structural bar
 * before we ask Codex to verify assertions? If a handoff fails this, the
 * orchestrator sends the worker back without burning an audit cycle.
 */
export function validateHandoff(h: Handoff | null, expected_phase_index: number): HandoffValidation {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!h) {
    return { valid: false, blockers: ['Worker did not emit a `handoff` JSON block — required.'], warnings: [] };
  }
  if (h.phase_index !== expected_phase_index) {
    blockers.push(`Handoff phase_index=${h.phase_index} but mission is on phase ${expected_phase_index}.`);
  }
  if (h.undone.length > 0) {
    blockers.push(`Handoff lists ${h.undone.length} undone item(s) — phase cannot advance until undone is empty.`);
  }
  if (h.completed.length === 0 && h.satisfied_assertions.length === 0) {
    blockers.push('Handoff has empty `completed` AND empty `satisfied_assertions` — nothing to audit.');
  }
  if (!h.summary.trim()) {
    warnings.push('Handoff `summary` is empty — fill it in for the audit log.');
  }
  if (h.commands_run.length === 0) {
    warnings.push('No commands_run entries — audit has no verification commands to re-run.');
  }
  for (const c of h.commands_run) {
    if (c.exit_code !== 0) {
      warnings.push(`Command \`${c.cmd}\` exited ${c.exit_code} — worker should have addressed before handoff.`);
    }
  }
  return { valid: blockers.length === 0, blockers, warnings };
}

// ─── Render handoff for audit consumption ────────────────────────────────

export function renderHandoffForAudit(h: Handoff): string {
  const lines: string[] = [];
  lines.push(`# Handoff — Phase ${h.phase_index}, attempt ${h.attempt}`);
  lines.push('');
  lines.push('## Completed');
  if (h.completed.length === 0) lines.push('_(nothing claimed)_');
  for (const c of h.completed) lines.push(`- ${c}`);
  lines.push('');
  if (h.undone.length > 0) {
    lines.push('## Undone (worker says these are NOT finished)');
    for (const u of h.undone) lines.push(`- ${u}`);
    lines.push('');
  }
  lines.push('## Commands run');
  for (const c of h.commands_run) {
    const dur = c.duration_ms ? ` (${c.duration_ms}ms)` : '';
    const out = c.output_summary ? ` → ${c.output_summary}` : '';
    lines.push(`- \`${c.cmd}\` exit=${c.exit_code}${dur}${out}`);
  }
  lines.push('');
  if (h.issues.length > 0) {
    lines.push('## Issues discovered');
    for (const i of h.issues) {
      const where = i.file ? ` _(${i.file})_` : '';
      const blocks = i.blocks_assertion ? ` BLOCKS ${i.blocks_assertion}` : '';
      lines.push(`- [${i.severity.toUpperCase()}] ${i.title}${where}${blocks}`);
      if (i.body) lines.push(`  ${i.body}`);
    }
    lines.push('');
  }
  lines.push('## Procedures followed');
  lines.push(h.procedures_followed ? '✓ all per-mission skills followed' : `✗ deviation: ${h.procedures_notes || '(no note)'}`);
  lines.push('');
  lines.push('## Satisfied assertions (CLAIMED — auditor must verify each)');
  if (h.satisfied_assertions.length === 0) lines.push('_(none claimed)_');
  for (const aid of h.satisfied_assertions) lines.push(`- ${aid}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(h.summary || '_(empty)_');
  // Phase 11 pair-worker mode: surface the Codex co-worker's
  // alternative-approach analysis so scrutiny audits with both viewpoints.
  // Scrutiny is instructed to compare implementation vs. perspective and
  // flag where the worker missed something Codex flagged.
  if (h.codex_perspective) {
    lines.push('');
    lines.push('## Codex co-worker perspective (read-only, parallel — pair mode)');
    lines.push('_The Anthropic worker did the implementation; below is what a Codex consultant said about the same brief, generated in parallel and independently. Use it to spot risks the worker may have missed and to verify the implementation makes sense from a different-provider perspective._');
    lines.push('');
    lines.push(h.codex_perspective.length > 8000 ? h.codex_perspective.slice(0, 8000) + '\n…[truncated]' : h.codex_perspective);
  }
  return lines.join('\n');
}
