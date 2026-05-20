/**
 * /api/chat/enhance-prompt — wand button backend.
 *
 * Takes the user's in-progress draft message + the last few chat messages
 * for context, asks Sonnet to rewrite the draft as a fuller, more directive
 * prompt that explicitly names which skills + agents the main MC chat
 * should use. The rewritten text is returned and gets dropped back into
 * the chat input box so the user can edit + send.
 *
 * Uses the Agent SDK (query()) so it picks up the user's Claude Max OAuth
 * credentials from ~/.claude/.credentials.json — same pattern as the rest
 * of MC (lib/mem/compress.ts, lib/teams/runner.ts).
 *
 * Body: { message: string, recentMessages?: Array<{role,content}>, chatId? }
 * Returns: { enhanced: string, model: string, durationMs: number }
 */

import { NextRequest } from 'next/server';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getSkillsCatalog } from '../../../../lib/skills-mcp';
import { getAgentsCatalog } from '../../../../lib/agents-mcp';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Sonnet 4.6 — fast enough for an interactive button, smart enough to pick
// the right skills out of a 418-skill catalog. Override via env.
const MODEL = process.env.MC_ENHANCE_MODEL || 'claude-sonnet-4-6';

// Resolve Claude Code CLI path. Try several common install locations
// since this varies per machine (system install vs npx cache vs Volta vs
// user-local). The lib/mem/compress.ts hardcoded path no longer matches
// this Linux box — keep that path as a fallback for backward compat.
import fs from 'node:fs';
function findClaudeCodeCli(): string {
  const candidates = [
    process.env.MC_CLAUDE_CLI,
    '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '~/.npm/_npx/b14b71b47167b11e/node_modules/@anthropic-ai/claude-code/cli.js',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* skip */ }
  }
  // Last resort: glob the npx cache for any claude-code cli.js
  try {
    const npxRoot = '~/.npm/_npx';
    if (fs.existsSync(npxRoot)) {
      for (const dir of fs.readdirSync(npxRoot)) {
        const candidate = `${npxRoot}/${dir}/node_modules/@anthropic-ai/claude-code/cli.js`;
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch { /* skip */ }
  // Nothing found — Agent SDK will surface a clear error.
  return '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js';
}
const CLAUDE_CODE_CLI = findClaudeCodeCli();

const SYSTEM_PROMPT = `You are a PROMPT-ENHANCER for Mission Control chat.

Mission Control's main chat agent is a Claude Code agent with access to 418 skills (across 5 repos: superpowers, everything-claude-code, ruflo, open-design, obsidian-skills) and 165 specialist subagent personas. The main agent has an auto-loader that injects matching skill bodies on regex match — but it depends on the user's wording hitting the right triggers.

Your job is to rewrite the user's draft into a structured plan that explicitly says:
- WHAT to accomplish
- HOW MANY subagents to spawn — derived from the actual decomposition of the work, NOT a round number
- WHICH specific agent persona each subagent uses
- WHICH skills the main agent loads directly vs which skills each subagent uses
- WHAT each subagent's deliverable is

# DECOMPOSITION PROCESS (you must do this internally before writing the rewrite)

Step 1 — Enumerate every skill the task could possibly need. SCAN the entire catalog below. For a Stripe checkout task you'd consider: testing skills (tdd, e2e, integration-testing, regression-testing), API skills (api-design, error-handling, idempotency, rate-limiting), security skills (security-review, auth-patterns, secret-handling), payment skills (anything stripe/billing/checkout), web skills (accessibility, frontend-design, react-patterns, ui-skills), DevOps skills (canary-watch, logging, monitoring), language skills (typescript-*), and verification skills (verification-before-completion, code-review). List EVERY skill in the catalog that touches even one aspect of the work.

Step 2 — Enumerate every specialist persona that could review or build a piece of this work. SCAN the entire agents catalog. For a Stripe checkout task you might want: @tdd-guide for test-first discipline, @security-reviewer for webhook signature handling, @a11y-architect for the success page, @typescript-reviewer for types, @e2e-runner for browser flows, @api-designer for endpoint contracts, @database-specialist for idempotency stores, @code-reviewer for the diff before merge, @documentation-engineer for inline docs, @performance-analyzer for hot paths, @error-handler for failure modes, @observability-engineer for logging — and many more. Don't artificially shorten the list; reject the impulse to land on a "round" number like 3 or 5.

Step 3 — For each candidate subagent, decide: does this work actually need this specialist's lens? If yes, they're in. If their lens overlaps 100% with someone already in, drop them as redundant. If they'd add a unique perspective, keep them. Most non-trivial tasks end up needing 4–12 subagents; trivial tasks need 0–2; rare mega-tasks need 15+.

Step 4 — Assign each subagent the skills they'll load when spawned. A subagent loads its OWN copy of the auto-loader skill set; pick skills directly relevant to that subagent's deliverable. Some subagents (most personas, actually) work fine on persona alone — that's totally valid.

Step 5 — Decide the parallelism graph. Which subagents block which? Which can fan out concurrently? Reviews almost always fan out parallel. Multi-step builds may have ordering. Be explicit.

# OUTPUT FORMAT

Format your rewrite EXACTLY like this:

<one-paragraph clear statement of what to accomplish — concrete, specific, no fluff>

**Main agent skills:** /<skill-a>, /<skill-b>, /<skill-c>, …
_(Skills that load into the MAIN chat agent's prompt — for the work the main agent does itself. List every skill that applies, no cap.)_

**Subagents to spawn (<N> total):**
1. **@<agent-name>** — skills: /<skill-x>, /<skill-y> — Will <one clear sentence on what this agent produces>
2. **@<agent-name>** — skills: /<skill-z> — Will <…>
3. **@<agent-name>** — skills: (none, persona alone) — Will <…>
…continue numbering for however many subagents the work needs. Could be 0, 1, 2, 7, 12, or whatever the actual decomposition produced. Do NOT cap or round.

**Parallelism:** <explicit graph — which run in parallel vs sequentially>

**Context from recent conversation:**
- <relevant fact 1>
- <relevant fact 2>

**Concrete steps for the main agent:**
1. <step>
2. <step>
3. <step>

**Done when:** <verification criteria — testable, not subjective>

# CRITICAL RULES on skill/agent naming

- Skills and agents MUST come from the catalogs below. The catalogs are EXHAUSTIVE — if a name is not listed below, IT DOES NOT EXIST.
- Do NOT invent plausible-sounding names like \`/stripe-integration\`, \`/webhook\`, \`/payment\`, \`/auth-patterns\`, \`/react-patterns\`, \`/api-security\`. These are made up. Only use names that literally appear in the catalog below — copy them character-for-character.
- Before you write each skill name, scan the catalog and confirm the exact slug exists. Same for agents.
- It is BETTER to list 3 real skills than 9 mixed-with-fake skills. Server validation will silently strip any fake names you include.
- Skill names start with \`/\` (e.g. \`/systematic-debugging\`). Agent names start with \`@\` (e.g. \`@security-reviewer\`). They are NOT interchangeable.
- An agent's "skills" line lists skills THAT AGENT loads when spawned. The main-agent skills line lists skills THE MAIN CHAT AGENT loads. A skill can appear in both lists.

# OTHER RULES

- ALWAYS pick exactly the right number of subagents for the specific task. Could be 0 (main agent solo). Could be 1 (one specialist). Could be 12 (heavy multi-domain task). Never round to 3 or 5 just because it "looks balanced." If 8 specialists each add unique value, list 8. If 11, list 11.
- ALWAYS show per-agent skill assignments. Skills a subagent will use go on its line, not in the main-agent skills line.
- If the user's draft is already detailed and clear, you may keep the body short, but still include the Main-agent-skills + Subagents + Done-when sections.
- If the user said something vague like "fix this" without a file reference, INFER from recent conversation what "this" probably is and put it in the rewrite.
- If multi-step work, break into ordered concrete steps in the "Concrete steps" section.
- NEVER invent specific filenames, function names, or table names the user didn't mention or that aren't in the recent conversation.
- Output ONLY the rewritten prompt. No preamble, no "Here's the rewrite:", no markdown wrapping with triple backticks. Just the prompt text the user will see in their input box.`;

interface EnhanceBody {
  message: string;
  recentMessages?: Array<{ role: string; content: string }>;
  chatId?: string;
}

function compactCatalog(): { skills: string; agents: string } {
  const skills = getSkillsCatalog();
  const agents = getAgentsCatalog();

  // Skills grouped by source, all of them, full descriptions.
  const bySource: Record<string, Array<{ name: string; description: string }>> = {};
  for (const s of skills) {
    if (!bySource[s.source]) bySource[s.source] = [];
    bySource[s.source].push({ name: s.name, description: s.description });
  }
  const order = ['superpowers', 'ecc', 'ruflo', 'opendesign', 'obsidian'];
  const skillLines: string[] = [];
  for (const src of order) {
    const list = bySource[src] || [];
    if (!list.length) continue;
    skillLines.push(`\n### ${src} (${list.length})`);
    for (const s of list) {
      skillLines.push(`- /${s.name} — ${s.description}`);
    }
  }

  // All personas with full descriptions.
  const agentLines = agents.map(a => `- @${a.name} (${a.source}/${a.category}) — ${a.description}`);

  return {
    skills: skillLines.join('\n'),
    agents: agentLines.join('\n'),
  };
}

async function runSonnet(systemPrompt: string, userText: string): Promise<string> {
  const q = query({
    prompt: userText,
    options: {
      pathToClaudeCodeExecutable: CLAUDE_CODE_CLI,
      model: MODEL,
      // 'claude_code' preset bakes in some scaffolding we don't want for
      // a pure text-rewrite task — use the bare preset and rely on our
      // system prompt to drive behavior. Setting append: <our prompt>
      // still puts our instructions in the system slot.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      settingSources: ['user'] as any,
      allowedTools: [], // text-only, no tools
      includePartialMessages: false,
      permissionMode: 'bypassPermissions' as any,
    },
  });
  // 4-minute safety budget. With the full catalog (no truncation) Sonnet
  // can take longer when it lists many skills + per-agent assignments.
  // If a single rewrite genuinely needs more than 4 min, something is
  // wrong (auth, network, etc.) — fail loud rather than hanging the
  // button forever.
  const timer = setTimeout(() => { try { (q as any).interrupt?.(); } catch {} }, 240_000);
  let assistantText = '';
  let resultText = '';
  try {
    for await (const msg of q) {
      if ((msg as any).type === 'result' && typeof (msg as any).result === 'string') {
        resultText = (msg as any).result;
      } else if ((msg as any).type === 'assistant') {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              assistantText += block.text;
            }
          }
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return (resultText || assistantText).trim();
}

export async function POST(request: NextRequest) {
  const t0 = Date.now();
  try {
    const body: EnhanceBody = await request.json();
    const { message, recentMessages = [], chatId } = body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return new Response(JSON.stringify({ error: 'message required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const { skills, agents } = compactCatalog();

    // Full recent context — pass every message the client sent, no truncation.
    const ctxLines: string[] = [];
    for (const m of recentMessages) {
      const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      ctxLines.push(`${m.role}: ${txt}`);
    }
    const recentContext = ctxLines.length
      ? `\n\n## Recent conversation in this chat\n\n${ctxLines.join('\n\n')}`
      : '';

    const userBlock = `# Available skills (auto-load when user wording matches their trigger phrases)
${skills}

# Available subagent personas (spawn via Task tool with the persona body as system prompt)
${agents}
${recentContext}

# User's draft message (rewrite this)
"""
${message}
"""

Output ONLY the rewritten prompt as described in your instructions. Nothing else.`;

    let text = await runSonnet(SYSTEM_PROMPT, userBlock);

    // Strip any wrapping triple backticks Sonnet may have added despite the
    // explicit instruction not to.
    text = text
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/\n?```\s*$/, '')
      .trim();

    if (!text) {
      return new Response(JSON.stringify({
        error: 'empty_response',
        message: 'Sonnet returned no text — try again or send as-is.',
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }

    // Validate every /skill-name and @agent-name against the actual catalogs;
    // silently strip hallucinations. Sonnet often invents plausible-sounding
    // slugs like /stripe-integration or /webhook that don't exist. We let it
    // try, then clean the output here.
    const skillSet = new Set(getSkillsCatalog().map(s => s.name.toLowerCase()));
    const agentSet = new Set(getAgentsCatalog().map(a => a.name.toLowerCase()));
    const droppedSkills = new Set<string>();
    const droppedAgents = new Set<string>();

    // Validate /skill and @agent tokens against the actual catalogs. The new
    // format puts skills on multiple lines (main-agent skills, plus per-
    // subagent skills lines). Any line containing markdown-listy /skill or
    // @agent tokens is scrubbed.
    function scrubTokens(line: string, kind: 'skill' | 'agent'): { line: string; dropped: string[] } {
      const dropped: string[] = [];
      const prefix = kind === 'skill' ? '/' : '@';
      const valid = kind === 'skill' ? skillSet : agentSet;
      // Look for tokens like /<slug> or @<slug>. Don't match URLs (https://...)
      // by anchoring to "non-letter before / or @". For agents we also allow
      // ** wrapping (e.g. **@security-reviewer**).
      const cleaned = line.replace(
        new RegExp(`(^|[^\\w])\\${prefix}([a-z0-9][a-z0-9_-]*)`, 'gi'),
        (_full, pre, name) => {
          if (valid.has(name.toLowerCase())) return `${pre}${prefix}${name}`;
          dropped.push(name);
          return pre; // drop the bad token
        },
      );
      return { line: cleaned, dropped };
    }

    // Lines worth scrubbing: any line mentioning a skill or agent token.
    // Heuristic: line must contain "/" or "@" preceded by non-word char,
    // AND look like a skill/agent listing — i.e. NOT a URL, NOT a code path.
    // We skip lines that look like file paths (start with /home, /usr, ./,
    // app/, lib/, components/, contain .ts/.js/.tsx/.jsx etc.).
    const isFilepathLine = (l: string) =>
      /\b(\/(home|usr|var|opt|etc|tmp|bin|lib|app|components|node_modules)\/)/i.test(l) ||
      /(\.tsx?|\.jsx?|\.mjs|\.json|\.yaml|\.md)\b/.test(l);
    const isUrlLine = (l: string) => /https?:\/\//i.test(l);

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (isFilepathLine(l) || isUrlLine(l)) continue;
      // Skip the literal "Concrete steps:" body — those don't contain skill
      // tokens we want to validate, just descriptions.
      // Only scrub if the line has skill (/) or agent (@) tokens.
      const hasSkillTokens = /(^|[^\w])\/[a-z][a-z0-9_-]+/i.test(l);
      const hasAgentTokens = /(^|[^\w])@[a-z][a-z0-9_-]+/i.test(l);
      if (!hasSkillTokens && !hasAgentTokens) continue;
      let working = l;
      if (hasSkillTokens) {
        const r = scrubTokens(working, 'skill');
        working = r.line;
        r.dropped.forEach(n => droppedSkills.add(n));
      }
      if (hasAgentTokens) {
        const r = scrubTokens(working, 'agent');
        working = r.line;
        r.dropped.forEach(n => droppedAgents.add(n));
      }
      // Final tidy after stripping invalid tokens. Sonnet wraps each name in
      // backticks (`/skill-name`); when we delete the name, the surrounding
      // backticks become an empty pair `` that needs removing too. Same for
      // bold markdown (**@name**).
      working = working
        // Empty backtick / bold pairs left after deletion
        .replace(/`\s*`/g, '')
        .replace(/\*\*\s*\*\*/g, '')
        // Collapse N-in-a-row comma-space sequences (`, , , ,`) to one comma
        .replace(/(?:,\s*){2,}/g, ', ')
        // Strip leading comma right after a label/header (e.g. "**Main agent
        // skills:** , /foo" or "1. **@agent** — skills: , /foo"). Happens
        // when the FIRST item in a list was a hallucinated name and got
        // stripped, leaving the comma orphaned.
        .replace(/(\*\*[^*]*?\*\*)\s*,\s*/g, '$1 ')
        .replace(/(skills:)\s*,\s*/gi, '$1 ')
        .replace(/(—)\s*,\s*/g, '$1 ')
        // Tidy punctuation around removed items
        .replace(/:\s*,+\s*/g, ': ')
        .replace(/\(\s*,/g, '(')
        .replace(/,\s*\)/g, ')')
        .replace(/,\s+(?=—|–|-|will\b|Will\b)/gi, ' ')
        .replace(/\s*—\s*skills:\s*(?=—|Will|will|$)/gi, ' ') // drop empty "— skills: —"
        .replace(/\s*—\s*skills:\s*$/i, '') // trailing empty "— skills:"
        .replace(/skills:\s*(?=—|$|Will|will)/gi, 'skills: (none — persona alone) ')
        .replace(/\s{2,}/g, ' ')
        .replace(/,\s*$/g, '')
        .replace(/,\s+and\s*$/i, '')
        .trim();
      lines[i] = working;
    }
    text = lines.join('\n').trim();

    if (droppedSkills.size || droppedAgents.size) {
      console.log('[enhance-prompt] stripped invalid names: skills=[%s] agents=[%s]',
        [...droppedSkills].join(','), [...droppedAgents].join(','));
    }

    return new Response(JSON.stringify({
      enhanced: text,
      model: MODEL,
      durationMs: Date.now() - t0,
      chatId,
      droppedInvalid: {
        skills: [...droppedSkills],
        agents: [...droppedAgents],
      },
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('[enhance-prompt]', e?.stack || e?.message || e);
    return new Response(JSON.stringify({
      error: 'enhance_failed',
      message: String(e?.message || e),
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
