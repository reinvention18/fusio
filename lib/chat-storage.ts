/**
 * chat-storage — Per-chat file layout for mission-control sessions.
 *
 * Before: single `data/chat-sessions.json` (15 MB by the time Chat 11
 * hit 1,756 messages). Every save rewrote the whole file; every boot
 * parsed it in full; any tab race could clobber concurrent writes.
 *
 * After:
 *   data/chats/<id>.json       — full ChatSession, redacted
 *   data/chat-index.json       — array of lite sessions (sidebar hot path)
 *   data/chat-sessions.json    — retained read-only for compatibility
 *                                until every caller has migrated
 *
 * Preserves the safety contract of the old route: suspicious per-session
 * message drops are still detected; rolling backups still happen (now per
 * file); credential keyFacts still route through `secrets-store`.
 */

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import {
  redactForDisk,
  hydrateFromDisk,
  migrateSessionsInPlace,
  deleteSecrets,
} from './secrets-store';

const DATA_DIR = path.join(process.cwd(), 'data');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const INDEX_FILE = path.join(DATA_DIR, 'chat-index.json');
const LEGACY_FILE = path.join(DATA_DIR, 'chat-sessions.json');
const BACKUP_DIR = path.join(DATA_DIR, 'chat-sessions-backups');
const SPLIT_MARKER = path.join(DATA_DIR, '.chats-split');
const PENDING_DIR = path.join(DATA_DIR, 'pending');

/**
 * Purge every `data/pending/req-<chatId>-*.json` buffer for a given chat.
 * Called when the user explicitly modifies (delete, edit, save with fewer
 * messages) or deletes a chat — the stuck-turn recovery sweep would
 * otherwise re-append the buffered assistant content after 20 min, which
 * the user sees as "recovered" messages re-appearing after they delete
 * them. The user's explicit save is the source of truth; the pending
 * buffer is now stale and must be removed so recovery can't resurrect it.
 */
function purgePendingBuffersForChat(chatId: string): number {
  if (!chatId) return 0;
  let removed = 0;
  try {
    if (!fs.existsSync(PENDING_DIR)) return 0;
    const prefix = `req-${chatId}-`;
    for (const f of fs.readdirSync(PENDING_DIR)) {
      if (!f.startsWith(prefix)) continue;
      try { fs.unlinkSync(path.join(PENDING_DIR, f)); removed++; } catch { /* ignore */ }
    }
  } catch { /* dir read failed — nothing to do */ }
  return removed;
}

export const MAX_MESSAGE_DROP_SLACK = 2;

export interface ChatSession {
  id: string;
  name: string;
  sessionKey?: string;
  messages: any[];
  createdAt: string | Date;
  updatedAt: string | Date;
  workspace?: string;
  contextSnapshot?: string;
  contextSnapshotAt?: number;
  keyFacts?: any[];
  githubRepo?: any;
  [k: string]: any;
}

export interface LiteSession {
  id: string;
  name: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  workspace?: string;
  sessionKey?: string;
  contextSnapshot?: string;
  contextSnapshotAt?: number;
  keyFacts?: any[];
  githubRepo?: any;
  messageCount: number;
  lastMessagePreview: string | null;
}

function ensureDirs(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CHATS_DIR)) fs.mkdirSync(CHATS_DIR, { recursive: true });
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function chatPath(id: string): string {
  if (!/^[A-Za-z0-9_\-]+$/.test(id)) throw new Error(`invalid chat id: ${id}`);
  return path.join(CHATS_DIR, `${id}.json`);
}

function toLite(s: ChatSession): LiteSession {
  const msgs = s.messages || [];
  const last = msgs.length > 1 ? msgs[msgs.length - 1] : null;
  return {
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    workspace: s.workspace,
    sessionKey: s.sessionKey,
    contextSnapshot: s.contextSnapshot,
    contextSnapshotAt: s.contextSnapshotAt,
    keyFacts: s.keyFacts,
    githubRepo: s.githubRepo,
    messageCount: msgs.length,
    lastMessagePreview: last ? ((last.content || '') as string).slice(0, 60) : null,
  };
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function backupFile(file: string, reason: string, keepLast = 24): void {
  try {
    if (!fs.existsSync(file)) return;
    const base = path.basename(file).replace(/\.json$/, '');
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `${base}.${iso}.${reason}.json`);
    fs.copyFileSync(file, dest);
    const prefix = `${base}.`;
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keepLast)) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch { /* ignore */ }
    }
  } catch (e) {
    console.error('[chat-storage] backup failed:', e);
  }
}

// ─── Migration from legacy monolith ────────────────────────────────

