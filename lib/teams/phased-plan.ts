/**
 * Phased plan — shared types + parser for Autopilot mode.
 *
 * A phased plan is a list of phases, each with explicit exit criteria. The
 * autopilot orchestrator runs them sequentially: Claude implements, Codex
 * audits against the criteria, decides phase-complete | needs-rework |
 * needs-user-input. The user only enters the loop when Codex flags a
 * blocker — otherwise both agents drive end-to-end.
 */

export interface Phase {
  /** 1-based index. Stable across reworks. */
  index: number;
  /** Short title — shown in progress UI. */
  name: string;
  /** What this phase delivers. Free-form markdown. */
  spec: string;
  /** Concrete checklist Codex audits against. Each item must be verifiable
   *  from code/diff/tests. Phase is not "complete" until every item passes. */
  exit_criteria: string[];
  /** Files this phase is expected to touch. Helps Codex flag scope drift. */
  expected_files?: string[];
  /** Notes / dependencies. Free-form. */
  notes?: string;
}

export interface PhasedPlan {
  goal: string;
  /** Optional preface before phase 1 (overall approach, conventions). */
  preface?: string;
  phases: Phase[];
  /** Per-phase rework cap. After this many failed Codex audits in a row,
   *  autopilot pauses and asks the user how to proceed. Default 5 — tuned
   *  from real autopilot runs where Codex caught real bugs each round and
   *  Claude was making genuine progress; 3 attempts wasn't enough. */
  rework_cap?: number;
}

/**
 * Parse a phased plan from user prose. Recognizes a few common shapes:
 *   ## Phase 1: <name>
 *   <spec>
 *   - exit: <criterion>
 *
 * Falls back to a single-phase plan if no markers are detected.
 */
export function parsePhasedPlan(text: string, fallbackGoal = ''): PhasedPlan | null {
  const phaseRe = /^#{1,3}\s+phase\s+(\d+)\s*[:\-]\s*(.+)$/im;
  if (!phaseRe.test(text)) return null;

  const lines = text.split('\n');
  const phases: Phase[] = [];
  let preface = '';
  let cur: Phase | null = null;
  let bucket: 'spec' | 'criteria' | 'notes' = 'spec';
  let specBuf: string[] = [];
  let critBuf: string[] = [];
  let notesBuf: string[] = [];
  let prefBuf: string[] = [];

  const flush = () => {
    if (!cur) return;
    cur.spec = specBuf.join('\n').trim();
    cur.exit_criteria = critBuf.map(s => s.trim()).filter(Boolean);
    cur.notes = notesBuf.join('\n').trim() || undefined;
    phases.push(cur);
    cur = null;
    specBuf = [];
    critBuf = [];
    notesBuf = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, '');
    const phaseMatch = line.match(/^#{1,3}\s+phase\s+(\d+)\s*[:\-]\s*(.+)$/i);
    if (phaseMatch) {
      flush();
      cur = {
        index: parseInt(phaseMatch[1], 10),
        name: phaseMatch[2].trim(),
        spec: '',
        exit_criteria: [],
      };
      bucket = 'spec';
      continue;
    }
    if (!cur) {
      prefBuf.push(line);
      continue;
    }
    // section markers
    if (/^#{2,4}\s+(exit\s+criteria|completion\s+criteria|done\s+when)/i.test(line)) {
      bucket = 'criteria';
      continue;
    }
    if (/^#{2,4}\s+(notes?|dependencies)/i.test(line)) {
      bucket = 'notes';
      continue;
    }
    if (bucket === 'criteria' && /^[-*+]\s+/.test(line)) {
      critBuf.push(line.replace(/^[-*+]\s+/, ''));
      continue;
    }
    // also catch inline `- exit: ...` lines anywhere
    const exitInline = line.match(/^[-*+]\s+(exit|done|criterion|criteria)\s*[:\-]\s*(.+)$/i);
    if (exitInline) {
      critBuf.push(exitInline[2]);
      continue;
    }
    if (bucket === 'spec') specBuf.push(line);
    else if (bucket === 'notes') notesBuf.push(line);
  }
  flush();
  preface = prefBuf.join('\n').trim();

  // Re-index 1..N to be safe (user might have skipped numbers).
  phases.forEach((p, i) => { p.index = i + 1; });

  return {
    goal: fallbackGoal || (phases[0]?.name ?? 'Untitled plan'),
    preface: preface || undefined,
    phases,
    rework_cap: 5,
  };
}

