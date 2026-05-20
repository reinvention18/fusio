# Mission Control / Fusio — Agent context

> Loaded automatically by Claude Code when working in this repo. Quick-read primer for agents (you). Longer human-readable docs in `docs/`.

## What this is

Mission Control (codename **Fusio**) is a single-user agentic operations console — a local web app that orchestrates Claude (or Codex / other providers) with a 5-repo skill library, MCP fabric, SQLite memory layer, and an optional multi-machine bridge. Runs at `localhost:3001` after `npm run dev` or under PM2 via `ecosystem.config.js`.

## First-run setup

After cloning fresh:

```bash
npm install
npm run dev   # http://localhost:3001
```

That's it. The app starts with empty state — no chats, no memory, no peers. Open Settings (top-right) to wire in:

- **Anthropic API key** — required for the chat to do anything (Settings → Credentials)
- **Workspaces** — the project directories the chat agent operates on (Settings → Projects, or use the project pill in the chat header)
- **Skills repos** (optional) — clone any of the supported skill libraries to `~/` and they're auto-detected (see [docs/SKILLS.md](docs/SKILLS.md))
- **Cross-machine peers** (optional) — if you want to run on more than one box, create `~/.config/mc-remote-hosts.json`. See [docs/CROSS-MACHINE-SETUP.md](docs/CROSS-MACHINE-SETUP.md)
- **Mobile PWA** (optional) — set up HTTPS certs in `certs/` for the install prompt. See the header comment in `https-proxy.js`

## Build notes

- **`npm run build` already includes `--max-old-space-size=16384`.** Don't drop that — webpack OOMs on `ChatPanel.tsx` (~8000 lines).
- **`next.config.js` disables minify and the in-build typecheck** for the same reason. Type-check separately with `npx tsc --noEmit -p tsconfig.json`.
- Dev mode (`next dev`) is recommended for daily use on the always-on box. Production builds are larger but feel slightly snappier; pick whichever fits.

## When changing code that touches cross-machine bridge

If you have multiple machines running this app, treat code changes carefully:

1. Commit + push from your dev box.
2. On every peer, `git pull` and restart (UI hot-reload picks up most front-end changes; new API routes or lib/ changes need a server restart).
3. Verify peers are at the same git HEAD: `curl http://localhost:3001/api/git/status` on each machine.

Files where shape must match across peers:
- `lib/remote/` — bridge config + MCP tools
- `lib/edit-log.ts` — capture format
- `lib/docs/` — `data/docs/<id>.md` frontmatter
- `lib/git-pull/repos.ts` — uses `os.homedir()` so the same code works on Linux + Windows + Mac
- `app/api/git/pull/route.ts`, `app/api/edits/recent/route.ts` — auth model

## Useful tools when debugging across machines

- `mcp__mc-remote__mc_remote_ask({host, message})` — ask a peer's agent to do something locally there
- `mcp__mc-edits__mc_edits_recent({host?})` — see what either machine just touched
- `mcp__mc-vault__vault_read({path, host?})` — read a file from a peer's wiki without syncing
- `mcp__mc-remote__mc_remote_recover({requestId?})` — recover an in-flight peer call that got interrupted

The bridge auto-injects `[Recent edits across machines]` into every prompt, so the agent already knows what the peer just did.

## See also

- `docs/CROSS-MACHINE-SETUP.md` — peer config + Tailscale tips
- `docs/MEMORY-VAULT-INTEGRATION.md` — Obsidian wiki integration
- `docs/MISSIONS_PLAN.md` — multi-agent missions architecture
- `docs/MULTI_AGENT_TEAMS_PLAN.md` — constellation/teams roster
- `docs/TEAMS-INTEGRATION.md`
- `docs/MISSION_CONTROL_LAYOUT.md` — panel layout reference
- `docs/VAULT-CONFIG.md` — vault wiring
- `README.md` — top-level user-facing setup guide
