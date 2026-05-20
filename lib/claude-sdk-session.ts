/**
 * Shared Agent SDK session + skills helpers.
 *
 * Extracted from `lib/claude-chat-bridge.ts` during Phase 1 of the Constellation
 * refactor. These helpers are stateless and safe for both the chat bridge
 * (`spawnClaudeStream`) and the Phase 2 team runner (`runAgent`) to call.
 *
 * The bridge re-exports the session-map helpers for backward compatibility
 * with existing consumers (see `lib/claude-chat-bridge.ts`).
 */

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── Constants ──────────────────────────────────────────────────────────

// Default workspace for new chat agents. Prefers ~/<your-mobile-app> (the user's
// primary project) when present, falling back to the legacy openclaw workspace.
// Per-chat override still wins via ChatSession.workspace / props.lockedWorkspace.
const FIELDREPAPP_WORKSPACE = path.join(os.homedir(), 'MyMobileApp');
const OPENCLAW_WORKSPACE = path.join(os.homedir(), '.openclaw', 'workspace');
export const GLOBAL_WORKSPACE = fs.existsSync(FIELDREPAPP_WORKSPACE)
  ? FIELDREPAPP_WORKSPACE
  : OPENCLAW_WORKSPACE;

const DATA_DIR = path.join(process.cwd(), 'data');
const SESSION_MAP_FILE = path.join(DATA_DIR, 'claude-code-sessions.json');

// ─── Session ID mapping (mcSessionKey → SDK session_id) ────────────────

export function loadSessionMap(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(SESSION_MAP_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveSessionMap(map: Record<string, string>): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SESSION_MAP_FILE, JSON.stringify(map, null, 2));
}

export function getClaudeSessionId(mcSessionKey: string): string | undefined {
  return loadSessionMap()[mcSessionKey];
}

export function setClaudeSessionId(mcSessionKey: string, claudeId: string): void {
  const map = loadSessionMap();
  map[mcSessionKey] = claudeId;
  saveSessionMap(map);
}

export function deleteClaudeSessionId(mcSessionKey: string): void {
  const map = loadSessionMap();
  delete map[mcSessionKey];
  saveSessionMap(map);
}

// ─── sessionKey namespace helpers (resolves hidden couplings #1/#3/#5) ─

/** A team agent's sessionKey uses the `team:<teamId>:<roleHandle>` prefix. */
export function isTeamSessionKey(sessionKey: string | undefined | null): boolean {
  return typeof sessionKey === 'string' && sessionKey.startsWith('team:');
}

/** SEO chat sessions use the `seo-<id>-<ts>` prefix. */
export function isSeoSessionKey(sessionKey: string | undefined | null): boolean {
  return typeof sessionKey === 'string' && sessionKey.startsWith('seo-');
}

/** Regular mission-control chat uses the `mc-<id>-<ts>` prefix. */
export function isMcChatSessionKey(sessionKey: string | undefined | null): boolean {
  return typeof sessionKey === 'string' && sessionKey.startsWith('mc-');
}

export function buildTeamSessionKey(teamId: string, roleHandle: string): string {
  return `team:${teamId}:${roleHandle}`;
}

export interface ParsedTeamSessionKey {
  teamId: string;
  roleHandle: string;
}

export function parseTeamSessionKey(sessionKey: string): ParsedTeamSessionKey | null {
  if (!isTeamSessionKey(sessionKey)) return null;
  const parts = sessionKey.split(':');
  if (parts.length < 3) return null;
  return { teamId: parts[1], roleHandle: parts.slice(2).join(':') };
}

// ─── Skills context (for system prompt append) ─────────────────────────

/**
 * The Matt Pocock skills (https://github.com/mattpocock/skills) are
 * installed as the primary engineering operating model for this user.
 * They take precedence over any other workspace skill: they are loaded
 * first into the system prompt, surfaced under an explicit PRIORITY
 * header, and given a larger per-skill char budget so the full SKILL.md
 * body fits. Order in the array = order rendered.
 */
