/**
 * Codex review subprocess wrapper for the Inspector role.
 *
 * Shells out to `node codex-companion.mjs adversarial-review --wait` from
 * the openai/codex-plugin-cc plugin. Parses structured JSON output per
 * review-output.schema.json (verdict, summary, findings[]).
 *
 * Prerequisites: Node ≥18.18, `npm i -g @openai/codex`, `codex login`.
 */

import 'server-only';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { persistReview, type PersistReviewInput, type ReviewFindingSeverity } from './schema';
import { appendEvent } from './schema';

// The codex-companion.mjs path. First check if we have a local copy
// (from the mc-research clone); fall back to a globally installed one.
function findCodexCompanion(): string | null {
  const localPath = path.join(
    process.cwd(), '..', '..', '..', 'mc-research',
    'codex-plugin-cc', 'plugins', 'codex', 'scripts', 'codex-companion.mjs',
  );
  if (existsSync(localPath)) return localPath;

  const homeLocal = path.join(
    process.env.HOME || '~', 'mc-research',
    'codex-plugin-cc', 'plugins', 'codex', 'scripts', 'codex-companion.mjs',
  );
  if (existsSync(homeLocal)) return homeLocal;

  return null;
}

export interface CodexReviewInput {
  mode: 'adversarial' | 'standard';
  base?: string;
  scope?: 'auto' | 'working-tree' | 'branch';
  focus?: string;
  cwd: string;
  taskId: string;
  teamId: string;
  reviewerAgentId?: string;
}

export interface CodexFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  body?: string;
  file?: string;
  line_start?: number;
  line_end?: number;
  confidence?: number;
  recommendation?: string;
}

export interface CodexReviewResult {
  verdict: 'approve' | 'needs-attention';
  summary: string;
  findings: CodexFinding[];
  next_steps: string[];
  raw: string;
  cost_usd?: number;
  duration_ms: number;
  review_id: string;
  finding_ids: string[];
}

function mapSeverity(s: string): ReviewFindingSeverity {
  if (s === 'critical') return 'critical';
  if (s === 'high') return 'high';
  if (s === 'medium') return 'medium';
  if (s === 'low') return 'low';
  return 'info';
}

export async function runCodexReview(input: CodexReviewInput): Promise<CodexReviewResult> {
  const companionPath = findCodexCompanion();
  if (!companionPath) {
    throw new Error(
      'codex-companion.mjs not found. Ensure openai/codex-plugin-cc is cloned at ~/mc-research/codex-plugin-cc or install it.',
    );
  }

  const args = [
    companionPath,
    input.mode === 'adversarial' ? 'adversarial-review' : 'review',
    '--wait',
    '--base', input.base || 'main',
    '--scope', input.scope || 'branch',
  ];
  if (input.focus) args.push(input.focus);

  const startTime = Date.now();

  const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const proc = spawn('node', args, {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    proc.on('error', reject);

    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      reject(new Error('Codex review timed out after 10 minutes'));
    }, 10 * 60 * 1000);
  });

  const duration_ms = Date.now() - startTime;

  if (result.code !== 0) {
    throw new Error(`Codex exited with code ${result.code}: ${result.stderr.slice(-500)}`);
  }

  let parsed: { verdict?: string; summary?: string; findings?: any[]; next_steps?: string[] };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = {
      verdict: 'needs-attention',
      summary: result.stdout.slice(0, 2000),
      findings: [],
      next_steps: [],
    };
  }

  const findings: CodexFinding[] = (parsed.findings || []).map((f: any) => ({
    severity: f.severity || 'medium',
    title: f.title || 'Untitled finding',
    body: f.body,
    file: f.file,
    line_start: f.line_start,
    line_end: f.line_end,
    confidence: f.confidence,
    recommendation: f.recommendation,
  }));

  const hasBlocker = findings.some(f => f.severity === 'critical' || f.severity === 'high');

  const reviewInput: PersistReviewInput = {
    task_id: input.taskId,
    reviewer_agent_id: input.reviewerAgentId,
    reviewer_model: 'gpt-5-codex',
    review_kind: input.mode === 'adversarial' ? 'adversarial' : 'diff',
    clean: !hasBlocker,
    verdict: (parsed.verdict as string) || (hasBlocker ? 'needs-attention' : 'approve'),
    summary: (parsed.summary as string) || '',
    cost_usd: 1.5,
    duration_ms,
    raw_output: result.stdout.slice(0, 100_000),
    findings: findings.map(f => ({
      severity: mapSeverity(f.severity),
      file: f.file,
      line_start: f.line_start,
      line_end: f.line_end,
      title: f.title,
      body: f.body,
      recommendation: f.recommendation,
      confidence: f.confidence,
    })),
  };

  const { review_id, finding_ids } = persistReview(reviewInput);

  appendEvent({
    team_id: input.teamId,
    agent_id: input.reviewerAgentId,
    task_id: input.taskId,
    kind: 'task_transition',
    severity: hasBlocker ? 'warn' : 'info',
    payload: {
      action: 'codex_review',
      verdict: parsed.verdict,
      findings_count: findings.length,
      blockers: findings.filter(f => f.severity === 'critical' || f.severity === 'high').length,
      duration_ms,
    },
    chat_report: hasBlocker,
  });

  return {
    verdict: (parsed.verdict as 'approve' | 'needs-attention') || (hasBlocker ? 'needs-attention' : 'approve'),
    summary: (parsed.summary as string) || '',
    findings,
    next_steps: (parsed.next_steps as string[]) || [],
    raw: result.stdout,
    cost_usd: 1.5,
    duration_ms,
    review_id,
    finding_ids,
  };
}

