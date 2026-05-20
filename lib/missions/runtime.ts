/**
 * Missions — in-process runtime registry.
 *
 * Phase 4: missions are long-running async tasks that outlive any single HTTP
 * request. They run as background promises inside the Next.js server process,
 * not in the SSE handler. The SSE handler is a thin **subscriber** that tails
 * the mission's event log file (see event-log.ts) — even if the SSE connection
 * drops, the runner keeps going and the next subscriber replays from offset 0.
 *
 * Why in-process and not a separate OS process:
 *   • All the Anthropic/OpenAI SDK clients, MCP servers, and Codex tooling
 *     already live in the Next.js process. A separate runner would need to
 *     re-bootstrap that infrastructure (~30MB of Node modules) per mission.
 *   • PM2 already supervises MC. If MC crashes, PM2 restarts it; on startup,
 *     `instrumentation.ts` scans for missions in `running` state and resumes
 *     them. Lock files (see persistence.ts) detect crash vs clean exit.
 *   • Browser close + network drop are handled by the SSE-tail-the-log model,
 *     which doesn't require a separate process.
 *
 * What this module provides:
 *   • A Map<missionId, RunningMission> — in-memory registry of active missions.
 *   • startMission(id) — kick off the runner if not already running, return a
 *     handle. Idempotent.
 *   • abortMission(id) — cooperatively cancel a mission (sets status, signals
 *     the runner via AbortSignal, runner finishes its current API call then
 *     persists `paused-checkpoint`).
 *   • getRunningMissionIds() — for instrumentation.ts re-attach detection.
 *
 * The runner itself (runMission in runner.ts) is unchanged — we just hand it
 * a log-backed Emit and let it write to disk.
 */

import 'server-only';
import type { MissionState } from './types';
import { loadMission, saveMission, updateMissionStatus, acquireRunnerLock, releaseRunnerLock, isLockStale } from './persistence';
import { appendEvent } from './event-log';
import { runMissionWithEmit, makeLogEmitter, drainEmitterPending, type MissionRunOptions } from './runner';

export interface RunningMission {
  id: string;
  startedAt: string;
  abortController: AbortController;
  /** The promise resolves when the runner finishes (cleanly OR by abort). */
  promise: Promise<void>;
}

/** In-memory registry. Singleton at module scope — Next.js dev mode HMR can
 *  reload this module, in which case the registry resets but the on-disk
 *  state + lock files keep the source of truth. instrumentation.ts will
 *  re-discover orphaned missions on startup. */
const REGISTRY: Map<string, RunningMission> = (globalThis as any).__mc_mission_registry__
  ?? ((globalThis as any).__mc_mission_registry__ = new Map<string, RunningMission>());

/** Has this mission already got a runner attached in this process? */
export function isMissionRunning(missionId: string): boolean {
  return REGISTRY.has(missionId);
}

/** All currently-attached mission ids. instrumentation.ts uses this on
 *  startup to skip missions that are already being managed. */
export function getRunningMissionIds(): string[] {
  return [...REGISTRY.keys()];
}

/** Start (or re-attach) the runner for a mission. If already running, returns
 *  the existing handle without spawning a duplicate. Sets status=running and
 *  acquires the cross-process lock. Errors are surfaced through the returned
 *  promise; callers decide whether to surface to the user. */
