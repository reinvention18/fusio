# Vault + Memory Configuration Guide

## 1. Pick your Obsidian vault

Choose one of:

**Option A — use an existing Obsidian vault.** Point MC at it:

```bash
# In Mission Control's .env.local (or shell env before PM2 start):
VAULT_PATH="/home/you/Documents/MySecondBrain"
```

**Option B — create a dedicated vault.** Leave `VAULT_PATH` unset; MC creates `~/Documents/MissionControl-Vault/` on first write. Open that folder in Obsidian (**File → Open vault**).

**Option C — configure via UI.** Open `http://localhost:3001/memory-vault`, paste the path in the **Vault path** field, click **Save**. Persists to `data/mission-control-settings.json`.

Precedence: `VAULT_PATH` env > `data/mission-control-settings.json` > default `~/Documents/MissionControl-Vault`.

## 2. Verify

```bash
curl -s http://localhost:3001/api/vault/config | jq
# => { "settings": { "path": "...", "enabled": true, ... }, "exists": true }
```

## 3. Obsidian skills

The 5 kepano obsidian-skills SKILL.md files are installed at `~/.openclaw/workspace/skills/`:

- `obsidian-markdown/`
- `obsidian-bases/`
- `json-canvas/`
- `obsidian-cli/`
- `defuddle/`

MC's existing skill loader (`lib/claude-sdk-session.ts:85–119`) picks them up automatically and appends them to every new-session system prompt (30KB total cap, 3KB per skill). To **disable one**, `touch ~/.openclaw/workspace/skills/<name>/.disabled`.

## 4. Memory

Nothing to configure. The memory engine runs in-process with MC; the schema migrates on first boot. To observe:

```bash
# 3-layer search
curl -s 'http://localhost:3001/api/mem/search?q=authentication' | jq

# Timeline for a session
curl -s 'http://localhost:3001/api/mem/timeline?session_id=<uuid>' | jq

# Force-compress pending observations
curl -s -X POST http://localhost:3001/api/mem/tick | jq
```

## 5. Optional — periodic compression tick

The chat / team stream ends already trigger compression. For idle sessions, add a cron or PM2 scheduled task:

```bash
# every 5 min
*/5 * * * * curl -s -X POST http://localhost:3001/api/mem/tick > /dev/null
```

## 6. Defuddle (optional web clipping)

Only needed when the agent fetches external URLs and you want them saved cleanly:

```bash
cd <MC_DIR>
npm i defuddle
```

The `defuddle` SKILL.md already documents usage; the agent will invoke it through Bash.

## 7. Privacy controls

- Exclude a specific chat from memory recall:

  ```bash
  curl -s -X POST http://localhost:3001/api/memory/disable \
    -H 'Content-Type: application/json' \
    -d '{"chatId":"<sessionKey>"}'
  ```

- Inspect or delete observations via `GET`/`DELETE` against the raw SQLite:

  ```bash
  sqlite3 data/memory.db 'SELECT id, type, title FROM mem_observations ORDER BY id DESC LIMIT 20;'
  ```

## 8. Reset

```bash
# Full memory reset (DANGEROUS — nukes ALL memory)
rm data/memory.db data/memory.db-wal data/memory.db-shm

# Vault reset — just delete the vault folder (your notes will be gone)
rm -rf "$VAULT_PATH"
```
