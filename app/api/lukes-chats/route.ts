import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');
const CHATS_FILE = join(DATA_DIR, 'lukes-chat-sessions.json');
const CHATS_BACKUP = join(DATA_DIR, 'lukes-chat-sessions.backup.json');
const BACKUP_DIR = join(DATA_DIR, 'lukes-chat-sessions-backups');

// Maximum messages we'll allow a single save to drop from an existing session.
// Anything larger than this is considered suspect and routed to a backup file.
// Small slack (2) covers legitimate dedupes and trailing system-message cleanup.
const MAX_MESSAGE_DROP_SLACK = 2;

// Lightweight version tracking — changes on every write
function getFileVersion(): number {
  try {
    if (!existsSync(CHATS_FILE)) return 0;
    const stat = statSync(CHATS_FILE);
    // Use mtime + size as a cheap fingerprint
    return stat.mtimeMs + stat.size;
  } catch { return 0; }
}

// Ensure data directory exists
function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureBackupDir() {
  ensureDataDir();
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

// Rolling timestamped backup — writes a full snapshot of the current file
// to chat-sessions-backups/. Keeps the N most recent by mtime, deletes older.
function rollingBackup(reason: string, keepLast = 24): void {
  try {
    if (!existsSync(CHATS_FILE)) return;
    ensureBackupDir();
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = join(BACKUP_DIR, `lukes-chat-sessions.${iso}.${reason}.json`);
    copyFileSync(CHATS_FILE, dest);

    // Prune — keep most recent N files
    const files = readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('lukes-chat-sessions.') && f.endsWith('.json'))
      .map(f => ({ f, t: statSync(join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keepLast)) {
      try { unlinkSync(join(BACKUP_DIR, f)); } catch { /* ignore */ }
    }
  } catch (e) {
    console.error('[Chats] rollingBackup failed:', e);
  }
}

// Load sessions from file
function loadSessions(): any[] {
  ensureDataDir();
  if (!existsSync(CHATS_FILE)) {
    return [];
  }
  try {
    const data = readFileSync(CHATS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    console.error('Error loading chat sessions:', e);
    return [];
  }
}

// Per-session message-count safety check. Returns a list of session ids
// where the proposed save would drop more than MAX_MESSAGE_DROP_SLACK messages.
function detectSuspiciousDrops(
  existing: any[],
  proposed: any[],
): Array<{ id: string; before: number; after: number }> {
  const existingMap = new Map<string, number>();
  for (const s of existing) {
    existingMap.set(s.id, (s.messages || []).length);
  }
  const drops: Array<{ id: string; before: number; after: number }> = [];
  for (const s of proposed) {
    const before = existingMap.get(s.id);
    if (before === undefined) continue;
    const after = (s.messages || []).length;
    if (before - after > MAX_MESSAGE_DROP_SLACK) {
      drops.push({ id: s.id, before, after });
    }
  }
  return drops;
}

// Save sessions to file — backs up if the new data is significantly smaller
function saveSessions(sessions: any[], { force = false } = {}): { saved: boolean; reason?: string; blockedDrops?: any[] } {
  ensureDataDir();
  const existing = loadSessions();

  // Safety 1: reject save-all that would drastically reduce session COUNT
  // (prevents a freshly-loaded mobile client from overwriting real data)
  if (!force && existing.length > 2 && sessions.length < existing.length * 0.5) {
    console.warn(
      `[Chats] BLOCKED save-all: would reduce sessions from ${existing.length} to ${sessions.length} — creating backup instead`
    );
    try { copyFileSync(CHATS_FILE, CHATS_BACKUP); } catch (e) { console.error('[Chats] Backup failed:', e); }
    rollingBackup('blocked-session-count', 48);
    return { saved: false, reason: `rejected: would reduce ${existing.length} sessions to ${sessions.length}` };
  }

  // Safety 2: detect per-session message-count drops (the chat 11 class of bug).
  // Any session whose message array would shrink by more than the slack is
  // flagged. If drops exist, we back up the CURRENT file and REPLACE the
  // shrunken sessions with their existing-on-disk messages — so the user's
  // sent messages are preserved even if the client tries to overwrite them.
  const drops = detectSuspiciousDrops(existing, sessions);
  if (!force && drops.length > 0) {
    console.warn(`[Chats] BLOCKED per-session message drops:`, drops);
    rollingBackup('blocked-msg-drop', 48);
    // Rewrite the proposed sessions: for any session with a suspicious drop,
    // substitute the existing on-disk messages array. This makes the save
    // path loss-free even under a buggy client.
    const existingById = new Map(existing.map((s: any) => [s.id, s]));
    const safeSessions = sessions.map((s: any) => {
      const dropRec = drops.find(d => d.id === s.id);
      if (!dropRec) return s;
      const onDisk = existingById.get(s.id);
      return { ...s, messages: (onDisk as any)?.messages ?? s.messages };
    });
    writeFileSync(CHATS_FILE, JSON.stringify(safeSessions, null, 2));
    return { saved: true, reason: 'protected', blockedDrops: drops };
  }

  // Safety 3: rolling backup before every successful full save.
  rollingBackup('routine', 24);

  writeFileSync(CHATS_FILE, JSON.stringify(sessions, null, 2));
  return { saved: true };
}

// GET - Retrieve all sessions, or just a version check for cross-device sync
export async function GET(request: NextRequest) {
  try {
    const check = request.nextUrl.searchParams.get('check');

    // Lightweight version poll — returns just a version number, no data
    if (check === 'version') {
      const version = getFileVersion();
      return NextResponse.json({ version }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    // Per-session fetch — returns only one session's messages (for sync)
    const sessionId = request.nextUrl.searchParams.get('sessionId');
    if (sessionId) {
      const sessions = loadSessions();
      const session = sessions.find((s: any) => s.id === sessionId);
      if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });
      return NextResponse.json({ session }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    // Lite mode — return session metadata without messages (for sidebar rendering)
    const lite = request.nextUrl.searchParams.get('lite');
    const sessions = loadSessions();

    if (lite === 'true') {
      const liteSessions = sessions.map((s: any) => {
        const msgs: any[] = s.messages || [];
        const lastMsg = msgs.length > 1 ? msgs[msgs.length - 1] : null;
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
          lastMessagePreview: lastMsg ? (lastMsg.content || '').slice(0, 60) : null,
          // Stub messages array with just enough for the sidebar
          messages: [],
        };
      });
      return NextResponse.json({ sessions: liteSessions, lite: true }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    return NextResponse.json({ sessions }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST - Save sessions or perform actions
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, sessions, session } = body;

    if (action === 'save-all') {
      // Replace all sessions — reject if it would wipe existing data
      const result = saveSessions(sessions);
      if (!result.saved) {
        return NextResponse.json(
          { success: false, error: result.reason },
          { status: 409 }
        );
      }
      return NextResponse.json({ success: true });
    }

    if (action === 'save-one') {
      // Update or add a single session.
      // Safety: if this save would shrink the session's message array
      // by more than a small slack, back up first and preserve on-disk messages.
      const existing = loadSessions();
      const index = existing.findIndex((s: any) => s.id === session.id);
      if (index >= 0) {
        const onDiskMsgCount = (existing[index].messages || []).length;
        const incomingMsgCount = (session.messages || []).length;
        if (onDiskMsgCount - incomingMsgCount > MAX_MESSAGE_DROP_SLACK) {
          console.warn(
            `[Chats] save-one would drop ${onDiskMsgCount - incomingMsgCount} messages from session ${session.id} (${onDiskMsgCount}→${incomingMsgCount}) — preserving on-disk messages`
          );
          rollingBackup('save-one-msg-drop', 48);
          // Keep everything from the incoming session EXCEPT overwrite the messages
          // array with the on-disk version (prevents loss).
          existing[index] = { ...session, messages: existing[index].messages };
        } else {
          existing[index] = session;
        }
      } else {
        existing.unshift(session);
      }
      saveSessions(existing, { force: true }); // force: inner safety already applied
      return NextResponse.json({ success: true });
    }

    if (action === 'delete') {
      // Delete a session
      const existing = loadSessions();
      const filtered = existing.filter((s: any) => s.id !== body.sessionId);
      saveSessions(filtered);
      return NextResponse.json({ success: true });
    }

    if (action === 'create-session') {
      // Create a new session and add it to the top
      const existing = loadSessions();
      existing.unshift(session);
      saveSessions(existing);
      return NextResponse.json({ success: true, sessionId: session.id });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
