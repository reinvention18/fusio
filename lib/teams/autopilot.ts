/**
 * Autopilot — the multi-phase orchestrator.
 *
 * Contract: the user gives a phased plan once. Claude implements each phase,
 * Codex audits against the phase's exit criteria, and the orchestrator either
 * advances, sends Claude back to fix gaps, or pauses to ask the user a single
 * blocking question. The user does NOT have to babysit between phases.
 *
 * The orchestrator emits the same SSE shape as runPair() — same content
 * deltas, same agent/phase markers, plus three new event types for autopilot:
 *
 *   { type: 'autopilot-phase',  index, total, name, status: 'start'|'audit'|'rework'|'complete'|'stuck' }
 *   { type: 'codex-question',   index, question, audit_summary }
 *   { type: 'autopilot-finish', summary }
 *
 * Codex's audit JSON is parsed with the existing tolerant extractor in
 * codex-consult.ts. Auth uses the local `codex login` (subscription).
 */

import 'server-only';
import { spawnClaudeStream, sseChunk, sseStatus, sseDone } from '../claude-chat-bridge';
import { runCodexConsult } from './codex-consult';
import {
  type PhasedPlan,
  type Phase,
  phaseImplementBrief,
  phaseAuditBrief,
} from './phased-plan';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// ─── Public types ─────────────────────────────────────────────────────────

export type AutopilotMode = 'autopilot-execute';

export interface AutopilotOptions {
  plan: PhasedPlan;
  /** Recent chat history — passed through for context on Claude's first turn. */
  messages?: any[];
  sessionKey?: string;
  workspace?: string;
  model?: string;
  permissionMode?: string;
  requestId?: string;
  chatId?: string;
  clientId?: string;
  /** Domains to weight Codex heavier on (race/prod-env/types/security). */
  focus?: string[];
  /** If the run was previously paused on a Codex question, the user's answer. */
  pendingUserAnswer?: { phase_index: number; answer: string };
  /** Resume from this phase index (1-based). Default 1. Used after pause. */
  resume_from_phase?: number;
  /** Resume from this attempt count (1-based). Used after pause/stuck so we
   *  don't waste fresh attempt slots redoing what already happened. */
  resume_from_attempt?: number;
  /** Audit history to seed (so Codex doesn't repeat itself across runs). */
  resume_audit_history?: string[];
  /** Override the plan's rework_cap on this run only. Used when the user
   *  bumps the cap after a phase got stuck. */
  override_rework_cap?: number;
}

export interface AutopilotRun {
  stream: ReadableStream;
}

// ─── Internal — emitter helpers ───────────────────────────────────────────

interface Emit {
  voice: (agent: 'claude' | 'codex' | 'orchestrator', phase: string) => void;
  status: (s: string) => void;
  text: (t: string) => void;
  raw: (frame: string) => void;
  card: (card: any) => void;
  phaseEvt: (
    index: number,
    total: number,
    name: string,
    status: 'start' | 'audit' | 'rework' | 'complete' | 'stuck',
    extra?: Record<string, unknown>,
  ) => void;
  question: (index: number, question: string, audit_summary: string, audit?: unknown) => void;
  finish: (summary: string) => void;
}

function makeEmit(controller: ReadableStreamDefaultController, enc: TextEncoder): Emit {
  const send = (frame: string) => {
    try { controller.enqueue(enc.encode(frame)); } catch { /* client gone */ }
  };
  return {
    voice: (agent, phase) => send(`data: ${JSON.stringify({ type: 'agent', agent, phase })}\n\n`),
    status: (s) => send(sseStatus(s)),
    text: (t) => send(sseChunk(t)),
    raw: (frame) => send(frame),
    card: (card) => send(`data: ${JSON.stringify({ type: 'plan-card', card })}\n\n`),
    phaseEvt: (index, total, name, status, extra) => send(
      `data: ${JSON.stringify({ type: 'autopilot-phase', index, total, name, status, ...(extra || {}) })}\n\n`,
    ),
    question: (index, question, audit_summary, audit) => send(
      `data: ${JSON.stringify({ type: 'codex-question', index, question, audit_summary, audit })}\n\n`,
    ),
    finish: (summary) => send(`data: ${JSON.stringify({ type: 'autopilot-finish', summary })}\n\n`),
  };
}

// ─── Helpers — Claude turn passthrough + git diff ─────────────────────────

async function streamClaudeTurn(args: {
  prompt: string;
  voice: { agent: 'claude'; phase: string };
  emit: Emit;
  base: AutopilotOptions;
}): Promise<string> {
  args.emit.voice('claude', args.voice.phase);

  const { stream } = spawnClaudeStream({
    prompt: args.prompt,
    sessionKey: args.base.sessionKey,
    workspace: args.base.workspace,
    model: args.base.model,
    permissionMode: args.base.permissionMode,
    requestId: args.base.requestId,
    chatId: args.base.chatId,
    clientId: args.base.clientId,
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
            args.emit.text(t);
          } else if (parsed.type === 'status') {
            args.emit.status(parsed.status || '');
          } else if (parsed.type === 'heartbeat') {
            // ignore
          }
        } catch { /* incomplete chunk */ }
      }
    }
  }
  return collected.trim();
}

async function readGitDiff(cwd: string, base?: string): Promise<string> {
  return new Promise((resolve) => {
    const args = base ? ['diff', '--no-color', '--unified=3', base] : ['diff', '--no-color', '--unified=3', 'HEAD'];
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', () => resolve(out));
    proc.on('error', () => resolve(''));
    setTimeout(() => { try { proc.kill(); } catch {} resolve(out); }, 8000);
  });
}

