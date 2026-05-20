/**
 * POST /api/missions/author
 *
 * The orchestrator surface (Phase 1 + Phase 8): take a single-sentence goal
 * (plus a working directory) and call Claude with the orchestrator role
 * skill to produce a complete Mission JSON — phases, validation contract,
 * sensible defaults. The user reviews/edits the output in the dashboard's
 * "Create new mission" panel before POSTing /api/missions to actually run.
 *
 * Body:
 *   {
 *     goal: string,
 *     cwd: string,
 *     target_url?: string,
 *     preset_id?: string,        // role-config preset id
 *   }
 *
 * Response:
 *   { mission: Mission, raw: string }   on success
 *   { error: string, hint?: string }    on failure
 *
 * Why a separate API endpoint and not "just type to chat":
 *   - Bounded scope: this is a one-shot author call, not a long-running
 *     mission. We don't need the runtime registry, persistence, or SSE.
 *   - Predictable shape: the response is exactly a Mission ready to POST.
 *     Inline-chat authoring would scatter the mission across multiple
 *     turns and require user-side stitching.
 *   - Separation of concerns: the chat panel is for ad-hoc Q&A; this is
 *     the structured "author a contract" surface.
 */

import { NextRequest } from 'next/server';
import { spawnClaudeStream } from '@/lib/claude-chat-bridge';
import { loadRoleSkill } from '@/lib/missions/skills';
import { ROLE_PRESETS, getPreset } from '@/lib/missions/role-config';
import { DEFAULT_ROLE_CONFIG } from '@/lib/missions/types';
import type { Mission } from '@/lib/missions/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AuthorBody {
  goal?: string;
  cwd?: string;
  target_url?: string;
  preset_id?: string;
}

export async function POST(req: NextRequest) {
  let body: AuthorBody = {};
  try { body = await req.json(); } catch { /* invalid json */ }

  const goal = String(body?.goal || '').trim();
  const cwd = String(body?.cwd || '').trim();
  if (!goal || !cwd) {
    return Response.json({ error: 'invalid_input', hint: 'Need both `goal` and `cwd`.' }, { status: 400 });
  }

  const preset = getPreset(String(body?.preset_id || '')) ?? ROLE_PRESETS[0];
  const orchestratorSkill = await loadRoleSkill('orchestrator');

  const prompt = buildAuthorPrompt(goal, cwd, body.target_url, preset?.config ?? DEFAULT_ROLE_CONFIG, orchestratorSkill);

  // Generate a unique session key per author call so the orchestrator's
  // context is fresh — no cross-mission contamination.
  const sessionKey = `mission-author-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  let collected = '';
  try {
    const { stream } = spawnClaudeStream({
      prompt,
      sessionKey,
      workspace: cwd,
      // Use the configured orchestrator model. Caller's preset wins.
      model: preset?.config.orchestrator.model,
    });
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let carry = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      carry += dec.decode(value, { stream: true });
      let idx;
      while ((idx = carry.indexOf('\n\n')) >= 0) {
        const frame = carry.slice(0, idx);
        carry = carry.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            if (parsed.choices?.[0]?.delta?.content) collected += parsed.choices[0].delta.content;
          } catch { /* ignore non-content frames */ }
        }
      }
    }
  } catch (err: any) {
    return Response.json({ error: 'orchestrator_failed', hint: String(err?.message || err) }, { status: 500 });
  }

  const mission = extractMissionJson(collected);
  if (!mission) {
    return Response.json({
      error: 'mission_parse_failed',
      hint: 'Orchestrator did not return a parseable Mission JSON.',
      raw_excerpt: collected.slice(-2000),
    }, { status: 502 });
  }

  // Apply server-side defaults so the user can submit immediately without
  // editing the JSON. Roles default to the requested preset; status, dates,
  // cwd, target_url all filled.
  const id = mission.id || `mission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  // Cast: `extractMissionJson` already verified `goal` + `phases` + the
  // overall shape is sane. Required fields (`contract`) are part of the
  // orchestrator's prompt; we trust the parsed JSON here.
  const filled = {
    ...(mission as Mission),
    id,
    cwd,
    target_url: body.target_url || mission.target_url,
    roles: mission.roles ?? (preset?.config ?? DEFAULT_ROLE_CONFIG),
    status: 'approved' as const,
    created_at: mission.created_at ?? now,
    last_activity_at: now,
  } satisfies Mission;

  return Response.json({ mission: filled, raw: collected });
}

