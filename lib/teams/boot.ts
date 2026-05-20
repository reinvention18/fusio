/**
 * Constellation boot — resumes any running teams after a server restart.
 *
 * Called once on module load. Uses globalThis guard to ensure it runs only
 * once per process (even across hot-reloads). The reaper must run first to
 * clean up stale claims before agents resume and try to re-claim tasks.
 */

import 'server-only';
import { listTeams, listTeamAgents, reapStaleClaims, appendEvent } from './schema';
import { getDb } from '../memory-db';
import { runAgent, getActiveRunners } from './runner';
import { startReaper } from './reaper';
import { tickAllActiveSessions } from '../mem/tick';

declare global {
  // eslint-disable-next-line no-var
  var __mcTeamsBooted: boolean | undefined;
  // eslint-disable-next-line no-var
  var __mcMemTicker: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __mcTeamAutonomyTicker: NodeJS.Timeout | undefined;
}

const REVIEWER_ROLES = new Set(['architect', 'inspector', 'sentinel', 'security', 'tester']);
const RESCUE_ROLES = new Set(['builder', 'scribe', 'scout', 'refactorer']);

/**
 * Safety tick: last-resort autonomy net.
 *
 * Every 60s, for each running team:
 *   1. If an agent's runner died but the team is still running, re-spawn it.
 *   2. If an agent has been idle > 3 min AND there's work it could claim
 *      (pending matching role, orphan-rescuable, or review-claimable for
 *      reviewer roles), inject a wake message via the runner handle.
 *
 * This catches events missed by the direct wake-up (message queue) when
 * reviewer runners happen to be mid-tool-use at submission time.
 */
