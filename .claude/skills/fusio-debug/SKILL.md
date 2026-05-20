---
name: fusio-debug
description: Diagnose and fix Fusio (Mission Control / MC) bugs. Use when MC is broken, hung, slow, returning errors, white-screening, losing chats, missing skills, missing memory, peer bridge silent, mobile PWA failing, missions stuck, or any other MC-specific failure mode. Includes the diagnostic surface, recovery playbooks, common code locations, and known footguns.
triggers:
  - "mission control is broken"
  - "mc is broken"
  - "fusio is broken"
  - "fix mc"
  - "fix fusio"
  - "fix mission control"
  - "mc won't start"
  - "fusio won't start"
  - "mc bug"
  - "fusio bug"
  - "mc chat hung"
  - "mc white screen"
  - "fusio white screen"
  - "mc memory broken"
  - "missions stuck"
  - "mc peer offline"
  - "mc pwa not working"
  - "chat panel won't load"
  - "mc returns 500"
  - "fusio returns 500"
---

# Fusio (Mission Control) — Bug Fix Skill

You are debugging an issue in the Fusio / Mission Control codebase. This skill gives you the diagnostic surface, the common failure modes, the recovery playbooks, and the known footguns. Use it to triage, locate, and fix issues efficiently — without guessing.

## Step 0: Triage — what kind of failure is it?

Ask the user (or check yourself) which of these symptoms applies. Many issues map to a known recovery playbook below.

