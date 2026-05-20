/**
 * skills-mcp — expose the workspace/bundled SKILL.md files as MCP tools
 * instead of concatenating all of them (30 KB) into every new session's
 * system prompt.
 *
 * Tools:
 *   mc_list_skills()        — compact index: name, description, one-line hook
 *   mc_load_skill(name)     — full SKILL.md body for the requested skill
 *
 * The system-prompt appendix (see loadSkillsIndex below) now only ships the
 * index, so the agent can decide what to pull on demand. This swings ~27 KB
 * out of every cold-start turn.
 */

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// MC's chat sources its skills from five upstream collections (added in
// order, name collisions go to first-loaded). All five are priority sources
// — the user's complete operating model is built from this set:
//   1. obra/superpowers — 14 core methodology skills (TDD, debugging,
//      plans, code review, parallel agents)
//   2. affaan-m/everything-claude-code — 230 production skills (api-design,
//      canary-watch, agent-architecture-audit, browser-qa, autonomous-loops)
//   3. ruvnet/ruflo — 39 agent-orchestration skills (agentdb-*, swarm-*,
//      sparc-methodology, hive-mind-advanced, stream-chain, pair-programming)
//   4. nexu-io/open-design — 133 design + creative skills (imagegen, gsap-*,
//      figma-*, fal-*, ppt/slide/poster/card generators, shadcn-ui, frontend-
//      design, brand-guidelines, theme-factory). Each ships its own
//      `triggers:` frontmatter array which is auto-converted to regex.
//   5. kepano/obsidian-skills — 5 vault skills (defuddle, json-canvas,
//      obsidian-bases, obsidian-cli, obsidian-markdown). Small but
//      high-leverage when the user is editing notes, canvases, or wants
//      web-page content extracted as clean markdown.
//
// Pre-existing ~/.openclaw/workspace/skills/ (Matt Pocock + workspace + bundled)
// is intentionally NOT scanned per user instruction 2026-05-17.
const SUPERPOWERS_SKILLS_DIR = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', 'superpowers', 'f2cbfbefebbf', 'skills');
const ECC_SKILLS_DIR = path.join(os.homedir(), 'everything-claude-code', 'skills');
const RUFLO_SKILLS_DIR = path.join(os.homedir(), 'ruflo', '.claude', 'skills');
const OPENDESIGN_SKILLS_DIR = path.join(os.homedir(), 'open-design', 'skills');
const OBSIDIAN_SKILLS_DIR = path.join(os.homedir(), 'obsidian-skills', 'skills');

interface SkillMeta {
  dir: string;
  file: string; // absolute path to SKILL.md
  name: string;
  description: string;
  source: 'superpowers' | 'ecc' | 'ruflo' | 'opendesign' | 'obsidian';
  triggers?: string[]; // built-in trigger phrases from frontmatter (opendesign)
}