export async function startMission(missionId: string, opts?: { runOptions?: Partial<MissionRunOptions> }): Promise<RunningMission> {
  const existing = REGISTRY.get(missionId);
  if (existing) return existing;

  // Verify state on disk and that no other process holds the lock.
  const state = await loadMission(missionId);
  if (!state) throw new Error(`mission not found: ${missionId}`);
  const stale = await isLockStale(missionId);
  if (!stale) {
    // Another process (or a previous instance of this one before HMR reload)
    // claims to be running this mission. Refuse — the caller can call
    // forceTakeover() if they really mean it.
    throw new Error(`mission ${missionId} is locked by another runner; refusing to start a duplicate`);
  }

  await acquireRunnerLock(missionId, `${process.platform}:${process.env.PM2_HOME ? 'pm2' : 'next'}`);
  await updateMissionStatus(missionId, 'running');
  await appendEvent(missionId, { type: 'mission.start', payload: { resumed_from_phase: state.current_phase_index, resumed_from_attempt: state.current_attempt } });

  const abortController = new AbortController();
  const startedAt = new Date().toISOString();
  const emit = makeLogEmitter(missionId);

  const runOptions: MissionRunOptions = {
    mission: state.mission,
    role_overrides: undefined,
    chatId: missionId,
    clientId: 'background-runner',
    requestId: `run-${Date.now()}`,
    ...(opts?.runOptions || {}),
    // The abort signal is honored by streamClaudeTurn / runCodexConsult
    // wherever they accept it; runner.ts will need to thread it through.
    abortSignal: abortController.signal,
  } as MissionRunOptions;

  const promise = (async () => {
    try {
      await runMissionWithEmit(runOptions, emit);
      // The runner returns whether it completed normally OR stopped early
      // (paused-question, paused-stuck, aborted). We can't tell from the
      // returned void alone, so we read the latest persisted status: the
      // runner keeps it accurate by emitting phase.stuck / question events
      // whose handlers in this same module write the right status to disk.
      // If the runner truly completed, mission.status will still be 'running'
      // and we promote it to 'completed' here. If it set itself to a
      // paused/stuck status earlier, we don't override.
      const final = await loadMission(missionId);
      const finalStatus = final?.mission.status ?? 'running';
      if (finalStatus === 'running') {
        // The runner returned but the persisted status is still 'running' —
        // figure out from the event log whether it actually completed,
        // hit the rework cap (stuck), or asked the user a question.
        // CRITICAL: drain the emit-side pending append queue BEFORE reading
        // the log. The runner's `emit.phaseEvt(...stuck)` returns to the
        // runner in microtasks but the actual disk write is async; without
        // the drain, the most recent few events (including phase.stuck)
        // can be in flight and missed by readAllEvents. This was the bug
        // that kept marking stuck missions as 'completed'.
        await drainEmitterPending(missionId);
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const eventLog = require('./event-log') as typeof import('./event-log');
          const events = await eventLog.readAllEvents(missionId);
          let outcome: 'completed' | 'paused-stuck' | 'paused-question' = 'completed';
          // Walk in reverse to find the latest meaningful runtime signal.
          for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i];
            if (e.type === 'question') { outcome = 'paused-question'; break; }
            if (e.type === 'phase.stuck') { outcome = 'paused-stuck'; break; }
            if (e.type === 'finish') { outcome = 'completed'; break; }
            // mission.start / contract_progress / text / voice — keep walking.
          }
          await updateMissionStatus(missionId, outcome);
          await appendEvent(missionId, { type: 'mission.end', payload: { reason: outcome } });
        } catch {
          // Couldn't read events — default to completed since the runner
          // returned without throwing.
          await updateMissionStatus(missionId, 'completed');
          await appendEvent(missionId, { type: 'mission.end', payload: { reason: 'completed' } });
        }
      } else {
        // Runner already set the right status (paused-question, etc.) —
        // emit a corresponding mission.end so subscribers see it.
        await appendEvent(missionId, { type: 'mission.end', payload: { reason: finalStatus } });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = abortController.signal.aborted;
      await updateMissionStatus(missionId, aborted ? 'paused-checkpoint' : 'paused-stuck');
      await appendEvent(missionId, {
        type: 'mission.error',
        payload: {
          reason: aborted ? 'aborted' : 'error',
          message,
          stack: err instanceof Error ? err.stack : undefined,
        },
      });
    } finally {
      try { await releaseRunnerLock(missionId); } catch { /* ignore */ }
      REGISTRY.delete(missionId);
    }
  })();

  const handle: RunningMission = { id: missionId, startedAt, abortController, promise };
  REGISTRY.set(missionId, handle);
  return handle;
}

/** Cooperatively cancel a running mission. The runner finishes its current
 *  in-flight API call, persists a checkpoint, and exits. The promise on the
 *  handle resolves once the runner has fully shut down. */
export async function abortMission(missionId: string, reason = 'user-requested'): Promise<void> {
  const handle = REGISTRY.get(missionId);
  if (!handle) {
    // Not running in this process. Update on-disk status anyway so a future
    // reattach knows not to resume.
    await updateMissionStatus(missionId, 'paused-checkpoint');
    await appendEvent(missionId, { type: 'mission.status', payload: { status: 'paused-checkpoint', reason } });
    return;
  }
  handle.abortController.abort(reason);
  // Wait for the runner to finish its current operation. We don't surface
  // its rejection — the start-side already converted abort into a status.
  await handle.promise.catch(() => undefined);
}

/** Persist a snapshot of `state` to disk. Convenience for callers that
 *  mutated state via the registry's reference and want to commit. */
export async function persistMissionState(state: MissionState): Promise<void> {
  await saveMission(state);
}

/** Phase 11: wait until every child mission named in `childIds` reaches a
 *  terminal status (`completed` or `cancelled`). Polls every 5s rather than
 *  inotify because the load is trivial and works across processes. The
 *  abortSignal is honored so a user-triggered abort on the parent
 *  cooperatively releases the wait.
 *
 *  Concurrency:
 *    - 'parallel': start every child concurrently (caller's job; we just wait).
 *    - 'sequential': caller starts them one-by-one; we just wait on the
 *      list as a whole.
 *    - 'auto': same as 'parallel' for now — the orchestrator's
 *      shared-resource analysis is a future feature.
 *
 *  Returns the final status of each child. If any child is `cancelled` or
 *  `paused-stuck`, the parent's caller should treat that as a blocker
 *  (orchestrator decision: broker-conflict or pause-for-user). */
export async function waitForChildMissions(
  childIds: string[],
  opts: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<Array<{ id: string; status: string }>> {
  const pollMs = opts.pollMs ?? 5_000;
  const terminal = new Set(['completed', 'cancelled', 'paused-stuck']);
  while (true) {
    if (opts.signal?.aborted) {
      throw Object.assign(new Error('parent mission aborted while waiting on children'), { name: 'AbortError' });
    }
    const states = await Promise.all(childIds.map(id => loadMission(id).catch(() => null)));
    const out = states.map((s, i) => ({
      id: childIds[i],
      status: s?.mission.status ?? 'missing',
    }));
    if (out.every(c => terminal.has(c.status) || c.status === 'missing')) return out;
    // Sleep with abort-aware racing: the signal may fire mid-sleep.
    await new Promise<void>(resolve => {
      const t = setTimeout(resolve, pollMs);
      const onAbort = () => { clearTimeout(t); resolve(); };
      opts.signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }
}