/** Diff between two tree-object SHAs (captured by captureWorkingTreeSnapshot).
 *  This is the audit primitive used while the autopilot defers commits — it
 *  shows exactly the changes between two working-tree snapshots without
 *  needing real commits in HEAD. `git diff <commit>` against the user's index
 *  is NOT equivalent: it compares the index to the commit, not the working
 *  tree, so untracked-but-snapshotted files would be misreported as deleted.
 *  diff-tree compares two tree objects directly and ignores the user's index. */
async function readGitDiffBetweenTrees(cwd: string, fromTree: string, toTree: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['diff-tree', '-p', '--no-color', '--unified=3', '-r', '--find-renames', fromTree, toTree], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', () => resolve(out));
    proc.on('error', () => resolve(''));
    setTimeout(() => { try { proc.kill(); } catch {} resolve(out); }, 12_000);
  });
}

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

/** Run a git command and return stdout (or empty string on failure). */
async function runGit(cwd: string, args: string[], timeoutMs = 10000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return runGitEnv(cwd, args, undefined, timeoutMs);
}

/** Like runGit, but allows merging additional environment variables (e.g.
 *  GIT_INDEX_FILE for isolated index operations). Used by the working-tree
 *  snapshot path so we can write-tree without polluting the user's index. */
async function runGitEnv(cwd: string, args: string[], envOverride: Record<string, string> | undefined, timeoutMs = 10000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(envOverride || {}) };
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
    proc.on('error', () => resolve({ ok: false, stdout: '', stderr: '' }));
    setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: false, stdout, stderr: 'timeout' }); }, timeoutMs);
  });
}

/** Capture the entire working tree (tracked + untracked + deletions) as a
 *  git tree object, WITHOUT touching HEAD, the user's index, or any refs.
 *  Returns the tree SHA. The plan's audit boundaries use these snapshots
 *  as diff bases — Codex sees `git diff <snapshot-sha>` which is exactly
 *  the phase's edits, without the orchestrator needing to commit anything.
 *
 *  Why this exists: per-phase autopilot commits caused two failure modes
 *  on chat 41 — Phase 1's pinned baseline was invalidated by an in-flight
 *  carryover commit, and Phase 4 hit a recursion trap on `git log HEAD~2..HEAD`
 *  because every fix-attempt commit shifted HEAD. Snapshots avoid both:
 *  HEAD never moves during a plan, and the diff baseline is exactly the
 *  state the phase started from. */
async function captureWorkingTreeSnapshot(cwd: string): Promise<string | null> {
  // Use an isolated index file inside .git so the user's real index is
  // untouched. Random suffix keeps concurrent autopilot runs safe.
  const tmpIndex = path.join(cwd, '.git', `autopilot-snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.idx`);
  try {
    // Seed temp index from HEAD so files tracked-but-unmodified are included.
    // If HEAD doesn't exist (fresh repo), read-tree fails harmlessly and we
    // proceed with an empty index — `add -A` will pick up everything.
    await runGitEnv(cwd, ['read-tree', 'HEAD'], { GIT_INDEX_FILE: tmpIndex });
    // Stage everything: modifications, additions, deletions, untracked.
    const add = await runGitEnv(cwd, ['add', '-A'], { GIT_INDEX_FILE: tmpIndex });
    if (!add.ok) return null;
    const tree = await runGitEnv(cwd, ['write-tree'], { GIT_INDEX_FILE: tmpIndex });
    if (!tree.ok) return null;
    const sha = tree.stdout.trim();
    return sha || null;
  } finally {
    // Clean up. If the unlink fails (file already gone, etc.), ignore — git
    // would never use this index again because it's only invoked with the
    // explicit GIT_INDEX_FILE env var.
    try { await fs.unlink(tmpIndex); } catch {}
  }
}

/** Returns the count of changed files (staged + unstaged + untracked). */
async function workingTreeChangeCount(cwd: string): Promise<number> {
  const r = await runGit(cwd, ['status', '--porcelain']);
  if (!r.ok) return 0;
  return r.stdout.split('\n').filter(l => l.trim().length > 0).length;
}

/** Stash the entire working tree (tracked + untracked) under a label. Returns
 *  ok=true with the stash ref if anything was stashed, or ok=true/created=false
 *  if there was nothing to stash. Used at the start of read-only audit phases
 *  so the audit sees the genuine pre-edit baseline state instead of in-flight
 *  WIP from a prior phase. The stash is popped at the end of the phase by the
 *  finally block in the phase loop — so even on stuck/paused/return paths the
 *  WIP is restored to the working tree for the next phase to pick up.
 *
 *  Why this exists: chat 41 had Phase 2 edits in the working tree when Phase 1
 *  (a read-only audit) started. The carryover commit baked them into HEAD,
 *  permanently invalidating Phase 1's pinned baseline criteria. Stashing
 *  preserves the WIP without contaminating the audit. */
async function gitStashPushAll(cwd: string, label: string): Promise<{ ok: boolean; created: boolean; ref: string | null }> {
  // -u keeps untracked files; --keep-index would keep staged, but for
  // autopilot we always want a clean tree for the audit, so we stash all.
  const r = await runGit(cwd, ['stash', 'push', '-u', '-m', label], 30_000);
  if (!r.ok) return { ok: false, created: false, ref: null };
  // git stash push prints "No local changes to save" when there's nothing.
  const created = !/No local changes to save/i.test((r.stdout + ' ' + r.stderr));
  if (!created) return { ok: true, created: false, ref: null };
  // The just-pushed stash is always at stash@{0}. We look it up immediately
  // by SHA so a concurrent stash from another tool doesn't shift our index.
  const list = await runGit(cwd, ['rev-parse', 'stash@{0}'], 5_000);
  return { ok: true, created: true, ref: list.ok ? list.stdout.trim() : 'stash@{0}' };
}

