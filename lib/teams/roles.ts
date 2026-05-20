import 'server-only';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import type { TeamAgentRole } from './schema';

// Lightweight YAML frontmatter parser. Supports the subset needed for role
// files: strings, numbers, booleans, flat arrays (inline `[a,b,c]` or block
// `- item`). Sufficient for `.claude/agents/*.md` frontmatter.

export interface RoleFileFrontmatter {
  name: string;
  description: string;
  role?: TeamAgentRole;
  model?: 'opus' | 'sonnet' | 'haiku';
  tools?: string[];
  glyph?: string;
  writesCode?: boolean;
  color?: string;
  [key: string]: unknown;
}

export interface RoleDefinition {
  role: TeamAgentRole;
  file: string;                 // absolute path
  frontmatter: RoleFileFrontmatter;
  body: string;                 // system prompt markdown after frontmatter
}

// ─── YAML subset parser ──────────────────────────────────────────────────

function parseScalar(s: string): unknown {
  const t = s.trim();
  if (t === '') return '';
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  // inline array
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(x => parseScalar(x.replace(/^['"]|['"]$/g, '').trim()));
  }
  // quoted string
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseYamlFrontmatter(src: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!src.startsWith('---')) return { frontmatter: {}, body: src };
  const end = src.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: src };
  const head = src.slice(3, end).replace(/^\n/, '');
  const body = src.slice(end + 4).replace(/^\n/, '');

  const result: Record<string, unknown> = {};
  const lines = head.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const rest = m[2];
    if (rest.trim() === '') {
      // block array or object — try block array
      const items: unknown[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        const it = lines[j].replace(/^\s+-\s+/, '').trim();
        items.push(parseScalar(it.replace(/^['"]|['"]$/g, '')));
        j++;
      }
      result[key] = items;
      i = j;
    } else {
      result[key] = parseScalar(rest);
      i++;
    }
  }
  return { frontmatter: result, body };
}

// ─── Role discovery ──────────────────────────────────────────────────────

function projectAgentsDir(): string {
  // Looks in <cwd>/.claude/agents — this is Mission Control's own repo.
  return path.join(process.cwd(), '.claude', 'agents');
}

function userAgentsDir(): string {
  return path.join(process.env.HOME || '~', '.claude', 'agents');
}

export async function listRoles(): Promise<RoleDefinition[]> {
  const dirs = [projectAgentsDir(), userAgentsDir()];
  const seen = new Map<string, RoleDefinition>();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = await fsp.readdir(dir);
    for (const file of entries) {
      if (!file.endsWith('.md')) continue;
      const full = path.join(dir, file);
      try {
        const src = await fsp.readFile(full, 'utf-8');
        const { frontmatter, body } = parseYamlFrontmatter(src);
        const fm = frontmatter as RoleFileFrontmatter;
        const role: TeamAgentRole | undefined = (fm.role as TeamAgentRole | undefined)
          ?? (file.replace(/\.md$/, '') as TeamAgentRole);
        if (!role) continue;
        // Project scope overrides user scope (seen order)
        if (seen.has(role)) continue;
        seen.set(role, {
          role,
          file: full,
          frontmatter: { ...fm, name: fm.name ?? role, description: fm.description ?? '' },
          body: body.trim(),
        });
      } catch (e) {
        console.warn(`[roles] failed to read ${full}:`, (e as Error).message);
      }
    }
  }
  return [...seen.values()];
}

export async function getRole(name: TeamAgentRole): Promise<RoleDefinition | null> {
  const all = await listRoles();
  return all.find(r => r.role === name) ?? null;
}

/** Compute allowed tool list for a role. Uses frontmatter.tools or a safe default. */
export function resolveAllowedTools(role: RoleDefinition, extraTools: string[] = []): string[] {
  const baseDefaults: Record<TeamAgentRole, string[]> = {
    commander: ['Read', 'Grep', 'Glob', 'Bash', 'TodoWrite', 'WebFetch'],
    architect: ['Read', 'Grep', 'Glob', 'WebFetch'],
    builder: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'WebFetch', 'TodoWrite'],
    inspector: ['Read', 'Grep', 'Glob', 'Bash'],
    sentinel: ['Bash', 'Read', 'Grep', 'Glob'],
    scout: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
    scribe: ['Read', 'Grep', 'Glob'],
    navigator: ['Read', 'Edit', 'Bash', 'Grep', 'Glob'],
    security: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch'],
    dba: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch'],
    tester: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    perfanalyst: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch'],
    uxreviewer: ['Read', 'Grep', 'Glob', 'WebFetch'],
    deployer: ['Bash', 'Read', 'Grep', 'Glob'],
    apidesigner: ['Read', 'Grep', 'Glob', 'WebFetch', 'Write'],
    refactorer: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
  };
  const fromFile = role.frontmatter.tools;
  const base = Array.isArray(fromFile) && fromFile.length > 0 ? fromFile : baseDefaults[role.role];
  return Array.from(new Set([...base, ...extraTools]));
}

export function modelFromTier(
  tier: 'opus' | 'sonnet' | 'haiku' | undefined,
  role?: TeamAgentRole,
): string {
  // Keep in sync with lib/teams/cost.ts rate table.
  switch (tier) {
    case 'opus':
      // Architect needs the 1M context window — it ingests scratchpad from
      // every prior agent plus chat context plus project docs. Other opus
      // roles get the standard 200K variant.
      return role === 'architect' ? 'claude-opus-4-7[1m]' : 'claude-opus-4-7';
    case 'haiku': return 'claude-haiku-4-5';
    case 'sonnet':
    default: return 'claude-sonnet-4-6';
  }
}