// ─── Mission-completion cross-model audit ────────────────────────────────
//
// When a team finishes, run the user's original prompt + the team's
// deliverable (scratchpad + changed files + completed task summaries)
// through Codex `exec` to get an adversarial second opinion: did the team
// actually address what was asked?

export interface MissionAuditResult {
  verdict: 'addressed' | 'partial' | 'missed';
  coverage: Array<{ requirement: string; status: 'addressed' | 'partial' | 'missed'; evidence?: string }>;
  missing_work: string[];
  unrelated_work: string[];
  quality_score: number; // 0-10
  summary: string;
  raw: string;
  duration_ms: number;
}

const MISSION_AUDIT_PROMPT = `You are a mission-completion auditor. Compare the ORIGINAL USER PROMPT against what the team actually delivered. Return ONLY a single JSON object (no markdown, no commentary):

{
  "verdict": "addressed" | "partial" | "missed",
  "coverage": [
    { "requirement": "<concrete thing the user asked for>", "status": "addressed"|"partial"|"missed", "evidence": "<file or finding that shows this, if addressed>" }
  ],
  "missing_work": ["<specific thing the user asked for that was not done>"],
  "unrelated_work": ["<thing the team did that the user did not ask for>"],
  "quality_score": <0-10 integer>,
  "summary": "<3-5 sentences: did the team actually solve the user's problem? what's the gap?>"
}

Rules:
- Be specific. "addressed" requires evidence. "missed" requires the requirement be in the original prompt.
- Score 0-10: 10=completely addressed + extras, 5=half the requirements, 0=mostly unrelated.
- Don't invent requirements the user didn't make.
- Don't praise the team for things outside the prompt unless they're direct prerequisites.`;

function shapeAuditObj(obj: any): Omit<MissionAuditResult, 'raw' | 'duration_ms'> | null {
  if (!obj || typeof obj !== 'object') return null;
  if (!('verdict' in obj) && !('coverage' in obj) && !('summary' in obj)) return null;
  return {
    verdict: ['addressed', 'partial', 'missed'].includes(obj.verdict) ? obj.verdict : 'partial',
    coverage: Array.isArray(obj.coverage) ? obj.coverage : [],
    missing_work: Array.isArray(obj.missing_work) ? obj.missing_work : [],
    unrelated_work: Array.isArray(obj.unrelated_work) ? obj.unrelated_work : [],
    quality_score: typeof obj.quality_score === 'number' ? Math.max(0, Math.min(10, Math.round(obj.quality_score))) : 5,
    summary: String(obj.summary || ''),
  };
}

