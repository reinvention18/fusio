/**
 * Centralized list of repos that the chat-header "Pull Latest" button can sync.
 *
 * Each entry is a local directory + display label. We resolve relative to the
 * user's home so the same config works on Linux + Windows + Mac (Node's
 * `os.homedir()` returns the right path on each).
 *
 * Configuration:
 *   - Default: only this Fusio repo is registered (auto-detected via __dirname).
 *   - To add more, drop a JSON file at `data/managed-repos.json` with an
 *     array of `{ id, label, path, npmInstall? }` entries. The path can use
 *     `~` for home (it'll be expanded). The file is in .gitignore so your
 *     local repo list never gets committed.
 *
 * Example data/managed-repos.json:
 * [
 *   { "id": "my-app", "label": "My App", "path": "~/projects/my-app" },
 *   { "id": "docs",   "label": "Docs",   "path": "~/docs",  "npmInstall": false }
 * ]
 */

import 'server-only';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export interface ManagedRepo {
  id: string;
  label: string;
  path: string;
  /** if true, also runs `npm install` after pull when package.json changed */
  npmInstall?: boolean;
}

const HOME = os.homedir();

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') return path.join(HOME, p.slice(1));
  return p;
}

// Self-registration: the directory this file lives in is the Fusio repo.
// __dirname inside lib/git-pull/ → up two = repo root.
const SELF_PATH = path.resolve(__dirname, '..', '..');

const DEFAULT_REPOS: ManagedRepo[] = [
  {
    id: 'fusio',
    label: 'Fusio',
    path: SELF_PATH,
  },
];

function loadUserRepos(): ManagedRepo[] {
  // Load user-defined repo list from data/managed-repos.json if present.
  // Errors silently fall through to default-only list so a malformed file
  // doesn't break the chat header.
  const file = path.join(process.cwd(), 'data', 'managed-repos.json');
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r: any) => r && typeof r.id === 'string' && typeof r.label === 'string' && typeof r.path === 'string')
      .map((r: any) => ({
        id: r.id,
        label: r.label,
        path: expandTilde(r.path),
        npmInstall: !!r.npmInstall,
      }));
  } catch {
    return [];
  }
}

export function listManagedRepos(): ManagedRepo[] {
  const all = [...DEFAULT_REPOS, ...loadUserRepos()];
  // Filter to repos that exist and are git checkouts.
  return all.filter(r => {
    try {
      return fs.existsSync(path.join(r.path, '.git'));
    } catch { return false; }
  });
}

export function getRepo(id: string): ManagedRepo | undefined {
  const all = [...DEFAULT_REPOS, ...loadUserRepos()];
  return all.find(r => r.id === id);
}
