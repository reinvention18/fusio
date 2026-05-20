/**
 * Missions — hibernation sweep.
 *
 * Phase 10 deliverable 3: "if no activity for >2h and waiting on user,
 * mission goes to disk-only state, frees memory."
 *
 * The runtime registry holds an AbortController + the runner's promise per
 * active mission. While the mission is paused-question (waiting on a user
 * answer), the runner promise is already settled — there's no in-flight work
 * — but the registry entry hangs around. This sweep walks the registry,
 * finds entries whose mission state shows `paused-question` AND whose
 * `last_activity_at` is older than the threshold, and removes the registry
 * entry. The on-disk state is unchanged — the next /resume call will
 * re-attach a fresh runner.
 *
 * Why bother: at 16+ day mission lengths, leaving registry entries around
 * for missions that are days-old waiting on a human answer leaks small
 * amounts of memory (closures over the original AbortController, timer
 * handles inside the runner's API client, etc.). Hibernation tidies that
 * without losing any state.
 */

import 'server-only';
import { listMissions, loadMission, releaseRunnerLock } from './persistence';
import { isMissionRunning, getRunningMissionIds } from './runtime';
import { appendEvent } from './event-log';

/** Default: 2 hours of inactivity → hibernate. Tunable via env var. */
const DEFAULT_HIBERNATE_AFTER_MS = parseInt(process.env.MC_MISSION_HIBERNATE_MS || '', 10) || 2 * 60 * 60 * 1000;

interface HibernateOptions {
  /** Override the inactivity threshold for a one-shot sweep (e.g. tests). */
  thresholdMs?: number;
  /** Dry-run — return who would be hibernated without doing it. */
  dryRun?: boolean;
}

export interface HibernateResult {
  scanned: number;
  hibernated: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/** One-shot hibernate sweep. Designed to be called from a periodic timer
 *  (e.g. every 15 minutes from instrumentation.ts) so a long-paused mission
 *  doesn't keep its runtime registry entry indefinitely. */
export async function runHibernateSweep(opts: HibernateOptions = {}): Promise<HibernateResult> {
  const threshold = opts.thresholdMs ?? DEFAULT_HIBERNATE_AFTER_MS;
  const now = Date.now();
  const result: HibernateResult = { scanned: 0, hibernated: [], skipped: [] };

  // Look at the in-memory registry: only attached missions are candidates.
  const attached = getRunningMissionIds();
  for (const id of attached) {
    result.scanned++;
    const state = await loadMission(id).catch(() => null);
    if (!state) {
      result.skipped.push({ id, reason: 'state_missing' });
      continue;
    }
    // Only hibernate when paused-question — that's the only status where
    // the runner is genuinely idle waiting on a user response. Active
    // missions (running) need to keep their AbortController; checkpoint
    // missions (paused-checkpoint) already finished cleanly and shouldn't
    // be in the registry anyway.
    if (state.mission.status !== 'paused-question') {
      result.skipped.push({ id, reason: `status=${state.mission.status}` });
      continue;
    }
    const lastActivity = state.mission.last_activity_at ? new Date(state.mission.last_activity_at).getTime() : 0;
    const ageMs = now - lastActivity;
    if (ageMs < threshold) {
      result.skipped.push({ id, reason: `active_recently(${Math.round(ageMs / 60000)}m)` });
      continue;
    }
    if (opts.dryRun) {
      result.hibernated.push(id);
      continue;
    }
    // Hibernate: drop the registry entry + release the cross-process lock
    // (no other process should have it, but be defensive). We DO NOT touch
    // the state file; the next /resume call rebuilds the runtime entry from
    // disk.
    try {
      // The runtime module's registry exposes no "drop" — we add one here
      // by reaching into the global handle. Safer than re-importing because
      // an HMR reload during dev mode would otherwise leave a phantom entry.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reg = (globalThis as any).__mc_mission_registry__ as Map<string, unknown> | undefined;
      reg?.delete(id);
      await releaseRunnerLock(id);
      await appendEvent(id, { type: 'mission.status', payload: { status: 'hibernated', reason: 'inactivity', age_minutes: Math.round(ageMs / 60000) } });
      result.hibernated.push(id);
    } catch (err: any) {
      result.skipped.push({ id, reason: `hibernate_failed: ${err?.message ?? err}` });
    }
  }

  return result;
}

/** Schedule the hibernate sweep on a recurring timer. Returns a stop function
 *  (call it on process shutdown). The sweep itself is cheap — a few stat
 *  calls per mission — so polling every 15 minutes is fine. */
export function startHibernateTimer(intervalMs = 15 * 60 * 1000): () => void {
  const timer = setInterval(async () => {
    try {
      const r = await runHibernateSweep();
      if (r.hibernated.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[Missions hibernate] hibernated ${r.hibernated.length} mission(s):`, r.hibernated);
      }
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error('[Missions hibernate] sweep failed:', err?.message ?? err);
    }
  }, intervalMs);
  // unref so the sweep timer doesn't keep the process alive on shutdown.
  timer.unref?.();
  return () => clearInterval(timer);
}

// listMissions kept as an export hook for tests that want to inspect what
// the sweep would have considered.
export { listMissions };
