# Memory + Vault Integration

Integration of **claude-mem** (persistent session memory) and **kepano/obsidian-skills** (structured knowledge vault) into Mission Control.

---

## Design summary

Rather than run the upstream claude-mem worker (port 37777, separate SQLite, ChromaDB), MC reuses its existing `lib/memory-*` engine (better-sqlite3, FTS5, Xenova embeddings) and adds a thin `mem/` layer that mirrors claude-mem's API surface:

- 3-layer progressive disclosure (`search → timeline → get`)
- AI-compressed observations (durable learnings, separate from raw `turns`)
- Cross-session scope (chat / team-meta / team-agent)
- MCP tools and HTTP routes with claude-mem-compatible shape

Obsidian integration is file-first: the vault is a plain folder on disk, the agent reads/writes it through `vault_*` MCP tools, and the kepano obsidian-skills SKILL.md files teach it correct Obsidian syntax.

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Chat / Agent prompt                                            │
│  ├─ System prompt (preset)                                      │
│  ├─ Skills appendix (obsidian-markdown, obsidian-bases, …)      │
│  ├─ <recalled_context>       raw turn excerpts (memory-retrieve)│
│  ├─ <mem_observations>       compressed learnings (mem/api)     │
│  ├─ <vault_context>          relevant vault notes (vault/)      │
│  ├─ Key facts (existing)                                        │
│  ├─ Pastes / loaded docs                                        │
│  └─ Conversation turns                                          │
└────────────────────────────────────────────────────────────────┘
```

## New tables (migration #7)

| Table | Purpose |
|---|---|
| `mem_sessions` | Namespace for observations: `chat` / `team_meta` / `team_agent` / `manual`. Children link via `parent_session_id`. |
| `mem_observations` + `_fts` | AI-compressed learnings, 7 types, embedded. |
| `mem_prompts` + `_fts` | User-prompt index for "when did I ask about X?" lookups. |
| `mem_obs_queue` | Raw tool-use / tool-result buffer, compressed by `mem/tick`. |
| `vault_notes` + `_fts` | Optional vault index cache (disk is authoritative). |

## Files added

```
lib/mem/
  api.ts              — facade (injectContext, captureToolUse, generateSummary, search, …)
  sessions.ts         — CRUD for mem_sessions, scope resolver
  observations.ts     — create/search/timeline/get + queue drain
  compress.ts         — AI compression via Agent SDK (haiku); heuristic fallback
  tick.ts             — background processor for queued observations
  mcp-tools.ts        — mem_search / mem_timeline / mem_get / mem_save
lib/vault/
  config.ts           — vault path resolution (VAULT_PATH > settings.json > default)
  service.ts          — read/write/search/list with path-traversal hardening
  obsidian-md.ts      — frontmatter / wikilink / callout helpers
  mcp-tools.ts        — vault_search / vault_list / vault_read / vault_write / vault_status

app/api/mem/         — REST surface: search, timeline, observations, sessions, context, tick, summary
app/api/vault/       — REST surface: search, notes, note, config, save

components/MemoryVaultPanel.tsx  — human inspection UI
app/memory-vault/page.tsx        — standalone settings page at /memory-vault

docs/MEMORY-VAULT-INTEGRATION.md — this file
docs/VAULT-CONFIG.md             — setup guide

~/.openclaw/workspace/skills/
  obsidian-markdown/SKILL.md
  obsidian-bases/SKILL.md
  json-canvas/SKILL.md
  obsidian-cli/SKILL.md
  defuddle/SKILL.md