let migrationRan = false;
function migrateFromMonolithOnce(): void {
  if (migrationRan) return;
  migrationRan = true;
  try {
    ensureDirs();
    if (fs.existsSync(SPLIT_MARKER)) return;
    if (!fs.existsSync(LEGACY_FILE)) {
      fs.writeFileSync(SPLIT_MARKER, new Date().toISOString());
      return;
    }
    const raw = fs.readFileSync(LEGACY_FILE, 'utf-8');
    const sessions: ChatSession[] = JSON.parse(raw);
    if (!Array.isArray(sessions)) {
      fs.writeFileSync(SPLIT_MARKER, new Date().toISOString());
      return;
    }
    // Apply secrets migration too — belt-and-suspenders; is a no-op if
    // /api/chats already ran it.
    migrateSessionsInPlace(sessions);
    let count = 0;
    const lite: LiteSession[] = [];
    for (const s of sessions) {
      if (!s || !s.id) continue;
      try {
        writeJsonAtomic(chatPath(s.id), s);
        lite.push(toLite(s));
        count++;
      } catch (e) {
        console.error(`[chat-storage] failed to split session ${s.id}:`, e);
      }
    }
    writeJsonAtomic(INDEX_FILE, lite);
    fs.writeFileSync(SPLIT_MARKER, new Date().toISOString());
    console.log(`[chat-storage] split ${count} sessions into per-chat files`);
  } catch (e) {
    console.error('[chat-storage] migration failed — falling back to legacy file:', e);
  }
}

// ─── Read helpers ──────────────────────────────────────────────────

export function loadIndex(): LiteSession[] {
  migrateFromMonolithOnce();
  if (!fs.existsSync(INDEX_FILE)) return rebuildIndex();
  try {
    const raw = fs.readFileSync(INDEX_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return rebuildIndex();
  }
}

export function loadChat(id: string): ChatSession | null {
  migrateFromMonolithOnce();
  const file = chatPath(id);
  if (!fs.existsSync(file)) {
    // Legacy fallback — session may still only exist in the monolith
    // if split failed for it. Not a hot path.
    try {
      if (fs.existsSync(LEGACY_FILE)) {
        const all = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf-8'));
        const hit = Array.isArray(all) ? all.find((s: any) => s.id === id) : null;
        if (hit) {
          hit.keyFacts = hydrateFromDisk(hit.id, hit.keyFacts);
          return hit;
        }
      }
    } catch { /* ignore */ }
    return null;
  }
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const session = JSON.parse(raw) as ChatSession;
    session.keyFacts = hydrateFromDisk(session.id, session.keyFacts);
    return session;
  } catch (e) {
    console.error(`[chat-storage] loadChat(${id}) failed:`, e);
    return null;
  }
}

export function loadAllChats(): ChatSession[] {
  migrateFromMonolithOnce();
  const index = loadIndex();
  const chats: ChatSession[] = [];
  for (const lite of index) {
    const chat = loadChat(lite.id);
    if (chat) chats.push(chat);
  }
  return chats;
}

function rebuildIndex(): LiteSession[] {
  ensureDirs();
  const lite: LiteSession[] = [];
  if (!fs.existsSync(CHATS_DIR)) return lite;
  for (const f of fs.readdirSync(CHATS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(CHATS_DIR, f), 'utf-8');
      const s = JSON.parse(raw) as ChatSession;
      if (s && s.id) lite.push(toLite(s));
    } catch { /* skip corrupt */ }
  }
  try { writeJsonAtomic(INDEX_FILE, lite); } catch { /* ignore */ }
  return lite;
}

// ─── Write helpers ─────────────────────────────────────────────────

export interface SaveResult {
  saved: boolean;
  reason?: string;
  blockedDrops?: Array<{ id: string; before: number; after: number }>;
}

