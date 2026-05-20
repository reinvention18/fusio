// Resolves to wherever you cloned this repo. Works on Linux + Windows + Mac.
const path = require('path');
const MC_DIR = __dirname;

module.exports = {
  apps: [
    {
      name: 'mission-control',
      script: 'node_modules/next/dist/bin/next',
      // Linux runs dev mode per CLAUDE.md ("Dev mode is fine for daily use
      // on Linux; PC runs prod build via PM2"). Avoids the multi-GB
      // production-build OOM on ChatPanel.tsx and lets hot-reload pick up
      // server-side fixes (e.g. autopilot escape valve) without a restart.
      args: 'dev -p 3001 -H 0.0.0.0',
      cwd: MC_DIR,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      // Give in-flight requests up to 60s to finish before PM2 SIGKILLs.
      // Default is 1.6s, which kills mid-turn sub-agent fanout and leaves
      // the Claude Code session in a state that fails to resume — exactly
      // what nuked Chat 20's 14-minute research turn.
      kill_timeout: 60000,
      // Wait for the process to send `process.send('ready')` before PM2
      // considers it started, so the new instance is fully booted before
      // load-balancing requests to it. Avoids the EADDRINUSE bouncing
      // we kept hitting on restart.
      wait_ready: false, // next.js doesn't IPC-signal readiness; leave off
      listen_timeout: 30000,
      // No max_memory_restart. The user explicitly wants MC to run for
      // hours solving long problems — restart caps killed long Claude
      // turns mid-flight every time we set one. The system has 30+ GB
      // of RAM. If a real runaway leak ever forces real OOM the kernel
      // will handle it. Day-to-day, Next dev + PM2 default behavior is
      // fine and we don't need to babysit memory.
      env: {
        // `next dev` requires NODE_ENV=development. Previously this was set
        // to 'production' and Next tolerated it (cached dev CSS rules
        // survived restarts). After a fresh .next cache wipe, Next now
        // refuses to apply the dev CSS loader pipeline when NODE_ENV=prod,
        // and globals.css fails to parse (`Unexpected character '@' at 1:0`).
        NODE_ENV: 'development',
        PORT: 3001,
        // Raise V8's heap limit from the default 2 GB to 8 GB. Reason:
        // Next dev mode (see node_modules/next/dist/server/lib/start-server.js
        // around line 234) has hardcoded auto-restart logic that fires when
        // V8 heap usage > 80% of heap_size_limit. With the default 2 GB
        // limit that's ~1.6 GB used → trigger. MC routinely hits 1.6 GB
        // after a few hours of normal use, triggering the worker to
        // process.exit(). The parent respawns it but the listening socket
        // sometimes stays bound to the dead worker — that's the 'PM2 says
        // online, every endpoint times out' wedge we hit on 2026-05-15
        // and 2026-05-17. With max-old-space=8192 the threshold becomes
        // 6.4 GB which normal usage never reaches. The trigger remains
        // as a runaway-leak safety net but no longer fires on healthy
        // long-running sessions.
        NODE_OPTIONS: '--max-old-space-size=8192'
      }
    },
    {
      name: 'mc-https',
      script: 'https-proxy.js',
      cwd: MC_DIR,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
