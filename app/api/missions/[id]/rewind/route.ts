/**
 * POST /api/missions/[id]/rewind
 *
 * Phase 10: rewind a mission's persisted state to a prior checkpoint and
 * (optionally) re-attach the runner. Body: `{ checkpoint: number }`. The
 * mission must NOT be currently running — abort it first via /abort.
 *
 * Side effects:
 *   • Replaces the mission's `<id>.json` state file with the checkpoint
 *     contents (atomic rename via saveMission).
 *   • Appends a `mission.status` event to the log noting the rewind.
 *   • Sets status to `paused-checkpoint` regardless of what the checkpoint
 *     said — the user is the one driving this, they get to pick whether to
 *     /resume next.
 *
 * Note: the event log is NOT truncated — the rewind shows up as a forward
 * event ("rewound to checkpoint 7") so timeline replay stays consistent.
 * If the user wants to discard later events too, they can DELETE the mission
 * and create a new one from the checkpoint.
 */

import { NextRequest } from 'next/server';
import { loadCheckpoint } from '@/lib/missions/checkpoints';
import { loadMission, saveMission, updateMissionStatus } from '@/lib/missions/persistence';
import { isMissionRunning } from '@/lib/missions/runtime';
import { appendEvent } from '@/lib/missions/event-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  if (isMissionRunning(id)) {
    return Response.json({ error: 'mission_is_running', hint: 'POST /abort first, then rewind.' }, { status: 409 });
  }

  const state = await loadMission(id);
  if (!state) return Response.json({ error: 'mission_not_found', id }, { status: 404 });

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const n = Number(body?.checkpoint);
  if (!Number.isInteger(n) || n < 1) {
    return Response.json({ error: 'invalid_checkpoint', need: 'integer >= 1' }, { status: 400 });
  }

  const ckpt = await loadCheckpoint(id, n);
  if (!ckpt) return Response.json({ error: 'checkpoint_not_found', n }, { status: 404 });

  // Defensive: refuse to rewind if the checkpoint is for a different mission
  // (shouldn't happen but file system shenanigans are real).
  if (ckpt.mission?.id !== id) {
    return Response.json({ error: 'checkpoint_mission_mismatch', expected: id, got: ckpt.mission?.id }, { status: 422 });
  }

  // Replace state — but keep the goal-truth fields the user authored at
  // creation (cwd, target_url, contract). The checkpoint had them too,
  // but if a checkpoint was written before a goal update we'd clobber it.
  // For now we trust the checkpoint completely — it IS the source of truth
  // for the moment we snapshotted. The user re-authoring the goal is a
  // separate feature.
  await saveMission(ckpt);
  await updateMissionStatus(id, 'paused-checkpoint');
  await appendEvent(id, {
    type: 'mission.status',
    payload: { status: 'rewound', checkpoint: n, label: 'user-rewind' },
  });

  return Response.json({ ok: true, rewound_to: n, status: 'paused-checkpoint' });
}
