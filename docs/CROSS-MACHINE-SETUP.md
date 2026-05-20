# Cross-Machine Mission Control — Full Reference

This is the human-readable companion to `CLAUDE.md` at the repo root. It explains how the Linux dev server and the Windows PC are wired together as peer Mission Control instances, and the workflow rules for keeping them in sync.

---

## Topology at a glance

```
                ┌─────────────────────────────┐
                │   Tailscale tailnet         │
                │   (encrypted, peer-to-peer) │
                └─────────────┬───────────────┘
                              │
        ┌─────────────────────┴─────────────────────┐
        │                                           │
┌───────▼──────────────┐                  ┌─────────▼──────────────┐
│   Linux server       │                  │   Windows PC           │
│   <linux-peer>:3001 │ ◄──────────────► │   <pc-peer>:3001   │
│   "Server"     │   Bridge tools   │   "Workstation"          │
│                      │                  │                        │
│   Mission Control    │                  │   Mission Control      │
│   (dev mode,         │                  │   (next start prod,    │
│    systemd-managed)  │                  │    PM2-managed)        │
└──────────────────────┘                  └────────────────────────┘
        │                                           │
        └────────────► GitHub (origin) ◄────────────┘
                       <your-github-user>/mission-control
                       <your-github-user>/<your-mobile-app>
                       <your-github-user>/<your-web-app>
                       <your-github-user>/<your-wiki-repo>
                       TheCraigHewitt/<your-seo-workspace>
```

---

## How the two MCs are tied together

### 1. Trust file (per-machine)

Each machine has `~/.config/mc-remote-hosts.json` listing the OTHER machines it trusts plus a shared bearer token used for inbound auth on `/api/remote-chat`, `/api/docs`, `/api/edits/recent`, `/api/vault/*`, etc.

```json
{
  "myToken":  "<long random token, same on both sides>",
  "myLabel":  "Server" | "Workstation",
  "myUrl":    "http://<linux-peer>:3001" | "http://<pc-peer>:3001",
  "hosts": [
    { "id": "pc"|"linux", "label": "...", "url": "...", "token": "<same>" }
  ]
}
```

The token is symmetric — both machines use the same string. That's how Linux can prove its identity to PC and vice versa.

### 2. Bridge MCP servers

Every chat agent on either machine boots with these MCP servers registered (`lib/claude-chat-bridge.ts`):

- **`mc-remote`** — `mc_remote_list_hosts`, `mc_remote_list_chats`, `mc_remote_ask`, `mc_remote_read`. The agent can send messages directly to the peer's agent and get a synchronous reply.
- **`mc-docs`** — `mc_docs_list({host?})`, `mc_docs_read({id, host?})`, `mc_docs_write`, `mc_docs_search({host?})`. Shared notes & plans; writes are local-only, reads are cross-machine.
- **`mc-vault`** — `vault_search`, `vault_list`, `vault_read`, `vault_status` ALL accept an optional `host` param. Lets the agent query the peer's Obsidian wiki in real time.
- **`mc-edits`** — `mc_edits_recent({host?})`. Cross-machine file-edit log so agents see what the peer just touched.
- **`mc-skills`** — local list of available skills; not cross-machine but mirrored installed skills are.
- **`mc-memory`** — per-chat 3-layer memory; per-machine.
- **`mc-commander`** — Constellation team control; per-machine.

### 3. UI surfaces

- **🛰 REMOTE tab** — iframes the peer's MC chat surface (using `?embed=1` to strip chrome). Same UI as your local CHAT, peer's data.
- **📋 DOCS tab** — list shows local + peer docs side-by-side with host badges; "Sync Now" button force-pulls both machines' wikis.
- **📝 ACTIVITY tab** — live feed of every Edit/Write across all machines, host filters, click-to-detail.
- **Chat header `🐙 GitHub`** — repo selection sets `activeSession.githubRepo`; injected into every chat send so the agent has gh CLI cheat-sheet.
- **Chat header `🌿 Pull Latest`** — dropdown shows all managed git repos with status; one-click fast-forward (refuses dirty trees).

### 4. Auto-injection on every chat turn

`app/api/chat/route.ts` `buildPrompt()` prepends a `[Recent edits across machines]` block before every user message — fetches local + peer edits with a 600ms timeout and lists each by host, time, file, +/- lines, and a 1-sentence summary. That's how the agents avoid stomping on each other's work without anyone asking.