export const MATT_POCOCK_SKILLS = [
  // Engineering — daily code work
  'grill-with-docs',                  // align before code: grill + update CONTEXT.md/ADRs
  'tdd',                               // red-green-refactor for features and bug fixes
  'diagnose',                          // disciplined bug/perf diagnosis loop
  'zoom-out',                          // step back, explain in system context
  'improve-codebase-architecture',     // periodic architecture deepening pass
  'to-prd',                            // synthesize current chat into a PRD issue
  'to-issues',                         // break a plan/PRD into vertical-slice issues
  'triage',                            // state-machine triage for incoming issues
  'setup-matt-pocock-skills',          // per-repo bootstrap before the others
  // Productivity — non-code workflow
  'grill-me',                          // get interviewed about a plan
  'caveman',                           // ultra-compressed comms mode
  'write-a-skill',                     // create new skills properly
];

/**
 * Load enabled OpenClaw skills as a system prompt appendix.
 *
 * Two-tier render:
 *   1. PRIORITY skills (Matt Pocock's set) — full bodies, named first,
 *      under a header that tells the agent these are the primary
 *      operating model. ~6KB per skill.
 *   2. Other workspace skills — abbreviated tails, under a secondary
 *      header. 3KB per skill, only filled if there's budget left.
 *
 * Total cap stays at 60KB so the priority block can fit fully even
 * when other skills are present.
 */
export function loadSkillsContext(): string {
  const skillsDir = path.join(os.homedir(), '.openclaw', 'workspace', 'skills');
  if (!fs.existsSync(skillsDir)) return '';

  const isUsableSkill = (d: string): boolean => {
    const fullPath = path.join(skillsDir, d);
    try {
      // Resolve symlinks (MP skills are linked from _external/mattpocock-skills/skills/<bucket>/<name>).
      const stat = fs.statSync(fullPath);
      return stat.isDirectory()
        && !fs.existsSync(path.join(fullPath, '.disabled'))
        && fs.existsSync(path.join(fullPath, 'SKILL.md'));
    } catch {
      return false;
    }
  };

  const renderSkill = (dir: string, capChars: number): string | null => {
    try {
      let content = fs.readFileSync(path.join(skillsDir, dir, 'SKILL.md'), 'utf-8');
      const fmEnd = content.indexOf('---', content.indexOf('---') + 3);
      if (fmEnd > 0) content = content.slice(fmEnd + 3).trim();
      if (content.length > capChars) content = content.slice(0, capChars) + '\n...[truncated]';
      if (content.length < 100) return null;
      return content;
    } catch {
      return null;
    }
  };

  const MAX_CHARS = 60_000;
  const PRIORITY_CAP = 6_000;
  const OTHER_CAP = 3_000;

  try {
    const allDirs = fs.readdirSync(skillsDir).filter(isUsableSkill);
    const allDirsSet = new Set(allDirs);

    const priorityParts: string[] = [];
    const otherParts: string[] = [];
    let totalChars = 0;

    // Tier 1 — priority (MP) skills, in canonical order
    for (const name of MATT_POCOCK_SKILLS) {
      if (totalChars >= MAX_CHARS) break;
      if (!allDirsSet.has(name)) continue;
      const body = renderSkill(name, PRIORITY_CAP);
      if (!body) continue;
      priorityParts.push(`### /${name}\n${body}`);
      totalChars += body.length;
    }

    // Tier 2 — everything else, alphabetically, abbreviated
    const priorityNames = new Set(MATT_POCOCK_SKILLS);
    for (const dir of allDirs) {
      if (priorityNames.has(dir)) continue;
      if (totalChars >= MAX_CHARS) break;
      const body = renderSkill(dir, OTHER_CAP);
      if (!body) continue;
      otherParts.push(`### Skill: ${dir}\n${body}`);
      totalChars += body.length;
    }

    if (priorityParts.length === 0 && otherParts.length === 0) return '';

    const sections: string[] = [];

    if (priorityParts.length > 0) {
      sections.push(
        `## PRIORITY SKILLS (Matt Pocock's engineering operating model)

These ${priorityParts.length} skills are the user's primary engineering workflow. Treat them as the default operating model for this chat.

**Always check this list first when:**
- The user types a slash command matching one of the names below (e.g. \`/tdd\`, \`/diagnose\`, \`/grill-me\`, \`/zoom-out\`, \`/to-prd\`, \`/to-issues\`, \`/triage\`, \`/caveman\`, \`/grill-with-docs\`, \`/improve-codebase-architecture\`, \`/setup-matt-pocock-skills\`, \`/write-a-skill\`). Run that skill's instructions verbatim.
- The user's request matches a skill's "Use when…" trigger (e.g. "debug this" → diagnose, "stress-test my plan" → grill-me, "build feature with TDD" → tdd, "create a PRD" → to-prd, "break this into issues" → to-issues, "I'm lost in this code" → zoom-out, "improve architecture" → improve-codebase-architecture, "be brief" / "less tokens" → caveman).
- A long task could benefit from one of these (e.g. before any non-trivial code change, consider \`/grill-with-docs\` to align; before fixing a hard bug, consider \`/diagnose\`).

**Precedence rules:**
1. If a priority skill matches, use it — don't fall back to ad-hoc behavior.
2. If a workspace skill from the secondary list below also matches, prefer the priority skill.
3. If no priority skill matches but the user invokes a slash command, look in the secondary list.

${priorityParts.join('\n\n---\n\n')}`
      );
    }

    if (otherParts.length > 0) {
      sections.push(
        `## Other workspace skills (secondary)

Use these only if no priority skill above matches the user's request.

${otherParts.join('\n\n---\n\n')}`
      );
    }

    return `\n\n${sections.join('\n\n')}`;
  } catch {
    return '';
  }
}