/** Render a Phase as a brief for Claude's implementation turn. */
export function phaseImplementBrief(plan: PhasedPlan, phase: Phase, attempt: number, priorConcerns?: string[]): string {
  const lines: string[] = [];
  lines.push(`# Autopilot — Phase ${phase.index}/${plan.phases.length}: ${phase.name}`);
  lines.push('');
  lines.push(`Attempt ${attempt}.`);
  if (plan.preface) {
    lines.push('');
    lines.push('## Plan preface');
    lines.push(plan.preface);
  }
  lines.push('');
  lines.push('## This phase — spec');
  lines.push(phase.spec || '(no spec)');
  if (phase.exit_criteria.length) {
    lines.push('');
    lines.push('## Exit criteria — PINNED for this phase');
    lines.push('Every item must be verifiably satisfied by your diff or by running a named command. Do NOT defer any criterion to a later phase.');
    for (let i = 0; i < phase.exit_criteria.length; i++) {
      lines.push(`- [${i + 1}] ${phase.exit_criteria[i]}`);
    }
  }
  if (phase.expected_files?.length) {
    lines.push('');
    lines.push('## Expected files (your work should be SCOPED to these)');
    lines.push('Modifying files outside this list is allowed only when strictly required by a criterion. Otherwise treat it as scope creep.');
    for (const f of phase.expected_files) lines.push(`- \`${f}\``);
  }
  if (priorConcerns?.length) {
    lines.push('');
    lines.push('## Prior audit concerns to address');
    lines.push('Each item below was raised by Codex on a previous attempt. Address each in order; cite the criterion # it relates to.');
    for (const c of priorConcerns) lines.push(`- ${c}`);
  }
  lines.push('');
  lines.push('## Rules');
  lines.push('- **First check if the work is already in place.** Before implementing, scan the repo: if the files listed in expected_files (or the criteria) already contain the required code from prior work or a baseline commit, DO NOT re-implement. Verify each criterion against the existing code, write a short verification summary citing file:line for each criterion, and return that. Re-implementing working code is the worst possible outcome.');
  lines.push('- DO the full work IF it isn\'t already done. No "I\'ll handle this later", no TODO/FIXME comments, no stub returns unless the spec calls for them.');
  lines.push('- **Stay in scope.** Don\'t fix repo-wide hygiene issues that aren\'t in this phase\'s exit_criteria — they\'re a separate concern. Bundling them in makes the diff unreviewable and triggers rework loops.');
  lines.push('- Tests/checks: add them when the criteria say so, and run them.');
  lines.push('- **Mission Control auto-commits at phase boundaries.** Don\'t worry about leaving uncommitted work for the next phase — MC handles that. Just finish this phase\'s work.');
  lines.push('- **Do NOT deploy** (Vercel, EAS, OTA, npm publish, supabase functions deploy) unless this phase\'s exit_criteria explicitly require it. Phase implementation = code + commits only. Deployment is the final phase or a separate manual gate.');
  lines.push('- After implementing, write a SHORT summary listing every exit criterion by [#] and where it was satisfied (file:line or command output). This makes Codex\'s audit fast and accurate.');
  lines.push('');
  lines.push('## When you genuinely cannot proceed');
  lines.push('Reserve `## Blockers` for things ONLY THE USER can answer:');
  lines.push('  • Missing credential/secret you cannot generate.');
  lines.push('  • Irreversible/destructive choice (drop a table that has prod data, force-push to main, delete a customer record).');
  lines.push('  • Conflicting BUSINESS requirements only the user can resolve (e.g. brand voice, pricing tiers, who can see what).');
  lines.push('');
  lines.push('Do NOT add to `## Blockers`:');
  lines.push('  ✗ Git/commit/branch organization — MC handles commits.');
  lines.push('  ✗ Lint rule scope — pick the default that doesn\'t bundle unrelated cleanup.');
  lines.push('  ✗ Deployment timing — code only, deploys at the end.');
  lines.push('  ✗ "Which option is preferred" when one is obviously safer or matches the plan — pick that one.');
  lines.push('  ✗ File organization / naming / style — pick something reasonable and move on.');
  lines.push('  ✗ Pre-session leftover work — MC already snapshots the baseline; ignore the noise.');
  lines.push('');
  lines.push('If you\'re tempted to ask "should we do (a) or (b)?" and (a) matches the spec or is the obvious safer default, just do (a). Note the choice in your summary so Codex sees the reasoning.');
  return lines.join('\n');
}

