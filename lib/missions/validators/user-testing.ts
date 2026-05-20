/**
 * User-testing validator — Phase 2 of missions architecture.
 *
 * Per Luke (Factory): "the user testing validator is more interesting. It
 * kind of acts like a QA engineer. It spawns the application, interacts with
 * it through computer use or something similar… ensures that functional flows
 * work holistically."
 *
 * Adversarial by design: the QA agent never sees the worker's code, only the
 * running app + the validation contract's `behavioral` assertions.
 *
 * Implementation: spawn a Claude SDK session with browser-tool access (via the
 * existing /api/browser endpoint, called by Bash/curl from inside the agent).
 * The agent walks each assertion's flow_steps, observes the running page, and
 * judges whether the expected_outcome holds. Returns a structured verdict per
 * assertion.
 *
 * For v1, behavioral assertions are verified one at a time within a single
 * shared browser session (sequential). Parallel-per-assertion is a Phase 6
 * (read-only parallelism) optimization.
 */

import 'server-only';
import { spawnClaudeStream, sseChunk, sseStatus } from '../../claude-chat-bridge';
import type { Assertion, BehavioralCheck, Mission, MissionPhase } from '../types';

export interface UserTestingEmit {
  voice: (agent: 'claude' | 'codex' | 'orchestrator', phase: string) => void;
  text: (t: string) => void;
  status: (s: string) => void;
  raw: (frame: string) => void;
}

export interface UserTestingOptions {
  mission: Mission;
  phase: MissionPhase;
  /** ONLY behavioral assertions — caller filters. */
  assertions: Assertion[];
  emit: UserTestingEmit;
  /** Worker session id this run is verifying (for tracing). */
  worker_session_id?: string;
  /** Override the Claude model used for the QA agent. */
  qa_model?: string;
  /** Local URL the validator can hit /api/browser at. Defaults to localhost:3005. */
  browser_api_url?: string;
  /** Phase 4: cancellation. When the parent mission is aborted mid-verification,
   *  we stop iterating assertions and mark the unfinished ones as
   *  `inconclusive` with `skipped_reason: 'aborted'`. The in-flight assertion's
   *  underlying Claude turn isn't interrupted (different SDK surface) but the
   *  next assertion in the queue won't start. */
  signal?: AbortSignal;
}

const DEFAULT_BROWSER_API = 'http://localhost:3005/api/browser';

