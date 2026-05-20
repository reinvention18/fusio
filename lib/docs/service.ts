/**
 * mc-docs/service — local CRUD over data/docs/. Each doc is a markdown file
 * with YAML-ish frontmatter; the index.json keeps a fast-list manifest so the
 * UI doesn't have to read every file just to render the list.
 *
 * Two doc types: 'note' (free-form) and 'plan' (structured task plan).
 * Both are the same file shape — type lives in frontmatter.
 *
 * No automatic peer sync — peer access is via mc-docs MCP tools that use the
 * existing /api/docs endpoints + bearer auth from mc-remote-hosts.json.
 */

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { ensureVault, getVaultSettings } from '../vault/config';
import { scheduleCommit } from '../vault/git-sync';

export type DocType = 'note' | 'plan';

export interface DocFrontmatter {
  id: string;
  type: DocType;
  title: string;
  created: string;        // ISO
  updated: string;        // ISO
  authorHost?: string;    // e.g. 'linux' | 'pc' — set on write from mc-remote-hosts.json
  chatOrigin?: string;    // sessionKey of the chat that produced this doc
  tags?: string[];
}

export interface Doc extends DocFrontmatter {
  content: string;
}

export interface DocSummary {
  id: string;
  type: DocType;
  title: string;
  updated: string;
  authorHost?: string;
  tags?: string[];
  bytes: number;
}

const DOCS_DIR = path.join(process.cwd(), 'data', 'docs');
const INDEX_PATH = path.join(DOCS_DIR, 'index.json');

function ensureDir() {
  if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
}

// Mirror docs into the configured Obsidian vault so they're visible to the
// existing mc-vault tools, the memory-vault UI, and the user's Obsidian app.
// data/docs/ stays canonical (used by listDocs/index.json); the vault copy
// is a denormalized read-only-ish mirror under <vault>/plans/ and <vault>/notes/.
function vaultMirrorPath(type: DocType, id: string): string | null {
  try {
    const settings = getVaultSettings();
    if (!settings.enabled) return null;
    const root = ensureVault();
    const sub = type === 'plan' ? 'plans' : 'notes';
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${id}.md`);
  } catch {
    return null;
  }
}

function writeVaultMirror(doc: Doc) {
  const fp = vaultMirrorPath(doc.type, doc.id);
  if (!fp) return;
  try {
    fs.writeFileSync(fp, serialize(doc));
    // Debounced commit + push so the peer sees this update
    scheduleCommit(`update ${doc.type} "${doc.title}"`);
  } catch (e) {
    console.warn('[docs] vault mirror write failed:', (e as Error).message);
  }
}

function deleteVaultMirror(type: DocType, id: string) {
  const fp = vaultMirrorPath(type, id);
  if (!fp) return;
  try {
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
      scheduleCommit(`delete ${type} ${id}`);
    }
  } catch {}
}

function docPath(id: string) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error(`invalid doc id: ${id}`);
  return path.join(DOCS_DIR, `${id}.md`);
}

// Slug an arbitrary title to a stable id-friendly suffix
function slugTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

function todayPrefix(): string {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

// ─── Frontmatter codec ─────────────────────────────────────────────────
// Minimal YAML — enough for our flat key:value frontmatter, no nested objects.

function serialize(doc: Doc): string {
  const fm: Record<string, unknown> = {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    created: doc.created,
    updated: doc.updated,
  };
  if (doc.authorHost) fm.authorHost = doc.authorHost;
  if (doc.chatOrigin) fm.chatOrigin = doc.chatOrigin;
  if (doc.tags && doc.tags.length) fm.tags = doc.tags;

  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.map(s => JSON.stringify(s)).join(', ')}]`);
    else if (typeof v === 'string') lines.push(`${k}: ${JSON.stringify(v)}`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n\n' + doc.content;
}

function parse(raw: string): Doc {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) throw new Error('doc missing frontmatter');
  const fm: Record<string, any> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^(\w+):\s*(.*)$/);
    if (!mm) continue;
    const key = mm[1];
    const val = mm[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      try { fm[key] = JSON.parse(val); } catch { fm[key] = []; }
    } else if (val.startsWith('"') && val.endsWith('"')) {
      try { fm[key] = JSON.parse(val); } catch { fm[key] = val; }
    } else {
      fm[key] = val;
    }
  }
  return {
    id: fm.id,
    type: (fm.type === 'plan' ? 'plan' : 'note') as DocType,
    title: fm.title || '(untitled)',
    created: fm.created,
    updated: fm.updated,
    authorHost: fm.authorHost,
    chatOrigin: fm.chatOrigin,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    content: m[2].trimStart(),
  };
}

