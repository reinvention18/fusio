/**
 * agents-mcp — expose subagent personas from ruvnet/ruflo + everything-claude-
 * code as MCP tools the MC chat agent can spawn via the Task tool.
 *
 * Discoverable as:
 *   mc_list_agents(category?)  — compact index of available personas
 *   mc_load_agent(name)        — full persona body for Task-tool spawning
 *
 * Sources:
 *   ~/ruflo/.claude/agents/                  — 108 agents (recursive, mix of
 *                                              top-level .md + 25 subdirs)
 *   ~/everything-claude-code/agents/         — 60 agents (flat .md files)
 *
 * Each .md file uses the standard Claude Code agent frontmatter:
 *   ---
 *   name: agent-name
 *   description: When to use this agent
 *   tools: ["Read", "Grep", ...]    (optional)
 *   model: opus | sonnet             (optional)
 *   ---
 *   <persona body — used directly as the Task tool's prompt>
 */

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const RUFLO_AGENTS_DIR = path.join(os.homedir(), 'ruflo', '.claude', 'agents');
const ECC_AGENTS_DIR = path.join(os.homedir(), 'everything-claude-code', 'agents');

interface AgentMeta {
  name: string;
  description: string;
  category: string;
  file: string;
  source: 'ruflo' | 'ecc';
  tools?: string[];
  model?: string;
}

function parseFrontmatter(content: string): { name?: string; description?: string; tools?: string[]; model?: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, any> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v: any = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      try { v = JSON.parse(v); } catch { /* fall through */ }
    } else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[kv[1]] = v;
  }
  return out;
}

/** Walk a directory recursively collecting .md agent files. Skips obvious
 *  non-agent files (README, MIGRATION_SUMMARY, etc.). Category is the
 *  immediate parent dir name when nested; 'general' for top-level files. */
function readAgentsRecursive(rootDir: string, source: 'ruflo' | 'ecc'): AgentMeta[] {
  if (!fs.existsSync(rootDir)) return [];
  const out: AgentMeta[] = [];
  const walk = (dir: string, category: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, e.name);
        continue;
      }
      if (!e.name.endsWith('.md')) continue;
      // Skip docs that aren't agents (case-insensitive)
      const lower = e.name.toLowerCase();
      if (lower === 'readme.md' || lower === 'migration_summary.md' || lower === 'agents.md' || lower === 'claude.md') continue;
      try {
        const body = fs.readFileSync(full, 'utf-8');
        const fm = parseFrontmatter(body);
        if (!fm.name && !fm.description) continue; // not an agent file
        out.push({
          name: fm.name || e.name.replace(/\.md$/, ''),
          description: fm.description || '',
          category,
          file: full,
          source,
          tools: Array.isArray(fm.tools) ? fm.tools : undefined,
          model: typeof fm.model === 'string' ? fm.model : undefined,
        });
      } catch { /* skip unreadable */ }
    }
  };
  walk(rootDir, 'general');
  return out;
}

let agentCache: { ts: number; agents: AgentMeta[] } | null = null;
const AGENT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

/** Catalog for prompt-enhancer use cases. Name + full description + source + category. */
export function getAgentsCatalog(): Array<{ name: string; description: string; source: string; category: string }> {
  return listAllAgents().map(a => ({
    name: a.name,
    description: (a.description || '').replace(/\s+/g, ' '),
    source: a.source,
    category: a.category,
  }));
}

function listAllAgents(): AgentMeta[] {
  const now = Date.now();
  if (agentCache && now - agentCache.ts < AGENT_CACHE_TTL_MS) return agentCache.agents;
  // ruflo first so it wins name collisions (it has more specialized variants).
  const ruflo = readAgentsRecursive(RUFLO_AGENTS_DIR, 'ruflo');
  const ecc = readAgentsRecursive(ECC_AGENTS_DIR, 'ecc');
  const taken = new Set<string>(ruflo.map(a => a.name.toLowerCase()));
  const eccUnique = ecc.filter(a => !taken.has(a.name.toLowerCase()));
  const all = [...ruflo, ...eccUnique].sort((a, b) => a.name.localeCompare(b.name));
  agentCache = { ts: now, agents: all };
  return all;
}