export async function runUserTestingValidation(opts: UserTestingOptions): Promise<BehavioralCheck[]> {
  const { mission, phase, assertions, emit } = opts;

  if (assertions.length === 0) {
    return [];
  }

  // Emit a top-level start event so the chat shows the QA validator firing up.
  emitUTEvent(emit, {
    type: 'user-testing-start',
    phase_index: phase.index,
    assertion_count: assertions.length,
  });
  emit.voice('orchestrator', `phase-${phase.index}-user-testing`);
  emit.text(`\n🌐 **User-testing validator starting** — ${assertions.length} behavioral assertion${assertions.length === 1 ? '' : 's'} to verify against the running app.\n\n`);

  const results: BehavioralCheck[] = [];

  for (const a of assertions) {
    // Phase 4 cooperative cancel: if the parent mission was aborted mid-run,
    // we stop here. Already-completed assertions stay in `results`; the
    // remainder are marked inconclusive so coverage shows the gap.
    if (opts.signal?.aborted) {
      const remaining = assertions.slice(assertions.indexOf(a));
      for (const r of remaining) {
        results.push({
          assertion_id: r.id,
          status: 'inconclusive',
          evidence: 'mission aborted before this assertion was verified',
          duration_ms: 0,
        });
      }
      emit.text(`\n⏸️ **User-testing aborted** — ${remaining.length} assertion(s) marked inconclusive.\n`);
      break;
    }
    const start = Date.now();
    const startUrl = a.behavior?.start_url || mission.target_url;

    // No URL we can navigate to — skip with a clear reason. Mission proceeds
    // but the assertion remains unverified and will surface in coverage.
    if (!startUrl) {
      const skipped: BehavioralCheck = {
        assertion_id: a.id,
        status: 'skipped',
        skipped_reason: 'No mission.target_url and no per-assertion start_url. Behavioral verification requires a running app URL.',
        duration_ms: 0,
      };
      results.push(skipped);
      emitUTEvent(emit, { type: 'user-testing-skip', assertion_id: a.id, reason: skipped.skipped_reason });
      emit.text(`- ⊘ **${a.id}** _skipped_ — ${skipped.skipped_reason}\n`);
      continue;
    }

    emitUTEvent(emit, { type: 'user-testing-step-start', assertion_id: a.id });
    emit.text(`\n#### 🌐 Verifying ${a.id} — ${a.statement}\n\n`);

    // Phase-9 ground-truth probe: before spawning the QA agent (which costs
    // a Claude turn), do a runner-side HTTP GET on startUrl. Catches:
    //   • Dev server not running on the expected port
    //   • Wrong URL → 404
    //   • TLS misconfig
    //   • Endpoint exists but returns 5xx
    // We feed the probe result to the QA agent as context AND record it on
    // the BehavioralCheck so Codex sees runner-verified evidence (the QA
    // agent could in principle hallucinate; the probe is concrete).
    const probe = await probeUrl(startUrl, 5_000, opts.signal);
    if (probe.error || (probe.status !== null && probe.status >= 500)) {
      // Hard-fail before burning a QA turn — the URL is unreachable / 5xx.
      const evidence = probe.error
        ? `pre-flight probe failed: ${probe.error}`
        : `pre-flight HTTP ${probe.status} from ${startUrl} — server reachable but errored`;
      const result: BehavioralCheck = {
        assertion_id: a.id,
        status: 'inconclusive',
        evidence,
        duration_ms: Date.now() - start,
      };
      results.push(result);
      emit.text(`? **${a.id}** — INCONCLUSIVE: ${evidence}\n`);
      emitUTEvent(emit, { type: 'user-testing-step-end', ...result, probe });
      continue;
    }

    try {
      const result = await verifyBehavioralAssertion({
        assertion: a,
        startUrl,
        browserApi: opts.browser_api_url || DEFAULT_BROWSER_API,
        qa_model: opts.qa_model,
        mission_id: mission.id,
        phase_index: phase.index,
        emit,
        probe,
      });
      result.duration_ms = Date.now() - start;
      // Annotate the QA agent's evidence with the runner's pre-flight probe
      // so scrutiny audits see both signals — agent observation AND runner
      // probe — without us widening the BehavioralCheck shape.
      if (probe) {
        const probeLine = probe.error
          ? `[probe: error ${probe.error}]`
          : `[probe: HTTP ${probe.status} ${probe.content_type ?? ''} ${probe.duration_ms}ms]`;
        result.evidence = result.evidence
          ? `${result.evidence}\n${probeLine}`
          : probeLine;
      }
      results.push(result);
      const icon = result.status === 'satisfied' ? '✓' : result.status === 'unsatisfied' ? '✗' : '?';
      const cls = result.status === 'satisfied' ? 'PASS' : result.status === 'unsatisfied' ? 'FAIL' : 'INCONCLUSIVE';
      emit.text(`\n${icon} **${a.id}** — ${cls} (${result.duration_ms}ms)${result.evidence ? '\n  ' + result.evidence : ''}\n`);
      emitUTEvent(emit, { type: 'user-testing-step-end', ...result, probe });
    } catch (err: any) {
      const failed: BehavioralCheck = {
        assertion_id: a.id,
        status: 'inconclusive',
        evidence: `QA agent crashed: ${err.message}`,
        duration_ms: Date.now() - start,
      };
      results.push(failed);
      emit.text(`\n? **${a.id}** — INCONCLUSIVE (QA error): ${err.message}\n`);
      emitUTEvent(emit, { type: 'user-testing-step-end', ...failed });
    }
  }

  // Summary
  const sats = results.filter(r => r.status === 'satisfied').length;
  const unsats = results.filter(r => r.status === 'unsatisfied').length;
  const incs = results.filter(r => r.status === 'inconclusive').length;
  const skips = results.filter(r => r.status === 'skipped').length;
  emit.text(`\n**User-testing summary:** ✓ ${sats} pass · ✗ ${unsats} fail · ? ${incs} inconclusive · ⊘ ${skips} skipped\n\n`);
  emitUTEvent(emit, { type: 'user-testing-complete', phase_index: phase.index, results });

  return results;
}

