/**
 * Missions — skill loader.
 *
 * Phase 8 (Bitter Lesson refactor): role behavior is driven by Markdown skill
 * files in `.claude/skills/missions/<role>.skill.md` instead of being baked
 * into runner.ts. When a model improves (Opus 4.8, Sonnet 4.7, GPT-6, an
 * open-weight challenger), upgrading the missions architecture is just
 * editing the skill files — no TypeScript changes.
 *
 * Per-mission custom skills live alongside the mission state at
 * `data/missions/<id>/skills/<name>.md`. The orchestrator can write these
 * inline ("for this mission, workers use React Aria, deploy via EAS") and
 * workers read them at spawn time.
 *
 * Loading is cached at module scope — skill files are read once per server
 * process, since they're authored content that changes only between
 * deployments. Per-mission skills are read fresh per call because the
 * orchestrator may add them mid-mission.
 */

import 'server-only';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type RoleId = 'orchestrator' | 'worker' | 'scrutiny' | 'user-testing';

const SKILLS_DIR = path.join(process.cwd(), '.claude', 'skills', 'missions');

const cache = new Map<RoleId, string>();

/** Load a role's skill text. Cached after first read; on cache miss we
 *  read the file and stash the contents. If the file is missing we return
 *  an empty string so callers can fall back to their hardcoded prompts —
 *  this keeps the migration safe even if a deploy somehow ships the code
 *  without the skills directory. */
export async function loadRoleSkill(role: RoleId): Promise<string> {
  const cached = cache.get(role);
  if (cached !== undefined) return cached;
  const filePath = path.join(SKILLS_DIR, `${role}.skill.md`);
  try {
    const body = await fs.readFile(filePath, 'utf8');
    cache.set(role, body);
    return body;
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      cache.set(role, '');
      return '';
    }
    throw err;
  }
}

/** Synchronous variant for the legacy prompt builders that aren't async.
 *  Reads from cache only — caller must have called loadRoleSkill at least
 *  once for the role. Returns empty string on cache miss. */
export function loadRoleSkillSync(role: RoleId): string {
  return cache.get(role) ?? '';
}

/** Warm the cache for all roles. Call once at server startup so the sync
 *  variant always has data. */
export async function warmRoleSkillCache(): Promise<void> {
  await Promise.all((['orchestrator', 'worker', 'scrutiny', 'user-testing'] as const).map(loadRoleSkill));
}

// ─── Per-mission custom skills ───────────────────────────────────────────

function missionSkillsDir(missionId: string): string {
  // Co-locate with persistence layer's mission directory so a mission
  // delete cascades to its skills naturally. We pick the same safeId
  // shape the persistence layer uses — see persistence.ts.
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(missionId)) {
    throw new Error(`mission id contains invalid characters: ${JSON.stringify(missionId.slice(0, 32))}`);
  }
  return path.join(process.cwd(), 'data', 'missions', missionId, 'skills');
}

/** Write a mission-specific skill. Idempotent — overwrite on duplicate name.
 *  The orchestrator calls this when it decides a worker for THIS mission
 *  needs extra context (library choices, deploy targets, conventions). */
export async function writeMissionSkill(missionId: string, name: string, content: string): Promise<void> {
  const safe = String(name).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64) || 'unnamed';
  const dir = missionSkillsDir(missionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${safe}.md`), content, 'utf8');
}

/** Read all of a mission's per-mission skill files. Returns content joined
 *  by file boundaries (`# <name>\n\n<content>`) so workers can paste this
 *  into their context as a single block. */
export async function loadMissionSkills(missionId: string): Promise<string> {
  const dir = missionSkillsDir(missionId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return '';
    throw err;
  }
  const mdFiles = entries.filter(e => e.endsWith('.md')).sort();
  if (mdFiles.length === 0) return '';
  const sections = await Promise.all(mdFiles.map(async (f) => {
    const body = await fs.readFile(path.join(dir, f), 'utf8');
    return `# Skill: ${f.replace(/\.md$/, '')}\n\n${body.trim()}`;
  }));
  return sections.join('\n\n---\n\n');
}

/** Compose a worker's full skill bundle: the worker role skill +
 *  any mission-specific skills the orchestrator wrote. This is what the
 *  worker prompt prepends to the per-attempt brief. */
export async function workerSkillBundle(missionId: string): Promise<string> {
  const role = await loadRoleSkill('worker');
  const mission = await loadMissionSkills(missionId);
  if (!role && !mission) return '';
  if (!mission) return role;
  if (!role) return mission;
  return `${role}\n\n---\n\n## Mission-specific skills\n\n${mission}`;
}

/** Compose a scrutiny validator's full skill bundle. Mirrors workerSkillBundle. */
export async function scrutinySkillBundle(missionId: string): Promise<string> {
  const role = await loadRoleSkill('scrutiny');
  const mission = await loadMissionSkills(missionId);
  if (!role && !mission) return '';
  if (!mission) return role;
  if (!role) return mission;
  return `${role}\n\n---\n\n## Mission-specific skills\n\n${mission}`;
}