// ─── System-prompt index ────────────────────────────────────────────────

/** Marquee agents — the ones we surface prominently in the system prompt
 *  with a "common use cases" mapping. Curated from the highest-leverage
 *  personas across both repos. */
const MARQUEE_AGENTS = [
  // architecture + planning
  'architect', 'code-architect', 'system-architect',
  // review + quality
  'code-reviewer', 'security-auditor', 'a11y-architect', 'database-reviewer',
  // ruflo specialized
  'project-coordinator', 'typescript-specialist', 'python-specialist', 'database-specialist',
  // debugging + ops
  'build-error-resolver', 'code-explorer', 'code-simplifier',
  // SPARC (ruflo's signature methodology)
  'sparc-coordinator', 'researcher', 'planner', 'coder', 'tester', 'reviewer',
  // testing
  'e2e-runner', 'tester',
];

/** Compact index appended to MC chat's system prompt. Tells the main
 *  Claude agent WHAT subagents exist + HOW to invoke them via the Task
 *  tool. Compact: one line per agent. Full bodies stay on disk and load
 *  on demand via mc_load_agent. */
export function loadAgentsIndex(): string {
  const all = listAllAgents();
  if (all.length === 0) return '';

  // Group by source for clean rendering, marquee agents first.
  const marqueeSet = new Set(MARQUEE_AGENTS);
  const marquee = all.filter(a => marqueeSet.has(a.name));
  const byCat = new Map<string, AgentMeta[]>();
  for (const a of all) {
    if (marqueeSet.has(a.name)) continue;
    const k = `${a.source}:${a.category}`;
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k)!.push(a);
  }

  const fmtAgent = (a: AgentMeta) => {
    const desc = (a.description || '').replace(/\s+/g, ' ').slice(0, 110);
    const tag = a.model ? ` _(${a.model})_` : '';
    return `- \`@${a.name}\`${tag} — ${desc}`;
  };

  const lines: string[] = [
    '',
    '## SUBAGENT PERSONAS — 168 specialists you can spawn via Task tool',
    '',
    '**How to use:**',
    '1. When the user\'s request needs a specialist\'s lens (security review, architecture, perf analysis, etc.), spawn that agent via the Task tool.',
    '2. Pull the persona body first: call `mc_load_agent("<name>")`. The returned text IS the agent\'s system prompt — use it as the `prompt` parameter for `Task`.',
    '3. The agent runs in isolation; you receive its final report and integrate it into your reply.',
    '4. Spawn multiple agents in parallel for independent perspectives (e.g. `security-auditor` + `code-reviewer` on the same diff).',
    '',
    '**Choosing the right one:**',
    '- Security review → `@security-auditor`',
    '- Architecture / scalability → `@architect` or `@code-architect`',
    '- Code review of a diff → `@code-reviewer`',
    '- A11y / accessibility → `@a11y-architect`',
    '- TypeScript heavy work → `@typescript-specialist`',
    '- Python heavy work → `@python-specialist`',
    '- DB schema / migration → `@database-specialist` or `@database-reviewer`',
    '- Multi-step coordination → `@project-coordinator` or `@sparc-coordinator`',
    '- Build / compile error → `@build-error-resolver`',
    '- Code exploration / understanding → `@code-explorer`',
    '- Refactoring for simplicity → `@code-simplifier`',
    '- E2E test run + analysis → `@e2e-runner`',
    '',
    '**Marquee agents (load on demand via `mc_load_agent`):**',
    '',
  ];

  // Marquee: render in fixed order regardless of alpha
  const marqueeByName = new Map(marquee.map(a => [a.name, a]));
  for (const n of MARQUEE_AGENTS) {
    const a = marqueeByName.get(n);
    if (a) lines.push(fmtAgent(a));
  }

  lines.push('', '**By category (sample — full list via `mc_list_agents("<category>")`):**', '');
  const sortedKeys = [...byCat.keys()].sort();
  for (const k of sortedKeys) {
    const items = byCat.get(k)!;
    if (items.length === 0) continue;
    const [src, cat] = k.split(':');
    lines.push(`*${src}/${cat}* — ${items.slice(0, 6).map(a => '`@' + a.name + '`').join(' · ')}${items.length > 6 ? ` _(+${items.length - 6} more)_` : ''}`);
  }
  lines.push(
    '',
    '**Rule of thumb:** spawn an agent when the request is specialist-shaped (security, architecture, perf, db). For general work, just answer directly — agents are heavy, only use when the persona\'s expertise meaningfully improves the answer.',
    '',
  );
  return lines.join('\n');
}

