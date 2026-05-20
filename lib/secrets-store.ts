/**
 * secrets-store — Isolates credential values (keyFacts with category:'credential')
 * out of the world-readable `data/chat-sessions.json` into a `chmod 600` file.
 *
 * Shape on disk (`data/.secrets.json`):
 *   {
 *     [chatId]: { [factId]: { value: string, updatedAt: number } }
 *   }
 *
 * Every credential in the main chat file is replaced with the placeholder
 * `__SECRET_REF__` on save and rehydrated on load. Non-credential keyFacts
 * (url, person, config, decision, reference) are untouched — those are not
 * sensitive and splitting them would bloat the hot path.
 *
 * Why not encrypt? This process already has filesystem + network access; the
 * threat model here is "another user on this box" or "an accidentally-public
 * backup". File-mode 600 + separate file defeats both without key management.
 */

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
const SECRETS_FILE = path.join(DATA_DIR, '.secrets.json');

export const SECRET_PLACEHOLDER = '__SECRET_REF__';

export interface KeyFactLike {
  id: string;
  category: string;
  value: string;
  [k: string]: unknown;
}

type SecretsMap = Record<string, Record<string, { value: string; updatedAt: number }>>;

let cache: SecretsMap | null = null;

function ensureFile(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SECRETS_FILE)) {
    fs.writeFileSync(SECRETS_FILE, '{}', { mode: 0o600 });
  }
  try {
    fs.chmodSync(SECRETS_FILE, 0o600);
  } catch {
    /* chmod may fail on some filesystems (tmpfs, WSL) — not fatal */
  }
}

function load(): SecretsMap {
  if (cache) return cache;
  ensureFile();
  try {
    const raw = fs.readFileSync(SECRETS_FILE, 'utf-8');
    cache = JSON.parse(raw) as SecretsMap;
  } catch {
    cache = {};
  }
  return cache!;
}

function persist(): void {
  if (!cache) return;
  ensureFile();
  const tmp = SECRETS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SECRETS_FILE);
}

export function setSecret(chatId: string, factId: string, value: string): void {
  if (!value || value === SECRET_PLACEHOLDER) return;
  const m = load();
  if (!m[chatId]) m[chatId] = {};
  m[chatId][factId] = { value, updatedAt: Date.now() };
  persist();
}

export function getSecret(chatId: string, factId: string): string | undefined {
  return load()[chatId]?.[factId]?.value;
}

export function deleteSecrets(chatId: string): void {
  const m = load();
  if (m[chatId]) {
    delete m[chatId];
    persist();
  }
}

/**
 * Given a list of keyFacts from a chat: for every credential, stash the real
 * value in the secrets store (if not already a placeholder) and return a new
 * array with credential values replaced by the placeholder. The returned
 * array is what goes to `chat-sessions.json` on disk.
 */
export function redactForDisk<T extends KeyFactLike>(chatId: string, facts: T[] | undefined): T[] | undefined {
  if (!facts || facts.length === 0) return facts;
  return facts.map(f => {
    if (f.category !== 'credential') return f;
    if (f.value === SECRET_PLACEHOLDER) return f; // already redacted
    if (f.value && f.value.length > 0) setSecret(chatId, f.id, f.value);
    return { ...f, value: SECRET_PLACEHOLDER } as T;
  });
}

/**
 * Inverse of redactForDisk: swap placeholders back to real values from the
 * secrets store. Used when serving chats to the client.
 */
export function hydrateFromDisk<T extends KeyFactLike>(chatId: string, facts: T[] | undefined): T[] | undefined {
  if (!facts || facts.length === 0) return facts;
  return facts.map(f => {
    if (f.category !== 'credential') return f;
    if (f.value !== SECRET_PLACEHOLDER) return f; // never redacted (legacy)
    const real = getSecret(chatId, f.id);
    return real ? ({ ...f, value: real } as T) : f;
  });
}

/**
 * One-shot migration: walk all sessions, move every credential value to the
 * secrets store, rewrite the sessions array with placeholders. Returns the
 * number of credentials migrated. Idempotent — skips values that already
 * match the placeholder.
 */
export function migrateSessionsInPlace(sessions: Array<{ id: string; keyFacts?: KeyFactLike[] }>): number {
  let migrated = 0;
  for (const s of sessions) {
    if (!s.keyFacts?.length) continue;
    for (const f of s.keyFacts) {
      if (f.category === 'credential' && f.value && f.value !== SECRET_PLACEHOLDER) {
        setSecret(s.id, f.id, f.value);
        f.value = SECRET_PLACEHOLDER;
        migrated++;
      }
    }
  }
  return migrated;
}

/** Force the cache to reload from disk (tests + signal-driven reload). */
export function resetCacheForTest(): void {
  cache = null;
}