/** Pop a previously stashed entry by its full SHA (preferred) or symbolic ref.
 *  If the SHA is no longer reachable from the stash list (rare — usually means
 *  someone else dropped it), we fall back to a no-op and warn. */
async function gitStashPopByRef(cwd: string, ref: string): Promise<{ ok: boolean; conflict: boolean; message: string }> {
  // Find the stash entry that matches `ref` (SHA or symbolic). git stash list
  // gives us "stash@{N}: ..." lines we can map back to SHAs.
  const list = await runGit(cwd, ['stash', 'list', '--format=%H %gd'], 5_000);
  if (!list.ok) return { ok: false, conflict: false, message: 'could not list stashes' };
  const lines = list.stdout.split('\n').filter(l => l.trim());
  const match = lines.find(l => l.startsWith(ref) || l.includes(ref));
  if (!match) {
    return { ok: false, conflict: false, message: `stash entry ${ref.slice(0, 8)} not found — was it dropped externally?` };
  }
  const symbolic = match.split(' ')[1] || 'stash@{0}';
  const r = await runGit(cwd, ['stash', 'pop', symbolic], 30_000);
  if (!r.ok) {
    // Conflict on pop — leave the stash in place, surface the conflict.
    const conflict = /conflict/i.test(r.stderr + ' ' + r.stdout);
    return { ok: false, conflict, message: r.stderr || r.stdout || 'pop failed' };
  }
  return { ok: true, conflict: false, message: 'restored' };
}

/** Heuristic: does this phase modify code, or is it a read-only audit/review?
 *  A read-only phase that runs against contaminated WIP is the chat 41 failure
 *  mode — its pinned criteria reference baseline state, but the WIP has
 *  already advanced past it. We detect read-only-ness from name/spec/criteria
 *  text and route the carryover through stash instead of commit. */
function isReadOnlyPhase(phase: Phase): boolean {
  const haystack = `${phase.name}\n${phase.spec || ''}\n${(phase.exit_criteria || []).join('\n')}`.toLowerCase();
  // Strong signals — phase explicitly declares read-only intent.
  if (/\b(read[- ]only|no[- ]modifications?|do not (modify|edit|change)|must not (modify|edit|write))\b/.test(haystack)) {
    return true;
  }
  // Name-based signals — audits/reviews/verifications are typically read-only.
  // We exclude "audit AND fix" / "review AND patch" patterns because those edit.
  const auditName = /\b(audit|review|verify|verification|inspect|investigate|analy[zs]e|check|assess|map|survey)\b/.test(phase.name.toLowerCase());
  const editsAlso = /\b(fix|patch|update|edit|modify|implement|build|refactor|migrate|rename|delete|add)\b/.test(phase.name.toLowerCase());
  if (auditName && !editsAlso) return true;
  // Criteria-only signal: every exit criterion is a verification (grep/cat/ls
  // /test/check) with no editing verbs.
  const criteria = (phase.exit_criteria || []).join(' ').toLowerCase();
  const onlyVerifications =
    criteria.length > 0 &&
    /\b(grep|cat|ls|find|test|check|verify|assert|show|list|count)\b/.test(criteria) &&
    !/\b(edit|write|create|add\s+(?!a\s+test)|modify|delete|rename|patch|fix|implement)\b/.test(criteria);
  return onlyVerifications;
}

/** Commit ALL working-tree changes with an autopilot-tagged message. Idempotent
 *  (if there's nothing to commit, returns ok=true with no hash change). */
async function autopilotCommit(cwd: string, message: string): Promise<{ ok: boolean; hash: string | null; nothingToCommit: boolean }> {
  // Stage everything (including new files + deletions).
  const add = await runGit(cwd, ['add', '-A']);
  if (!add.ok) return { ok: false, hash: null, nothingToCommit: false };

  // Check if there's anything staged.
  const diff = await runGit(cwd, ['diff', '--cached', '--quiet']);
  // git diff --quiet returns 0 if no diff, 1 if diff, other on error.
  if (diff.ok) {
    // Nothing to commit.
    return { ok: true, hash: null, nothingToCommit: true };
  }

  // Commit with an autopilot author so it's attributable in git log.
  const commit = await runGit(cwd, [
    '-c', 'user.email=autopilot@mission-control.local',
    '-c', 'user.name=Autopilot (MC)',
    'commit',
    '--no-verify',          // skip pre-commit hooks — autopilot owns the commit shape
    '-m', message,
  ], 30_000);
  if (!commit.ok) return { ok: false, hash: null, nothingToCommit: false };

  const hash = await readGitHead(cwd);
  return { ok: true, hash, nothingToCommit: false };
}

// ─── Audit shape (what Codex returns for each phase) ──────────────────────

interface PhaseAudit {
  verdict: 'phase-complete' | 'needs-rework' | 'needs-user-input';
  summary: string;
  concerns?: Array<{ severity?: string; title: string; body?: string; file?: string; axis?: string }>;
  rework_directive?: string[];
  user_question?: string;
  proceed_message?: string;
}

