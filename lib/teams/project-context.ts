/**
 * Project Context Loader
 *
 * Automatically discovers and loads project context files from the workspace.
 * Looks for context in these locations (in order of priority):
 *
 *   1. {project}/docs/app-context-v2/  — code-first audit pack (final-audit-summary, system-overview, etc.)
 *   2. {project}/.context/             — generic context directory
 *   3. {project}/.cursor/context-engineering.md  — Cursor-style context
 *
 * The loader reads a curated set of files (not the entire directory) to stay
 * within prompt budget. Priority files are loaded first; if the budget is
 * exceeded, lower-priority files are truncated or dropped.
 *
 * Used by:
 *   - runner.ts → buildRoleSystemPrompt() for constellation agents
 *   - claude-chat-bridge.ts → buildPrompt() for chat sessions (future)
 */

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

const MAX_CONTEXT_CHARS = 80_000; // ~21K tokens — generous but bounded

// Files to load from docs/app-context-v2/, in priority order.
// High-priority files are always included; lower ones are dropped if over budget.
const APP_CONTEXT_V2_FILES = [
  // Tier 1: Always include — the minimum viable context
  { file: 'final-audit-summary.md', tier: 1 },
  { file: 'system-overview.md', tier: 1 },
  { file: 'reviewer-starter-checklist.md', tier: 1 },

  // Tier 2: Include if budget allows — architecture details
  { file: 'service-architecture.md', tier: 2 },
  { file: 'data-model-and-key-entities.md', tier: 2 },
  { file: 'auth-and-session-flow.md', tier: 2 },
  { file: 'tenant-isolation-and-permissions.md', tier: 2 },
  { file: 'navigation-and-screen-map.md', tier: 2 },

  // Tier 3: Include if still under budget — deep dives
  { file: 'financial-billing-and-portal-flows.md', tier: 3 },
  { file: 'edge-functions-and-api-surface.md', tier: 3 },
  { file: 'risk-hotspots-for-code-review.md', tier: 3 },
  { file: 'deployment-architecture.md', tier: 3 },
  { file: 'storage-files-and-photo-architecture.md', tier: 3 },
];

// Files to load from .context/ directory
const GENERIC_CONTEXT_FILES = [
  'README.md',
  'overview.md',
  'architecture.md',
  'context.md',
];

interface LoadedFile {
  name: string;
  content: string;
  chars: number;
}

function tryReadFile(filePath: string, maxChars: number): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.length > maxChars ? content.slice(0, maxChars) + '\n...[truncated]' : content;
  } catch {
    return null;
  }
}

export interface ProjectContext {
  source: string;           // which directory the context came from
  files: LoadedFile[];      // loaded files
  totalChars: number;       // total characters loaded
  formatted: string;        // ready-to-inject prompt block
}

/**
 * Load project context from the workspace directory.
 * Returns null if no context directory is found.
 */
export function loadProjectContext(projectId: string): ProjectContext | null {
  // Try app-context-v2 first (the rich audit pack)
  const v2Dir = path.join(projectId, 'docs', 'app-context-v2');
  if (fs.existsSync(v2Dir)) {
    return loadAppContextV2(v2Dir);
  }

  // Try .context/ directory
  const contextDir = path.join(projectId, '.context');
  if (fs.existsSync(contextDir)) {
    return loadGenericContext(contextDir);
  }

  // Try .cursor/context-engineering.md
  const cursorContext = path.join(projectId, '.cursor', 'context-engineering.md');
  const content = tryReadFile(cursorContext, MAX_CONTEXT_CHARS);
  if (content) {
    return {
      source: cursorContext,
      files: [{ name: 'context-engineering.md', content, chars: content.length }],
      totalChars: content.length,
      formatted: formatContextBlock([{ name: 'context-engineering.md', content, chars: content.length }], cursorContext),
    };
  }

  return null;
}

function loadAppContextV2(dir: string): ProjectContext {
  const files: LoadedFile[] = [];
  let totalChars = 0;

  for (const { file, tier } of APP_CONTEXT_V2_FILES) {
    if (totalChars >= MAX_CONTEXT_CHARS) break;

    const remaining = MAX_CONTEXT_CHARS - totalChars;
    // Tier 1 gets full budget per file, tier 2/3 get progressively less
    const maxPerFile = tier === 1 ? remaining : Math.min(remaining, Math.floor(MAX_CONTEXT_CHARS / (tier * 3)));

    const content = tryReadFile(path.join(dir, file), maxPerFile);
    if (content) {
      files.push({ name: file, content, chars: content.length });
      totalChars += content.length;
    }
  }

  return {
    source: dir,
    files,
    totalChars,
    formatted: formatContextBlock(files, dir),
  };
}

function loadGenericContext(dir: string): ProjectContext {
  const files: LoadedFile[] = [];
  let totalChars = 0;

  for (const file of GENERIC_CONTEXT_FILES) {
    if (totalChars >= MAX_CONTEXT_CHARS) break;
    const content = tryReadFile(path.join(dir, file), MAX_CONTEXT_CHARS - totalChars);
    if (content) {
      files.push({ name: file, content, chars: content.length });
      totalChars += content.length;
    }
  }

  // Also load any .md files not in the priority list, up to budget
  try {
    const allFiles = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !GENERIC_CONTEXT_FILES.includes(f));
    for (const file of allFiles.slice(0, 10)) {
      if (totalChars >= MAX_CONTEXT_CHARS) break;
      const content = tryReadFile(path.join(dir, file), MAX_CONTEXT_CHARS - totalChars);
      if (content) {
        files.push({ name: file, content, chars: content.length });
        totalChars += content.length;
      }
    }
  } catch { /* ignore */ }

  if (files.length === 0) return null as any;

  return {
    source: dir,
    files,
    totalChars,
    formatted: formatContextBlock(files, dir),
  };
}

function formatContextBlock(files: LoadedFile[], source: string): string {
  if (files.length === 0) return '';

  const parts: string[] = [];
  parts.push(`## Project Context (loaded from ${source})`);
  parts.push(`Loaded ${files.length} context files (${Math.round(files.reduce((a, f) => a + f.chars, 0) / 1024)}KB).\n`);

  for (const f of files) {
    parts.push(`### ${f.name}`);
    parts.push(f.content);
    parts.push('');
  }

  return parts.join('\n');
}