function buildAuthorPrompt(
  goal: string,
  cwd: string,
  targetUrl: string | undefined,
  roles: typeof DEFAULT_ROLE_CONFIG,
  orchestratorSkill: string,
): string {
  const lines: string[] = [];
  if (orchestratorSkill) {
    lines.push(orchestratorSkill);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  lines.push('# Mission authoring task');
  lines.push('');
  lines.push('Author a complete `Mission` JSON for the goal below. The output of this turn must be **a single fenced JSON block** with the mission shape — no prose before/after. The user will review and edit before running it.');
  lines.push('');
  lines.push(`## Goal`);
  lines.push(goal);
  lines.push('');
  lines.push(`## Working directory`);
  lines.push(`\`${cwd}\``);
  if (targetUrl) {
    lines.push('');
    lines.push(`## Target URL`);
    lines.push(`\`${targetUrl}\` — the user-testing validator will navigate here for behavioral assertions.`);
  }
  lines.push('');
  lines.push(`## Role config (already chosen by the user)`);
  lines.push('```json');
  lines.push(JSON.stringify(roles, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Required output shape');
  lines.push('Return EXACTLY one fenced ```json block containing a Mission object with these fields:');
  lines.push('- `goal` — copy/refine the input goal');
  lines.push('- `preface` — optional, 1-2 sentences of global plan context');
  lines.push('- `phases` — array of MissionPhase: `{ index, name, spec, expected_files?, assertion_ids, origin: "plan", rework_cap? }`. Aim for 2-5 phases. Each phase\'s `spec` is a few sentences of what it delivers. `assertion_ids` references contract assertion ids this phase is responsible for satisfying.');
  lines.push('- `contract.assertions` — array of Assertion: `{ id, statement, type: "static"|"behavioral", verification_command?, behavior?, severity }`. 5-15 assertions total. Each assertion is verifiable from a diff/test/lint (static) or a browser flow (behavioral). Static assertions SHOULD include a `verification_command` (e.g. `npx tsc --noEmit`, `npx vitest run path/to/test`). Behavioral assertions need `{ flow_steps: [], expected_outcome: "" }`.');
  lines.push('- `cwd` — copy from input');
  lines.push('- `target_url` — copy if provided');
  lines.push('- `roles` — copy the role config JSON above');
  lines.push('- `rework_cap` — default 5');
  lines.push('- `status` — set to `"approved"` so the runner starts immediately');
  lines.push('');
  lines.push('## Constraints');
  lines.push('- Stay scoped to the goal. Don\'t scope-creep into adjacent improvements.');
  lines.push('- Every assertion id should appear in exactly one phase\'s `assertion_ids`.');
  lines.push('- If the goal is too vague to author a contract from, return a JSON object with `{"error": "needs_clarification", "questions": ["…"]}` instead of a Mission.');
  lines.push('');
  lines.push('Return the JSON now and nothing else.');
  return lines.join('\n');
}

/** Pull the first fenced JSON block out of the orchestrator's output and
 *  parse it as a Mission. Tolerates surrounding prose if any slips through.
 *  Returns null on parse failure or `error` shape. */
function extractMissionJson(raw: string): Partial<Mission> | null {
  // Try fenced block first: ```json … ``` or ``` … ```
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  let body: string | null = null;
  if (fence) body = fence[1].trim();
  // Fall back to first { … } in the output (greedy depth match is impossible
  // with regex, so we hand-roll a brace counter).
  if (!body) {
    const start = raw.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < raw.length; i++) {
      const c = raw[i];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { body = raw.slice(start, i + 1); break; } }
    }
  }
  if (!body) return null;
  let parsed: any;
  try { parsed = JSON.parse(body); } catch { return null; }
  // Refuse to treat a needs_clarification envelope as a mission.
  if (parsed?.error || parsed?.needs_clarification) return null;
  // Cheap structural sanity check.
  if (typeof parsed?.goal !== 'string' || !Array.isArray(parsed?.phases)) return null;
  return parsed;
}