function runTeamAutonomyTick(): void {
  try {
    const db = getDb();
    const runningTeams = listTeams({ status: 'running' });
    const planningTeams = listTeams({ status: 'planning' as any });
    const teams = [...runningTeams, ...planningTeams];
    if (teams.length === 0) return;

    const activeRunners = getActiveRunners();
    const IDLE_THRESHOLD_MS = 3 * 60 * 1000;
    const HARD_RECOVERY_THRESHOLD_MS = 8 * 60 * 1000;
    const now = Date.now();

    for (const team of teams) {
      // Hard team timeout: if a team has been running longer than its configured
      // max_team_duration_minutes (default 30), force-complete it and ensure
      // the scribe has a chance to compile a partial deliverable. Without this,
      // dead teams hold runner slots indefinitely.
      if (team.status === 'running' || team.status === 'planning') {
        try {
          const settings = team.settings_json ? JSON.parse(team.settings_json) : {};
          const maxMin = typeof settings.max_team_duration_minutes === 'number' ? settings.max_team_duration_minutes : 30;
          const startedAt = team.created_at;
          const elapsedMin = Math.floor((now - startedAt) / 60000);
          if (elapsedMin >= maxMin) {
            // Already timed-out check: did we already inject the scribe?
            const alreadyTimedOut = db.prepare(
              `SELECT created_at FROM team_events
                 WHERE team_id = ? AND kind = 'system' AND payload LIKE '%"team_timeout"%'
                 ORDER BY created_at DESC LIMIT 1`
            ).get(team.id) as { created_at: number } | undefined;

            if (!alreadyTimedOut) {
              console.warn(`[autonomy] Team ${team.id.slice(0, 8)} hit hard timeout (${elapsedMin}m >= ${maxMin}m) — forcing partial deliverable`);
              const scribeAgent = db.prepare(
                `SELECT id, role_handle FROM team_agents WHERE team_id = ? AND role = 'scribe' LIMIT 1`
              ).get(team.id) as { id: string; role_handle: string } | undefined;

              if (scribeAgent) {
                // Inject a partial-deliverable task for the scribe
                const { createTeamTask } = require('./schema');
                createTeamTask({
                  team_id: team.id,
                  title: `[TIMEOUT] Compile partial deliverable`,
                  description: `WHAT: The team hit its ${maxMin}-minute hard timeout. Compile whatever the team produced so far into a partial deliverable for the commander.\nWHERE: scratchpad only.\nOUTPUT: ## Final Deliverable (partial)\nREADS: ALL scratchpad sections.\n\nBe explicit about what was completed vs what was incomplete. List unfinished tasks. Recommend next steps.`,
                  role_hint: 'scribe',
                  priority: 100,
                });
                // Wake the scribe
                const handle = activeRunners.get(scribeAgent.id);
                if (handle) {
                  handle.send(`Team timeout reached. New high-priority task created: compile partial deliverable. Call mc_get_next_task immediately.`, { priority: 'now' });
                }
              }

              // Cancel any non-scribe in-flight tasks so the team can wind down
              db.prepare(
                `UPDATE team_tasks SET status = 'cancelled', status_reason = 'Cancelled: team hit hard timeout'
                   WHERE team_id = ? AND status IN ('pending', 'claimed', 'in_progress', 'rework_in_progress')
                     AND (role_hint != 'scribe' OR role_hint IS NULL)`
              ).run(team.id);

              appendEvent({
                team_id: team.id,
                kind: 'system',
                severity: 'warn',
                payload: { action: 'team_timeout', elapsed_minutes: elapsedMin, max_minutes: maxMin, scribe_invoked: !!scribeAgent },
                chat_report: true,
              });
            }
          }
        } catch (e) {
          console.warn(`[autonomy] timeout check failed for ${team.id}:`, (e as Error).message);
        }
      }

      // Auto-completion check: if all tasks are done/approved, flip the team
      // to completed (and kick off the final audit). Previously this only ran
      // inside mc_submit_task_result, so teams whose last transition was via
      // review-reaper or parent-auto-done never completed.
      if (team.status === 'running') {
        const active = db.prepare(
          "SELECT COUNT(*) as c FROM team_tasks WHERE team_id = ? AND status IN ('pending','claimed','in_progress','needs_rework','rework_in_progress','re_testing','review','ready_for_review')"
        ).get(team.id) as { c: number };
        const total = db.prepare(
          "SELECT COUNT(*) as c FROM team_tasks WHERE team_id = ?"
        ).get(team.id) as { c: number };
        // Skip auto-complete for the first 3 min after a recent reopen —
        // gives the architect time to propose remediation tasks when Codex
        // flags gaps.
        const recentReopen = db.prepare(
          `SELECT created_at FROM team_events
             WHERE team_id = ? AND kind = 'system'
               AND payload LIKE '%"auto_remediation_reopen"%'
             ORDER BY created_at DESC LIMIT 1`
        ).get(team.id) as { created_at: number } | undefined;
        const reopenGraceMs = 3 * 60 * 1000;
        const withinReopenGrace = recentReopen && (now - recentReopen.created_at) < reopenGraceMs;

        if (active.c === 0 && total.c > 0 && !withinReopenGrace) {
          const changed = db.prepare(
            "UPDATE teams SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'running'"
          ).run(now, team.id).changes === 1;
          if (changed) {
            console.log(`[autonomy] Team ${team.id.slice(0, 8)} auto-completed — firing final audit`);
            void (async () => {
              try {
                const mod = await import('./final-audit');
                await mod.runAndStoreFinalAudit(team.id);
              } catch (e: any) {
                console.warn('[autonomy] final-audit failed:', e?.message);
              }
            })();
            continue;
          }
        }
      }


      const agents = listTeamAgents(team.id);
      // Build set of roles on this team for orphan-role detection
      const teamRoleSet = new Set<string>(agents.map(a => a.role as string));

      // Precompute work availability once per team
      const pendingTasks = db.prepare(
        `SELECT id, role_hint, depends_on, phase FROM team_tasks
         WHERE team_id = ? AND status = 'pending'`
      ).all(team.id) as Array<{ id: string; role_hint: string | null; depends_on: string | null; phase: string | null }>;

      const reviewableTasks = db.prepare(
        `SELECT id, assigned_agent_id, role_hint FROM team_tasks
         WHERE team_id = ? AND status = 'ready_for_review' AND commit_sha IS NOT NULL`
      ).all(team.id) as Array<{ id: string; assigned_agent_id: string | null; role_hint: string | null }>;

      // Active-phase IDs for this team (mirror of claimNextTask's phase gate).
      const activePhaseIds = new Set(
        (db.prepare(
          `SELECT id FROM team_phases WHERE team_id = ? AND status = 'active'`
        ).all(team.id) as Array<{ id: string }>).map(r => r.id)
      );

      // Helper: a pending task is claim-ready for an agent if deps satisfied + role compatible
      const depsSatisfied = (depsJson: string | null): boolean => {
        let deps: string[];
        try { deps = JSON.parse(depsJson || '[]'); } catch { return true; }
        if (deps.length === 0) return true;
        const placeholders = deps.map(() => '?').join(',');
        // ready_for_review does NOT satisfy a dependency — only done/approved do.
        const row = db.prepare(
          `SELECT COUNT(*) AS n FROM team_tasks
           WHERE id IN (${placeholders}) AND status IN ('done','approved')`
        ).get(...deps) as { n: number };
        return row.n === deps.length;
      };

      for (const agent of agents) {
        if (['error', 'cancelled'].includes(agent.status)) continue;

        // (1) Respawn dead runners (process or generator gone, or agent
        // marked `done` prematurely while team is still running)
        if (!activeRunners.has(agent.id)) {
          if (team.status === 'planning' && agent.role !== 'architect') continue;
          console.log(`[autonomy] Respawning ${agent.role_handle} (status=${agent.status}) for team ${team.id.slice(0, 8)}`);
          // If the agent was marked done, flip to idle so runAgent initial
          // message is the fresh "begin" rather than the "resume" variant.
          if (agent.status === 'done') {
            try {
              const { getDb } = require('../memory-db');
              getDb().prepare("UPDATE team_agents SET status = 'idle' WHERE id = ?").run(agent.id);
            } catch {}
          }
          runAgent(agent).catch(err => {
            console.error(`[autonomy] Respawn failed for ${agent.role_handle}:`, err.message);
          });
          continue;
        }

        const sinceLastActivity = now - (agent.last_activity_at || agent.created_at);
        if (sinceLastActivity < IDLE_THRESHOLD_MS) continue;

        const handle = activeRunners.get(agent.id);
        if (!handle) continue;

        // (2a) Unconditional hard-recovery: > 8 min since any activity → the
        // SDK generator has hung internally (common after MCP interrupt errors
        // or network blips). Kill it regardless of whether work is waiting —
        // the next tick respawns from the persisted session. Better to cycle
        // a hung agent than leave it festering.
        if (sinceLastActivity >= HARD_RECOVERY_THRESHOLD_MS) {
          console.warn(`[autonomy] Hard-restarting hung ${agent.role_handle} (idle ${Math.round(sinceLastActivity / 60000)}m)`);
          handle.close().catch((e: any) => console.warn(`[autonomy] close error for ${agent.role_handle}:`, e?.message));
          continue;
        }

        // (2b) Soft nudge: only when there's actual work matching the agent.
        const hasPending = pendingTasks.some(t => {
          const hint = t.role_hint;
          const hintIsOrphan = !!hint && !teamRoleSet.has(hint);
          const roleOk = !hint || hint === agent.role || (RESCUE_ROLES.has(agent.role) && hintIsOrphan);
          if (!roleOk) return false;
          // Phase gate: if task has a phase, it's only available when that phase is active.
          if (t.phase && !activePhaseIds.has(t.phase)) return false;
          return depsSatisfied(t.depends_on);
        });

        const hasReviewable = REVIEWER_ROLES.has(agent.role) && reviewableTasks.some(t => {
          if (t.assigned_agent_id === agent.id) return false;
          if (agent.role !== 'architect' && t.role_hint === agent.role) return false;
          return true;
        });

        if (!hasPending && !hasReviewable) continue;

        const kind = hasPending ? 'new pending task' : 'ready_for_review work to review';
        console.log(`[autonomy] Nudging idle ${agent.role_handle} — ${kind} available (idle ${Math.round(sinceLastActivity / 60000)}m)`);
        handle.send(
          `Autonomy tick: you have ${kind} available but haven't made progress in ${Math.round(sinceLastActivity / 60000)} min. Call mc_get_next_task now.`,
          { priority: 'now' }
        );
      }
    }
  } catch (err) {
    console.warn('[autonomy] tick failed:', (err as Error).message);
  }
}

