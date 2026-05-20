/**
 * vault/service — filesystem operations scoped inside the Obsidian vault.
 *
 * Hardened against path traversal. No binary reads; markdown-focused.
 * Ripgrep-backed search if available, naive fs scan otherwise.
 */

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ensureVault,
  getVaultSettings,
  resolveInVault,
  vaultExists,
} from './config';
import { parseFrontmatter, withFrontmatter, noteSlug, type Frontmatter } from './obsidian-md';

export interface NoteSummary {
  path: string;            // relative to vault root, POSIX
  title: string;
  tags: string[];
  mtime: number;
  size: number;
}

export interface NoteFull {
  path: string;
  title: string;
  frontmatter: Frontmatter;
  body: string;
  raw: string;
  mtime: number;
  size: number;
}

export interface VaultSearchHit {
  path: string;
  title: string;
  line: number;
  preview: string;
}

function toRel(absPath: string): string {
  const root = path.resolve(ensureVault());
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  return rel;
}

function walkMd(rootDir: string, out: string[] = [], cap = 5000): string[] {
  if (out.length >= cap) return out;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(rootDir, e.name);
    if (e.isDirectory()) walkMd(full, out, cap);
    else if (e.isFile() && /\.md$/i.test(e.name)) {
      out.push(full);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

export function isConfigured(): boolean {
  return vaultExists() || getVaultSettings().createIfMissing;
}

export function vaultRoot(): string {
  return ensureVault();
}

export function listNotes(params?: { limit?: number; prefix?: string }): NoteSummary[] {
  const root = ensureVault();
  const files = walkMd(root, []);
  const filtered = params?.prefix
    ? files.filter(f => toRel(f).startsWith(params.prefix!))
    : files;
  const lim = Math.min(Math.max(params?.limit ?? 200, 1), 5000);
  return filtered.slice(0, lim).map(f => {
    const stat = fs.statSync(f);
    let title = path.basename(f, '.md');
    let tags: string[] = [];
    try {
      const raw = fs.readFileSync(f, 'utf-8');
      const { fm } = parseFrontmatter(raw);
      if (typeof fm.title === 'string' && fm.title.trim()) title = fm.title as string;
      if (Array.isArray(fm.tags)) tags = (fm.tags as unknown[]).filter(x => typeof x === 'string') as string[];
    } catch {}
    return {
      path: toRel(f),
      title,
      tags,
      mtime: stat.mtimeMs,
      size: stat.size,
    } satisfies NoteSummary;
  }).sort((a, b) => b.mtime - a.mtime);
}

export function readNote(relativePath: string): NoteFull {
  const abs = resolveInVault(relativePath.endsWith('.md') ? relativePath : `${relativePath}.md`);
  const raw = fs.readFileSync(abs, 'utf-8');
  const stat = fs.statSync(abs);
  const { fm, body } = parseFrontmatter(raw);
  let title = typeof fm.title === 'string' ? (fm.title as string) : path.basename(abs, '.md');
  return {
    path: toRel(abs),
    title,
    frontmatter: fm,
    body,
    raw,
    mtime: stat.mtimeMs,
    size: stat.size,
  };
}

export function writeNote(params: {
  path: string;
  content: string;
  frontmatter?: Frontmatter;
  overwrite?: boolean;
}): NoteFull {
  let rel = params.path.endsWith('.md') ? params.path : `${params.path}.md`;
  // If the path is just a name with no directory, place it under inbox/
  // (Karpathy wiki convention — captures land in inbox/ for triage).
  if (!rel.includes('/')) {
    rel = `inbox/${noteSlug(rel.replace(/\.md$/i, ''))}.md`;
  }
  const abs = resolveInVault(rel);
  if (fs.existsSync(abs) && !params.overwrite) {
    const { dir, name, ext } = path.parse(abs);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const alt = path.join(dir, `${name}-${stamp}${ext}`);
    return writeNote({ ...params, path: toRel(alt), overwrite: true });
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const withFm = params.frontmatter
    ? withFrontmatter(params.frontmatter, params.content)
    : params.content;
  fs.writeFileSync(abs, withFm, 'utf-8');
  // Sync to peers — debounced commit + push if the vault is a git repo.
  // Lazy-import to avoid a circular dep through git-sync → vault/config.
  try {
    const { scheduleCommit } = require('./git-sync');
    scheduleCommit(`vault write ${rel}`);
  } catch {}
  return readNote(toRel(abs));
}

export function deleteNote(relativePath: string): void {
  const abs = resolveInVault(relativePath.endsWith('.md') ? relativePath : `${relativePath}.md`);
  if (fs.existsSync(abs)) {
    fs.unlinkSync(abs);
    try {
      const { scheduleCommit } = require('./git-sync');
      scheduleCommit(`vault delete ${relativePath}`);
    } catch {}
  }
}

function ripgrepAvailable(): boolean {
  try { return spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
}

export function searchVault(query: string, opts?: { limit?: number }): VaultSearchHit[] {
  const root = ensureVault();
  const lim = Math.min(Math.max(opts?.limit ?? 30, 1), 200);
  if (!query?.trim()) return [];

  if (ripgrepAvailable()) {
    const res = spawnSync('rg', [
      '--no-config',
      '--no-heading',
      '--with-filename',
      '--line-number',
      '--max-count', '3',
      '--glob', '*.md',
      '-i',
      query,
      root,
    ], { encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 });
    if (res.status === 0 || res.status === 1) {
      const hits: VaultSearchHit[] = [];
      for (const line of res.stdout.split('\n')) {
        if (!line) continue;
        const m = line.match(/^(.+?):(\d+):(.*)$/);
        if (!m) continue;
        const absPath = m[1];
        const hitPath = toRel(absPath);
        const hitLine = Number(m[2]);
        const preview = m[3].slice(0, 240);
        hits.push({
          path: hitPath,
          title: path.basename(hitPath, '.md'),
          line: hitLine,
          preview,
        });
        if (hits.length >= lim) break;
      }
      return hits;
    }
  }

  // Fallback scan
  const files = walkMd(root, []);
  const needle = query.toLowerCase();
  const hits: VaultSearchHit[] = [];
  for (const abs of files) {
    try {
      const content = fs.readFileSync(abs, 'utf-8');
      const lower = content.toLowerCase();
      const idx = lower.indexOf(needle);
      if (idx < 0) continue;
      const before = content.slice(0, idx);
      const line = before.split('\n').length;
      const start = Math.max(0, idx - 60);
      const end = Math.min(content.length, idx + 180);
      hits.push({
        path: toRel(abs),
        title: path.basename(abs, '.md'),
        line,
        preview: content.slice(start, end).replace(/\s+/g, ' '),
      });
      if (hits.length >= lim) break;
    } catch {}
  }
  return hits;
}

/** Build a short context block of vault hits suitable for splicing into a prompt. */
export function formatVaultHits(hits: VaultSearchHit[], maxTokens = 2500): string {
  if (hits.length === 0) return '';
  const lines: string[] = ['<vault_context>'];
  lines.push('  <note>Excerpts from the user\'s Obsidian vault. Use the vault_read tool to fetch full notes.</note>');
  let used = 0;
  for (const h of hits) {
    const entry = `  <note path="${escapeAttr(h.path)}" line="${h.line}"><title>${escapeXml(h.title)}</title><preview>${escapeXml(h.preview)}</preview></note>`;
    used += Math.ceil(entry.length / 3.8);
    if (used > maxTokens) break;
    lines.push(entry);
  }
  lines.push('</vault_context>');
  return lines.join('\n');
}

function escapeXml(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;');
}