function parseMissionAuditJson(text: string): Omit<MissionAuditResult, 'raw' | 'duration_ms'> | null {
  // Codex CLI emits NDJSON stream events. The payload we want is an
  // `agent_message` item whose `.text` is the JSON audit — possibly wrapped
  // in markdown code fences. Walk line-by-line.
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const candidates: any[] = [];
  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      if (evt?.item?.type === 'agent_message' && typeof evt.item.text === 'string') {
        const innerText = evt.item.text.replace(/```(?:json)?/gi, '').trim();
        try { candidates.push(JSON.parse(innerText)); } catch { /* ignore */ }
      } else if (evt?.type === 'agent_message' && typeof evt.text === 'string') {
        const innerText = evt.text.replace(/```(?:json)?/gi, '').trim();
        try { candidates.push(JSON.parse(innerText)); } catch { /* ignore */ }
      } else {
        // Maybe this line itself is the audit JSON (when CLI isn't in NDJSON mode)
        const shaped = shapeAuditObj(evt);
        if (shaped) return shaped;
      }
    } catch { /* not JSON — skip */ }
  }
  for (const c of candidates) {
    const shaped = shapeAuditObj(c);
    if (shaped) return shaped;
  }

  // Last-ditch: legacy balanced-brace scan (non-fenced plain JSON).
  const stripped = text.replace(/```(?:json)?/gi, '');
  const start = stripped.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          const shaped = shapeAuditObj(JSON.parse(stripped.slice(start, i + 1)));
          if (shaped) return shaped;
        } catch { /* ignore */ }
      }
    }
  }
  return null;
}

/**
 * Run a cross-model audit of team deliverable against the original prompt.
 * Fires automatically on team completion but can be re-invoked.
 */
export async function runCodexMissionAudit(input: {
  teamId: string;
  cwd: string;
  userPrompt: string;
  scratchpad: string;
  filesChanged: string[];
  completedTaskSummaries: Array<{ title: string; summary: string | null; role: string | null }>;
}): Promise<MissionAuditResult> {
  const startTime = Date.now();

  // Build the context dump Codex will see
  const contextLines: string[] = [];
  contextLines.push('=== ORIGINAL USER PROMPT ===');
  contextLines.push(input.userPrompt);
  contextLines.push('');
  contextLines.push('=== TEAM SCRATCHPAD (top 12KB) ===');
  contextLines.push(input.scratchpad.slice(0, 12_000));
  contextLines.push('');
  contextLines.push(`=== FILES CHANGED (${input.filesChanged.length}) ===`);
  contextLines.push(input.filesChanged.slice(0, 60).join('\n'));
  contextLines.push('');
  contextLines.push('=== COMPLETED TASK SUMMARIES ===');
  for (const t of input.completedTaskSummaries.slice(0, 20)) {
    contextLines.push(`[${t.role || '?'}] ${t.title}`);
    contextLines.push((t.summary || '').slice(0, 500));
    contextLines.push('');
  }

  const userContent = contextLines.join('\n');
  const finalPrompt = `${MISSION_AUDIT_PROMPT}\n\n${userContent}`;

  const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const proc = spawn('codex', ['exec', finalPrompt, '--json'], {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    proc.on('error', reject);
    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      reject(new Error('Codex mission audit timed out after 10 minutes'));
    }, 10 * 60 * 1000);
  });

  const duration_ms = Date.now() - startTime;

  if (result.code !== 0) {
    throw new Error(`Codex mission audit exited ${result.code}: ${result.stderr.slice(-500)}`);
  }

  const parsed = parseMissionAuditJson(result.stdout);
  if (!parsed) {
    // Fallback — emit a minimal partial verdict with raw output for the user to read.
    return {
      verdict: 'partial',
      coverage: [],
      missing_work: [],
      unrelated_work: [],
      quality_score: 5,
      summary: 'Codex returned output that could not be parsed as JSON. See raw output.',
      raw: result.stdout,
      duration_ms,
    };
  }

  appendEvent({
    team_id: input.teamId,
    kind: 'codex_mission_audit',
    severity: parsed.verdict === 'missed' ? 'warn' : 'info',
    payload: {
      verdict: parsed.verdict,
      quality_score: parsed.quality_score,
      missing_count: parsed.missing_work.length,
      duration_ms,
    },
    chat_report: true,
  });

  return { ...parsed, raw: result.stdout, duration_ms };
}

/** Check if Codex CLI is available. Returns null if OK, or an error message. */
export async function checkCodexPrereqs(): Promise<string | null> {
  const companionPath = findCodexCompanion();
  if (!companionPath) return 'codex-companion.mjs not found — clone openai/codex-plugin-cc to ~/mc-research/codex-plugin-cc';

  try {
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      const p = spawn('codex', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', d => { out += d.toString(); });
      p.on('close', () => resolve({ stdout: out }));
      p.on('error', reject);
    });
    if (!stdout.trim()) return 'codex CLI found but returned empty version';
  } catch {
    return 'codex CLI not found — run: npm i -g @openai/codex';
  }

  try {
    const authPath = path.join(process.env.HOME || '~', '.codex', 'auth.json');
    if (!existsSync(authPath)) return 'Codex not authenticated — run: codex login';
  } catch {
    return 'Could not check codex auth state';
  }

  return null;
}