// ─── Index ──────────────────────────────────────────────────────────────

interface Index {
  version: 1;
  docs: DocSummary[];
}

function readIndex(): Index {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
  } catch {
    return { version: 1, docs: [] };
  }
}

function writeIndex(idx: Index) {
  ensureDir();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2));
}

function rebuildIndex(): Index {
  ensureDir();
  const idx: Index = { version: 1, docs: [] };
  for (const f of fs.readdirSync(DOCS_DIR)) {
    if (!f.endsWith('.md')) continue;
    try {
      const fp = path.join(DOCS_DIR, f);
      const raw = fs.readFileSync(fp, 'utf-8');
      const doc = parse(raw);
      idx.docs.push({
        id: doc.id,
        type: doc.type,
        title: doc.title,
        updated: doc.updated,
        authorHost: doc.authorHost,
        tags: doc.tags,
        bytes: fs.statSync(fp).size,
      });
    } catch (e) {
      console.warn('[docs] skipping malformed', f, (e as Error).message);
    }
  }
  idx.docs.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  writeIndex(idx);
  return idx;
}

// ─── Public API ─────────────────────────────────────────────────────────

export function listDocs(opts: { type?: DocType; limit?: number } = {}): DocSummary[] {
  let idx = readIndex();
  if (idx.docs.length === 0) idx = rebuildIndex();
  let docs = idx.docs;
  if (opts.type) docs = docs.filter(d => d.type === opts.type);
  if (opts.limit) docs = docs.slice(0, opts.limit);
  return docs;
}

export function readDoc(id: string): Doc | null {
  ensureDir();
  const fp = docPath(id);
  if (!fs.existsSync(fp)) return null;
  return parse(fs.readFileSync(fp, 'utf-8'));
}

export function writeDoc(input: {
  type: DocType;
  title: string;
  content: string;
  id?: string;
  tags?: string[];
  chatOrigin?: string;
  authorHost?: string;
}): Doc {
  ensureDir();
  const now = new Date().toISOString();
  let id = input.id;
  let created: string;
  if (id) {
    const existing = readDoc(id);
    created = existing?.created || now;
  } else {
    id = `${todayPrefix()}-${slugTitle(input.title)}`;
    // Ensure unique — if collision, append timestamp
    if (fs.existsSync(docPath(id))) {
      id = `${id}-${Date.now().toString(36).slice(-5)}`;
    }
    created = now;
  }
  const doc: Doc = {
    id,
    type: input.type,
    title: input.title,
    created,
    updated: now,
    authorHost: input.authorHost,
    chatOrigin: input.chatOrigin,
    tags: input.tags || [],
    content: input.content,
  };
  fs.writeFileSync(docPath(id), serialize(doc));
  // Mirror into the Obsidian vault — non-fatal on failure.
  writeVaultMirror(doc);
  // Update index
  const idx = readIndex();
  const existingIdx = idx.docs.findIndex(d => d.id === id);
  const summary: DocSummary = {
    id, type: doc.type, title: doc.title,
    updated: doc.updated, authorHost: doc.authorHost,
    tags: doc.tags, bytes: fs.statSync(docPath(id)).size,
  };
  if (existingIdx >= 0) idx.docs[existingIdx] = summary;
  else idx.docs.unshift(summary);
  idx.docs.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  writeIndex(idx);
  return doc;
}

export function deleteDoc(id: string): boolean {
  ensureDir();
  const fp = docPath(id);
  if (!fs.existsSync(fp)) return false;
  // Read type before delete so we can find the right vault mirror to remove.
  let type: DocType = 'note';
  try { type = parse(fs.readFileSync(fp, 'utf-8')).type; } catch {}
  fs.unlinkSync(fp);
  deleteVaultMirror(type, id);
  const idx = readIndex();
  idx.docs = idx.docs.filter(d => d.id !== id);
  writeIndex(idx);
  return true;
}

export function searchDocs(query: string, opts: { type?: DocType; limit?: number } = {}): DocSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = opts.limit ?? 30;
  const matches: { summary: DocSummary; score: number }[] = [];
  for (const summary of listDocs({ type: opts.type })) {
    let score = 0;
    if (summary.title.toLowerCase().includes(q)) score += 10;
    if ((summary.tags || []).some(t => t.toLowerCase().includes(q))) score += 5;
    // Body search — only read the file if title/tags didn't match
    if (score === 0) {
      try {
        const doc = readDoc(summary.id);
        if (doc && doc.content.toLowerCase().includes(q)) score = 1;
      } catch {}
    }
    if (score > 0) matches.push({ summary, score });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit).map(m => m.summary);
}
