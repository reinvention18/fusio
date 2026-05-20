import 'server-only';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { runMigrations } from './memory-schema';

export type DB = Database.Database;

declare global {
  // eslint-disable-next-line no-var
  var __mc_memory_db__: DB | undefined;
}

function dispose(): void {
  const existing = globalThis.__mc_memory_db__;
  if (existing) {
    try {
      existing.close();
    } catch {
      // ignore close errors
    }
    globalThis.__mc_memory_db__ = undefined;
  }
}

function openDb(): DB {
  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'memory.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('wal_autocheckpoint = 1000');

  runMigrations(db);

  if (process.env.NODE_ENV !== 'production') {
    process.once('SIGTERM', dispose);
    process.once('beforeExit', dispose);
  }

  return db;
}

export function getDb(): DB {
  if (!globalThis.__mc_memory_db__) {
    globalThis.__mc_memory_db__ = openDb();
  }
  return globalThis.__mc_memory_db__;
}