// ─── Per-assertion verification ──────────────────────────────────────────

interface VerifyOptions {
  assertion: Assertion;
  startUrl: string;
  browserApi: string;
  qa_model?: string;
  mission_id: string;
  phase_index: number;
  emit: UserTestingEmit;
  /** Phase-9 ground-truth probe of startUrl, captured by the runner before
   *  the QA agent spawns. Passed into the QA prompt so the agent knows the
   *  page is reachable and what content-type/preview to expect. */
  probe?: UrlProbe;
}

/** Result of a runner-side HTTP probe of a behavioral assertion's start URL.
 *  Captured BEFORE the QA agent runs so we can fail fast on unreachable
 *  pages and so Codex has concrete evidence the URL was actually reachable
 *  at audit time (the QA agent runs in a sandbox and could in principle
 *  hallucinate browser state). */
export interface UrlProbe {
  url: string;
  status: number | null;
  /** ISO timestamp of the probe. */
  ts: string;
  duration_ms: number;
  content_type?: string;
  /** First ~1KB of response body, normalized — gives Codex a tiny preview
   *  to anchor "yes this looks like the page the assertion describes". */
  body_preview?: string;
  /** Set when the probe failed at the network layer (DNS, connection
   *  refused, TLS error, timeout). null when status is set instead. */
  error?: string;
}

const PROBE_BODY_PREVIEW_BYTES = 1024;