/** Render the brief for Codex's phase audit. */
export function phaseAuditBrief(plan: PhasedPlan, phase: Phase, claudeSummary: string, gitDiff: string, attempt: number, history: string[]): string {
  const lines: string[] = [];
  lines.push(`# Autopilot phase audit — Phase ${phase.index}/${plan.phases.length}: ${phase.name}`);
  lines.push(`Attempt ${attempt}. Cap: ${plan.rework_cap ?? 5}.`);
  lines.push('');
  lines.push('## Phase spec (PINNED — do not expand or reinterpret)');
  lines.push(phase.spec);
  lines.push('');
  if (phase.exit_criteria.length) {
    lines.push('## Exit criteria — PINNED for this phase');
    lines.push('These criteria were agreed before implementation. They are the COMPLETE acceptance set for this phase.');
    lines.push('Audit ONLY against this list. Do NOT add new criteria mid-flight. Do NOT widen the scope of an');
    lines.push('existing criterion across attempts (e.g. "lint clean for owned files" cannot become "lint clean repo-wide" on attempt 2).');
    lines.push('If a criterion is genuinely ambiguous, set verdict=needs-user-input and ask one clear question.');
    lines.push('');
    for (let i = 0; i < phase.exit_criteria.length; i++) {
      lines.push(`- [${i + 1}] ${phase.exit_criteria[i]}`);
    }
    lines.push('');
  }
  if (phase.expected_files && phase.expected_files.length) {
    lines.push('## Phase-owned files (informational)');
    lines.push('Files listed below are the expected scope of this phase. The diff below is already filtered');
    lines.push('to changes since phase start, so unrelated pre-existing files won\'t appear unless this phase');
    lines.push('genuinely modified them. If you see modifications outside this list, it\'s legitimate scope drift to flag.');
    for (const f of phase.expected_files) lines.push(`- \`${f}\``);
    lines.push('');
  }
  lines.push('## Claude\'s summary of this attempt');
  lines.push(claudeSummary || '(empty)');
  lines.push('');
  lines.push('## Git diff since phase start (this phase ONLY)');
  lines.push('Note: this diff is bounded to changes made AFTER the phase began (Mission Control auto-commits at');
  lines.push('phase boundaries). Anything that was already committed before this phase is NOT in this diff.');
  lines.push('');
  lines.push('**If the diff is empty or near-empty:** the phase work may already exist in a prior commit (baseline,');
  lines.push('a previous phase, or pre-session work). In that case Claude should have written a VERIFICATION summary');
  lines.push('citing file:line for each criterion (no new code needed). Audit by checking the existing code at those');
  lines.push('paths against the criteria, not by demanding a new diff. Do NOT mark "no implementation visible" as a');
  lines.push('blocker if Claude\'s summary points to existing code that satisfies the criteria.');
  lines.push('```diff');
  lines.push(gitDiff.length > 60_000 ? gitDiff.slice(0, 60_000) + '\n…[truncated]' : gitDiff || '(no diff — verification mode if Claude\'s summary cites existing code)');
  lines.push('```');
  if (history.length) {
    lines.push('');
    lines.push('## Audit history (prior attempts on this phase)');
    lines.push('Cite specific items from prior audits when explaining what was/wasn\'t addressed.');
    for (const h of history) lines.push(`- ${h}`);
  }
  lines.push('');
  lines.push('## What we want from you');
  lines.push('Return JSON with these fields:');
  lines.push('- `verdict`: one of `phase-complete` | `needs-rework` | `needs-user-input`');
  lines.push('- `summary`: 1–3 sentences explaining your verdict.');
  lines.push('- `concerns`: array of {severity, title, body?, file?, axis?} — populate for needs-rework.');
  lines.push('- `patches`: array of suggested patches — only if you have concrete fixes (else omit).');
  lines.push('- `rework_directive`: a precise, ordered list of items Claude must address before re-audit. Each item MUST cite the specific exit criterion number it addresses (e.g. "[criterion 3] tsc --noEmit must exit 0; current: 2 errors in src/X.ts:L4"). Omit unless verdict=needs-rework.');
  lines.push('- `user_question`: ONE clear question for the user. Required iff verdict=needs-user-input.');
  lines.push('- `proceed_message`: a short "Phase N complete — moving on to Phase N+1" line. Required iff verdict=phase-complete.');
  lines.push('');
  lines.push('## Audit discipline');
  lines.push('1. **Pinned criteria**: if every criterion in the PINNED list is verifiably satisfied by the diff/checks, return phase-complete. You may NOT block on a concern outside the criteria list.');
  lines.push('2. **No goalpost moving**: if you cited concern X on attempt N and Claude addressed X on attempt N+1, do not re-cite X with a stricter standard. Either it\'s addressed or it\'s not.');
  lines.push('3. **Scope discipline**: real bugs OUTSIDE the phase\'s criteria go in `concerns` with severity=low — they\'re informational, not blocking. Only criteria items can block.');
  lines.push('4. **Hunt for**: deferred work ("later phase", "for now"), TODO/FIXME comments Claude added, stub returns, missing tests when a CRITERION asked for them, criteria not verifiable from the diff/checks.');
  lines.push('5. **Approve fast** if the work is genuinely complete — don\'t invent rework to look thorough.');
  lines.push('6. **Disputed-criterion escape valve** — CRITICAL:');
  lines.push('   If Claude\'s summary contains a `## Disputed criteria` section claiming a pinned criterion is **logically/structurally impossible** (math error in the criterion text, git-semantics violation like requiring "A" for a file already tracked in HEAD, mutually contradictory pair of criteria, etc.), do NOT keep demanding rework. The pinned plan made an error.');
  lines.push('   Instead, set `verdict: "needs-user-input"` and use `user_question` to surface the dispute concisely. Example:');
  lines.push('     "Phase N criterion [9] asks for `15+0+21=35` but the actual sum is 36. Edit the criterion, drop it, or override and accept the phase?"');
  lines.push('   Take Claude\'s dispute at face value when she\'s on the third+ attempt and the dispute reasoning cites concrete impossibility. Don\'t loop her on a math/semantics error you can\'t resolve either.');
  lines.push('   Disputed criteria that are NOT logically impossible (just inconvenient) — keep auditing as needs-rework normally.');
  lines.push('');
  lines.push('## When to use needs-user-input — RARE, HIGH-BAR ONLY');
  lines.push('The user is paying you to NOT bother them. Default to deciding yourself or to needs-rework.');
  lines.push('');
  lines.push('USE needs-user-input ONLY when ALL of the following are true:');
  lines.push('  • The decision is irreversible or destructive (e.g. dropping production data, deleting a customer record, force-pushing).');
  lines.push('  • You and Claude cannot rationally infer the user\'s preference from the plan, the spec, or normal engineering defaults.');
  lines.push('  • A wrong choice causes user-visible damage or significant rework.');
  lines.push('');
  lines.push('DO NOT use needs-user-input for:');
  lines.push('  ✗ Git/commit organization questions (autopilot owns commits — it auto-commits at phase boundaries).');
  lines.push('  ✗ Deployment strategy questions (autopilot does NOT deploy to Vercel/EAS until the entire plan is complete unless the plan explicitly says so).');
  lines.push('  ✗ Lint rule scope (Claude proposes a scope, you accept it if reasonable; bundling repo-wide cleanup into a feature phase is forbidden by audit discipline #3).');
  lines.push('  ✗ "Which option is preferred" when a default is obviously safer/saner — TAKE the safer default and proceed.');
  lines.push('  ✗ Migration/schema patching strategy — forward-only is always the right default; never edit applied migrations.');
  lines.push('  ✗ Pre-session uncommitted work — autopilot already commits it as a baseline; don\'t ask.');
  lines.push('  ✗ Naming, file-organization, code-style, or "should we keep this work" questions — pick a sensible default and continue.');
  lines.push('');
  lines.push('If you\'re tempted to ask the user "should we (a) X or (b) Y" and (a) is the obvious safer default, set verdict=phase-complete or needs-rework as appropriate and CHOOSE (a). Note the choice in `summary`. Move on.');
  lines.push('');
  lines.push('Hard rule: if the question you\'re about to ask has any answer that starts with "the default is" or "we recommend", DO NOT ASK. Take the default.');
  return lines.join('\n');
}
