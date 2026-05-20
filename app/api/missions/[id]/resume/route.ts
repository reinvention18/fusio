/**
 * POST /api/missions/[id]/resume
 *
 * Phase 4: idempotent runner-attach. If the mission is already running in
 * this process, returns ok=true with running=true. Otherwise, validates the
 * lock state and starts a fresh runner. Used by:
 *   • Manual "Resume" button in the dashboard
 *   • The Luke's Chat UI's "answer the paused question" handler (after the
 *     answer is persisted into the mission state, this endpoint kicks the
 *     runner back into action)
 *   • instrumentation.ts on MC startup, for missions that were running when
 *     the previous MC process crashed.
 *
 * Body (optional):
 *   { user_answer: { phase_index: number, answer: string } }
 *     — if a phase is paused-question, the answer is captured into the
 *       mission state before resuming so the worker sees it on next attempt.
 *   { override_rework_cap: number }
 *     — bumps the cap before resuming a paused-stuck phase.
 */

import { NextRequest } from 'next/server';
import { loadMission, updateMission, isLockStale } from '@/lib/missions/persistence';
import { startMission, isMissionRunning } from '@/lib/missions/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const state = await loadMission(id);
  if (!state) return Response.json({ error: 'mission_not_found', id }, { status: 404 });

  // Idempotency: if a runner is already attached in this process, do nothing.
  if (isMissionRunning(id)) {
    return Response.json({ ok: true, running: true, already_attached: true });
  }

  // Cross-process check: if a different process is the runner, refuse.
  const stale = await isLockStale(id);
  if (!stale) {
    return Response.json({ error: 'mission_locked_by_other', id }, { status: 409 });
  }

  // Apply the optional body before starting so the runner sees fresh state.
  let body: any = {};
  try { body = await req.json(); } catch { /* no body is fine */ }

  if (body?.user_answer || typeof body?.override_rework_cap === 'number') {
    await updateMission(id, (s) => {
      if (body.user_answer && body.user_answer.phase_index && typeof body.user_answer.answer === 'string') {
        // Stash the user answer where the runner picks it up on next loop.
        // The exact field name matches MissionRunOptions.pendingUserAnswer
        // so when startMission spawns the runner it can read it through.
        (s.mission as any).pendingUserAnswer = body.user_answer;
      }
      if (typeof body.override_rework_cap === 'number') {
        (s.mission as any).override_rework_cap = body.override_rework_cap;
      }
    });
  }

  const handle = await startMission(id, {
    runOptions: {
      pendingUserAnswer: body?.user_answer,
      override_rework_cap: body?.override_rework_cap,
      resume_from_phase: state.current_phase_index,
      resume_from_attempt: state.current_attempt,
    },
  }).catch((err: unknown) => err);

  if (handle instanceof Error) {
    return Response.json({ error: 'start_failed', message: handle.message }, { status: 500 });
  }

  return Response.json({ ok: true, running: true, started_at: (handle as { startedAt: string }).startedAt });
}