function parseFrontmatter(content: string): { name?: string; description?: string; triggers?: string[] } {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  const triggers: string[] = [];
  const lines = m[1].split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    const rawVal = kv[2].trim();
    // YAML folded ('>') or literal ('|') scalar — collect indented continuation lines.
    if (rawVal === '>' || rawVal === '|' || rawVal === '>-' || rawVal === '|-') {
      const collected: string[] = [];
      i++;
      while (i < lines.length && /^\s+\S/.test(lines[i])) {
        collected.push(lines[i].trim());
        i++;
      }
      // Folded ('>') joins lines with a space; literal ('|') keeps newlines.
      out[key] = (rawVal.startsWith('>') ? collected.join(' ') : collected.join('\n')).trim();
      continue;
    }
    // YAML inline array on next lines: `triggers:` then a sequence of `  - "x"`.
    if (rawVal === '' && key === 'triggers') {
      i++;
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        const item = lines[i].replace(/^\s*-\s+/, '').trim().replace(/^['"]|['"]$/g, '');
        if (item) triggers.push(item);
        i++;
      }
      continue;
    }
    out[key] = rawVal.replace(/^['"]|['"]$/g, '');
    i++;
  }
  return { name: out.name, description: out.description, triggers: triggers.length ? triggers : undefined };
}

function readSkillsFromDir(dir: string, source: SkillMeta['source']): SkillMeta[] {
  if (!fs.existsSync(dir)) return [];
  const out: SkillMeta[] = [];
  try {
    for (const d of fs.readdirSync(dir)) {
      const full = path.join(dir, d);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
        if (fs.existsSync(path.join(full, '.disabled'))) continue;
        const file = path.join(full, 'SKILL.md');
        if (!fs.existsSync(file)) continue;
        const body = fs.readFileSync(file, 'utf-8');
        const fm = parseFrontmatter(body);
        out.push({
          dir: d,
          file,
          name: fm.name || d,
          description: fm.description || '',
          source,
          triggers: fm.triggers,
        });
      } catch { /* skip unreadable */ }
    }
  } catch { /* dir read failed */ }
  return out;
}

// Priority skills — top-billed in the index. The user's daily-driver
// workflows: superpowers (core methodology) + ecc high-value picks +
// ruflo orchestration picks. These also have explicit auto-trigger
// patterns in SKILL_TRIGGERS below so they force-load when matched.
const PRIORITY_SKILL_NAMES = [
  // superpowers — methodology core
  'using-superpowers', 'systematic-debugging', 'test-driven-development',
  'brainstorming', 'writing-plans', 'executing-plans',
  'subagent-driven-development', 'dispatching-parallel-agents',
  'verification-before-completion', 'requesting-code-review',
  // everything-claude-code — high-leverage picks
  'agent-architecture-audit', 'api-design', 'autonomous-loops',
  'browser-qa', 'canary-watch', 'code-review', 'feature-dev',
  'agentic-engineering', 'ai-regression-testing',
  // ruflo — agent orchestration / swarm coordination
  'sparc-methodology', 'swarm-orchestration', 'hive-mind-advanced',
  'pair-programming', 'agentdb-advanced', 'reasoningbank-intelligence',
  'stream-chain', 'github-code-review',
  // open-design — creative/design marquee picks
  'frontend-design', 'frontend-dev', 'ui-skills', 'ui-ux-pro-max',
  'shadcn-ui', 'design-review', 'brand-guidelines', 'theme-factory',
  'imagegen', 'gsap-core', 'gsap-react', 'figma-use',
  'ppt-keynote', 'pptx', 'web-artifacts-builder', 'taste-skill',
  // kepano/obsidian-skills — ALL 5 are priority (small, high-leverage set)
  'defuddle', 'json-canvas', 'obsidian-bases', 'obsidian-cli', 'obsidian-markdown',
];

/** Catalog for prompt-enhancer use cases. Name + full description + source. */
export function getSkillsCatalog(): Array<{ name: string; description: string; source: string }> {
  return listAllSkills().map(s => ({
    name: s.name,
    description: (s.description || '').replace(/\s+/g, ' '),
    source: s.source,
  }));
}

function listAllSkills(): SkillMeta[] {
  // Order matters for name collisions: superpowers > ecc > ruflo > opendesign > obsidian.
  const sp = readSkillsFromDir(SUPERPOWERS_SKILLS_DIR, 'superpowers');
  const ecc = readSkillsFromDir(ECC_SKILLS_DIR, 'ecc');
  const ruflo = readSkillsFromDir(RUFLO_SKILLS_DIR, 'ruflo');
  const opendesign = readSkillsFromDir(OPENDESIGN_SKILLS_DIR, 'opendesign');
  const obsidian = readSkillsFromDir(OBSIDIAN_SKILLS_DIR, 'obsidian');
  const taken = new Set<string>(sp.map(s => s.name.toLowerCase()));
  const eccUnique = ecc.filter(s => !taken.has(s.name.toLowerCase()));
  eccUnique.forEach(s => taken.add(s.name.toLowerCase()));
  const rufloUnique = ruflo.filter(s => !taken.has(s.name.toLowerCase()));
  rufloUnique.forEach(s => taken.add(s.name.toLowerCase()));
  const odUnique = opendesign.filter(s => !taken.has(s.name.toLowerCase()));
  odUnique.forEach(s => taken.add(s.name.toLowerCase()));
  const obsUnique = obsidian.filter(s => !taken.has(s.name.toLowerCase()));
  return [...sp, ...eccUnique, ...rufloUnique, ...odUnique, ...obsUnique].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Compact index appended to the system prompt: one line per skill,
 * with the agent instructed to call `mc_load_skill(name)` to pull the body.
 *
 * Priority skills (Matt Pocock's set) are listed first, under their own
 * header, with explicit instructions that they're the primary operating
 * model for this user. Slash commands like `/tdd`, `/diagnose`, `/grill-me`
 * map directly to skill names.
 */
export function loadSkillsIndex(): string {
  const skills = listAllSkills();
  if (skills.length === 0) return '';

  const prioritySet = new Set(PRIORITY_SKILL_NAMES);
  const priority: SkillMeta[] = [];
  const other: SkillMeta[] = [];
  for (const s of skills) {
    if (prioritySet.has(s.name)) priority.push(s);
    else other.push(s);
  }
  // Render priority list in canonical order (engineering-first), not alpha.
  priority.sort((a, b) => PRIORITY_SKILL_NAMES.indexOf(a.name) - PRIORITY_SKILL_NAMES.indexOf(b.name));

  const fmt = (s: SkillMeta) => {
    const desc = (s.description || '').replace(/\s+/g, ' ').slice(0, 140);
    return `- \`/${s.name}\` — ${desc}`;
  };

  const out: string[] = [''];

  if (priority.length > 0) {
    out.push(
      '## PRIORITY SKILLS — superpowers + everything-claude-code + ruflo + open-design + obsidian-skills core',
      '',
      'These are the user\'s primary workflow. **Always check this list first.** Each name is a slash command (e.g. `/test-driven-development`, `/systematic-debugging`). When the user types one, OR when their request matches a skill\'s "Use when…" trigger, follow the body verbatim — don\'t fall back to ad-hoc behavior. Many of these auto-load (full body inlined below the index) when triggers match.',
      '',
      ...priority.map(fmt),
      '',
      '**Common triggers → skill mapping:**',
      '- "fix this bug" / "test failing" / "why is X broken" → `/systematic-debugging`',
      '- "implement feature X with tests" / "TDD this" → `/test-driven-development`',
      '- "let\'s brainstorm" / "design X" / "trade-offs" → `/brainstorming`',
      '- "write a plan for" / "step-by-step" / "implementation plan" → `/writing-plans`',
      '- "execute the plan" / "follow the plan" → `/executing-plans`',
      '- "spawn parallel agents" / "fan out" / "concurrent tasks" → `/dispatching-parallel-agents`',
      '- "ready to merge" / "all done" / "ship it" → `/verification-before-completion`',
      '- "review my code" / "code review" / "before merge" → `/requesting-code-review` or `/code-review`',
      '- "design a REST API" / "endpoint design" / "versioning" → `/api-design`',
      '- "watch the deploy" / "monitor prod" / "canary" → `/canary-watch`',
      '- "audit my agent" / "wrapper regression" / "12-layer" → `/agent-architecture-audit`',
      '- "playwright" / "browser test" / "UI automation" → `/browser-qa`',
      '- "autonomous loop" / "self-healing agent" / "RFC-driven" → `/autonomous-loops`',
      '- "build a feature" / "feature work" → `/feature-dev`',
      '- "SPARC" / "specification → architecture → refinement" → `/sparc-methodology`',
      '- "orchestrate a swarm" / "multi-agent run" → `/swarm-orchestration`',
      '- "hive mind" / "collective intelligence" → `/hive-mind-advanced`',
      '- "pair programming" → `/pair-programming`',
      '- "agentdb" / "agent memory db" / "vector search in agent memory" → `/agentdb-advanced` or `/agentdb-vector-search`',
      '- "reasoning bank" / "capture reasoning trace" → `/reasoningbank-intelligence`',
      '- "stream chain" / "chained streams" → `/stream-chain`',
      '- "review a PR on github" → `/github-code-review`',
      '- "github workflow automation" / "github actions" → `/github-workflow-automation`',
      '- "design this UI" / "build the landing page" / "design system component" → `/frontend-design` or `/ui-skills`',
      '- "shadcn" / "accessible components" → `/shadcn-ui`',
      '- "design review" / "critique my design" → `/design-review`',
      '- "brand guidelines" / "brand book" → `/brand-guidelines`',
      '- "generate a theme" / "theme tokens" → `/theme-factory`',
      '- "generate an image" / "dall-e" / "icon design" → `/imagegen`',
      '- "gsap" / "tween" / "easing" → `/gsap-core` (`/gsap-react`, `/gsap-scrolltrigger`, `/gsap-timeline` for variants)',
      '- "figma" / "import from figma" → `/figma-use`',
      '- "powerpoint" / "pptx" / "build a deck" → `/pptx` or `/ppt-keynote`',
      '- "web artifact" / "interactive artifact" → `/web-artifacts-builder`',
      '- "design taste" / "aesthetic judgement" → `/taste-skill`',
      '- "use Apple\'s design language" / "Stripe-style UI" / "design like <brand>" → call `mc_load_design_system(<brand>)`',
      '- "fetch this URL as clean markdown" / "read this article" / `https://…` → `/defuddle` (prefer over WebFetch for non-.md URLs)',
      '- "edit my .canvas file" / "obsidian canvas" / "mindmap node" → `/json-canvas`',
      '- "edit a .base file" / "obsidian base view" / "table view of notes" → `/obsidian-bases`',
      '- "search my vault" / "obsidian CLI" / "reload obsidian plugin" → `/obsidian-cli`',
      '- "wikilink" / "callout" / "obsidian frontmatter" / "edit a note in obsidian" → `/obsidian-markdown`',
    );
  }

  if (other.length > 0) {
    out.push(
      '',
      '## Other skills (secondary — call `mc_load_skill(<name>)` to fetch body)',
      '',
      ...other.map(fmt),
    );
  }

  out.push('', '**Rule of thumb:** load on demand — skill bodies can be multiple KB. Prefer priority skills when both match.');
  return out.join('\n');
}

// ─── Auto-trigger router for superpowers + priority skills ───────────────
//
// User wants: "force load into every prompt based on what im asking or
// instructing." So instead of just showing the index and letting the agent
// decide whether to call mc_load_skill, we look at the user's text and
// inline the FULL body of matched skills directly into the system prompt
// appendix. Each turn gets the skills that match its semantics.
//
// Matching is regex-based against each skill's trigger phrases. Total
// inlined size is capped at AUTO_SKILL_BUNDLE_MAX_CHARS so token cost stays
// bounded (~1.5K tokens at the 6KB default).

// Per-turn skill bundle budget. Each matched skill is truncated to
// MAX_SKILL_BODY_INLINE if it would push the total over budget; the bundle
// itself never exceeds AUTO_SKILL_BUNDLE_MAX_CHARS. Previously this was
// 6000 and any single >6 KB skill (e.g. superpowers test-driven-development
// at 9867 B) silently dropped to ZERO inlined bytes because the original
// break-on-overflow logic skipped the first item instead of truncating it.
const AUTO_SKILL_BUNDLE_MAX_CHARS = 12000;
const MAX_SKILL_BODY_INLINE = 5500;

/** Trigger patterns per skill. Authored once here per superpowers + priority
 *  skill. When the user's message matches any pattern, the skill is loaded
 *  inline. Add new entries by skill name (matching the dir name in
 *  WORKSPACE_SKILLS_DIR). Case-insensitive, word-boundary aware. */
const SKILL_TRIGGERS: Array<{ name: string; patterns: RegExp[] }> = [
  // ─ Superpowers ──────────────────────────────────────────────────────
  { name: 'systematic-debugging',          patterns: [/\b(bug|broken|error|fail(s|ed|ing|ure)?|crash|stack trace|not working|why (does|is)|unexpected)\b/i, /\b(debug|diagnose|investigate)\b/i] },
  { name: 'test-driven-development',       patterns: [/\b(tdd|test[- ]driven|red[- ]green|write (the )?test (first|before))\b/i, /\b(implement|build|add|create)\b.*\b(feature|function|method|endpoint|class|component)\b/i, /\b(unit test|spec|coverage)\b/i] },
  { name: 'brainstorming',                 patterns: [/\b(brainstorm|design|architect|figure out how to|approach for|what.{0,20}options|trade[- ]?off|let'?s think)\b/i, /\b(should we|could we|what if we)\b/i] },
  { name: 'writing-plans',                 patterns: [/\b(plan(ning)?( this| out)?|step[- ]by[- ]step|roadmap|phases|milestones|how should we tackle|break .{0,20}down|implementation plan)\b/i] },
  { name: 'executing-plans',               patterns: [/\b(execute (the |this )?plan|implement (the |this )?plan|follow (the |this )?plan|carry out .{0,20}plan)\b/i] },
  { name: 'subagent-driven-development',   patterns: [/\b(sub[- ]?agent|delegate|fan[- ]?out (work|tasks)|parallel (impl|implementation|tasks)|spawn .{0,15}task)\b/i] },
  { name: 'dispatching-parallel-agents',   patterns: [/\b(parallel|fan[- ]?out|concurrent(ly)?|at the same time|in parallel|multiple agents)\b/i] },
  { name: 'using-git-worktrees',           patterns: [/\b(worktree|isolated branch|separate workspace|git worktree)\b/i, /\b(work on (this|both|two|multiple).{0,30}without (disturb|touching|breaking))\b/i] },
  { name: 'requesting-code-review',        patterns: [/\b(code review|review (this|my|the) code|review (this |the )?(pr|patch|changes?|implementation)|merge (this |to |into)|ship (it|this)|before (we |i )?merge)\b/i] },
  { name: 'receiving-code-review',         patterns: [/\b(reviewer (said|wants|asked)|review feedback|review comments?|address (the )?review|got (a )?review)\b/i] },
  { name: 'finishing-a-development-branch',patterns: [/\b(finish(ing)? .{0,20}(branch|feature)|wrap (up|this) (work|feature)|ready to merge|done with (this|the) (feature|branch)|land (this|the) (branch|work))\b/i] },
  { name: 'verification-before-completion',patterns: [/\b(it'?s? done|all done|complete[d]?|finished|fixed|passing|ready (to ship|for review)|works now|ship it)\b/i] },
  { name: 'writing-skills',                patterns: [/\b(write (a )?skill|create (a )?skill|new skill|skill\.md|skill definition|edit (this |the )?skill)\b/i] },
  { name: 'using-superpowers',             patterns: [/\b(superpowers?|what skills|list skills|how do skills work)\b/i] },
  // ─ everything-claude-code (affaan-m) — 230 skills, high-value picks ─
  { name: 'agent-architecture-audit',      patterns: [/\b(audit (the |my )?(agent|harness)|agent architecture|wrapper regression|12.layer|memory poll|context bloat)\b/i] },
  { name: 'api-design',                    patterns: [/\b(design (an? |the )?api|rest (api|endpoint)|api endpoint|resource naming|http status codes?|api versioning|pagination|api conventions?)\b/i] },
  { name: 'autonomous-loops',              patterns: [/\b(autonomous (loop|agent)|self.healing loop|rfc.driven|claude code loop|ralph (loop)?|continuous agent)\b/i] },
  { name: 'browser-qa',                    patterns: [/\b(browser (test|qa|automation)|visual test|ui interaction|playwright|selenium|e2e (test|verification))\b/i] },
  { name: 'canary-watch',                  patterns: [/\b(canary|watch (the |my )?deploy|monitor (the )?(deploy|release|prod)|verify (the )?(deploy|release)|deployment health)\b/i] },
  { name: 'code-review',                   patterns: [/\b(review (this |my )?(code|pr|diff|patch)|do a code review|code review of)\b/i] },
  { name: 'continuous-learning-v2',        patterns: [/\b(learn from this|extract (a )?skill|instinct (capture|export)|stop hook learning|crystallize (this )?skill)\b/i] },
  { name: 'database-migrations',           patterns: [/\b(db migration|database migration|schema migration|alembic|knex migration|prisma migrate)\b/i] },
  { name: 'feature-dev',                   patterns: [/\b(build (a |the )?feature|new feature|feature work|implement .{0,30}feature|develop (a )?feature)\b/i] },
  { name: 'agentic-engineering',           patterns: [/\b(agentic engineering|agent.driven (dev|engineering)|use agents to (build|develop))\b/i] },
  { name: 'agentic-os',                    patterns: [/\b(agentic os|agent.based os|agents as os|agent operating system)\b/i] },
  { name: 'ai-regression-testing',         patterns: [/\b(regression test|sandbox.mode (api )?test|ai test|prevent regression)\b/i] },
  { name: 'blueprint',                     patterns: [/\b(blueprint|architectural blueprint|system blueprint|reference architecture)\b/i] },
  { name: 'agent-introspection-debugging', patterns: [/\b(agent (debug|introspect|trace)|why did the agent|inspect agent state|agent loop debug)\b/i] },

  // ─ ruflo (ruvnet) — agent orchestration / swarm coordination ────────
  { name: 'sparc-methodology',             patterns: [/\b(sparc|specification.pseudocode.architecture|sparc methodology|s\.?p\.?a\.?r\.?c)\b/i] },
  { name: 'swarm-orchestration',           patterns: [/\b(swarm orchestration|orchestrate (a |the )?swarm|coordinate (multi.|several )?agents|agent swarm|multi.agent (run|exec|orchestr))\b/i] },
  { name: 'swarm-advanced',                patterns: [/\b(advanced swarm|swarm topology|swarm patterns|complex swarm)\b/i] },
  { name: 'hive-mind-advanced',            patterns: [/\b(hive.?mind|collective intelligence|shared memory across agents|agent consensus)\b/i] },
  { name: 'pair-programming',              patterns: [/\b(pair program|pair[- ]programming|drive (and|while) navig|two agents working together)\b/i] },
  { name: 'agentdb-advanced',              patterns: [/\b(agentdb|agent (database|memory db)|persistent agent state)\b/i] },
  { name: 'agentdb-memory-patterns',       patterns: [/\b(memory pattern|agent memory layout|cross.session memory)\b/i] },
  { name: 'agentdb-vector-search',         patterns: [/\b(vector search|embedding search|semantic search in agent (memory|db))\b/i] },
  { name: 'reasoningbank-intelligence',    patterns: [/\b(reasoning bank|reasoningbank|reasoning trace|capture reasoning|recall reasoning)\b/i] },
  { name: 'stream-chain',                  patterns: [/\b(stream chain|chained streams|pipe (the )?stream through|stream pipeline)\b/i] },
  { name: 'github-code-review',            patterns: [/\b(github code review|review (a |the )?pr on github|github pr review)\b/i] },
  { name: 'github-multi-repo',             patterns: [/\b(multi.?repo|across (the |multiple )?repos|coordinate changes (across|in multiple) repos)\b/i] },
  { name: 'github-workflow-automation',    patterns: [/\b(github workflow|github actions|ci automation|automate (the |github )?workflow)\b/i] },
  { name: 'github-release-management',     patterns: [/\b(github release|release management|cut a release|tag (a )?release)\b/i] },
  { name: 'github-project-management',     patterns: [/\b(github project|github project board|kanban (on |in )?github|manage issues on github|github (issue|kanban) (board|management))\b/i] },
  { name: 'flow-nexus-swarm',              patterns: [/\b(flow.?nexus|flow nexus swarm|nexus orchestrat)\b/i] },
  { name: 'flow-nexus-neural',             patterns: [/\b(flow.?nexus neural|neural net (on |for )?nexus)\b/i] },
  { name: 'hooks-automation',              patterns: [/\b(hooks automation|claude code hooks|automate via hooks|hook[- ]based)\b/i] },
  { name: 'skill-builder',                 patterns: [/\b(build (a )?skill|generate (a )?skill|skill builder|new skill scaffolding)\b/i] },
  { name: 'performance-analysis',          patterns: [/\b(perf analysis|performance analysis|profile (this|the) (code|agent)|benchmark agent)\b/i] },
  { name: 'verification-quality',          patterns: [/\b(verification quality|quality verification|verify (the )?(quality|output))\b/i] },
  { name: 'worker-integration',            patterns: [/\b(worker integration|wire up worker|integrate worker)\b/i] },
  { name: 'worker-benchmarks',             patterns: [/\b(worker benchmark|benchmark workers|worker perf)\b/i] },
  { name: 'agentic-jujutsu',               patterns: [/\b(jujutsu|agentic jujutsu|agent leverage|prompt judo)\b/i] },

  // ─ open-design (nexu-io) — design & creative ────────────────────────
  // Marquee design skills get hand-authored patterns; everything else
  // auto-derives from each SKILL.md's own `triggers:` frontmatter array
  // via buildOpendesignTriggersFromFrontmatter() below.
  { name: 'frontend-design',               patterns: [/\b(frontend design|design (a |the |this |that |my )?\w{0,20}?\s?(ui|interface|page|screen|layout|view|dashboard|landing|hero|navbar|sidebar|modal|form)|design system .{0,20}(component|page)|build .{0,40}(landing|marketing) page|visual hierarchy)\b/i] },
  { name: 'frontend-dev',                  patterns: [/\b(frontend dev|build (this|the|a )?(component|widget|screen)|wire up (this |the )?ui|implement (this |the )?(component|screen|page))\b/i] },
  { name: 'shadcn-ui',                     patterns: [/\b(shadcn|shadcn[- ]?ui|accessible (components?|primitives?)|radix (ui|primitives?))\b/i] },
  { name: 'ui-skills',                     patterns: [/\b(ui skills?|ui primitives?|build ui|ui kit|design tokens?)\b/i] },
  { name: 'ui-ux-pro-max',                 patterns: [/\b(ui[/ ]?ux pro max|ux pro max|comprehensive ux|ux audit|ux review|full ux pass)\b/i] },
  { name: 'design-review',                 patterns: [/\b(design review|review (this |the |my )?design|critique (this |the |my )?design|visual review|aesthetic review)\b/i] },
  { name: 'brand-guidelines',              patterns: [/\b(brand guidelines?|brand book|brand identity|brand voice|brand standards?)\b/i] },
  { name: 'theme-factory',                 patterns: [/\b(theme factory|generate (a |the )?theme|theme generator|make .{0,20}theme|design (a |the )?theme|theme tokens?)\b/i] },
  { name: 'imagegen',                      patterns: [/\b(generate (an? )?(image|icon|illustration|mockup)|create (an? )?(image|icon|illustration|mockup)|image gen|openai image|gpt[- ]?image|dall.?e|icon design|mockup image)\b/i] },
  { name: 'gsap-core',                     patterns: [/\b(gsap|greensock|tween|easing|gsap\.(to|from|fromTo|timeline))\b/i] },
  { name: 'gsap-react',                    patterns: [/\b(gsap react|useGSAP|gsap (in |for )?(react|next))\b/i] },
  { name: 'gsap-scrolltrigger',            patterns: [/\b(scrolltrigger|scroll[- ]trigger|scroll[- ]based animation|pin (on )?scroll)\b/i] },
  { name: 'gsap-timeline',                 patterns: [/\b(gsap timeline|animation timeline|sequenced animation|chained tweens?)\b/i] },
  { name: 'figma-use',                     patterns: [/\b(figma|figma file|figma frame|use figma|import from figma)\b/i] },
  { name: 'figma-generate-design',         patterns: [/\b(generate (a )?figma design|create .{0,20}figma|figma generate)\b/i] },
  { name: 'figma-implement-design',        patterns: [/\b(implement .{0,30}figma|build from figma|figma to code|figma handoff)\b/i] },
  { name: 'figma-code-connect-components', patterns: [/\b(code connect|figma code connect|connect figma components?)\b/i] },
  { name: 'figma-create-design-system-rules', patterns: [/\b(figma design system|design system in figma|figma design rules)\b/i] },
  { name: 'figma-create-new-file',         patterns: [/\b(create (a |new )?figma file|new figma file|figma new file)\b/i] },
  { name: 'figma-generate-library',        patterns: [/\b(figma library|generate (a )?figma library|figma component library)\b/i] },
  { name: 'ppt-keynote',                   patterns: [/\b(keynote (deck|slides?|presentation)|ppt[- ]?keynote|apple keynote)\b/i] },
  { name: 'pptx',                          patterns: [/\b(pptx|powerpoint|generate (a )?(deck|presentation|slides?)|build (a )?(deck|presentation))\b/i] },
  { name: 'pptx-generator',                patterns: [/\b(pptx generator|powerpoint generator|generate pptx|programmatic powerpoint)\b/i] },
  { name: 'pptx-html-fidelity-audit',      patterns: [/\b(pptx fidelity|powerpoint fidelity|html.to.pptx|pptx audit)\b/i] },
  { name: 'deck-guizang-editorial',        patterns: [/\b(editorial deck|guizang|editorial presentation)\b/i] },
  { name: 'deck-open-slide-canvas',        patterns: [/\b(open slide canvas|slide canvas|deck canvas)\b/i] },
  { name: 'deck-swiss-international',      patterns: [/\b(swiss (deck|slides?|presentation|style)|international typographic style deck)\b/i] },
  { name: 'slides',                        patterns: [/\b(slide deck|slides?|presentation slides?|build (a )?slide)\b/i] },
  { name: 'frontend-slides',               patterns: [/\b(frontend slides?|html slides?|browser slides?|reveal\.?js)\b/i] },
  { name: 'web-artifacts-builder',         patterns: [/\b(web artifact|build (a )?web artifact|claude artifact|interactive artifact)\b/i] },
  { name: 'artifacts-builder',             patterns: [/\b(artifact builder|build (an? )?artifact|claude\.ai artifact)\b/i] },
  { name: 'doc',                           patterns: [/\b(generate (a |the )?doc|create (a |the )?doc|build (a |the )?doc|html doc)\b/i] },
  { name: 'docx',                          patterns: [/\b(docx|word doc|generate (a )?docx|microsoft word document)\b/i] },
  { name: 'pdf',                           patterns: [/\b(generate (a )?pdf|create (a )?pdf|export .{0,20}pdf|pdf doc(ument)?)\b/i] },
  { name: 'taste-skill',                   patterns: [/\b(taste|design taste|aesthetic judgement|good taste|sense of design)\b/i] },
  { name: 'color-expert',                  patterns: [/\b(color (palette|theory|expert|expertise)|pick (a |the )?(palette|colors?)|color combinations?|harmonious colors?)\b/i] },
  { name: 'creative-director',             patterns: [/\b(creative direction|art direction|creative director|set (the |a )?creative direction)\b/i] },
  { name: 'design-brief',                  patterns: [/\b(design brief|creative brief|project brief|write (a )?brief)\b/i] },
  { name: 'design-consultation',           patterns: [/\b(design consultation|consult on .{0,20}design|design advice)\b/i] },
  { name: 'design-md',                     patterns: [/\b(design\.md|design md|design markdown|spec out (the )?design)\b/i] },
  { name: 'enhance-prompt',                patterns: [/\b(enhance (this |the |my )?prompt|improve (this |the |my )?prompt|prompt enhancer|better prompt)\b/i] },
  { name: 'web-design-guidelines',         patterns: [/\b(web design guidelines?|web design rules|website design (guide|spec))\b/i] },
  { name: 'platform-design',               patterns: [/\b(platform design|design (a |the |our )?platform|saas design language)\b/i] },
  { name: 'apple-hig',                     patterns: [/\b(apple hig|human interface guidelines|apple guidelines|hig)\b/i] },
  { name: 'swiftui-design',                patterns: [/\b(swiftui design|swiftui (component|view|layout)|design (a |an? )?swiftui)\b/i] },
  { name: 'flutter-animating-apps',        patterns: [/\b(flutter animation|flutter animating|animate (in |a )?flutter)\b/i] },
  { name: 'threejs',                       patterns: [/\b(three\.?js|threejs|3d (in |on )?web|webgl scene)\b/i] },
  { name: 'shader-dev',                    patterns: [/\b(shader|glsl|fragment shader|vertex shader|webgl shader)\b/i] },
  { name: 'remotion',                      patterns: [/\b(remotion|programmatic video|video as code|react video)\b/i] },
  { name: 'sora',                          patterns: [/\b(sora|openai sora|sora video|text.?to.?video)\b/i] },
  { name: 'replicate',                     patterns: [/\b(replicate\.com|replicate model|run on replicate)\b/i] },
  { name: 'imagen',                        patterns: [/\b(imagen|google imagen|imagen 3|imagen 4)\b/i] },
  { name: 'speech',                        patterns: [/\b(text.?to.?speech|tts|generate speech|voice over|speech synthesis)\b/i] },
  { name: 'video-hyperframes',             patterns: [/\b(hyperframes?|video hyperframe|frame.based video)\b/i] },
  { name: 'video-downloader',              patterns: [/\b(download (a |this |the )?video|video downloader|yt.?dlp)\b/i] },
  { name: 'youtube-clipper',               patterns: [/\b(youtube clip|youtube clipper|clip (from )?youtube)\b/i] },
  { name: 'slack-gif-creator',             patterns: [/\b(slack gif|slack emoji gif|gif for slack)\b/i] },
  { name: 'gif-sticker-maker',             patterns: [/\b(gif sticker|sticker maker|telegram sticker)\b/i] },
  { name: 'hand-drawn-diagrams',           patterns: [/\b(hand.?drawn diagram|sketchy diagram|excalidraw|tldraw)\b/i] },
  { name: 'd3-visualization',              patterns: [/\b(d3 visualization|d3\.js|d3 chart|svg chart with d3)\b/i] },
  { name: 'data-report',                   patterns: [/\b(data report|generate (a )?data report|analytics report)\b/i] },
  { name: 'resume-modern',                 patterns: [/\b(modern resume|build (a |my )?resume|cv design|resume design)\b/i] },
  { name: 'login-flow',                    patterns: [/\b(login flow|sign in flow|auth flow ui|onboarding flow)\b/i] },
  { name: 'paywall-upgrade-cro',           patterns: [/\b(paywall|upgrade screen|cro|conversion rate optimi[sz]ation|monetization screen)\b/i] },
  { name: 'marketing-psychology',          patterns: [/\b(marketing psychology|persuasion (principles?|design)|cialdini|behavioral marketing)\b/i] },
  { name: 'copywriting',                   patterns: [/\b(copywriting|write (the |some )?copy|marketing copy|landing page copy|tagline|microcopy)\b/i] },
  { name: 'ad-creative',                   patterns: [/\b(ad creative|ad design|generate (an? )?ad|banner ad|social ad)\b/i] },
  { name: 'competitive-ads-extractor',     patterns: [/\b(competitor ads?|competitive ads?|ads? library|scrape ads?)\b/i] },
  { name: 'screenshot',                    patterns: [/\b(take (a )?screenshot|screen capture|screenshot tool)\b/i] },
  { name: 'full-page-screenshot',          patterns: [/\b(full page screenshot|whole page screenshot|scroll screenshot)\b/i] },
  { name: 'screenshots-marketing',         patterns: [/\b(marketing screenshots?|product screenshots?|app store screenshots?)\b/i] },
  { name: 'mockup-device-3d',              patterns: [/\b(device mockup|3d mockup|phone mockup|laptop mockup)\b/i] },
  { name: 'poster-hero',                   patterns: [/\b(poster|hero poster|movie poster|design (a )?poster)\b/i] },
  { name: 'social-x-post-card',            patterns: [/\b(x post card|twitter post card|x\.com (post|card))\b/i] },
  { name: 'social-reddit-card',            patterns: [/\b(reddit card|reddit post (card|design))\b/i] },
  { name: 'social-spotify-card',           patterns: [/\b(spotify card|now playing card|spotify share card)\b/i] },
  { name: 'card-twitter',                  patterns: [/\b(twitter card|twitter share card|twitter (link )?preview)\b/i] },
  { name: 'card-xiaohongshu',              patterns: [/\b(xiaohongshu|red note|little red book card)\b/i] },
  { name: 'faq-page',                      patterns: [/\b(faq page|design (a |the )?faq|frequently asked questions page)\b/i] },
  { name: 'release-notes-one-pager',       patterns: [/\b(release notes|changelog (page|one.pager)|release one.?pager)\b/i] },
  { name: 'algorithmic-art',               patterns: [/\b(algorithmic art|generative art|creative coding|p5\.?js art)\b/i] },
  { name: 'ai-music-album',                patterns: [/\b(ai music album|generate (an? )?album|music cover art)\b/i] },
  { name: 'venice-image-generate',         patterns: [/\b(venice (ai )?image|venice generate|uncensored image gen)\b/i] },
  { name: 'venice-image-edit',             patterns: [/\b(venice (ai )?(image )?edit|venice inpaint)\b/i] },
  { name: 'venice-video',                  patterns: [/\b(venice (ai )?video|venice video gen)\b/i] },
  { name: 'venice-audio-music',            patterns: [/\b(venice (ai )?music|venice audio music)\b/i] },
  { name: 'venice-audio-speech',           patterns: [/\b(venice (ai )?speech|venice audio speech)\b/i] },
  { name: 'fal-generate',                  patterns: [/\b(fal\.ai|fal generate|fal image gen)\b/i] },
  { name: 'fal-image-edit',                patterns: [/\b(fal (image )?edit|fal\.ai edit|fal inpaint)\b/i] },
  { name: 'fal-video-edit',                patterns: [/\b(fal video edit|fal\.ai video)\b/i] },
  { name: 'fal-vision',                    patterns: [/\b(fal vision|fal\.ai vision|fal image understanding)\b/i] },
  { name: 'fal-tryon',                     patterns: [/\b(virtual try.?on|fal tryon|clothing try.?on)\b/i] },
  { name: 'fal-3d',                        patterns: [/\b(fal 3d|fal\.ai 3d|3d (model )?gen(eration)?)\b/i] },
  { name: 'fal-upscale',                   patterns: [/\b(upscale (an? )?image|fal upscale|image super.?resolution)\b/i] },
  { name: 'fal-restore',                   patterns: [/\b(restore (an? )?image|fal restore|image restoration)\b/i] },
  { name: 'fal-lip-sync',                  patterns: [/\b(lip.?sync|fal lip sync|sync lips to audio)\b/i] },
  { name: 'fal-kling-o3',                  patterns: [/\b(kling|kling.o3|fal kling)\b/i] },
  { name: 'fal-realtime',                  patterns: [/\b(fal realtime|realtime image gen)\b/i] },
  { name: 'fal-train',                     patterns: [/\b(fal train|train (a |an? )?(model )?on fal|fine.?tune (an? )?image model)\b/i] },
  { name: 'nanobanana-ppt',                patterns: [/\b(nanobanana|nano banana (ppt|deck))\b/i] },
  { name: 'stitch-loop',                   patterns: [/\b(stitch loop|stitch design loop|design.then.code loop)\b/i] },
  { name: 'image-enhancer',                patterns: [/\b(enhance (an? |this |the )?image|image enhancer|improve image quality)\b/i] },
  { name: 'plan-design-review',            patterns: [/\b(plan (a |the )?design review|design plan review)\b/i] },
  { name: 'domain-name-brainstormer',      patterns: [/\b(domain name|brainstorm (a |some |the )?(domain|brand name)|name (this |our |the )?(brand|product|app))\b/i] },

  // ─ kepano/obsidian-skills — vault editing primitives ────────────────
  { name: 'defuddle',                      patterns: [/\b(defuddle|extract (clean |readable )?content (from )?(a |the |that |this )?(web|url|page)|fetch (a |the |that |this )?url (and|to) (read|markdown)|article extract|reader mode (for|on)|strip nav (from )?(a |the )?(page|url))\b/i, /\bhttps?:\/\/\S+\b/i] },
  { name: 'json-canvas',                   patterns: [/\b(\.canvas|json[- ]canvas|obsidian canvas|canvas (file|node|edge|group)|mind ?map|flowchart in obsidian)\b/i] },
  { name: 'obsidian-bases',                patterns: [/\b(\.base|obsidian bases?|base file|database view (in |of )?(notes|vault|obsidian)|table view (in |of )?(my |our |the )?(notes|obsidian)|card view (in )?obsidian|formula (in |for )?(a )?base)\b/i] },
  { name: 'obsidian-cli',                  patterns: [/\b(obsidian[- ]?cli|obsidian command line|search (the |my )?vault|read (a |my )?(vault|obsidian) note|reload (the )?obsidian plugin|obsidian plugin (dev|develop|debug)|obsidian (theme|theme dev))\b/i] },
  { name: 'obsidian-markdown',             patterns: [/\b(obsidian (markdown|note|flavored markdown|frontmatter)|wikilinks?|\[\[[^\]]+\]\]|callouts?|embed (a )?(note|file) in obsidian|obsidian properties|obsidian tags?)\b/i, /\b(edit (a |my |this |the )?(note|md|markdown) (in |for )?obsidian|create (a |the )?(note|md) (in |for )?(obsidian|vault))\b/i] },
];

/** Build a regex from a literal trigger phrase (escape regex metachars and
 *  wrap in word boundaries when alphanumeric). */
function literalToTriggerRegex(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  // \b only works on word chars; for multi-word literal phrases like
  // "shadcn ui" it still bounds on first/last char which is fine.
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

/** Build trigger entries from each opendesign skill's frontmatter
 *  `triggers:` array, skipping any skill that already has a hand-authored
 *  pattern in SKILL_TRIGGERS. Cached after first computation. */
let _fmTriggers: Array<{ name: string; patterns: RegExp[] }> | null = null;
function getFrontmatterTriggers(): Array<{ name: string; patterns: RegExp[] }> {
  if (_fmTriggers) return _fmTriggers;
  const hand = new Set(SKILL_TRIGGERS.map(t => t.name));
  const out: Array<{ name: string; patterns: RegExp[] }> = [];
  for (const s of listAllSkills()) {
    if (s.source !== 'opendesign') continue;
    if (hand.has(s.name)) continue;
    if (!s.triggers || s.triggers.length === 0) continue;
    const patterns: RegExp[] = [];
    for (const t of s.triggers) {
      if (!t || t.length < 3) continue; // avoid 1-char regexes blowing up
      try { patterns.push(literalToTriggerRegex(t)); } catch { /* skip */ }
    }
    if (patterns.length) out.push({ name: s.name, patterns });
  }
  _fmTriggers = out;
  return out;
}

/** Match user text against trigger patterns; return matched skill names in
 *  priority order. Limit to `max` matches to keep the bundle small.
 *  Hand-authored patterns (SKILL_TRIGGERS) are checked first; if budget
 *  remains, opendesign frontmatter triggers fill in. */
export function matchSkillsForText(text: string, max = 4): string[] {
  if (!text || text.length < 8) return [];
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const { name, patterns } of SKILL_TRIGGERS) {
    if (matched.length >= max) break;
    if (patterns.some(p => p.test(text))) {
      if (!seen.has(name)) { matched.push(name); seen.add(name); }
    }
  }
  if (matched.length < max) {
    for (const { name, patterns } of getFrontmatterTriggers()) {
      if (matched.length >= max) break;
      if (seen.has(name)) continue;
      if (patterns.some(p => p.test(text))) {
        matched.push(name);
        seen.add(name);
      }
    }
  }
  return matched;
}

/** Load the full SKILL.md bodies for the named skills, concatenated with
 *  separators, capped at AUTO_SKILL_BUNDLE_MAX_CHARS total. Returns empty
 *  string if no skills matched or all skill files were missing. */
export function loadMatchedSkillsBundle(text: string): string {
  const names = matchSkillsForText(text);
  if (names.length === 0) return '';
  const all = listAllSkills();
  const byName = new Map(all.map(s => [s.name, s]));
  const parts: string[] = [];
  let total = 0;
  for (const name of names) {
    const meta = byName.get(name);
    if (!meta) continue;
    try {
      let body = fs.readFileSync(meta.file, 'utf-8').trim();
      // Truncate the body if it would push the bundle over budget. Better
      // a truncated skill than no skill — Claude can still read the front
      // half and call `mc_load_skill` for the full body if needed.
      if (body.length > MAX_SKILL_BODY_INLINE) {
        body = body.slice(0, MAX_SKILL_BODY_INLINE) + `\n\n_…[truncated — call \`mc_load_skill("${name}")\` for the full body]_`;
      }
      const block = `\n\n## Auto-loaded skill: ${name}\n\n_(Matched your message — follow this skill's instructions verbatim for this turn.)_\n\n${body}\n`;
      const remaining = AUTO_SKILL_BUNDLE_MAX_CHARS - total;
      if (remaining <= 600) break; // not enough room for a useful chunk
      if (block.length > remaining) {
        // Hard-truncate the block itself to fit the remaining budget.
        parts.push(block.slice(0, remaining - 100) + `\n_…[budget cap reached]_\n`);
        total = AUTO_SKILL_BUNDLE_MAX_CHARS;
        break;
      }
      parts.push(block);
      total += block.length;
    } catch { /* skip unreadable */ }
  }
  if (parts.length === 0) return '';
  return [
    '',
    '---',
    '## AUTO-LOADED SKILLS (matched your message — apply these workflows BEFORE responding)',
    '',
    `_${names.slice(0, parts.length).join(', ')} matched semantic triggers in your message. The full bodies are inlined below; follow them as if you ran \`mc_load_skill\` on each. Use these in addition to (not instead of) anything in the priority skills index above._`,
    ...parts,
    '',
    '---',
    '',
  ].join('\n');
}

export const SKILLS_TOOL_NAMES = [
  'mcp__mc-skills__mc_list_skills',
  'mcp__mc-skills__mc_load_skill',
];

let cachedServer: ReturnType<typeof createSdkMcpServer> | null = null;
export function createSkillsMcpServer() {
  if (cachedServer) return cachedServer;
  const t = <S extends z.ZodRawShape>(
    name: string,
    desc: string,
    schema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
  ) => tool(name, desc, schema, handler as any);

  const tools = [
    t(
      'mc_list_skills',
      'List every installed skill with its one-line description. Priority skills (Matt Pocock\'s engineering operating model) are listed first, marked [PRIORITY]. Use when you forgot a skill name or want to rediscover options.',
      {},
      async () => {
        const skills = listAllSkills();
        const prioritySet = new Set(PRIORITY_SKILL_NAMES);
        const priority = skills
          .filter(s => prioritySet.has(s.name))
          .sort((a, b) => PRIORITY_SKILL_NAMES.indexOf(a.name) - PRIORITY_SKILL_NAMES.indexOf(b.name));
        const other = skills.filter(s => !prioritySet.has(s.name));
        const lines: string[] = [];
        if (priority.length) {
          lines.push('## PRIORITY (Matt Pocock\'s engineering operating model)');
          for (const s of priority) lines.push(`- /${s.name} [PRIORITY] — ${s.description || '(no description)'}`);
        }
        if (other.length) {
          if (priority.length) lines.push('', '## Other');
          for (const s of other) lines.push(`- ${s.name} [${s.source}] — ${s.description || '(no description)'}`);
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') || 'No skills installed.' }] };
      },
    ),
    t(
      'mc_load_skill',
      'Return the full SKILL.md body for the named skill. Only the content after the frontmatter is returned. Fetch on demand — skills can be multiple KB each.',
      {
        name: z.string().min(1).describe('Exact skill name from the index (case-insensitive).'),
      },
      async ({ name }) => {
        const skills = listAllSkills();
        const hit = skills.find(s => s.name.toLowerCase() === name.toLowerCase());
        if (!hit) {
          return { content: [{ type: 'text' as const, text: `Unknown skill "${name}". Call mc_list_skills to see available options.` }] };
        }
        try {
          let content = fs.readFileSync(hit.file, 'utf-8');
          const fmEnd = content.indexOf('---', content.indexOf('---') + 3);
          if (fmEnd > 0) content = content.slice(fmEnd + 3).trim();
          return { content: [{ type: 'text' as const, text: `# Skill: ${hit.name}\n\n${content}` }] };
        } catch (e: any) {
          return { content: [{ type: 'text' as const, text: `Failed to read skill "${name}": ${e.message}` }] };
        }
      },
    ),
  ];

  cachedServer = createSdkMcpServer({ name: 'mc-skills', version: '1.0.0', tools });
  return cachedServer;
}