// ─── Auto-trigger router ────────────────────────────────────────────────

/** Pattern map for agents that should auto-load when the user's message
 *  matches. Mirrors the skills auto-trigger system — these are SUGGESTIONS
 *  for the main agent; final spawn decision is still its judgment. */
const AGENT_TRIGGERS: Array<{ name: string; patterns: RegExp[] }> = [
  { name: 'security-auditor',      patterns: [/\b(security (review|audit)|owasp|injection|xss|csrf|leak (credentials|secrets|api keys?)|threat model|attack surface|hardening)\b/i] },
  { name: 'architect',             patterns: [/\b(architect (this|the|a |an |new |some )|architectural design|system design|scalability|technical decision|design (a |an |the )?system|design (a |an |the )?(architecture|topology)|new feature.{0,30}(scalable|architecture))\b/i] },
  { name: 'code-reviewer',         patterns: [/\b(review (this |my )?(code|diff|pr|patch)|code review|review my implementation)\b/i] },
  { name: 'a11y-architect',        patterns: [/\b(a11y|accessibility|wcag|aria|screen reader|keyboard navigation)\b/i] },
  { name: 'typescript-specialist', patterns: [/\b(typescript|ts type|tsc|narrow .{0,20}type|generic .{0,20}constraint|tsconfig)\b/i] },
  { name: 'python-specialist',     patterns: [/\b(python|pip|poetry|virtualenv|django|fastapi|pytest|asyncio|mypy|ruff)\b/i] },
  { name: 'database-specialist',   patterns: [/\b(schema design|database design|database schema|design (the |a )?(schema|db schema|database schema)|index strategy|query plan|postgres tuning|migration strategy)\b/i] },
  { name: 'database-reviewer',     patterns: [/\b(review (this |the )?(schema|migration|query)|db review|sql review)\b/i] },
  { name: 'project-coordinator',   patterns: [/\b(coordinate .{0,20}(work|tasks|agents)|project plan|orchestrate (work|tasks))\b/i] },
  { name: 'build-error-resolver',  patterns: [/\b(build (error|failure|broken)|compile error|cargo build|webpack error|vite build|gradle build)\b/i] },
  { name: 'code-explorer',         patterns: [/\b(explore (the |this )?(codebase|repo)|find where|understand .{0,20}(this code|the codebase)|how does .{0,20}work)\b/i] },
  { name: 'code-simplifier',       patterns: [/\b(simplify (this|the|that|my)|simplify .{0,30}(code|function|method|class)|cleanup (this|the)|reduce complexity|too complex|refactor for simplicity)\b/i] },
  { name: 'e2e-runner',            patterns: [/\b(run (the )?e2e|e2e (test|run)|end to end test|playwright run|cypress run)\b/i] },
  { name: 'researcher',            patterns: [/\b(research (this|how|what|whether)|investigate (whether|how|the best way)|look into how)\b/i] },
];

/** Match user text against agent triggers; return matched agent names. */
export function matchAgentsForText(text: string, max = 3): string[] {
  if (!text || text.length < 8) return [];
  const all = listAllAgents();
  const byName = new Map(all.map(a => [a.name, a]));
  const matched: string[] = [];
  for (const { name, patterns } of AGENT_TRIGGERS) {
    if (matched.length >= max) break;
    if (!byName.has(name)) continue; // only suggest agents that actually exist
    if (patterns.some(p => p.test(text))) matched.push(name);
  }
  return matched;
}

const AUTO_AGENT_BUNDLE_MAX_CHARS = 8000;
const MAX_AGENT_BODY_INLINE = 3500;

