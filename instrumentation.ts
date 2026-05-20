// Mission Control memory pump trigger.
//
// Why fetch instead of `import('./lib/memory-indexer')`:
// instrumentation.ts is compiled for BOTH the nodejs and edge runtimes by Next.js
// even when guarded with NEXT_RUNTIME, and webpack statically traces dynamic imports.
// Importing the indexer here drags better-sqlite3 into the edge bundle, which can't
// resolve `fs` and breaks the dev compile. Fetching the route instead keeps this
// file dependency-free; the route runs in the nodejs runtime where serverExternalPackages
// applies and better-sqlite3 works correctly.

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const port = process.env.PORT || '3001';
  const tickUrl = `http://127.0.0.1:${port}/api/memory/tick`;

  const tick = async () => {
    try {
      const res = await fetch(tickUrl, { method: 'POST' });
      if (!res.ok) {
        console.error('[Memory pump] tick http', res.status);
      }
    } catch (e: any) {
      // Server may not be fully up on the very first tick — that's fine.
      if (e?.code !== 'ECONNREFUSED') {
        console.error('[Memory pump] tick failed:', e?.message ?? e);
      }
    }
  };

  // First run after 15s (give the server room to finish booting), then every 30s.
  setTimeout(() => {
    tick();
    setInterval(tick, 30_000);
  }, 15_000);

  console.log('[Memory] background pump scheduled (every 30s, via /api/memory/tick)');

  // Resume any running/planning constellation teams + start the mem compression
  // ticker. Dynamic import so this file stays edge-runtime-safe (the module
  // pulls in better-sqlite3 which only works in nodejs).
  setTimeout(async () => {
    try {
      const { bootTeams } = await import('./lib/teams/boot');
      await bootTeams();
      console.log('[Boot] Constellation boot complete');
    } catch (e: any) {
      console.error('[Boot] Failed to run bootTeams:', e?.message ?? e);
    }
  }, 2_000);

  // Start the wiki git-sync pull loop. No-op if the vault is not a git repo.
  setTimeout(async () => {
    try {
      const { startGitSyncLoop } = await import('./lib/vault/git-sync');
      startGitSyncLoop();
      console.log('[wiki-git] sync loop started');
    } catch (e: any) {
      console.error('[wiki-git] failed to start sync loop:', e?.message ?? e);
    }
  }, 3_000);

  // Phase 8 (missions / Bitter Lesson refactor): warm the role-skill cache
  // so the synchronous loaders (used by audit-brief builder) see data.
  setTimeout(async () => {
    try {
      const { warmRoleSkillCache } = await import('./lib/missions/skills');
      await warmRoleSkillCache();
      console.log('[Missions] role-skill cache warmed');
    } catch (e: any) {
      console.error('[Missions] failed to warm role-skill cache:', e?.message ?? e);
    }
  }, 4_000);

  // Phase 4 (missions persistence): on MC startup, re-attach any mission
  // whose status is `running` / `paused-stuck` and whose lock is stale
  // (= previous MC crashed mid-run). paused-question missions are left
  // alone — the user owes us an answer.
  setTimeout(async () => {
    try {
      const { listMissions, isLockStale } = await import('./lib/missions/persistence');
      const { startMission, isMissionRunning } = await import('./lib/missions/runtime');
      const candidates = await listMissions({ statuses: ['running', 'paused-stuck'] });
      let resumed = 0;
      for (const m of candidates) {
        if (isMissionRunning(m.id)) continue;
        const stale = await isLockStale(m.id).catch(() => true);
        if (!stale) continue;
        try { await startMission(m.id); resumed += 1; }
        catch (err: any) { console.error(`[Missions reattach] ${m.id}:`, err?.message ?? err); }
      }
      if (resumed > 0) console.log(`[Missions reattach] resumed ${resumed} mission(s)`);
    } catch (e: any) {
      console.error('[Missions reattach] startup scan failed:', e?.message ?? e);
    }
  }, 5_000);

  // Phase 10 (long-running missions): hibernate sweep — drop in-memory
  // entries for missions paused-question > 2h. State on disk is preserved.
  setTimeout(async () => {
    try {
      const { startHibernateTimer } = await import('./lib/missions/hibernate');
      startHibernateTimer(); // default 15-min interval, 2h threshold
      console.log('[Missions hibernate] sweep timer started');
    } catch (e: any) {
      console.error('[Missions hibernate] failed to start:', e?.message ?? e);
    }
  }, 6_000);

  // Remote-chat pending-file sweep — prunes stale outbound (caller-side
  // remote-out-*.json) and inbound (peer-side remote-<id>.json) records.
  // 1h TTL for terminal records (done/error), 7-day TTL for in-flight so a
  // user coming back from vacation can still recover via mc_remote_recover.
  // Without this, the data/pending/ dir grows forever on every remote call.
  setTimeout(async () => {
    try {
      const { startRemotePendingSweep } = await import('./lib/remote/mcp-tools');
      startRemotePendingSweep(); // first run +60s, then every 30 min
      console.log('[remote-sweep] timer scheduled');
    } catch (e: any) {
      console.error('[remote-sweep] failed to start:', e?.message ?? e);
    }
  }, 7_000);

  // ─── App-level memory watchdog REMOVED ─────────────────────────────
  // History: I added a 2 GB watchdog after the 5-day wedge pattern. That
  // killed the process every ~2 min because Next dev steady-state was
  // 2.1 GB. Raised to 3.5 GB. Then Next dev grew (more routes, more
  // missions code) and 3.5 GB became the new steady-state — same loop.
  //
  // Decision: defer all memory management to (a) PM2's max_memory_restart
  // in ecosystem.config.js (4 GB hard cap) and (b) Next dev's own
  // approaching-threshold monitor. Layering a third in-process watchdog
  // on top creates restart cascades when steady-state shifts. PM2 + Next
  // already handle this without my help.
  //
  // The original 5-day wedge bug was a SEPARATE issue (SSE listener leak
  // in chat-broadcast + MCP-cache unbounded growth + HMR SIGTERM
  // accumulation). Those structural fixes from 2026-05-14 are still in
  // place — the wedge can't happen even WITHOUT a memory watchdog because
  // the leak sources are bounded.
  console.log('[memory-watchdog] disabled — relying on PM2 max_memory_restart + Next built-in monitor');
}