/**
 * One-shot data heal at boot: strip `depends_on: [parent]` from any Fix tasks
 * whose parent is in needs_rework. Pre-fix code added that dep, which made the
 * Fix task permanently un-claimable (needs_rework doesn't satisfy deps).
 * Idempotent — does nothing on subsequent boots once the data is clean.
 */
function healStuckReworkFixTasks(): void {
  try {
    const db = getDb();
    const stuck = db.prepare(`
      SELECT t.id, t.depends_on, t.parent_task_id, t.title
      FROM team_tasks t
      JOIN team_tasks p ON p.id = t.parent_task_id
      WHERE t.status = 'pending'
        AND p.status = 'needs_rework'
        AND t.depends_on IS NOT NULL
        AND t.depends_on != '[]'
    `).all() as Array<{ id: string; depends_on: string; parent_task_id: string; title: string }>;

    let healed = 0;
    for (const row of stuck) {
      let deps: string[];
      try { deps = JSON.parse(row.depends_on); } catch { continue; }
      const filtered = deps.filter(d => d !== row.parent_task_id);
      if (filtered.length === deps.length) continue; // nothing to strip
      db.prepare('UPDATE team_tasks SET depends_on = ? WHERE id = ?')
        .run(JSON.stringify(filtered), row.id);
      healed++;
      console.log(`[boot.heal] Stripped parent dep from Fix task "${row.title.slice(0, 60)}" (was deadlocked)`);
    }
    if (healed > 0) console.log(`[boot.heal] Healed ${healed} deadlocked Fix task(s)`);
  } catch (e) {
    console.warn('[boot.heal] failed:', (e as Error).message);
  }
}