/** Load the full body of matched agents (frontmatter + persona), capped.
 *  Returned text is prepended to the prompt at the end so the main agent
 *  has the persona ready to hand to the Task tool. Truncates any single
 *  oversized persona instead of dropping the bundle to empty. */
export function loadMatchedAgentsBundle(text: string): string {
  const names = matchAgentsForText(text);
  if (names.length === 0) return '';
  const all = listAllAgents();
  const byName = new Map(all.map(a => [a.name, a]));
  const parts: string[] = [];
  let total = 0;
  for (const name of names) {
    const meta = byName.get(name);
    if (!meta) continue;
    try {
      let body = fs.readFileSync(meta.file, 'utf-8').trim();
      if (body.length > MAX_AGENT_BODY_INLINE) {
        body = body.slice(0, MAX_AGENT_BODY_INLINE) + `\n\n_…[truncated — call \`mc_load_agent("${name}")\` for the full persona]_`;
      }
      const block = `\n\n### Auto-loaded agent persona: @${name} (${meta.source}/${meta.category})\n\n_(Matched your message. If you decide to use this specialist, spawn them via the Task tool with the body below as the prompt parameter.)_\n\n\`\`\`md\n${body}\n\`\`\`\n`;
      const remaining = AUTO_AGENT_BUNDLE_MAX_CHARS - total;
      if (remaining <= 500) break;
      if (block.length > remaining) {
        parts.push(block.slice(0, remaining - 80) + `\n_…[budget cap reached]_\n`);
        total = AUTO_AGENT_BUNDLE_MAX_CHARS;
        break;
      }
      parts.push(block);
      total += block.length;
    } catch { /* skip */ }
  }
  if (parts.length === 0) return '';
  return [
    '',
    '---',
    '## AUTO-MATCHED AGENT PERSONAS',
    '',
    `_${names.slice(0, parts.length).join(', ')} matched your message. Consider spawning one or more via the Task tool. Persona bodies inlined below._`,
    ...parts,
    '---',
    '',
  ].join('\n');
}

// ─── MCP tools ──────────────────────────────────────────────────────────

export const AGENTS_TOOL_NAMES = [
  'mcp__mc-agents__mc_list_agents',
  'mcp__mc-agents__mc_load_agent',
];

export function createAgentsMcpServer() {
  return createSdkMcpServer({
    name: 'mc-agents',
    version: '1.0.0',
    tools: [
      tool(
        'mc_list_agents',
        'List available subagent personas (from ruvnet/ruflo + affaan-m/everything-claude-code). Optional filter by category name (e.g. "github", "sparc", "hive-mind").',
        { category: z.string().optional() },
        async (input) => {
          const all = listAllAgents();
          const filtered = input?.category
            ? all.filter(a => a.category.toLowerCase().includes((input.category as string).toLowerCase()))
            : all;
          const lines = filtered.map(a => `- ${a.source}/${a.category}/${a.name}${a.model ? ` (${a.model})` : ''}: ${a.description.slice(0, 120)}`);
          return {
            content: [{ type: 'text', text: `${filtered.length} agents${input?.category ? ` matching "${input.category}"` : ''}:\n\n${lines.join('\n')}` }],
          };
        },
      ),
      tool(
        'mc_load_agent',
        'Load the full persona body for a subagent. The returned text is the agent\'s system prompt — pass it as the `prompt` parameter to the Task tool to spawn that specialist.',
        { name: z.string() },
        async (input) => {
          const all = listAllAgents();
          const meta = all.find(a => a.name === input.name);
          if (!meta) {
            const candidates = all.filter(a => a.name.includes(input.name)).slice(0, 5).map(a => a.name);
            return {
              content: [{ type: 'text', text: `Agent "${input.name}" not found. ${candidates.length > 0 ? `Did you mean: ${candidates.join(', ')}?` : 'Use mc_list_agents() to see available agents.'}` }],
              isError: true,
            };
          }
          try {
            const body = fs.readFileSync(meta.file, 'utf-8');
            return {
              content: [{ type: 'text', text: `# Agent: ${meta.name}\n_(source: ${meta.source}/${meta.category})_\n\n${body}` }],
            };
          } catch (err: any) {
            return {
              content: [{ type: 'text', text: `Failed to read agent file: ${err.message}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