// ─── Sub-agent delegation strategy ─────────────────────────────────────

/**
 * Injected into the system prompt so the top-level chat agent knows when to
 * launch a Task/Agent sub-agent. Claude Code sub-agents run on Sonnet by
 * default — cheap, fast, and great for bounded research. Reserves Opus (the
 * parent) for synthesis and multi-step reasoning.
 */
export function getSubagentStrategy(): string {
  return `
## Sub-agent Strategy

The user (sales@revolve.construction) has a roster of named specialists in \`~/.claude/agents/\`. **Always prefer a named specialist over generic \`Explore\` / \`general-purpose\`.** Sub-agents are powerful but not free — pick deliberately, brief tightly, synthesize at the end.

### The roster (use \`subagent_type: "<name>"\`)

| Agent | Use for |
|---|---|
| \`react-native-architect\` | Designing RN/Expo features in MyMobileApp — screen shape, state, perf budget. **Doesn't write code.** |
| \`react-native-engineer\` | Implementing RN/Expo features — screens, components, hooks, native wiring. |
| \`expo-deploy-engineer\` | EAS Build, EAS Update OTA, app.config, store submission. |
| \`supabase-engineer\` | Schema, RLS, migrations, edge functions, auth, storage. |
| \`postgres-optimizer\` | Query plans, indexing, slow queries, partitioning. |
| \`nextjs-vercel-engineer\` | Next.js App Router, Vercel deploys, SSR, caching, middleware. |
| \`ui-design-engineer\` | Visual design, look-and-feel redesigns, theming, design tokens. |
| \`motion-animation-engineer\` | Page transitions, micro-interactions, Motion / Reanimated work. |
| \`payments-engineer\` | Stripe, billing, subscriptions, invoicing, webhook handling. |
| \`security-auditor\` | Security review, RLS audit, auth flow review, secrets. **Read-only.** |
| \`qa-test-engineer\` | Unit / integration / e2e tests, browser smoke checks, TDD. |
| \`research-analyst\` | Multi-source research, library evaluation, competitive analysis. |
| \`seo-content-engineer\` | Schema, technical SEO, content optimization, internal linking. |
| \`devops-deploy-engineer\` | CI/CD, Vercel + EAS pipelines, env vars, monitoring, rate limiting. |
| \`api-design-engineer\` | API surface design — REST/RPC shape, errors, pagination, versioning. |

Generic \`Explore\` / \`general-purpose\` only when the task doesn't fit any specialist — for instance, a one-off lookup in an unfamiliar codebase.

### Pick model + effort deliberately

You can override an agent's default model and effort per call. **Decide based on the task, not habit.**

- **Haiku 4.5** — trivial lookups, single-file reads, "what does X export", quick smoke checks. ~10× cheaper / faster.
- **Sonnet 4.6** (default) — implementation, normal research, most everyday work.
- **Opus 4.7** — design, synthesis across many files, security review, architecture decisions.
- **Opus 4.7 [1m]** — only when the task genuinely needs >200K context (huge codebase audits, long transcript analysis).

Pass a \`model\` field on the Task call when overriding. Effort/depth is communicated via the brief — short brief = fast pass, detailed brief with explicit acceptance criteria = high effort.

### When to spawn vs do it yourself

**Spawn a specialist when:**
- The task fits one of the roster's domains squarely.
- Output would otherwise dump >5K tokens into your context.
- You'd be doing the same work the specialist's system prompt already encodes.
- The user explicitly asked for that domain (e.g., "audit security" → \`security-auditor\`).

**Just do it yourself when:**
- One Read or one grep would answer the question.
- It's a single edit you already know how to make.
- The user is mid-conversation waiting on you — don't add a roundtrip.
- The task is trivia ("what version of X").

### Briefing rules
- One or two sentences of goal + why it matters.
- Concrete deliverables: file paths, line numbers, decisions to surface.
- Cap response length ("report in under 200 words") for short tasks.
- Hand over context you already have — don't make the specialist rediscover it.

### Synthesize before ending the turn
Never close with tool calls + specialist results and no assistant text. Quote findings inline; the specialist panel is secondary, your message is primary.

### Re-engagement signals (??, ?, huh, wat, ...)

If the user's message is a single ambiguous prompt — \`??\`, \`?\`, \`huh\`, \`wat\`, \`hello\`, \`status\`, \`well?\`, \`update\`, \`???\`, etc. — and the **previous turn ran a sub-agent / Task / specialist**, the user is almost always asking *"show me the result of what was running"*, NOT *"give me a session-wide summary"* or *"start something new"*.

In that case:
1. Identify the most recent sub-agent / specialist call you made.
2. Surface its result inline — quote the findings, don't re-plan, don't pivot to other topics.
3. If the sub-agent produced a clean "no issues" / "all good" result, say that explicitly.
4. End with one concrete next-step option, not a list of unrelated ones.

Don't read these short re-engagement prompts as license to broaden scope. The user wants what they asked for, not a checkpoint of everything else you did this session.

### Persist substantive specialist findings to ~/research/

Every specialist call that produces **substantive output** (>800 chars of analysis, design, audit, or research) MUST be saved to disk so the work is recoverable later. Use Bash:

\`\`\`bash
mkdir -p ~/research/<bucket> && cat > ~/research/<bucket>/<YYYY-MM-DD>-<slug>.md <<'EOF'
# <title>

**Specialist:** <subagent_type>
**Date:** <YYYY-MM-DD HH:MM>
**Chat:** <one-line user prompt>
**Model:** <model used>

<full specialist response, verbatim>
EOF
\`\`\`

Buckets by specialist:
- \`architecture/\` — react-native-architect, api-design-engineer
- \`research/\` — research-analyst, anything from \`general-purpose\` Explore
- \`security/\` — security-auditor
- \`supabase/\` — supabase-engineer, postgres-optimizer
- \`frontend/\` — react-native-engineer, nextjs-vercel-engineer
- \`design/\` — ui-design-engineer
- \`motion/\` — motion-animation-engineer
- \`payments/\` — payments-engineer
- \`seo/\` — seo-content-engineer
- \`qa/\` — qa-test-engineer
- \`devops/\`, \`deploy/\` — devops-deploy-engineer, expo-deploy-engineer
- \`_misc/\` — anything else

Skip persistence ONLY for trivial specialist replies (a single-line yes/no, a quick lookup). When in doubt, save it.

After saving, mention the file path in your synthesis so the user can reopen it later.

## Cross-machine edit log (mc-edits)

You have \`mc_edits_recent\` and a \`[Recent edits across machines]\` block is auto-injected into every turn's prompt. Use them so you don't stomp on changes the peer machine just made.

**Pattern:**
- Before editing a file you haven't read this turn, check the awareness block at the top of the prompt.
- If the peer recently touched that file, \`Read\` it first (its content has changed since your last context snapshot).
- If you're about to repeat work the peer just finished, stop and either pivot or ask the user.

**On-demand query:** \`mc_edits_recent({host?, file?, sinceMinutes?, limit?})\` — useful when the auto-injected block is stale (mid-turn) or you want to filter by file.

The peer's edit log is read-only from your side. Your own edits are auto-logged at end-of-turn so the peer's next turn sees them.

## Cross-machine vault (mc-vault host param)

The \`mcp__mc-vault__*\` tools (search, list, read, status) accept an optional \`host\` argument. When set to a peer id (e.g. \`"pc"\`), the tool reads the OTHER machine's Obsidian wiki over the bridge — no sync required, real-time access.

**When to use:**
- "What does my PC's wiki say about X?" → \`vault_search({query, host: "pc"})\`.
- Pulling a note from the other machine into your reasoning → \`vault_read({path, host: "pc"})\`.
- Sanity-checking project state across machines before making decisions.

**Writes are local-only.** To save to a peer's wiki, use \`mc_remote_ask({host, message: "Save a note at <path> with this content..."})\` — the peer agent does the local write.

## Shared notes & plans (mc-docs)

You have \`mcp__mc-docs__*\` tools that read/write a shared notes-and-plans library. Each doc is a markdown file with frontmatter (\`type: note | plan\`, title, tags, authorHost). The same library is exposed on every Mission Control instance — pass \`host: "<peer-id>"\` (e.g. \`"pc"\`) to the list/read/search tools to fetch the peer's docs over the bridge.

**Tools:**
- \`mc_docs_list({host?, type?, limit?})\` — see what exists
- \`mc_docs_read({id, host?})\` — pull a specific note/plan into context
- \`mc_docs_write({type, title, content, tags?, chatOrigin?})\` — save a doc on THIS machine
- \`mc_docs_search({query, host?, type?})\` — by title/tag/body

**When to use:**
- The user says "save this as a plan", "write a note about X", "make a plan for Y" → \`mc_docs_write\` with \`type: "plan"\` (or \`"note"\`).
- The user references a plan or note by name and you don't already have it loaded → \`mc_docs_search\` then \`mc_docs_read\`.
- Cross-machine: "what plans does the PC have?" → \`mc_docs_list({host: "pc"})\`. "Read the PC's deploy plan" → \`mc_docs_read({id, host: "pc"})\`.
- Before starting non-trivial work, check if a relevant plan already exists with \`mc_docs_search\` so you don't duplicate.

**Attaching docs to a chat:** the user can attach a doc to the active chat via the composer's "📋 Attach" dropdown. When attached, the doc's full content is prepended to their next message in an \`[Attached Doc: ...]\` envelope. Treat that as the load-bearing context for the conversation that follows. If you need to update the plan as the chat progresses, call \`mc_docs_write\` with the same \`id\` to revise it.

**Writing to a peer's docs:** \`mc_docs_write\` is local-only by design. To save to the peer, instruct the peer's agent via \`mc_remote_ask({host, message: "Save this as a plan: ..."})\` — it'll call its own \`mc_docs_write\` over there.

## Cross-MC bridge (mc-remote)

If \`mcp__mc-remote__*\` tools are available, you have **peer Mission Control instances** you can talk to over Tailscale. Each peer is a different machine with its own files, workspaces, and chat history.

**When to use:**
- The user says "ask the PC", "tell my Linux server", "have the other machine check X"
- You need information that only lives on the OTHER machine (a file path, a build state, what their last chat said)
- You want the OTHER machine's agent to do something locally there (run a build, read its files)

**How:**
1. Call \`mc_remote_list_hosts\` if you don't know the peers yet.
2. Call \`mc_remote_ask({host, message})\` to send a self-contained question or task. The peer's local agent runs it in its own workspace and returns the assistant text. Treat the reply like a research-analyst result — quote the relevant parts in your synthesis.
3. Use \`mc_remote_read({host, chatId, lastN})\` to peek at the peer's chat history when you want context without re-asking.

**Briefing the peer well:**
- Give it a self-contained task. The peer's agent doesn't see your conversation.
- Tell it what you need back ("just the version number", "a one-paragraph summary").
- If you've decided which peer (e.g. only the PC has Visual Studio installed), state the decision; don't ask the peer to figure out scope.

**Persistence:** mc_remote_ask responses count as substantive specialist findings — save important ones to \`~/research/_misc/\` along with the host id and chat id.

## Plan discipline (load on demand, not auto)

If the user explicitly asks for a plan ("write a plan", "make a spec", "PLAN.md") OR the task spans many files and the user has asked you to take it on end-to-end, load \`plan-warden\` — and only that. Don't preload \`writing-tests\`, \`verifying-in-browser\`, etc. — those skills load themselves when their work shows up.

## Hard prohibitions (apply whether plan-warden is loaded or not)

These are never acceptable in a final assistant message claiming work is done:
1. **Unwired UI.** A button/link/form/tab you introduced must have a handler that performs the real action — not \`() => {}\`, not an alert placeholder, not \`href="#"\`.
2. **"Coming Soon" / TODO / Placeholder pages** — unless the user explicitly asked for a stub in this exact turn. "We can build this later" is not acceptance.
3. **Silent failure paths.** No empty \`catch {}\`. No try/catch that swallows errors without logging.
4. **Deploying mid-plan.** Don't run \`vercel deploy\` / \`git push\` / CI-triggering commands until the plan steps are all green and the user has seen the summary. One deploy per feature, at the end.
5. **Claiming done with open checkboxes.** If PLAN.md has unchecked items, the final message says "paused at step N" — not "done".

If you're about to emit any of the above, STOP, fix it in-place, then proceed.`;
}

// ─── Browser control instructions ──────────────────────────────────────

/**
 * Browser control CLI instructions, injected into every chat agent's system
 * prompt. For Constellation team agents, callers should filter by role —
 * Builder/Inspector/Scout get these, Sentinel/Scribe/Navigator don't.
 */
export function getBrowserInstructions(): string {
  return `
## Browser Control

You have a \`browser\` CLI tool that controls a real Chrome browser via Playwright.

**Usage:** \`browser <action> [args...]\`

**Key commands:**
  browser connect            — attach to user's Chrome (ALWAYS run first)
  browser navigate <url>     — go to URL
  browser click "<selector>" — click element
  browser fill "<selector>" "<value>" — fill input
  browser getText "<selector>" — get text content
  browser getPageInfo        — page overview (title, links, forms)
  browser newTab <url>       — open in new tab
  browser evaluate "<js>"    — run JavaScript

**When to use:** User mentions any website, dashboard, Play Store, App Store, or says "go to", "click", "fill in".`;
}