/**
 * Auto-resolve "placeholder" tasks (no commit_sha, stuck in review or
 * ready_for_review) to `done`. These are typically architect planning tasks or
 * goal-task shells that have no verifiable deliverable. Without this, they
 * count toward `active` status and prevent team completion forever.
 */
function healCommitlessReviewTasks(): void {
  try {
    const db = getDb();
    const result = db.prepare(`
      UPDATE team_tasks
         SET status = 'done',
             status_reason = 'Auto-resolved: placeholder/planning task with no commit',
             completed_at = ?
       WHERE status IN ('ready_for_review', 'review')
         AND (commit_sha IS NULL OR commit_sha = '')
    `).run(Date.now());
    if (result.changes > 0) {
      console.log(`[boot.heal] Auto-resolved ${result.changes} commitless review task(s)`);
    }
  } catch (e) {
    console.warn('[boot.heal] commitless-review failed:', (e as Error).message);
  }
}

/**
 * Revive agents that marked themselves `done` during a momentary empty-queue
 * lull while their team is still running. Pre-fix behavior auto-done'd agents
 * on all_tasks_complete and they never came back when new rework tasks were
 * created asynchronously — deadlocking the team.
 */
function revivePrematurelyDoneAgents(): void {
  try {
    const db = getDb();
    const result = db.prepare(`
      UPDATE team_agents
         SET status = 'idle',
             status_reason = 'Revived from premature done — team still running'
       WHERE status = 'done'
         AND team_id IN (SELECT id FROM teams WHERE status IN ('running', 'planning', 'paused'))
    `).run();
    if (result.changes > 0) {
      console.log(`[boot.revive] Revived ${result.changes} prematurely-done agent(s)`);
    }
  } catch (e) {
    console.warn('[boot.revive] failed:', (e as Error).message);
  }
}

function startAutonomyTicker(): void {
  if (globalThis.__mcTeamAutonomyTicker) return;
  const INTERVAL_MS = 60 * 1000;
  globalThis.__mcTeamAutonomyTicker = setInterval(runTeamAutonomyTick, INTERVAL_MS);
  // Run once shortly after boot
  setTimeout(runTeamAutonomyTick, 20_000);
  console.log(`[autonomy] team autonomy tick scheduled every ${INTERVAL_MS / 1000}s`);
}

// Auto-compress memory every 2 minutes so observations populate the Memory tab
// in the UI without the user having to manually POST /api/mem/tick. Cheap —
// skips sessions with nothing pending.
function startMemTicker(): void {
  if (globalThis.__mcMemTicker) return;
  const INTERVAL_MS = 2 * 60 * 1000;
  globalThis.__mcMemTicker = setInterval(() => {
    tickAllActiveSessions({ maxSessionsPerTick: 5 }).catch(e => {
      console.warn('[mem.ticker] tick failed:', e?.message);
    });
  }, INTERVAL_MS);
  // Fire once shortly after boot so recently-stored queue items compress fast
  setTimeout(() => {
    tickAllActiveSessions({ maxSessionsPerTick: 10 }).catch(() => { /* ignore */ });
  }, 10_000);
  console.log(`[mem.ticker] auto-compression scheduled every ${INTERVAL_MS / 1000}s`);
}

export async function bootTeams(): Promise<void> {
  if (globalThis.__mcTeamsBooted) return;
  globalThis.__mcTeamsBooted = true;

  startReaper();
  startMemTicker();
  startAutonomyTicker();

  reapStaleClaims();
  healStuckReworkFixTasks();
  healCommitlessReviewTasks();
  revivePrematurelyDoneAgents();

  const activeRunners = getActiveRunners();
  const runningTeams = listTeams({ status: 'running' });
  const planningTeams = listTeams({ status: 'planning' as any });
  const allTeams = [...runningTeams, ...planningTeams];

  if (allTeams.length === 0) return;

  console.log(`[Boot] Resuming ${allTeams.length} team(s) (${runningTeams.length} running, ${planningTeams.length} planning)...`);

  for (const team of allTeams) {
    const agents = listTeamAgents(team.id);
    for (const agent of agents) {
      if (['done', 'error', 'cancelled'].includes(agent.status)) continue;
      if (activeRunners.has(agent.id)) continue;
      // In planning phase, only resume architect agents
      if (team.status === 'planning' && agent.role !== 'architect') continue;

      try {
        await runAgent(agent);
        console.log(`[Boot] Resumed ${agent.role_handle} (${agent.id})`);
      } catch (err: any) {
        console.error(`[Boot] Failed to resume ${agent.role_handle}:`, err.message);
      }
    }
  }
}