export function saveChat(session: ChatSession, { force = false } = {}): SaveResult {
  migrateFromMonolithOnce();
  ensureDirs();
  if (!session?.id) return { saved: false, reason: 'missing id' };

  const file = chatPath(session.id);
  const existing = fs.existsSync(file) ? loadChat(session.id) : null;
  const drops: Array<{ id: string; before: number; after: number }> = [];

  // Detect explicit user-driven deletion (or edit) of messages within an
  // already-allowed range. When the new version has fewer messages than the
  // existing one, the user has explicitly removed something — clear any
  // pending buffers for this chat so the stuck-turn recovery sweep can't
  // resurrect deleted assistant content 20 minutes later.
  const before = existing ? (existing.messages || []).length : 0;
  const after = (session.messages || []).length;
  const messagesShrank = existing && before > after;

  if (!force && existing) {
    if (before - after > MAX_MESSAGE_DROP_SLACK) {
      drops.push({ id: session.id, before, after });
      backupFile(file, 'blocked-msg-drop', 48);
      const protectedCopy: ChatSession = { ...session, messages: existing.messages };
      const redacted = { ...protectedCopy, keyFacts: redactForDisk(session.id, protectedCopy.keyFacts) };
      writeJsonAtomic(file, redacted);
      updateIndexOne(protectedCopy);
      return { saved: true, reason: 'protected', blockedDrops: drops };
    }
  }

  const redacted = { ...session, keyFacts: redactForDisk(session.id, session.keyFacts) };
  if (existing) backupFile(file, 'routine', 12);
  writeJsonAtomic(file, redacted);
  updateIndexOne(session);

  // If the save shrank the message list, purge pending buffers so the
  // recovery sweep doesn't bring deleted assistant messages back later.
  if (messagesShrank) {
    const removed = purgePendingBuffersForChat(session.id);
    if (removed > 0) {
      console.log('[chat-storage] purged %d pending buffer(s) after deletion in chat=%s (%d → %d msgs)',
        removed, session.id, before, after);
    }
  }

  return { saved: true };
}

export function saveAllChats(sessions: ChatSession[], { force = false } = {}): SaveResult {
  migrateFromMonolithOnce();
  ensureDirs();

  const existingIndex = loadIndex();
  // Safety 1: reject save-all that would drastically reduce session COUNT.
  if (!force && existingIndex.length > 2 && sessions.length < existingIndex.length * 0.5) {
    console.warn(
      `[chat-storage] BLOCKED save-all: would reduce ${existingIndex.length}→${sessions.length} sessions`
    );
    return { saved: false, reason: `rejected: would reduce ${existingIndex.length} sessions to ${sessions.length}` };
  }

  // Safety 2: per-session drops. We save each chat individually through saveChat,
  // which already enforces the per-file drop guard. Collect any blocked reports.
  const allDrops: Array<{ id: string; before: number; after: number }> = [];
  for (const s of sessions) {
    const r = saveChat(s, { force });
    if (r.blockedDrops) allDrops.push(...r.blockedDrops);
  }

  return { saved: true, ...(allDrops.length > 0 ? { reason: 'protected', blockedDrops: allDrops } : {}) };
}

/**
 * Append a USER message to a chat file IF the most recent user message is not
 * already this same text. Server-side fallback for the case where the client
 * sends a message via /api/chat but doesn't get a chance to PUT /api/chats
 * before closing (mobile background, network drop, etc.).
 *
 * Without this, the server runs the agent, the agent answers, but the chat
 * file never sees the user prompt that started it — and the response looks
 * orphaned when the user reopens.
 *
 * Idempotent — checks the existing tail; no-op if the prompt is already there.
 * Also creates a minimal chat file if none exists yet.
 */