async function probeUrl(url: string, timeoutMs = 5_000, signal?: AbortSignal): Promise<UrlProbe> {
  const ts = new Date().toISOString();
  const started = Date.now();
  if (!url) {
    return { url, status: null, ts, duration_ms: 0, error: 'no url' };
  }
  // Use the platform fetch with an AbortSignal that races our internal
  // timeout against the caller's abort signal. Both fire kill the request.
  const ctl = new AbortController();
  const timeoutTimer = setTimeout(() => ctl.abort(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs);
  const onParentAbort = () => ctl.abort(new Error('mission aborted'));
  signal?.addEventListener('abort', onParentAbort, { once: true });
  try {
    const r = await fetch(url, {
      method: 'GET',
      // Don't follow infinite redirects; one hop is fine. fetch follows by
      // default so we leave that behavior — the final URL is what users see.
      signal: ctl.signal,
      headers: { 'user-agent': 'mc-mission-prober/1' },
    });
    const ct = r.headers.get('content-type') ?? undefined;
    let preview: string | undefined;
    try {
      // Read up to PROBE_BODY_PREVIEW_BYTES bytes — bounded so a giant page
      // doesn't blow up the audit brief. We treat as text; binary content
      // gets a graceful "<binary>" stand-in.
      const reader = r.body?.getReader();
      if (reader) {
        const dec = new TextDecoder('utf-8', { fatal: false });
        let collected = '';
        while (collected.length < PROBE_BODY_PREVIEW_BYTES) {
          const { value, done } = await reader.read();
          if (done) break;
          collected += dec.decode(value, { stream: true });
        }
        try { reader.cancel(); } catch { /* fine */ }
        preview = collected.slice(0, PROBE_BODY_PREVIEW_BYTES);
        // Strip control chars except tab/newline so it's brief-safe
        preview = preview.replace(/[ --]/g, '');
      }
    } catch { /* preview is best-effort */ }
    return {
      url,
      status: r.status,
      ts,
      duration_ms: Date.now() - started,
      content_type: ct,
      body_preview: preview,
    };
  } catch (err: any) {
    return {
      url,
      status: null,
      ts,
      duration_ms: Date.now() - started,
      error: String(err?.message || err).slice(0, 300),
    };
  } finally {
    clearTimeout(timeoutTimer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

async function verifyBehavioralAssertion(opts: VerifyOptions): Promise<BehavioralCheck> {
  const { assertion: a, startUrl, browserApi, qa_model, mission_id, phase_index, emit } = opts;
  if (!a.behavior) {
    return {
      assertion_id: a.id,
      status: 'inconclusive',
      evidence: 'Assertion has no behavior block (flow_steps + expected_outcome).',
    };
  }

  // Fresh QA session per assertion — no contamination across runs.
  const sessionKey = `mission:${mission_id}:user-testing:p${phase_index}:${a.id}:${Date.now()}`;
  const prompt = buildQAPrompt(a, startUrl, browserApi, opts.probe);

  // Stream the QA agent's actions through to the chat so the user can watch.
  const { stream } = spawnClaudeStream({
    prompt,
    sessionKey,
    workspace: undefined, // QA doesn't need a specific cwd
    model: qa_model && qa_model !== 'default' ? qa_model : undefined,
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
            emit.text(t);
          }
        } catch {}
      }
    }
  }

  return parseQAResult(collected, a.id);
}

// ─── QA agent prompt ─────────────────────────────────────────────────────

function buildQAPrompt(a: Assertion, startUrl: string, browserApi: string, probe?: UrlProbe): string {
  if (!a.behavior) return '';
  const lines: string[] = [];
  lines.push(`# QA Validator — verifying behavioral assertion ${a.id}`);
  lines.push('');
  lines.push('You are an adversarial QA agent. You DO NOT have access to the source code — you only have a running browser. Drive it through the flow, observe outcomes, judge whether the assertion holds.');
  lines.push('');
  lines.push(`## Assertion`);
  lines.push(`**Statement:** ${a.statement}`);
  lines.push(`**Severity:** ${a.severity}`);
  lines.push('');
  lines.push(`## Flow steps to perform`);
  for (let i = 0; i < a.behavior.flow_steps.length; i++) {
    lines.push(`${i + 1}. ${a.behavior.flow_steps[i]}`);
  }
  lines.push('');
  lines.push(`## Expected outcome`);
  lines.push(a.behavior.expected_outcome);
  lines.push('');
  lines.push(`## Start URL`);
  lines.push(startUrl);
  if (probe) {
    // Phase-9 ground truth: the runner already probed the URL before this
    // turn started. Surface the result so the QA agent doesn't waste a
    // navigate call on a discovery — and so it knows what the page should
    // look like at minimum.
    lines.push('');
    lines.push(`## Pre-flight probe (runner-verified)`);
    lines.push(`The runner ran an HTTP GET on the start URL ${probe.duration_ms}ms before this turn:`);
    if (probe.error) {
      lines.push(`- error: \`${probe.error}\``);
    } else {
      lines.push(`- status: \`${probe.status}\``);
      if (probe.content_type) lines.push(`- content-type: \`${probe.content_type}\``);
      if (probe.body_preview) {
        lines.push(`- body preview (first ${probe.body_preview.length} bytes):`);
        lines.push('```');
        lines.push(probe.body_preview);
        lines.push('```');
      }
    }
    lines.push('');
    lines.push(`Use the probe as a sanity check. If your browser sees something WILDLY different from this, the page changed under you (race) or your tool is wrong — investigate before judging.`);
  }
  lines.push('');
  lines.push(`## Browser tools — call via Bash + curl`);
  lines.push(`The local Mission Control instance exposes a headless Chrome session at: \`${browserApi}\``);
  lines.push('');
  lines.push('Each call is `curl -sS -X POST <url> -H "Content-Type: application/json" -d \'<json>\'`. Available actions:');
  lines.push('');
  lines.push('```bash');
  lines.push(`# Navigate to a URL`);
  lines.push(`curl -sS -X POST ${browserApi} -H 'Content-Type: application/json' -d '{"action":"navigate","url":"${startUrl}"}'`);
  lines.push('');
  lines.push(`# Click a selector`);
  lines.push(`curl -sS -X POST ${browserApi} -H 'Content-Type: application/json' -d '{"action":"click","selector":"button.submit"}'`);
  lines.push('');
  lines.push(`# Type into a field`);
  lines.push(`curl -sS -X POST ${browserApi} -H 'Content-Type: application/json' -d '{"action":"type","selector":"input[name=email]","text":"user@example.com"}'`);
  lines.push('');
  lines.push(`# Wait for a selector to appear (max 5s)`);
  lines.push(`curl -sS -X POST ${browserApi} -H 'Content-Type: application/json' -d '{"action":"waitFor","selector":".success-toast","timeout":5000}'`);
  lines.push('');
  lines.push(`# Get text content`);
  lines.push(`curl -sS -X POST ${browserApi} -H 'Content-Type: application/json' -d '{"action":"getText","selector":"main"}'`);
  lines.push('');
  lines.push(`# Get current page info (url + title)`);
  lines.push(`curl -sS -X POST ${browserApi} -H 'Content-Type: application/json' -d '{"action":"getPageInfo"}'`);
  lines.push('');
  lines.push(`# Run arbitrary JS`);
  lines.push(`curl -sS -X POST ${browserApi} -H 'Content-Type: application/json' -d '{"action":"evaluate","script":"document.title"}'`);
  lines.push('```');
  lines.push('');
  lines.push('## Your task');
  lines.push('');
  lines.push('1. Navigate to the start URL.');
  lines.push('2. Walk through the flow steps. After each step, briefly confirm what happened (use getText / getPageInfo / evaluate).');
  lines.push('3. Once the flow is complete (or you hit an error), judge whether the expected outcome holds.');
  lines.push('4. Return your verdict in a fenced JSON block, EXACTLY this shape:');
  lines.push('');
  lines.push('```verification');
  lines.push('{');
  lines.push('  "status": "satisfied" | "unsatisfied" | "inconclusive",');
  lines.push('  "evidence": "1-3 sentences explaining what you observed",');
  lines.push('  "steps_completed": <int — how many flow steps succeeded>');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('Verdict policy:');
  lines.push('- `satisfied` — the expected outcome was clearly observable.');
  lines.push('- `unsatisfied` — you completed the flow but the outcome was wrong/missing.');
  lines.push('- `inconclusive` — you couldn\'t complete the flow (selector not found, page error, target URL unreachable).');
  lines.push('');
  lines.push('Do not invent failures. Don\'t fail an assertion because of cosmetic differences. Focus on the literal expected_outcome.');
  return lines.join('\n');
}

// ─── Parse the QA agent's verification block ─────────────────────────────

function parseQAResult(output: string, assertion_id: string): BehavioralCheck {
  const fence = output.match(/```verification\s*([\s\S]*?)```/);
  if (!fence) {
    return {
      assertion_id,
      status: 'inconclusive',
      evidence: 'QA agent did not return a `verification` JSON fence — verdict could not be determined.',
    };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(fence[1].trim());
  } catch {
    return {
      assertion_id,
      status: 'inconclusive',
      evidence: 'QA agent returned a `verification` fence but it failed to JSON-parse.',
    };
  }
  const status = (['satisfied', 'unsatisfied', 'inconclusive'] as const).includes(parsed?.status)
    ? parsed.status as 'satisfied' | 'unsatisfied' | 'inconclusive'
    : 'inconclusive';
  return {
    assertion_id,
    status,
    evidence: typeof parsed?.evidence === 'string' ? parsed.evidence : undefined,
    steps_completed: Number.isFinite(Number(parsed?.steps_completed)) ? Number(parsed.steps_completed) : undefined,
  };
}

// ─── SSE event helper ────────────────────────────────────────────────────

function emitUTEvent(emit: UserTestingEmit, data: Record<string, unknown>): void {
  emit.raw(`data: ${JSON.stringify(data)}\n\n`);
}