### 5. Continuous sync surfaces

- **Wiki**: `~/<your-wiki-dir>` is a git checkout of `<your-github-user>/<your-wiki-repo>`. Auto-commits 30s after any write (via `lib/vault/git-sync.ts`), auto-pulls every 5 min on both machines, force-pulls via the DOCS tab "Sync Now" button.
- **Docs/plans**: every `mc_docs_write` mirrors into `~/<your-wiki-dir>/plans/<id>.md` or `~/<your-wiki-dir>/notes/<id>.md`, which then propagates via the wiki git-sync above. Result: writing a plan on Linux makes it visible in PC's `mc_docs_list` within ~5 min, sooner with Sync Now.
- **Edit log**: per-machine append-only `data/edit-log.jsonl`; cross-readable via `/api/edits/recent` proxy. Not synced, just queryable.
- **Chats**: per-machine. `data/chats/<id>.json` on Linux ≠ PC. The bridge lets agents quote peer chat content via `mc_remote_read`, but each machine has its own chat list.

---

## Workflow: changing MC code

**Rule: every change to this repo needs to land on BOTH machines or the bridge can break.**

### Standard flow

1. **Edit on Linux** (or wherever you're working). MC's dev server picks up changes immediately on Linux (it runs `next dev`).
2. **Type-check**: `npx tsc --noEmit -p tsconfig.json` (don't rely on the in-build check — it's disabled in `next.config.js` because it OOMs on ChatPanel.tsx).
3. **Commit + push**:
   ```bash
   git add <files>
   git commit -m "..."
   git push origin master
   ```
4. **Deploy to PC**. SSH from Linux:
   ```bash
   ssh <your-ssh-user>@<pc-peer> \
     'powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\<your-user>\pc-pull-build.ps1'
   ```
   That script does `pm2 stop` → `git pull` → `npx next build` (with 16GB heap, ~2-3 min) → `pm2 restart` → smoke test.
5. **Verify**:
   ```bash
   curl http://localhost:3001/api/git/status   # Linux
   curl http://<pc-peer>:3001/api/git/status   # PC
   ```
   Both should show the same HEAD on `mission-control`.

### Why dev vs prod matters

- Linux runs `next dev` (under systemd). Hot-reload, no build step.
- PC runs `next start` (under PM2). Needs a build to reflect changes.

If you push to GitHub but skip step 4, **PC keeps serving the old build** until its next manual rebuild. That's the most common drift cause.

### Just deploying small things

If a change is genuinely tiny (e.g. a string tweak), the chat-header **Pull Latest** button can fast-forward PC's git checkout — but **it does NOT rebuild**. You still need a build for the new code to actually run. Use the SSH path for anything code-shaped.

### Files you should NOT commit

`.gitignore` already excludes these, but worth knowing — they're per-machine and **must not** be synced:

- `data/memory.db*` — SQLite memory store
- `data/chats/*.json` — chat history
- `data/.secrets.json` — extracted credentials cache
- `data/edit-log.jsonl` — edit-log entries
- `data/pending/` — in-flight response buffer
- `data/claude-code-sessions.json` — sessionKey → Anthropic session_id map (machine-specific)
- `mission-control.log` — runtime log
- `.next/` — build output

---

## When the user-level agents change

The 15 specialist roster lives at `~/.claude/agents/*.md`. **Not** in the repo (it's a global Claude Code feature). When you add or modify a specialist:

```bash
tar czf /tmp/claude-agents.tgz -C ~/.claude agents
scp -o BatchMode=yes /tmp/claude-agents.tgz <your-ssh-user>@<pc-peer>:/Users/<your-user>/claude-agents.tgz
ssh <your-ssh-user>@<pc-peer> 'powershell -NoProfile -Command "Set-Location $env:USERPROFILE\.claude; tar -xzf $env:USERPROFILE\claude-agents.tgz"'
```

This is the manual way for now. Could be promoted to a git repo later if it becomes a chronic update path.

---

## Troubleshooting

**"PC's chats aren't showing my new agent specialists"** → tar/scp `~/.claude/agents` to PC.

**"PC says repo is empty / gh button shows nothing"** → token expired. Run `gh auth login -h github.com` in a PowerShell window on the PC. The MC UI now shows this hint via `/api/github?action=status` returning a useful error.

**"Both machines have HEAD A but PC behaves like it's on commit B"** → PC didn't rebuild. Run the `pc-pull-build.ps1` script.

**"Mission Control on PC won't start"** → check `pm2 list` on PC. If `mission-control` is errored, look at `pm2 logs mission-control --lines 50`. Common cause: dirty `.next` from a killed build. Fix with `rm -rf .next && npm run build` then `pm2 restart`.

**"git pull says diverged"** → Pull Latest button refuses non-fast-forward intentionally. Either push from PC (`git push`) if its commits are real, or `git reset --hard origin/master` if PC's commits are leftover noise from byte-identical scp drops.

---

## File map of the cross-machine code

```
lib/
├── remote/
│   ├── config.ts             # load mc-remote-hosts.json + auth helpers
│   └── mcp-tools.ts          # mc-remote MCP server + 4 tools
├── docs/
│   ├── service.ts            # local CRUD + wiki mirror
│   └── mcp-tools.ts          # mc-docs MCP server + 4 host-aware tools
├── edits/
│   └── mcp-tools.ts          # mc-edits MCP server + mc_edits_recent
├── edit-log.ts               # capture + read append-only JSONL
├── git-pull/
│   └── repos.ts              # manifest of managed repos
├── vault/
│   ├── mcp-tools.ts          # mc-vault (host param added)
│   ├── service.ts            # local file ops + auto-commit on write
│   └── git-sync.ts           # debounced commit + auto-pull loop
└── chat-storage.ts           # commitAssistantMessageIfMissing fallback

app/api/
├── chat/route.ts             # buildPrompt injects [Recent edits...] block
├── docs/route.ts, [id]/route.ts
├── edits/recent/route.ts
├── github/route.ts           # cross-platform gh path resolution
├── git/status/route.ts       # for Pull Latest dropdown
├── git/pull/route.ts         # ff-only, refuses dirty
├── remote-chat/route.ts      # bearer-auth inbound from peer
├── remote/hosts/route.ts     # UI-safe peer list
├── remote/docs/route.ts, [id]/route.ts
├── remote/edits/route.ts     # peer edits proxy
├── remote/vault-sync/route.ts # force-pull peer's wiki
└── vault/sync/route.ts       # local force-pull

components/
├── DocsPanel.tsx             # 📋 DOCS tab
├── ActivityPanel.tsx         # 📝 ACTIVITY tab
├── RemotePanel.tsx           # 🛰 REMOTE tab (peer iframe with ?embed=1)
└── chat/
    ├── DocAttachDropdown.tsx # composer dropdown
    └── PullLatestButton.tsx  # chat-header button
```

---

## Adding a new repo to the system

1. In `lib/git-pull/repos.ts`, add an entry to `ALL_REPOS` with cross-platform `pickPath()`.
2. Generate a per-repo SSH deploy key on PC + register it as a deploy key (write access) on the repo.
3. Update PC's SSH config alias in `~/.ssh/config` (`Host github-<name>`).
4. Clone on PC: `git clone github-<name>:owner/repo.git ~/<name>`.
5. Linux already has gh CLI auth so it can pull/push directly via HTTPS.
6. Restart MC on both machines.

The Pull Latest button then picks it up automatically (it filters to repos that exist as `.git` checkouts).

---

## Quick reference

```bash
# Linux dev hot-reload (already running):
systemctl --user status mission-control.service

# PC redeploy after a Linux push:
ssh <your-ssh-user>@<pc-peer> 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\<your-user>\pc-pull-build.ps1'

# Verify both at same HEAD:
curl http://localhost:3001/api/git/status | jq '.repos[] | select(.id=="mission-control")'
curl http://<pc-peer>:3001/api/git/status | jq '.repos[] | select(.id=="mission-control")'

# Force wiki sync everywhere:
curl -X POST http://localhost:3001/api/vault/sync
curl -X POST http://localhost:3001/api/remote/vault-sync?host=pc

# Talk to PC's agent from Linux's chat:
# (just type in chat) "Ask the PC to <do thing>"
# the agent calls mc_remote_ask({host: "pc", message: "..."})
```
