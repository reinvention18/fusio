/**
 * mem/tick — run periodic background processing for memory.
 *
 * Called from the existing `/api/memory/tick` route (which we extend) and on
 * session end. Compresses pending queue items across all recently-active
 * sessions, trimming nothing else (observations stay forever unless deleted).
 */

import 'server-only';
import { getDb } from '../memory-db';
import { compressPendingForSession } from './compress';

export async function tickAllActiveSessions(opts?: {
  maxSessionsPerTick?: number;
}): Promise<{ sessionsProcessed: number; observationsWritten: number }> {
  const db = getDb();
  const maxSessions = opts?.maxSessionsPerTick ?? 10;

  const rows = db.prepare(
    `SELECT DISTINCT q.session_id AS id
     FROM mem_obs_queue q
     WHERE q.processed_at IS NULL
     GROUP BY q.session_id
     ORDER BY COUNT(*) DESC
     LIMIT ?`
  ).all(maxSessions) as Array<{ id: string }>;

  let written = 0;
  for (const r of rows) {
    try {
      written += await compressPendingForSession(r.id, { maxItems: 150 });
    } catch (e) {
      console.warn('[mem.tick] compress failed for', r.id, (e as Error).message);
    }
  }
  return { sessionsProcessed: rows.length, observationsWritten: written };
}