| Symptom | Most likely cause | Jump to |
|---|---|---|
| PM2 says "online" but every endpoint times out | The wedge pattern — Next dev's 80%-heap auto-restart fired but socket stayed bound | [§1](#1-wedged-pm2--online-but-every-endpoint-times-out) |
| White screen on load, console says "Cannot access 'X' before initialization" | V2 minifier TDZ pattern | [§2](#2-white-screen-on-load) |
| Chat reply is hung / streaming stopped / stop button does nothing | Wedged SDK subprocess or activeQueries map drift | [§3](#3-chat-is-hung) |
| Mission stuck on "running" but no progress | Phase-cap exceeded, scrutiny unreachable, or ghost lock | [§4](#4-mission-is-stuck) |
| `/api/mem/timeline` returns 500 or empty; observations not writing | Memory DB corrupted | [§5](#5-memory-db-corrupted) |
| Chat sessions vanished from the sidebar | `data/<ns>-chat-sessions.json` corrupted; restore from backups dir | [§6](#6-chat-sessions-vanished) |
| Skill not loading even though it should | Wrong source dir, regex doesn't match, body too big, or stale TS cache | [§7](#7-skill-wont-load) |
| Cross-machine peers silently absent | `~/.config/mc-remote-hosts.json` missing or malformed | [§8](#8-cross-machine-bridge-silently-disappeared) |
| `mission-control.log` huge | pm2-logrotate not installed or misconfigured | [§9](#9-logs-too-big) |
| Approval modal let through a destructive op | Approval gate is allow-listed — only matches specific Bash patterns + a fixed list of protected paths for Edit/Write | [§10](#10-approval-bypass) |
| Mobile PWA stopped working | Tailscale cert expired or certs missing | [§11](#11-mobile-pwa-broken) |
| Terminal mode shows no messages | No active chat session in localStorage, or wrong namespace | [§12](#12-terminal-mode-empty) |
| `mc_remote_ask` returns truncated reply | Stream closed before `remote-done` event — try `mc_remote_recover` | [§13](#13-mc_remote_ask-truncated) |

If none of the symptoms above match, **run the diagnostic sweep** first (§99) before guessing.

---

## §1. Wedged PM2 — "online but every endpoint times out"

**Symptom**: `pm2 status` shows `online`, but `curl http://localhost:3001/api/git/status` hangs or 502s.

**Cause**: Next dev's hardcoded 80%-heap auto-restart fired (see `node_modules/next/dist/server/lib/start-server.js` around line 234). The worker exited, the parent respawned, but the listening socket stayed bound to the dead worker. Mitigation already in place: `NODE_OPTIONS=--max-old-space-size=8192` in `ecosystem.config.js:57` raises the trigger from ~1.6 GB to ~6.4 GB.

**Fix:**
```bash
pm2 restart mission-control
# If that hangs:
pm2 delete mission-control && pm2 start ecosystem.config.js
```

**Verify:** `curl http://localhost:3001/api/git/status` returns JSON within 2s.

---

## §2. White screen on load

**Symptom**: page loads but renders nothing; browser console shows `Cannot access '<name>' before initialization`.

**Cause**: V2 minifier TDZ pattern. `useCallback` references a `useMemo` that's declared LATER in the same component. In dev mode this works (hoisting friendlier); in production-minified bundles it throws because the var is in the temporal dead zone.

**Fix:**
1. Open browser devtools → Console → identify the variable name in the error.
2. Find the file. Look for:
   ```tsx
   const cb = useCallback(() => { ... }, [memoizedThing]);   // ← uses memoizedThing
   const memoizedThing = useMemo(() => ..., []);             // ← declared AFTER
   ```
3. Move the `useMemo` declaration ABOVE the `useCallback`. Repeat for any other hook ordering issues.
4. Rebuild: `npm run build` then `pm2 restart mission-control`.

**Prevention:** ESLint react-hooks/exhaustive-deps catches some of these but not all. Lint your component manually if you're touching the order of `useMemo`/`useCallback` declarations.

---

## §3. Chat is hung

**Symptom**: you sent a message, response started or didn't, now it sits forever. Stop button does nothing.

**Diagnostic:**
```bash
pm2 logs mission-control --lines 200 | grep -iE "active queries|activeQueries|shutdown"
```

**Fix sequence:**
1. Click Stop in the chat UI first — fires `POST /api/stop` → SDK `Query.interrupt()`.
2. If unresponsive, send POST manually:
   ```bash
   curl -X POST http://localhost:3001/api/chat/stop -H "Content-Type: application/json" -d '{"sessionKey":"<key-from-pm2-logs>"}'
   ```
3. If stuck across ALL chats, the SDK subprocess is wedged: `pm2 restart mission-control` (graceful drain runs for up to 50s due to `kill_timeout: 60000` in ecosystem.config.js).

**Common root causes:**
- Anthropic rate-limited the sessionKey for 60s (see `lib/claude-chat-bridge.ts:markRateLimited`). Per-session lockout — other chats keep working.
- Approval gate has a pending approval the UI never showed. Check `pm2 logs | grep '[approval]'`.
- SSE listener leaked. Check `activeQueries.size` via the `/api/chat/listen?chatId=__snapshot__` snapshot endpoint.

---

## §4. Mission is stuck

**Symptom**: a mission shows status `running` in the dashboard but no events for 30+ minutes, or `paused-stuck`.

**Diagnostic:**
```bash
cat data/missions/<id>/state.json | jq '{ status, currentPhase, lastEvent: (.events | last) }'
tail -50 data/missions/<id>/events.jsonl
```

**Fix paths:**
- **Status `paused-stuck`** (phase-cap exceeded): resume via `POST /api/missions/<id>/resume`.
- **Status `paused-question`**: orchestrator asked the user something. Answer in the dashboard's question UI.
- **Scrutiny unreachable**: every Codex lane failed. Check `codex` CLI availability (`which codex && codex --version`), then resume.
- **Status `running` but no progress + no lock file holder**: ghost — `rm data/missions/<id>/.lock && pm2 restart mission-control`. `instrumentation.ts` re-bootstraps running missions on boot.

**Last resort — rewind to a checkpoint:**
```bash
curl http://localhost:3001/api/missions/<id>/checkpoints | jq
curl -X POST http://localhost:3001/api/missions/<id>/rewind \
  -H 'content-type: application/json' \
  -d '{"checkpoint_id":"<ckpt-id>"}'
```

**Architectural note:** missions use per-phase session key `mission:<id>:p<N>` (not per-attempt). Rework attempts see prior context — this is intentional for prompt-cache hits but means a phase that's locked into a bad pattern may keep producing similar output. Rewind instead.

---

## §5. Memory DB corrupted

**Symptom**: `/api/mem/timeline` returns 500, observations don't write, `data/memory.db-wal` huge.

**Detection (since 2026-05-19 fix):** `pm2 logs mission-control | grep '\[mem\] write failed'` — throttled warnings now surface when SQLite breaks. Previously empty-catch blocks made memory silently die.

Also: `pm2 logs mission-control | grep 'mem injection failed'` — the per-turn auto-inject path (`lib/claude-chat-bridge.ts` around line 530-560) also surfaces failures.

**Fix:**
```bash
pm2 stop mission-control
cp data/memory.db data/memory.db.bak.$(date +%s)
rm data/memory.db data/memory.db-shm data/memory.db-wal
pm2 start mission-control
# Schema auto-recreates from lib/memory-schema.ts. Observations re-accrue from new turns.
```

The backup file is your safety net — if you want to try to recover old observations, copy it back and run `sqlite3 data/memory.db.bak.<ts> '.recover' | sqlite3 data/memory.db.recovered`.

---

## §6. Chat sessions vanished

**Symptom**: the chat sidebar shows no sessions for one or more namespaces.

**Cause**: `data/<ns>-chat-sessions.json` got truncated or corrupted. (Common during MC crashes; defensive saves write to `<file>.backup.json` + rolling backups in `<ns>-chat-sessions-backups/`.)

**Fix:**
```bash
pm2 stop mission-control
cd data
ls chat-sessions-backups/ | sort -r | head -5
# Pick the most recent valid backup; verify it's JSON-parseable:
cat chat-sessions-backups/<file>.json | python3 -m json.tool > /dev/null && echo OK
cp chat-sessions-backups/<file>.json chat-sessions.json
pm2 start mission-control
```

(Same for `seo-chat-sessions.json` / `lukes-chat-sessions.json` and their respective backup dirs.)

---

## §7. Skill won't load

**Symptom**: a skill that should trigger for some prompt isn't appearing in the auto-load.

**Diagnostic:**
```bash
curl 'http://localhost:3001/api/debug/match-probe?text=your+trigger+phrase' | jq
```

Returns the full match result: `skills.matched`, `bytesInlined`, `agents.matched`, `designSystems.matched`. **If `bytesInlined: 0` for your skill name**, the file read failed (silent catch) — check perms.

**Common causes:**
1. **Regex didn't match.** Look at `lib/skills-mcp.ts` around line 299 in `SKILL_TRIGGERS`. Test your pattern: `node -e 'console.log(/\b(your pattern)\b/i.test("test sentence"))'`.
2. **Skill is in a non-scanned directory.** The 5 scanned dirs are at the top of `lib/skills-mcp.ts` — make sure your `SKILL.md` is under one of them.
3. **Body > 5500 chars** — it loads but truncates. Check `MAX_SKILL_BODY_INLINE` in `lib/skills-mcp.ts:293`.
4. **You just edited `SKILL_TRIGGERS`** in TS code: `pm2 restart mission-control`. Skill bodies are re-read from disk every call, but the trigger TABLE is module-cached.
5. **Cap exceeded:** max 4 skills per turn (`matchSkillsForText(text, max = 4)` at `lib/skills-mcp.ts:510`). Add yours to `PRIORITY_SKILL_NAMES` (~line 129) to win the cap.

---

## §8. Cross-machine bridge silently disappeared

**Symptom**: the Remote tab is empty, `mc_remote_*` tools aren't available, `[Recent edits across machines]` block missing from prompts.

**Diagnostic:**
```bash
cat ~/.config/mc-remote-hosts.json | jq
```

If this fails (file missing or invalid JSON), `loadRemoteConfig()` returns null, `listHosts()` returns `[]`, and the bridge in `lib/claude-chat-bridge.ts` around line 670 skips registering `mc-remote` entirely.

**Fix:** create or repair the trust file:
```json
{
  "myToken": "<base64 random — same on every machine in the cluster>",
  "myLabel": "Server A",
  "myUrl": "http://10.0.0.5:3001",
  "hosts": [
    {
      "id": "b",
      "label": "Workstation B",
      "url": "http://10.0.0.6:3001",
      "token": "<same myToken from machine B>"
    }
  ]
}
```

Reciprocal entries on every peer. Symmetric tokens. mtime-watched — no restart needed after edit.

**Verify:** the Remote tab now shows the peer with a reachability dot (`/api/remote/hosts`).

---

## §9. Logs too big

**Symptom**: `mission-control.log` or `~/.pm2/logs/mission-control-*.log` hit 100+ MB.

**Detection:**
```bash
ls -lh ~/.pm2/logs/ mission-control.log 2>/dev/null
```

**Fix — install pm2-logrotate (one-time setup):**
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 save
```

**Immediate cleanup:**
```bash
pm2 flush mission-control            # clears PM2 logs
: > mission-control.log              # truncates in-repo log
```

The legacy in-repo `mission-control.log` (not under PM2's management) is from an older direct-run setup. Safe to delete entirely if you're using PM2.

---

## §10. Approval bypass

**Symptom**: a destructive operation went through without an approval modal.

**Cause**: the approval gate (`lib/approval-gate.ts`) is **allow-listed**, not deny-by-default. It catches:
- Bash matching specific patterns: `rm -rf`, `sudo rm`, `DROP TABLE`, `DROP DATABASE`, `TRUNCATE TABLE`, `git push --force`, `git reset --hard origin`, `git branch -D`, `git checkout .`, `mkfs`, `:> /dev/sd[a-z]`
- Edit/Write/MultiEdit on protected paths: mc-remote-hosts.json, `.env*`, `~/.ssh/`, `~/.aws/`, `/etc/{passwd,shadow,sudoers,ssh}`, `data/memory.db*`, `data/<ns>-chat-sessions.json`, `data/missions/<id>/state.json`, `ecosystem.config.js`, `authorized_keys`

Anything outside those lists passes through.

**Fix — add coverage:**
- Open `lib/approval-gate.ts`
- For new Bash patterns, add to the patterns array around line 63
- For new protected paths, add to the `protectedPatterns` array (Edit/Write branch)
- Restart: `pm2 restart mission-control`

---

## §11. Mobile PWA broken

**Symptom**: PWA install prompt missing on Chrome, or "Not Secure" warning, or HTTPS proxy unreachable.

**Diagnostic — is the proxy running?**
```bash
pm2 status | grep mc-https
curl -k https://localhost:3443/api/git/status   # -k = skip cert validation
```

**Common causes:**
- **Certs missing or expired.** The proxy looks for `certs/tls.crt` and `certs/tls.key` (or whatever `MC_CERT_PATH`/`MC_KEY_PATH` env vars point to). See header comment in `https-proxy.js` for setup.
- **Tailscale cert expired** (90-day lifetime if you used `tailscale cert`): regenerate via `sudo tailscale cert <your-hostname>` and `pm2 restart mc-https`.
- **`MC_PWA_URL` env var not set:** cosmetic — only affects the boot log line that prints the install URL.
- **Chrome cached a Service Worker from a stale build:** in Chrome devtools → Application → Service Workers → Unregister, then reinstall the PWA.

---

## §12. Terminal mode empty

**Symptom**: clicking the `Full` pill enters fullscreen terminal mode but shows no messages.

**Causes:**
1. **No active chat selected** — `localStorage[<ns>-activeSessionId]` is empty. Exit fullscreen, open or create a chat, re-enter fullscreen.
2. **Wrong namespace** — `TerminalChat` reads the active session for the namespace matching the current tab. If you toggled fullscreen on the Chat tab but the active session is from SEO or Luke's, you'll see no messages. Switch tabs first.
3. **API fetch failed** — open devtools Network tab and look for `/api/chats?sessionId=...` (or `seo-chats`/`lukes-chats`). If 404 or empty response, the chat file may have been deleted from disk.

**Diagnostic:**
```js
// In browser devtools console:
localStorage.getItem('mc-activeSessionId')
localStorage.getItem('seo-activeSessionId')
localStorage.getItem('missions-activeSessionId')
```

---

## §13. mc_remote_ask truncated

**Symptom**: the chat agent's `mc_remote_ask` call returns "stream closed without remote-done" or partial text.

**Cause**: peer's stream closed before emitting the `remote-done` event. Could be network blip, peer restart, or `maxDuration` hit (which only applies on Vercel deploys — on PM2 it doesn't fire).

**Recovery:**
The caller's outbound record stays in `data/pending/remote-chat/out/<requestId>.json` until the user explicitly recovers. Use:
```
mc_remote_recover requestId=<the-one-from-the-error-message>
```
(In chat, the agent can call this MCP tool directly. It fetches the peer's persisted result via `GET /api/remote-chat/result?requestId=X`.)

If the peer also crashed before persisting the final result, the call is genuinely lost. Re-issue.

---

## §99. Diagnostic sweep — run this first if nothing else fits

Quick health-check sequence — copy/paste safe:

```bash
echo "=== git HEAD ==="
curl -sS http://localhost:3001/api/git/status | jq '.repos[0] | {head, dirty}'

echo "=== PM2 status ==="
pm2 status | head -10

echo "=== recent errors ==="
pm2 logs mission-control --lines 200 --nostream 2>&1 | grep -iE "error|fail|crash" | tail -10

echo "=== memory pump alive ==="
pm2 logs mission-control --lines 100 --nostream 2>&1 | grep -i "memory" | tail -3

echo "=== auto-load on a recent turn ==="
pm2 logs mission-control --lines 200 --nostream 2>&1 | grep "chat-autoload" | tail -2

echo "=== active queries ==="
curl -sS 'http://localhost:3001/api/chat/listen?chatId=__snapshot__' | jq '.streams | length'

echo "=== pending response buffers ==="
ls data/pending/*.json 2>/dev/null | wc -l

echo "=== in-flight missions ==="
curl -sS http://localhost:3001/api/missions 2>&1 | jq 'map(select(.status=="running")) | length'

echo "=== peers reachable? ==="
curl -sS http://localhost:3001/api/remote/hosts 2>&1 | jq '.hosts'
```

Once you have this output, you usually know which section above to jump to.

---

## Key files to know

When in doubt, these are the files that hold the most important behavior:

| Concern | File |
|---|---|
| Chat pipeline (the heart) | `lib/claude-chat-bridge.ts` (~1500 LOC) |
| Mission runtime | `lib/missions/runner.ts`, `runtime.ts`, `persistence.ts` |
| Memory facade | `lib/mem/api.ts`, `lib/memory-*.ts` |
| Skill auto-loader | `lib/skills-mcp.ts` |
| Agent persona loader | `lib/agents-mcp.ts` |
| Approval gate | `lib/approval-gate.ts` |
| Chat broadcast (multi-device SSE) | `lib/chat-broadcast.ts` |
| Cross-machine MCP tools | `lib/remote/mcp-tools.ts` |
| Trust file loader | `lib/remote/config.ts` |
| PM2 config (heap, kill_timeout) | `ecosystem.config.js` |
| Build config (minify off, env vars) | `next.config.js` |
| Boot hooks (memory pump, team boot, mission re-attach) | `instrumentation.ts` |
| Per-doc reference | `docs/MISSION_CONTROL_FUSIO.md`, `docs/HELP_GUIDE.md`, `docs/FAQ.md` |

## Known footguns (read before editing)

1. **V2 minifier TDZ pattern** — `useCallback` referencing a later-declared `useMemo` works in dev, breaks in prod. Declare memos first.
2. **System prompt appendix only on NEW sessions** — skill/agent/design index in `lib/claude-chat-bridge.ts:558-565` only fires when there's no resumable `claudeSessionId`. Adding a new skill won't show in old chat sessions until they roll over.
3. **Per-phase mission session key is shared across attempts** (`runner.ts:288`) — `mission:<id>:p<N>`. Reworks see prior context. Trade-off for prompt caching.
4. **Skill match runs against full prompt INCLUDING history** — old messages can trigger a skill on a later turn. Accepted noise.
5. **Memory captures don't auto-inject by default before commit `a8de092`** — if you're on an older clone, the bridge captures observations but doesn't inject them back. Pull latest.
6. **Approval gate is allow-listed, not deny-by-default** — see §10. Anything outside the Bash regex + protected paths slips through.
7. **`mc_remote_ask` has no resume-by-default for caller-side restarts** — calls succeed but on caller crash the result is in peer's `data/pending/remote-chat/<requestId>.json`, fetchable via `mc_remote_recover`.
8. **Pending-file sweep targets ONLY `data/pending/remote-chat/`** — the main bridge writes its own `data/pending/<requestId>.json` files (no subdirectory). Don't write a sweep that targets `data/pending/` root with a `remote-` prefix filter; it'll delete bridge state for remote-caller turns.
9. **MCP server cache LRU cap = 50** — exceed 50 distinct sessionKeys and oldest commander/mem servers evict; re-creating causes a per-turn pause.
10. **All `mem/api.ts` capture functions previously swallowed exceptions silently.** Post `a8de092` they emit throttled `[mem] write failed` warnings — but only one per 30s, so a persistent failure may surface slowly.

## Coding rules when fixing MC bugs

1. **Always type-check** before committing: `npx tsc --noEmit -p tsconfig.json`. The build skips this for performance.
2. **Never re-enable minification** in `next.config.js`. SWC minifier loops on `ChatPanel.tsx`. Documented in the config comments.
3. **Don't drop `--max-old-space-size=16384`** from `npm run build`. Webpack OOMs without it.
4. **`pm2 restart mission-control` only** for code changes — `pm2 reload` doesn't drain in-flight queries; `kill_timeout: 60000` is set specifically so restart gracefully drains.
5. **HMR-safe install pattern**: any top-level `setInterval` / `process.on(SIGTERM)` MUST guard with a `Symbol.for(...)` global flag, or Next dev's module reloads stack handlers. See `lib/claude-chat-bridge.ts:60-67` for the canonical pattern.
6. **Test in dev mode first**: `npm run dev`, drive the broken surface, watch `pm2 logs --lines 100 --nostream` for new error patterns.
7. **Commit message format**: `fix(<scope>): <what> — <why>`. Scope is usually `chat`, `missions`, `mem`, `remote`, `approval`, `pwa`, `terminal`, or the file area.

## When you can't reproduce

If the user reports a bug you can't reproduce locally:
1. Get their `pm2 logs mission-control --lines 500 --nostream` output.
2. Get their `curl http://localhost:3001/api/git/status` to confirm git HEAD.
3. Get the contents of `~/.config/mc-remote-hosts.json` (token can be redacted).
4. Get the file mtime + size of `data/memory.db` and `data/<ns>-chat-sessions.json`.
5. Check their browser console errors.

These five together cover 90% of "works on my machine" gaps.

---

**End of skill.** If you've worked through the relevant sections and still can't fix the issue, search the `docs/HELP_GUIDE.md` recovery section (§18.x) for additional playbooks, then escalate as a GitHub issue with the diagnostic-sweep output attached.