export function commitUserMessageIfMissing(opts: {
  chatId: string;
  content: string;
  sessionKey?: string;
  workspace?: string;
  attachments?: any[];
}): { appended: boolean; reason?: string } {
  if (!opts.chatId || !opts.content || opts.content.length < 1) {
    return { appended: false, reason: 'empty' };
  }

  let chat = loadChat(opts.chatId);
  // If this is the first turn and the client hasn't created the chat record
  // yet, materialize a minimal one so the user message has somewhere to land.
  if (!chat) {
    chat = {
      id: opts.chatId,
      name: `Chat (recovered ${new Date().toISOString().slice(0, 10)})`,
      sessionKey: opts.sessionKey,
      workspace: opts.workspace,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as ChatSession;
  }

  const msgs = chat.messages || [];

  // Walk backward — if the latest user message matches this content (first 200
  // chars), the client already saved it. No-op.
  const head = opts.content.slice(0, 200);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== 'user') continue;
    const existingText = typeof m.content === 'string' ? m.content : '';
    if (existingText.slice(0, 200) === head) {
      return { appended: false, reason: 'already present' };
    }
    // Stop at the first user message — older ones don't matter for dedup
    break;
  }

  const id = `mc-server-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const newMessage = {
    id,
    role: 'user',
    content: opts.content,
    timestamp: now,
    serverCommitted: true,
    ...(opts.attachments && opts.attachments.length ? { attachments: opts.attachments } : {}),
  };

  const updated: ChatSession = {
    ...chat,
    messages: [...msgs, newMessage],
    updatedAt: now,
  };
  const r = saveChat(updated, { force: true });
  if (!r.saved) return { appended: false, reason: r.reason || 'save failed' };
  return { appended: true };
}

/**
 * Append an assistant message to a chat file IF the most recent message is
 * NOT already this same assistant text. Used as a server-side fallback when
 * the client never came back to claim the streaming response (closed tab,
 * network drop, etc.) — keeps the persisted chat file in sync with what the
 * SDK actually said. Idempotent.
 *
 * Returns true if the message was appended, false if the chat already has
 * this content (or a near-identical assistant reply right after the latest
 * user message — meaning the client did commit normally).
 */
export function commitAssistantMessageIfMissing(opts: {
  chatId: string;
  content: string;
  messageId?: string;
  /** Optional: only append if this user-message timestamp is the latest user msg.
   *  Prevents stale background commits from clobbering newer user activity. */
  expectedLatestUserAt?: number;
}): { appended: boolean; reason?: string } {
  if (!opts.chatId || !opts.content || opts.content.length < 4) {
    return { appended: false, reason: 'empty content' };
  }
  const chat = loadChat(opts.chatId);
  if (!chat) return { appended: false, reason: 'chat not found' };

  const msgs = chat.messages || [];

  // Walk backward to find the last user + last assistant
  let lastUserIdx = -1;
  let lastAssistantAfterUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (lastAssistantAfterUserIdx === -1 && m?.role === 'assistant') lastAssistantAfterUserIdx = i;
    if (m?.role === 'user') { lastUserIdx = i; break; }
  }

  // No user message — never write blindly
  if (lastUserIdx === -1) return { appended: false, reason: 'no user message yet' };

  // If a newer user message has appeared since this turn started, skip.
  if (opts.expectedLatestUserAt) {
    const lu = msgs[lastUserIdx];
    const luTs = lu?.timestamp instanceof Date
      ? lu.timestamp.getTime()
      : new Date(lu?.timestamp || 0).getTime();
    if (luTs > opts.expectedLatestUserAt + 5_000) {
      return { appended: false, reason: 'newer user message since turn started' };
    }
  }

  // If there's already an assistant message AFTER the last user, the client
  // likely committed normally. Compare content to dedupe — if the existing
  // text starts with our content's first 120 chars (or vice versa, in case
  // the client trimmed), treat as duplicate.
  if (lastAssistantAfterUserIdx > lastUserIdx) {
    const existing = msgs[lastAssistantAfterUserIdx];
    const existingText = typeof existing?.content === 'string' ? existing.content : '';
    const head = opts.content.slice(0, 120);
    if (existingText.startsWith(head) || opts.content.startsWith(existingText.slice(0, 120))) {
      return { appended: false, reason: 'already committed by client' };
    }
    // The persisted assistant text differs — could be a partial commit or
    // a different turn entirely. Be conservative: don't double-write.
    return { appended: false, reason: 'different assistant text already present (partial commit?)' };
  }

  const id = opts.messageId
    || `mc-server-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const newMessage = {
    id,
    role: 'assistant',
    content: opts.content,
    timestamp: now,
    serverCommitted: true,
  };

  const updated: ChatSession = {
    ...chat,
    messages: [...msgs, newMessage],
    updatedAt: now,
  };
  const r = saveChat(updated, { force: true });
  if (!r.saved) return { appended: false, reason: r.reason || 'save failed' };
  return { appended: true };
}

export function deleteChat(id: string): void {
  migrateFromMonolithOnce();
  const file = chatPath(id);
  if (fs.existsSync(file)) {
    backupFile(file, 'pre-delete', 48);
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
  deleteSecrets(id);
  // Refresh index
  const index = loadIndex().filter(s => s.id !== id);
  writeJsonAtomic(INDEX_FILE, index);
  // Drop any pending buffers — they'd otherwise spawn a "Chat (recovered …)"
  // record via commitUserMessageIfMissing the next time the sweep runs.
  const removed = purgePendingBuffersForChat(id);
  if (removed > 0) {
    console.log('[chat-storage] purged %d pending buffer(s) on chat-delete chat=%s', removed, id);
  }
}

function updateIndexOne(session: ChatSession): void {
  const index = loadIndex();
  const pos = index.findIndex(s => s.id === session.id);
  const lite = toLite(session);
  if (pos >= 0) index[pos] = lite;
  else index.unshift(lite);
  try { writeJsonAtomic(INDEX_FILE, index); } catch (e) { console.error('[chat-storage] index write failed:', e); }
}

// ─── Version fingerprint for cross-device polling ─────────────────

export function getVersion(): number {
  migrateFromMonolithOnce();
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const st = fs.statSync(INDEX_FILE);
      return st.mtimeMs + st.size;
    }
  } catch { /* ignore */ }
  return 0;
}