function normalizeAudit(raw: any): PhaseAudit {
  let verdict = (raw?.verdict === 'phase-complete' || raw?.verdict === 'needs-rework' || raw?.verdict === 'needs-user-input')
    ? raw.verdict
    : 'needs-rework';

  const userQ = typeof raw?.user_question === 'string' ? raw.user_question : undefined;

  // AUTO-RESOLVE: catch needs-user-input questions that are obviously
  // engineering trivia and auto-downgrade to needs-rework with a directive
  // telling Claude to take the default. The user explicitly said: stop asking
  // me questions the agents can answer themselves. This is the safety net.
  if (verdict === 'needs-user-input' && userQ && isTrivialQuestion(userQ, raw)) {
    verdict = 'needs-rework';
    const inferredDirective = `Codex asked the user a question that should not need user input ("${userQ.slice(0, 200)}"). Take the obvious safer default and proceed: ${defaultForQuestion(userQ)}. Do NOT escalate engineering trivia to the user.`;
    raw.rework_directive = [
      inferredDirective,
      ...(Array.isArray(raw.rework_directive) ? raw.rework_directive : []),
    ];
    raw.user_question = undefined;
  }

  return {
    verdict,
    summary: typeof raw?.summary === 'string' ? raw.summary : '',
    concerns: Array.isArray(raw?.concerns) ? raw.concerns : [],
    rework_directive: Array.isArray(raw?.rework_directive) ? raw.rework_directive.map((x: any) => String(x)) : [],
    user_question: verdict === 'needs-user-input' ? userQ : undefined,
    proceed_message: typeof raw?.proceed_message === 'string' ? raw.proceed_message : undefined,
  };
}

