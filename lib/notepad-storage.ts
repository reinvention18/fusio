/**
 * notepad-storage — per-pad JSON file under data/notepads/<id>.json.
 *
 * Schema: { id, content, version, updatedAt, updatedBy }
 * Versioning: monotonically incremented on every save. Clients send their
 * baseVersion with each save so the server can detect conflicts (still
 * accepts — last-write-wins — but reports the stomp in the response).
 */

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'data', 'notepads');

export interface NotepadDoc {
  id: string;
  content: string;
  version: number;
  updatedAt: string;
  updatedBy?: string; // clientId of the last writer
}

function ensureDir(): void {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function padPath(id: string): string {
  // Sanitize id — only allow lowercase letters, digits, dash. Prevents
  // path traversal and weird filenames from URL params.
  const safe = id.replace(/[^a-z0-9-]/gi, '').slice(0, 60).toLowerCase() || 'default';
  return path.join(DIR, `${safe}.json`);
}

export function loadPad(id: string): NotepadDoc {
  ensureDir();
  const file = padPath(id);
  if (!fs.existsSync(file)) {
    return { id, content: '', version: 0, updatedAt: new Date(0).toISOString() };
  }
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const j = JSON.parse(raw);
    return {
      id,
      content: typeof j.content === 'string' ? j.content : '',
      version: typeof j.version === 'number' ? j.version : 0,
      updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : new Date(0).toISOString(),
      updatedBy: typeof j.updatedBy === 'string' ? j.updatedBy : undefined,
    };
  } catch {
    return { id, content: '', version: 0, updatedAt: new Date(0).toISOString() };
  }
}

export function savePad(id: string, content: string, updatedBy?: string): NotepadDoc {
  ensureDir();
  const file = padPath(id);
  const prev = loadPad(id);
  const next: NotepadDoc = {
    id,
    content,
    version: prev.version + 1,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  // Atomic write — write to tmp then rename so a crash mid-write can't
  // leave a half-written file.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}