```

## Files changed

| File | Purpose |
|---|---|
| `lib/memory-schema.ts` | Added migration #7 (mem_sessions, mem_observations, mem_prompts, mem_obs_queue, vault_notes). |
| `app/api/chat/route.ts` | Create/touch chat mem session; capture user prompt; inject `<mem_observations>` + `<vault_context>` alongside `<recalled_context>`. |
| `lib/claude-chat-bridge.ts` | Register `mc-memory` + `mc-vault` MCP servers; tap tool_use / tool_result / assistant text streams to the queue; trigger compression at stream end. |
| `lib/teams/runner.ts` | Ensure per-agent mem session and team_meta session on `startTeam`; inject agent mem context into role prompt; register mem/vault MCP servers for each agent; capture tool events to the agent's mem queue; compress on agent close. |

## Lifecycle hook mapping (claude-mem ↔ MC)

| claude-mem hook | MC trigger |
|---|---|
| `context-hook` (SessionStart) | `buildPrompt()` — `retrieveForPrompt` + `injectContext` + `formatVaultHits`. |
| `user-message-hook` / `new-hook` | `ensureChatSession` + `captureUserMessage` on each POST /api/chat. |
| `save-hook` (PostToolUse) | Tool-use & tool-result taps in `claude-chat-bridge.ts` and `teams/runner.ts` → `mem_obs_queue`. |
| `summary-hook` (Stop) | `compressPendingForSession` at stream end / agent close. Explicit via `POST /api/mem/summary`. |
| `cleanup-hook` (SessionEnd) | `endSession` via `generateSessionSummary`. |

## MCP tools exposed

**Chat + every team agent:**

- `mem_search(query, type?, limit, all_sessions)` — layer 1 (titles + excerpts)
- `mem_timeline(observation_id?, limit, window_before, window_after)` — layer 2
- `mem_get(id)` — layer 3 (full content)
- `mem_save(type, title, content, tags?, files?)` — write durable observation
- `vault_search(query, limit)` — ripgrep over the vault
- `vault_list(prefix?, limit)` — recent notes
- `vault_read(path)` — note + frontmatter
- `vault_write(path, content, frontmatter?, overwrite?)` — write a note
- `vault_status()` — vault config / note count

## Memory isolation rules

- `mem_search` with a `sessionId` defaults to the **resolved scope**: the session + its `parent_session_id` + its direct children.
  - A chat session sees its own observations.
  - A team agent sees its own + the team_meta + siblings.
  - A team_meta session sees its own + all agents.
  - The Commander chat, if deployed from itself, sees: its chat observations + any team_meta that links under it.
- Pass `all_sessions: true` to bypass the scope and search globally (rarely needed).

## Token budget

Soft caps at injection time (in `buildPrompt` and `buildRoleSystemPrompt`):

- `<recalled_context>`: 8192 (new session) / 4096 (resumed) — existing `memory-retrieve`.
- `<mem_observations>`: 3500 tokens.
- `<vault_context>`: 2500 tokens.

If the sum approaches the model limit, trim first from older memory recall, then vault hits.

## Testing checklist

See `docs/VAULT-CONFIG.md` for setup. Then:

1. **Schema** — Start the dev server; check `data/memory.db` includes `mem_sessions`, `mem_observations`, `mem_obs_queue`, `vault_notes`.
2. **Chat session persistence** — Send a message. Confirm `POST /api/mem/sessions { kind:'chat', chat_id:<sessionKey> }` returns a stable id. Open `/memory-vault?chat=<sessionKey>` and watch observations accumulate as tools run.
3. **Compression** — After several messages, trigger `POST /api/mem/tick`. `GET /api/mem/timeline?session_id=<id>` should return entries with non-heuristic content.
4. **Prompt injection** — Send a follow-up question. In the server logs, confirm `<mem_observations>` appears in the outgoing prompt.
5. **Vault round-trip** — Set `VAULT_PATH` or configure via UI, then in chat ask the agent to "save our plan to the vault as 'Integration plan'". Confirm the file appears with frontmatter and wikilinks.
6. **Vault search injection** — Ask something that matches existing vault notes; confirm `<vault_context>` appears in the prompt.
7. **Constellation isolation** — Start a team; confirm each agent gets a distinct `mem_session` (one per agent + one team_meta). Observations should not cross between siblings.
8. **3-layer disclosure** — Ask the agent to "use mem_search to find past auth decisions, then mem_get the most relevant id." Confirm both tools fire.

## Known limitations / deferred work

- **Defuddle web fetch** — The skill is documented; the `defuddle` npm package is not yet added to `package.json`. Add when you actually need web clipping (`npm i defuddle`).
- **ChatPanel buttons** — No inline memory badge / "Save to Vault" button in the 7600-line ChatPanel yet. Access via `/memory-vault` route and via MCP tools. Inline buttons are a follow-up.
- **Vault indexer** — `vault_notes_fts` table exists but is not auto-populated; `searchVault` uses ripgrep directly. Add background indexer only if you need sub-50ms vault search.
- **Cross-chat observation pooling** — Works via `all_sessions:true` on `mem_search`. More sophisticated scoping (per-project) can be added on top of the `tags` column.