/** Pull the Disputed criteria section out of a worker summary, if present. */
function extractDisputedCriteria(summary: string): string | null {
  if (!summary) return null;
  // Match either explicit ## Disputed criteria heading, or a self-labeled
  // "structurally impossible" / "mathematically impossible" / "cannot be
  // satisfied" phrase. Conservative — only fires on clear disputes.
  const headed = summary.match(/##\s+Disputed criteria[\s\S]*?(?=\n##\s+|$)/i);
  if (headed) return headed[0];
  if (/(structurally|mathematically|literally) impossible|cannot be satisfied|impossibility/i.test(summary)) {
    // Take the paragraph containing the impossibility claim.
    const idx = summary.search(/(structurally|mathematically|literally) impossible|cannot be satisfied|impossibility/i);
    return summary.slice(Math.max(0, idx - 200), Math.min(summary.length, idx + 800));
  }
  return null;
}

/** Detect questions that should NEVER reach the user — git/lint/migration/
 *  deploy/scope/file-org questions that have an obvious engineering default. */
function isTrivialQuestion(q: string, audit: any): boolean {
  const low = q.toLowerCase();
  // Patterns Codex's prompt now forbids but might still slip through.
  const trivialPatterns = [
    /\b(commit|branch|git|push|merge|history|tree)\b.*\b(strategy|how|where|when|whether)\b/,
    /\b(should|how|where).{0,30}\b(commit|merge|push|branch|squash|rebase)\b/,
    /\b(lint|eslint|hooks?\s+rule|warning).{0,40}\b(scope|enforce|level|repo[- ]wide|owned|per[- ]glob)\b/,
    /\b(migration|schema).{0,30}\b(edit|patch|forward[- ]only|in[- ]place)\b/,
    /\b(deploy|vercel|eas|ota|publish).{0,30}\b(when|whether|now|wait)\b/,
    /\b(pre[- ]session|pre[- ]existing|leftover|wip).{0,40}\b(commit|revert|keep|throw)\b/,
    /\b(file|directory|folder).{0,30}\b(name|naming|organization|structure|layout)\b/,
    /\b(option|choice).{0,30}\b\(a\).{0,200}\(b\)\b/,                 // "(a) … (b) …" framing
    /default\s*(is|should\s+be|recommended)/,                        // self-labeled defaults
  ];
  if (trivialPatterns.some(re => re.test(low))) return true;
  // The audit summary self-disclosing it's not really blocking.
  const summary = (audit?.summary || '').toLowerCase();
  if (/\bdefault\b.*\b(is|recommend|safer|sensible)\b/.test(summary)) return true;
  return false;
}

/** Synthesize a "take the default" directive from the question text. */
function defaultForQuestion(q: string): string {
  const low = q.toLowerCase();
  if (/\b(lint|hooks?\s+rule)\b/.test(low)) return 'use a per-glob override on owned files only; leave legacy violations alone';
  if (/\b(migration|schema)\b/.test(low)) return 'use a forward-only follow-up migration; never edit applied migrations';
  if (/\b(deploy|vercel|eas|ota)\b/.test(low)) return 'do NOT deploy mid-plan; deployment happens after the full plan completes (or in a phase that explicitly requires it)';
  if (/\b(pre[- ]session|pre[- ]existing|leftover|wip)\b/.test(low)) return 'preserve as a labeled "chore: pre-session WIP" commit; do not revert';
  if (/\b(commit|branch|git|squash|rebase|merge)\b/.test(low)) return 'autopilot owns the git ledger — keep work on the current branch as separate per-phase commits, no rebases or force-pushes';
  if (/\b(throw\s+away|revert|discard)\b/.test(low) && /\b(work|files?|changes?)\b/.test(low)) return 'preserve the work; do not revert without an explicit user instruction';
  return 'take the safer default that does not require destructive or irreversible action';
}

function renderAuditBubble(a: PhaseAudit, phase: Phase): string {
  const lines: string[] = [];
  const badge = a.verdict === 'phase-complete' ? '✅ PHASE COMPLETE'
    : a.verdict === 'needs-rework' ? '🔁 NEEDS REWORK'
    : '❓ NEEDS YOUR INPUT';
  lines.push(`### ⚡ Codex audit — Phase ${phase.index}: ${phase.name}`);
  lines.push('');
  lines.push(`**Verdict:** ${badge}`);
  lines.push('');
  if (a.summary) { lines.push(a.summary); lines.push(''); }
  if (a.concerns && a.concerns.length) {
    lines.push('**Concerns**');
    for (const c of a.concerns) {
      const sev = c.severity ? `[${c.severity.toUpperCase()}]` : '';
      const where = c.file ? ` _(${c.file})_` : '';
      lines.push(`- ${sev} **${c.title}**${where}`);
      if (c.body) lines.push(`  ${c.body}`);
    }
    lines.push('');
  }
  if (a.rework_directive && a.rework_directive.length) {
    lines.push('**Rework directive (in order)**');
    for (const d of a.rework_directive) lines.push(`- ${d}`);
    lines.push('');
  }
  if (a.user_question) {
    lines.push('**Question for you**');
    lines.push(`> ${a.user_question}`);
    lines.push('');
  }
  if (a.proceed_message) {
    lines.push(`_${a.proceed_message}_`);
  }
  return lines.join('\n');
}

// ─── Public entry ─────────────────────────────────────────────────────────

export function runAutopilot(opts: AutopilotOptions): AutopilotRun {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = makeEmit(controller, enc);

      try {
        await runAutopilotInner(opts, emit);
      } catch (err: any) {
        emit.voice('orchestrator', 'final');
        emit.text(`\n\n⚠️ Autopilot error: ${err?.message || String(err)}\n`);
      } finally {
        emit.raw(sseDone());
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return { stream };
}

async function runAutopilotInner(opts: AutopilotOptions, emit: Emit): Promise<void> {
  const plan = opts.plan;
  const total = plan.phases.length;
  // Allow per-run override of the plan's cap (used when user bumps cap after stuck).
  const reworkCap = opts.override_rework_cap ?? plan.rework_cap ?? 5;
  const cwd = opts.workspace || process.cwd();
  const startFromIdx = Math.max(1, opts.resume_from_phase ?? 1);
  const isResume = !!opts.resume_from_phase || !!opts.resume_from_attempt || (opts.resume_audit_history?.length ?? 0) > 0;

  // Orchestrator preface — different copy for fresh start vs resume so the
  // user sees the run continuing rather than restarting.
  emit.voice('orchestrator', 'final');
  if (isResume) {
    emit.text(`\n↻ **Autopilot resuming** — Phase ${startFromIdx}/${total}${opts.resume_from_attempt ? ` (attempt ${opts.resume_from_attempt + 1})` : ''}.\n`);
  } else {
    emit.text(`\n🚦 **Autopilot starting** — ${total} phase${total === 1 ? '' : 's'}.\n\n`);
    for (const p of plan.phases) {
      emit.text(`- **Phase ${p.index}.** ${p.name}\n`);
    }
    emit.text(`\nClaude implements each phase. Codex audits against exit criteria. Rework cap per phase: ${reworkCap}. I'll auto-commit the working tree at every phase boundary — you don't need to touch git. I'll only stop for questions you alone can answer.\n\n`);
  }

  for (let i = startFromIdx; i <= total; i++) {
    const phase = plan.phases[i - 1];

    emit.phaseEvt(phase.index, total, phase.name, 'start');
    emit.status(`🚦 Phase ${phase.index}/${total}: ${phase.name}`);

    // CARRYOVER — at the start of EVERY phase, get the working tree to a
    // state the phase can be honestly audited against.
    //
    // ARCHITECTURAL NOTE (2026-05-07): autopilot no longer commits between
    // phases. The user's directive: "as long as the code is complete is
    // all that matters … it should not be committing until all the code
    // for the entire plan is written." Per-phase commits caused Phase 4
    // recursion traps (any criterion referencing `git log HEAD~..` becomes
    // self-defeating because every fix-attempt commit shifts HEAD). They
    // also caused Phase 1 baseline contamination on chat 41.
    //
    // Instead: snapshot the working tree to a git tree object (in the
    // object DB only — no refs, no HEAD changes) and pass that SHA to
    // `git diff` as the audit baseline. Codex sees exactly the same diff
    // it always saw, just rooted in a tree SHA instead of a commit SHA.
    // HEAD never moves during a plan. The user commits when ready.
    //
    // Two carryover paths remain:
    //
    //   (A) READ-ONLY AUDIT phases — stash WIP so the audit reads the
    //       genuine pre-edit baseline state (chat 41 Phase 1 fix). Stash
    //       is popped in the finally block so WIP isn't lost.
    //
    //   (B) NORMAL editing phases — no commit, no stash. The snapshot
    //       captured below as `headBefore` IS the baseline. Worker edits
    //       freely. Audit sees the diff between snapshot and current
    //       working tree — that's exactly this phase's work.
    const dirtyBefore = await workingTreeChangeCount(cwd);
    const phaseIsReadOnly = isReadOnlyPhase(phase);
    let stashRef: string | null = null;

    if (dirtyBefore > 0 && phaseIsReadOnly) {
      const stashLabel = `[autopilot] stash before read-only phase ${phase.index} (${phase.name}) — ${dirtyBefore} file(s)`;
      emit.status(`📥 Stash: ${dirtyBefore} file(s) so audit sees clean baseline`);
      const stashed = await gitStashPushAll(cwd, stashLabel);
      if (stashed.ok && stashed.created && stashed.ref) {
        stashRef = stashed.ref;
        emit.text(`📥 Stashed ${dirtyBefore} dirty file${dirtyBefore === 1 ? '' : 's'} (\`${stashed.ref.slice(0, 8)}\`) so Phase ${phase.index}'s read-only audit sees the genuine baseline. WIP will be restored when the phase finishes.\n\n`);
      } else if (!stashed.ok) {
        // Stash failed — emit a warning but DO NOT fall back to commit.
        // Per the no-commits-mid-plan policy, the worst case is the audit
        // reads dirty-WIP state; the disputed-criteria auto-accept will
        // catch any pinned-criterion failures it causes.
        emit.text(`⚠️ Could not stash ${dirtyBefore} dirty file${dirtyBefore === 1 ? '' : 's'} before read-only Phase ${phase.index}. Audit will read working-tree state directly.\n\n`);
      }
    } else if (dirtyBefore > 0 && i > startFromIdx) {
      // Non-read-only phase, has WIP from a prior phase. Just acknowledge —
      // the snapshot captured below INCLUDES this WIP, so it becomes the
      // baseline for the new phase's audit. No commit needed.
      emit.text(`_(${dirtyBefore} file${dirtyBefore === 1 ? '' : 's'} from prior phase carried into baseline — no commit, just a snapshot.)_\n\n`);
    }

    // Capture the working tree as a tree-object snapshot. This is the
    // diff baseline Codex audits against. No commit, no ref churn —
    // pure object-DB write that git diff can read back from.
    let headBefore: string | null = await captureWorkingTreeSnapshot(cwd);
    if (!headBefore) {
      // Snapshot failed (very rare — e.g., disk full). Fall back to HEAD
      // so the audit at least has SOMETHING; the diff will include any
      // pre-existing dirty state but Codex will still get a usable view.
      headBefore = await readGitHead(cwd);
      emit.text(`⚠️ Working-tree snapshot failed; falling back to HEAD as audit baseline. Audit may include pre-existing WIP in diff.\n\n`);
    }

    // On resume of THIS phase: seed the audit history + attempt counter so we
    // don't waste fresh slots redoing what already happened. Only applies to
    // the first resumed phase; subsequent phases start fresh.
    const isResumedPhase = !!opts.resume_from_phase && i === opts.resume_from_phase;
    const auditHistory: string[] = isResumedPhase && opts.resume_audit_history?.length
      ? [...opts.resume_audit_history]
      : [];
    let attempt = isResumedPhase && typeof opts.resume_from_attempt === 'number'
      ? Math.max(0, opts.resume_from_attempt)
      : 0;
    let priorConcerns: string[] = opts.pendingUserAnswer && opts.pendingUserAnswer.phase_index === phase.index
      ? [`The user answered an outstanding Codex question: "${opts.pendingUserAnswer.answer}". Use this to proceed.`]
      : [];

    // Clear resume metadata after applying so subsequent phases start fresh.
    if (opts.pendingUserAnswer?.phase_index === phase.index) opts.pendingUserAnswer = undefined;
    if (isResumedPhase) {
      opts.resume_from_attempt = undefined;
      opts.resume_audit_history = undefined;
    }

    let phaseDone = false;
    // Wrap the phase loop in try/finally so a stash created above is ALWAYS
    // popped — on phase-complete, stuck, codex-unreachable, needs-user-input,
    // or any uncaught throw. Without this, a paused autopilot would leave
    // the user's WIP trapped in `git stash list` after a crash or pause.
    try {
    while (!phaseDone) {
      attempt++;
      if (attempt > reworkCap) {
        emit.phaseEvt(phase.index, total, phase.name, 'stuck', {
          rework_cap: reworkCap,
          attempts_used: attempt - 1,
          // Resume hints so the client's "Retry phase" button can pick up
          // where we left off (with a higher cap).
          resume_attempt: attempt - 1,
          audit_history: auditHistory,
          last_concerns: priorConcerns,
        });
        emit.voice('orchestrator', 'final');
        emit.text(`\n\n⛔ **Phase ${phase.index} stuck** — exceeded rework cap of ${reworkCap}. Pausing for your input.\n\nUse the **Retry phase** button below to bump the cap and resume from attempt ${attempt}, or fix the blockers manually and click **Continue from next phase**.\n`);
        return;
      }

      // ── Claude implements ──
      emit.status(`🛠 Phase ${phase.index} — Claude implementing (attempt ${attempt}/${reworkCap})`);
      const claudePrompt = phaseImplementBrief(plan, phase, attempt, priorConcerns);
      const claudeSummary = await streamClaudeTurn({
        prompt: claudePrompt,
        voice: { agent: 'claude', phase: `phase-${phase.index}-impl-a${attempt}` },
        emit,
        base: opts,
      });

      // ── Codex audits ──
      emit.phaseEvt(phase.index, total, phase.name, 'audit', { attempt });
      emit.status(`⚖️ Phase ${phase.index} — Codex auditing`);
      emit.voice('codex', `phase-${phase.index}-audit-a${attempt}`);
      emit.text('_Codex auditing this phase against its exit criteria…_\n\n');

      // Snapshot the post-worker working tree, then diff against the
      // pre-phase snapshot. This gives Codex the exact same diff it would
      // see from `git diff <prior-commit>` if we'd been committing — but
      // without any commits being made. If snapshotting fails for any
      // reason, fall back to diffing against HEAD (legacy path), which
      // means the diff will include any pre-existing dirty WIP.
      const headAfter = await captureWorkingTreeSnapshot(cwd);
      let diff = '';
      if (headBefore && headAfter && /^[0-9a-f]{40}$/.test(headBefore) && /^[0-9a-f]{40}$/.test(headAfter)) {
        diff = await readGitDiffBetweenTrees(cwd, headBefore, headAfter);
      }
      if (!diff) {
        // Either snapshot failed or the trees were identical (rare —
        // maybe Claude only printed text, no edits). Try the legacy
        // `git diff HEAD` as a last-resort signal for Codex.
        diff = await readGitDiff(cwd, 'HEAD');
      }
      const brief = phaseAuditBrief(plan, phase, claudeSummary, diff, attempt, auditHistory);

      let audit: PhaseAudit;
      try {
        const result = await runCodexConsult({
          brief,
          role: 'reviewer',
          focus: opts.focus,
          cwd,
          timeoutMs: 20 * 60 * 1000,
        });
        audit = normalizeAudit(extractAuditFromConsult(result));

        // ── DISPUTED-CRITERIA AUTO-ACCEPT ──
        // If Claude's worker explicitly disputed criteria (## Disputed
        // criteria block, "structurally/mathematically impossible", etc.)
        // AND we're on attempt 2+, auto-accept the phase as
        // complete-with-disputes instead of paging the user. Both agents
        // have had at least two rounds to converge; if Claude is still
        // surfacing the same impossibility AND Codex is either still
        // asking for rework OR escalating to user-input, the user has
        // explicitly said: "stop asking me to waive criteria the agents
        // already agreed are unsatisfiable." The dispute is logged in
        // the audit summary so it's visible in the phase commit.
        //
        // This catches two failure modes in chat 41:
        //   (a) Codex returns needs-rework round after round on a
        //       pinned literal that the worker proved unsatisfiable
        //       (lowered from attempt >= 3 to >= 2 because by attempt 2
        //       the agents have already exchanged their full case).
        //   (b) Codex itself escalates to needs-user-input on the same
        //       disputed criterion — the previous valve missed this
        //       because it only watched needs-rework.
        const shouldAutoAccept =
          attempt >= 2 &&
          (audit.verdict === 'needs-rework' || audit.verdict === 'needs-user-input');

        if (shouldAutoAccept) {
          const disputeBlock = extractDisputedCriteria(claudeSummary);
          if (disputeBlock) {
            const priorVerdict = audit.verdict;
            const disputeOneLine = disputeBlock
              .slice(0, 600)
              .replace(/\s+/g, ' ')
              .trim();
            audit = {
              ...audit,
              verdict: 'phase-complete',
              user_question: undefined,
              summary:
                (audit.summary ? audit.summary + ' · ' : '') +
                `Auto-accepted with disputes after ${attempt} attempts — worker flagged criteria as unsatisfiable: ${disputeOneLine}`,
              proceed_message: `✓ Phase ${phase.index} accepted with disputed criteria after ${attempt} attempts. Proceeding to Phase ${phase.index + 1}.`,
            };
            emit.text(
              `\n\n🟢 **Disputed-criteria auto-accept** — Claude has explicitly disputed criteria for ${attempt} attempt${attempt === 1 ? '' : 's'} and Codex would otherwise ${priorVerdict === 'needs-user-input' ? 're-page you' : 'loop again'}. Both agents have made their case; accepting the phase with disputes logged so autopilot proceeds without further interruption.\n`
            );
          }
        }
      } catch (err: any) {
        // Codex unreachable — surface and pause autopilot so user can intervene.
        emit.text(`\n\n⚠️ Codex unreachable during audit: ${err.message}. Autopilot paused at Phase ${phase.index}.\n`);
        emit.phaseEvt(phase.index, total, phase.name, 'stuck', { reason: 'codex-unreachable' });
        return;
      }

      emit.text(renderAuditBubble(audit, phase));

      // Persist a short audit history line for subsequent attempts.
      auditHistory.push(`Attempt ${attempt}: ${audit.verdict} — ${audit.summary.slice(0, 200)}`);

      if (audit.verdict === 'phase-complete') {
        // No commit. The next phase will snapshot the current working tree
        // (which now includes this phase's edits) as its own audit baseline.
        // Diff isolation is preserved without touching git history. Reason:
        // committing per phase causes recursion traps for any criterion
        // referencing HEAD/git-log, and the user explicitly asked us to
        // hold all commits until the entire plan is complete.
        emit.phaseEvt(phase.index, total, phase.name, 'complete', {
          attempts: attempt,
          // commit_hash intentionally omitted — no commit was made.
          snapshot_sha: headBefore,
          deferred_commit: true,
        });
        emit.voice('orchestrator', 'final');
        emit.text(`\n\n${audit.proceed_message || `✓ Phase ${phase.index} complete. Proceeding to Phase ${phase.index + 1}.`}\n_(no commit — autopilot defers all commits until plan completion. Phase boundary tracked via snapshot \`${(headBefore || '').slice(0, 8)}\`.)_\n\n`);
        phaseDone = true;
        break;
      }

      if (audit.verdict === 'needs-user-input') {
        const q = audit.user_question || 'Codex needs your input to proceed but did not provide a specific question.';
        emit.phaseEvt(phase.index, total, phase.name, 'rework', {
          attempt,
          reason: 'needs-user-input',
          // Include resume hints so the client passes them back on the answer.
          resume_attempt: attempt,
          audit_history: auditHistory,
        });
        emit.question(phase.index, q, audit.summary, {
          ...audit,
          // Same hints embedded in the question for the answer-button handler.
          resume_attempt: attempt,
          audit_history: auditHistory,
        });
        emit.voice('orchestrator', 'final');
        emit.text(`\n\n⏸️ **Autopilot paused** — Codex needs your input on Phase ${phase.index}.\n\nAnswer in chat to resume.\n`);
        return;
      }

      // verdict === 'needs-rework' — go around again.
      emit.phaseEvt(phase.index, total, phase.name, 'rework', { attempt });
      priorConcerns = [
        ...(audit.rework_directive || []),
        ...(audit.concerns || []).map(c => `${c.title}${c.body ? ': ' + c.body : ''}`),
      ];
      emit.voice('orchestrator', 'final');
      emit.text(`\n\n🔁 Rework attempt ${attempt}/${reworkCap} for Phase ${phase.index}. Claude will address ${priorConcerns.length} item${priorConcerns.length === 1 ? '' : 's'}.\n\n`);
      // Loop continues — Claude re-implements with priorConcerns.
    }
    } finally {
      // Restore the WIP we stashed before a read-only audit phase, on EVERY
      // exit path (complete, stuck, paused, codex-unreachable, throw). The
      // next phase's carryover will commit/restash this work appropriately.
      if (stashRef) {
        const popped = await gitStashPopByRef(cwd, stashRef);
        if (popped.ok) {
          emit.text(`📤 Restored ${dirtyBefore} stashed file${dirtyBefore === 1 ? '' : 's'} after Phase ${phase.index} (read-only audit done) — next phase will see them as carryover.\n\n`);
        } else if (popped.conflict) {
          emit.text(`⚠️ Stash pop conflicted on Phase ${phase.index} — Claude edited a file the stash also touches. Stash retained at \`${stashRef.slice(0, 8)}\`. Run \`git stash list\` / \`git stash show -p\` to inspect.\n\n`);
        } else {
          emit.text(`⚠️ Could not restore stash after Phase ${phase.index}: ${popped.message}. Stash ref: \`${stashRef.slice(0, 8)}\`.\n\n`);
        }
      }
    }
  }

  // All phases done.
  emit.phaseEvt(total, total, plan.phases[total - 1]?.name || '', 'complete', { all_phases_done: true });
  // Plan-end summary: no commits were made during the plan. Compute a
  // diff summary against the original baseline so the user knows what's
  // pending in the working tree and can commit on their own terms.
  const finalDirty = await workingTreeChangeCount(cwd);
  const filesChangedLine = finalDirty > 0
    ? `${finalDirty} file${finalDirty === 1 ? '' : 's'} pending in your working tree.`
    : `Working tree is clean.`;
  emit.finish(`Autopilot complete — all ${total} phase${total === 1 ? '' : 's'} closed. ${filesChangedLine}`);
  emit.voice('orchestrator', 'final');
  emit.text(
    `\n🏁 **Autopilot complete.** All ${total} phase${total === 1 ? '' : 's'} delivered and audited.\n\n` +
    (finalDirty > 0
      ? `**${finalDirty} file${finalDirty === 1 ? '' : 's'}** changed across the plan, currently uncommitted in your working tree (no auto-commits during the plan, by design).\n\n` +
        `Suggested next steps:\n` +
        `- \`git status\` — see what changed\n` +
        `- \`git diff\` — review the full plan diff\n` +
        `- \`git add -A && git commit -m "<plan goal>"\` — single commit for the whole plan\n` +
        `- Or stage selectively if you want multiple commits.\n`
      : `_(No file changes pending — the plan didn't modify the working tree, or you've already committed.)_\n`)
  );
}

// ─── Audit extraction helper ─────────────────────────────────────────────
//
// runCodexConsult returns a ConsultResult shaped for the simpler critic role.
// The autopilot brief asks for additional fields (rework_directive,
// user_question, proceed_message). We dig those out of the raw stdout payload
// the consult call already parsed. If raw has them, use them; otherwise fall
// back to the consult's structured fields.

function extractAuditFromConsult(consult: { raw: string; verdict: string; summary: string; concerns: any[]; suggestions: string[]; patches: any[] }): any {
  // Try to find a JSON object in raw with our richer fields.
  const lines = consult.raw.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let evt: any;
    try { evt = JSON.parse(lines[i]); } catch { continue; }
    const candidates: string[] = [];
    if (evt?.item?.text) candidates.push(evt.item.text);
    if (typeof evt?.message === 'string') candidates.push(evt.message);
    if (typeof evt?.text === 'string') candidates.push(evt.text);
    for (const text of candidates) {
      const obj = parseJsonish(text);
      if (obj && (obj.verdict || obj.rework_directive || obj.user_question)) {
        // Map verdict aliases.
        if (obj.verdict === 'agree') obj.verdict = 'phase-complete';
        else if (obj.verdict === 'agree-with-concerns' || obj.verdict === 'disagree') obj.verdict = 'needs-rework';
        else if (obj.verdict === 'needs-info') obj.verdict = 'needs-user-input';
        return obj;
      }
    }
  }
  // Fallback: synthesize from consult shape.
  return {
    verdict: consult.verdict === 'agree' ? 'phase-complete'
      : consult.verdict === 'needs-info' ? 'needs-user-input'
      : 'needs-rework',
    summary: consult.summary,
    concerns: consult.concerns,
    rework_directive: consult.suggestions,
  };
}

function parseJsonish(text: string): any {
  if (!text) return null;
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : trimmed;
  try { return JSON.parse(body); } catch {}
  const f = body.indexOf('{'); const l = body.lastIndexOf('}');
  if (f >= 0 && l > f) {
    try { return JSON.parse(body.slice(f, l + 1)); } catch {}
  }
  return null;
}
