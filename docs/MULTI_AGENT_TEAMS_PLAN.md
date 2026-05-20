# Mission Control — Multi-Agent Teams: Comprehensive Build Plan

**Date:** 2026-04-11
**Author:** Claude (research + synthesis)
**Status:** **v2 — pre-implementation design locked.** All 11 blocking gaps + 4 critical hidden couplings from the audit are resolved. Migration SQL verified against a backup of production `memory.db`.
**Scope:** Add a first-class "team of agents" feature to Mission Control so the user can run 3–8 specialized Claude agents in parallel on one or more projects, watch them live, review their work, and merge it.

---

## v2 DECISIONS LOCKED — READ THIS FIRST

Everything below this box was written during research. The box is the ground truth for implementation. Where the older sections and the box disagree, **the box wins**.

### D1. Runtime model: **Option C — MCP-driven autonomous loop (with Option B escape hatch)**
Each worker agent is one long-lived `query()` call whose `prompt` is an `AsyncIterable<SDKUserMessage>` the runner controls. The agent's system prompt instructs it to loop: call `mc_get_next_task` → do the work → call `mc_submit_task_result` → repeat until `{status:'halt'}`. The dispatcher does NOT push; workers pull via the MCP tool. The pattern is verified against the real SDK source (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1891` for `AsyncIterable` prompt, `:1237` for `Options.mcpServers`, `:403–414` for `createSdkMcpServer`, `:4490` for `tool()`). The in-process MCP server is created inside `runAgent()` so its handlers close over `{teamId, agentId}` — every agent gets its own tool set bound to its own identity.

**Escape hatch (Option B):** the runner retains an `inputQueue.enqueue(userMessage, {priority:'now'|'next'|'later'})` method (`SDKUserMessage.priority`, `sdk.d.ts:2918–2931`) for human overrides: `@inspector` mentions from chat, halt commands, budget-exceeded notices. Never the primary driver.

### D2. Commander binding: **Commander IS the chat session, not a separate runner.**
The Agent SDK does **not** support two callers resuming the same `session_id` simultaneously — verified by reading `sdk.d.ts` and observing that `lib/claude-chat-bridge.ts:211–216` already kills-and-respawns any existing query for a session before starting a new one. Async generators can't be multi-iterated, the CLI spawns one subprocess per `query()`, and session JSONL files would corrupt on concurrent writes.

**Resolution:** Commander never "inherits" the chat session. Commander *is* the existing chat session, augmented with an `mc-commander` MCP server registered at `spawnClaudeStream` time, exposing `mc_create_team`, `mc_list_teams`, `mc_team_status`, `mc_diff_task`, `mc_approve_task`, `mc_reject_task`, `mc_halt_team`, `mc_send_to_agent`. The user types `"spin up a Feature constellation on X"` in chat; the same Claude Code session that was already their chat picks up the new tools and calls `mc_create_team(...)` which launches the worker agents via `runAgent()`. Workers coordinate via SQLite rows, so Commander observes/controls them through the same rows exposed as Commander-flavored MCP tools. Zero binding logic. Zero multi-driving.

### D3. Inspector/Codex integration: **custom `mc_codex_review` MCP tool that shells out to `codex-companion.mjs`.**
The `openai/codex-plugin-cc` source (now at `~/mc-research/codex-plugin-cc/`) confirms the plugin is a **pure Claude Code CLI plugin bundle**, not an MCP server. Its `/codex:review` commands are CLI-only constructs (markdown files at `plugins/codex/commands/*.md` that the Claude Code CLI expands before sending to the model). Agent SDK's `query()` does NOT expand slash commands — if a Sonnet agent types `/codex:review` into its output, nothing happens.

**Resolution:** Bypass slash commands entirely. The Inspector's MCP server (created via `createSdkMcpServer`) adds one extra tool:

```ts
tool('mc_codex_review',
  'Run Codex read-only review of the current branch vs main and return structured findings.',
  {
    mode: z.enum(['standard','adversarial']).default('adversarial'),
    base: z.string().default('main'),
    scope: z.enum(['auto','working-tree','branch']).default('branch'),
    focus: z.string().optional()
  },
  async (args) => {
    const out = await spawnCodex([
      'node', CODEX_COMPANION_PATH,
      args.mode === 'adversarial' ? 'adversarial-review' : 'review',
      '--wait', '--base', args.base, '--scope', args.scope,
      ...(args.focus ? [args.focus] : [])
    ], { cwd: inspector.worktree_path });
    // adversarial mode returns JSON matching codex-plugin-cc/plugins/codex/schemas/review-output.schema.json
    // standard mode returns free-form markdown
    const parsed = args.mode === 'adversarial'
      ? JSON.parse(out.stdout)
      : { verdict: 'needs-attention', summary: out.stdout, findings: [] };
    await teamsDB.persistReview(currentTaskId, parsed, args.mode);
    return { content: [{ type: 'text', text: JSON.stringify(parsed) }]};
  })
```

`CODEX_COMPANION_PATH` points to `~/mc-research/codex-plugin-cc/plugins/codex/scripts/codex-companion.mjs` (or a copy installed in the MC repo). **Prereqs surfaced at first run:** Node ≥18.18, `npm i -g @openai/codex` executed, `codex login` completed. MC checks `~/.codex/auth.json` existence and shows a blocking "Install Codex" modal if missing.

**Output schema for adversarial mode** (from `schemas/review-output.schema.json`):
```json
{
  "verdict": "approve" | "needs-attention",
  "summary": "...",
  "findings": [{
    "severity": "critical"|"high"|"medium"|"low",
    "title": "...", "body": "...",
    "file": "src/foo.ts", "line_start": 42, "line_end": 58,
    "confidence": 0.0..1.0,
    "recommendation": "..."
  }],
  "next_steps": ["...", "..."]
}
```

Inspector writes each review to `task_reviews` and each finding to `task_review_findings` (both tables in migration #3). The severity set in the schema maps directly to the column's CHECK constraint.

### D4. Task state machine — the canonical version
Supersedes the ambiguous `'review'` / `'ready_for_review'` language in earlier sections.

```
                        ┌──────────────── stale_reaper ─────────────┐
                        │  (claimed|in_progress, claimed_at < now-5m)│
                        ▼                                            │
  pending ─ mc_get_next_task ─▶ claimed ─ first tool_use ─▶ in_progress
                                                               │
                                                               ├─ submit(ready_for_review) ─▶ ready_for_review
                                                               ├─ submit(blocked) ────────┐
                                                               └─ submit(failed) ───────┐ │
                                                                                        │ │
                                      ready_for_review ─ Sentinel exit 0 ─▶ review      │ │
                                                       └ Sentinel exit 2 ─▶ blocked ◀───┤ │
                                                                                        │ │
                                      review ─ Inspector clean ─▶ approved              │ │
                                             └ Inspector critical ─▶ blocked ◀──────────┘ │
                                                                                          │
                                      approved ─ merge lane ─▶ merging                    │
                                                               ├ conflict ─▶ blocked ◀────┘
                                                               └ success  ─▶ done
  blocked ─ agent revises, child task created with parent_task_id ─▶ pending ─▶ ...
  failed  = terminal, retry_count exhausted
  cancelled = user-initiated, terminal
```

Every transition is a single SQL `UPDATE team_tasks SET status=? ... WHERE id=? AND status=?` gated on the source state. The column CHECK constraint (migration #3) prevents invalid values. The status column is the single source of truth; there is no in-memory task-state cache.

### D5. sessionKey namespacing scheme
- **Chat sessions:** `mc-<uuid>` (unchanged, current format).
- **Team agents:** `team:<team_id>:<role_handle>` — e.g. `team:01HXX4...K:builder-1`, `team:01HXX4...K:inspector`.
- **The bridge's kill-on-reentry** at `claude-chat-bridge.ts:211–216` is modified: it only kills existing queries whose sessionKey starts with `mc-` (chat sessions). Team sessions are NEVER killed by that path — the team runner is the only driver and uses an explicit `handle.close()`.
- **`/api/stop?sessionKey=X`** checks the prefix: if `team:*`, it refuses (returns 409 with `{error:'use /api/teams/:id/halt'}`) to prevent accidentally killing a team Commander.
- **`mc_subagents` table** (migration #3) has nullable `team_id`, `team_agent_id`, `team_task_id` FKs. The `SubAgentTracker` UI in `ChatPanel.tsx` filters `WHERE team_id IS NULL` for chat context and ignores team subagents; the Constellation tab's equivalent component filters `WHERE team_id = ?`.
- **SSE event type namespacing:** the team runner emits `type:'team_event'` wrappers around raw SDK messages (`{ type:'team_event', teamId, agentId, payload: <raw SDK msg> }`) so the existing `SubAgentTracker.tsx` parser — which handles `type:'subagent'` — does not pick them up by accident.

### D6. JSON state → SQLite migration
Resolves hidden coupling #4 (JSON file write races are fatal under parallel agents).

- **`data/mc-subagents.json` → `mc_subagents` table** (migration #3). The store module `lib/mc-subagents-store.ts` is refactored: `recordStart`, `recordFinish`, `listRuns`, `gc` all hit SQLite. Function signatures preserved for backward compat with existing callers in the bridge. On first boot after migration, a one-shot `migrateLegacyJson()` reads `mc-subagents.json` if present, `INSERT OR IGNORE`s into the table, and renames the file to `.bak`.
- **`data/active-tasks.json` → `active_tasks` table** (migration #3). Same pattern. `active_tasks.session_key` ties each row to a chat. `active_tasks.promoted_team_id` is the FK that lets a Workshop task be "promoted" into a Constellation team — this is how the existing Workshop UI continues to work and gains the ability to hand off personal kanban tasks to a real team.
- **`data/claude-code-sessions.json` stays as-is.** It's a tiny flat map, rarely written, and the fix is orthogonal. Team agents persist their `session_id` directly to `team_agents.session_id` instead.
- **GC:** the dispatcher's periodic tick (every 30s) calls `gcSubagents()` which deletes completed rows >7 days old. The old JSON file had this function defined but never called; the SQLite version actually runs it.

### D7. Commander MCP tools
The Commander doesn't need a custom runner — it's the chat session with extras. But it does need its own MCP tool set. Registered in `spawnClaudeStream()` when the chat detects a "team context" (either an active `parent_chat_key` match in `teams`, or an explicit `?teams=1` flag). The tool surface:

| Tool | Purpose |
|---|---|
| `mc_create_team(name, preset, goal, roles[], budget_usd)` | Spawns worker agents. Returns team_id. |
| `mc_list_teams(status?)` | Returns all un-archived teams, optionally filtered. |
| `mc_team_status(team_id)` | Returns `{ team, agents[], pending, in_progress, review, done }`. |
| `mc_list_tasks(team_id, status?)` | Returns tasks filtered by status. |
| `mc_get_task(task_id)` | Full task detail including diff and reviews. |
| `mc_diff_task(task_id)` | Returns the task's worktree diff vs main. |
| `mc_approve_task(task_id, merge?: boolean)` | Moves to `approved`; optionally auto-merges. |
| `mc_reject_task(task_id, reason)` | Moves to `cancelled`. |
| `mc_revise_task(task_id, feedback)` | Creates child task with `parent_task_id`, enqueues for Builder. |
| `mc_send_to_agent(agent_id, body, priority)` | Injects a user message into the target agent's input queue. |
| `mc_halt_team(team_id, reason?)` | Pauses (reversible) the team. |
| `mc_resume_team(team_id)` | Resumes. |
| `mc_merge_all_approved(team_id, lane)` | Runs the merge lane for every approved task. |
| `mc_update_scratchpad(team_id, content)` | Commander can write to team memory. |

Because the Commander MCP server is registered inline with the chat's `query()` call, the user experience is: they keep typing in their normal chat. Claude Code (as Commander) calls these tools when appropriate. The user sees Commander's reasoning + tool output in the same SSE stream they were already watching.

### D8. Hot-reload and server-restart survival
The Next.js dev server's hot-reload replaces the module graph. To survive:
- `activeRunners: Map<agentId, RunnerHandle>` lives on `globalThis.__mcTeams` (Prisma-style dev-mode guard).
- `lib/teams/boot.ts` runs once on module load. It: (a) reads `SELECT * FROM teams WHERE status='running' AND archived_at IS NULL`, (b) for each agent in non-terminal status, calls `runAgent(agentRow)` with `Options.resume: agent.session_id`, (c) the SDK rehydrates the conversation from its JSONL, (d) the first injected user message on resume is *"Server restarted. Resume your task loop — call `mc_get_next_task` now."*
- The stale-claim reaper runs before boot completes. Any task in `claimed`/`in_progress` with `claimed_at < now-5min` reverts to `pending` so the resumed agent re-claims naturally.

### D9. Budget enforcement
- **Where cost comes from:** the SDK emits `result` messages with a `usage` field (confirmed in `claude-chat-bridge.ts:584`). Each includes input_tokens, output_tokens, cache_creation/read tokens. Plus a `total_cost_usd` field — we use this directly instead of recomputing from a rate table.
- **When it's checked:** inside `runAgent`'s drain loop, on every `result` message. Atomic: `UPDATE team_agents SET tokens_in=tokens_in+?, tokens_out=tokens_out+?, cost_usd=cost_usd+? WHERE id=?; UPDATE teams SET spent_usd=spent_usd+? WHERE id=? RETURNING spent_usd, budget_usd;`. If the returned `spent_usd >= budget_usd`, the runner calls `pauseTeam(teamId, 'budget_exceeded')`.
- **Pause semantics:** (a) flip `teams.status='paused'` and `teams.pause_reason='budget_exceeded'`, (b) for each running agent, `handle.send('Budget exceeded. Finish current tool call and call mc_submit_task_result with status=blocked and blocker="budget_exceeded".', {priority:'now'})`, (c) 15s grace, (d) if still running, `handle.close()`. All sessions preserved for resume.
- **Codex cost** is not reported by the plugin (`codex-companion.mjs` doesn't expose token counts). We estimate $0.50–$1.50 per adversarial review based on the plugin's config default, annotate it on `task_reviews.cost_usd`, and surface it separately in the cost badge (the chart shows "Claude spend" and "Codex spend" stacked).

### D10. Hook execution contract
`TaskCompleted` hooks are stored as `teams.settings_json.hooks.taskCompleted: {cmd: string, args: string[]}` (array form, not shell string — prevents injection). Execution contract:

| Property | Value |
|---|---|
| spawner | `child_process.spawn(cmd, args, opts)` (no shell) |
| cwd | task's `worktree_path` |
| env | parent env + `MC_TASK_ID`, `MC_TEAM_ID`, `MC_AGENT_ID`, `MC_WORKTREE`, `MC_FILES_TOUCHED` (JSON array), `MC_BRANCH_NAME`, `MC_BASE_BRANCH` |
| stdin | closed |
| stdout/stderr | captured up to 64KB each, stored in `team_events.payload` with `kind='hook_run'` |
| timeout | `teams.settings_json.hooks.taskCompleted.timeout_ms` (default 600000 / 10min) |
| exit codes | `0`=pass → task → `review`. `2`=block → task → `blocked`, stderr becomes `status_reason`. any other non-zero → task → `blocked` with "hook infrastructure error". |
| default command | `['pnpm', ['-C', '$MC_WORKTREE', 'test', '--filter', '$MC_FILES_TOUCHED']]` (overridable per team) |

The hook runner lives in `lib/teams/hooks.ts`. It is **NOT** the SDK's hook system (which is Claude Code CLI scoped) — it's our own per-task execution wrapper. The SDK's hooks are Claude Code CLI only, not available to Agent SDK sessions.

### D11. Status detection via output hash (verified cheap)
Every 500ms the runner's `StatusDetector` computes `sha256(last 4KB of this agent's SSE output buffer)`. Three classes:
- Hash unchanged for ≥5 seconds AND agent isn't mid-tool-call → `idle`
- Hash changing AND tool_use active → `working`
- Output contains known "awaiting input" strings → `needs_input`. Match list (ported from `claude-squad/session/tmux/tmux.go:235–256`):
  - Claude: `"No, and tell Claude what to do differently"`
  - Aider: `"(Y)es/(N)o"`
  - Gemini: `"Yes, allow once"`
  - Plus Mission Control's own: `"Permission required to"`, `"Would you like me to proceed"`
- Writes result to `team_agents.last_output_hash` and `team_agents.status`.

### D12. Gap resolution index → see §16 for the full 62-item table

---

---

## 1. TL;DR

Mission Control already has the hard parts: a streaming chat built on `@anthropic-ai/claude-agent-sdk`, a SQLite memory store, an SSE infrastructure that observes subagent tool calls in real time, and ~50 UI panels. What it lacks is **parallelism, isolation, and coordination** — there's no worktree-per-agent, no task dispatcher, no shared team state, and no multi-agent UI.

After deep-diving three reference projects — `parallel-code` (Electron + SolidJS desktop), `claude-squad` (Go + tmux TUI), and `claude-flow` (Node "hive-mind" swarm) — the pattern that actually wins is:

> **Git worktree per agent + shared SQLite task list + one Agent-SDK session per agent + real terminal for "focus pane" + hooks for quality gates.**

Anything fancier (Raft consensus, Byzantine voting, CRDTs, WASM agent boosters) is over-engineered for a 5–8 agent use case. This plan builds the 80/20 core in ~2–3 weeks of focused work, layered on top of the existing `claude-chat-bridge.ts`.

---

## 2. Current Mission Control architecture (the foundation)

Location: `<MC_DIR>/`
Stack: Next.js 15, React 19, TypeScript, `@anthropic-ai/claude-agent-sdk`, `better-sqlite3`, xterm.js, Tailwind.

### 2.1 What's strong (keep it)
- **`lib/claude-chat-bridge.ts` (663 lines)** — the whole Agent SDK integration. Calls `query()`, maps `sessionKey` → SDK `session_id` in `data/claude-code-sessions.json`, converts async generator → SSE, auto-recovers stale sessions, loads workspace skills as system prompt. Already observes `Task`/`Agent` tool_use blocks and records them to `data/mc-subagents.json` with `recordSubagentStart/Finish`. **This is the single most reusable piece in the app.**
- **`app/api/chat/route.ts`** — dedupes context, offloads large pastes, wraps the bridge in SSE, runs memory recall for new sessions.
- **`lib/memory-db.ts` + `lib/memory-schema.ts`** — `data/memory.db` with `turns`, `episodes`, FTS5, HNSW-ish hybrid recall. Already production-quality.
- **`components/SubAgentTracker.tsx`** — dropdown that reads the SSE `stream_event` firehose and shows running subagents with model badges, elapsed time, result previews.
- **`components/ClaudeCodeTerminal.tsx`** — xterm.js integration already works.
- **~50 panels** — `TeamsPanel`, `AgentHub`, `Workshop`, `SubAgentTracker`, `SkillsManager`, `UsageStats`, etc. Plenty of surfaces to extend.

### 2.2 What's weak (gaps to close)
- `lib/agents.ts` — deprecated localStorage personas.
- `lib/claude-code-teams.ts` — just polls `.claude/teams/` and `.claude/tasks/` as read-only filesystem state. No create/update/dispatch.
- `lib/claude-code-runner.ts` — a state machine for sessions with no spawn logic.
- `TeamsPanel.tsx`, `AgentHub.tsx`, `Workshop.tsx` — UI shells without runtime wiring.
- **No worktree manager.** All agent activity happens in one `cwd`.
- **No parallel execution.** Subagents run serially inside one chat.
- **No cost/budget tracking.** No hard caps.
- **No role library.** Agents have no declared skills; dispatch is manual.
- **No quality gates.** No hooks on task completion.
- **No team-aware persistence.** `mc-subagents.json` flattens all subagents with no team context.

---

## 3. Ecosystem research summary

### 3.1 The projects that matter (April 2026)

| Project | Stars | Pattern | Key idea |
|---|---|---|---|
| **ruvnet/claude-flow** | ~31k | Hive-mind swarm | SQLite `.swarm/memory.db`, queen/worker coordinator, Raft consensus (real), SONA learning (real), ~150 MCP tools. Over-engineered for <10 agents but the memory schema is worth stealing. |
| **smtg-ai/claude-squad** | ~7k | Tmux + worktree TUI | Go Bubble Tea TUI. One tmux session + one worktree per agent. Status via pane-hash polling every 100ms. The canonical pattern. |
| **johannesjo/parallel-code** | ~512 | Electron + SolidJS desktop | Worktree per task with `node_modules` symlinked, PTY batching, safe-merge with detached-HEAD checks, Tailscale/QR remote access. The closest precedent to Mission Control. |
| **wshobson/agents** | ~33k | Role library | 182 agent personas, 3-tier model strategy (Opus/Sonnet/Haiku), 16 team presets. |
| **VoltAgent/awesome-claude-code-subagents** | ~popular | Role library | 100+ drop-in markdown role files. |
| **SuperClaude_Framework** | ~popular | Configuration framework | Cognitive personas + MCP servers (Context7, Sequential, Magic, Morphllm). |
| **BMAD-METHOD** | ~popular | Methodology | Document sharding + 9 persona agents. |
| **claude-code-router** | ~popular | Proxy | Routes per-request to different backends/models for cost control. |
| **Agent Teams (official)** | — | Experimental Claude Code feature | Shared task list with file-locked self-claim, peer messaging, `TeammateIdle`/`TaskCreated`/`TaskCompleted` hooks. Gated by `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. First official primitive for peer coordination. |

### 3.2 Anthropic primitives we actually build on

- **Agent SDK `query({ agents })`** — pass an `AgentDefinition` array, parent must include `"Agent"` in `allowedTools`. Subagents can't spawn subagents (hard ceiling). Sessions resumable via `resume: sessionId`.
- **Filesystem subagents** — `.claude/agents/*.md` (project) or `~/.claude/agents/*.md` (user). YAML frontmatter: `name`, `description`, `tools`, `model`. Loaded at startup.
- **Agent Teams (experimental)** — `~/.claude/teams/{team}/config.json`, `~/.claude/tasks/{team}/`. Shared task list, mailbox, hooks. Caveats: no nesting, split-pane needs real tmux.
- **Hooks** — `PreToolUse`, `PostToolUse`, `Stop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`. Exit code 2 blocks. The supported way to enforce "tests must pass."
- **MCP servers** — the shared service layer. One MCP server exposing docs/DB/scratchpad, mounted into every teammate.
- **Skills** — progressive-disclosure knowledge packs. Not inherited by subagents-as-teammates (known gotcha).

### 3.3 The six patterns that recur

1. **Git worktree per agent** — every serious tool landed here. Non-negotiable.
2. **Orchestrator → workers** — Anthropic's research system reports +90% on research tasks vs single Opus, at **~15× token cost**. Token spend explains ~80% of the gain.
3. **Shared task list with self-claim** — pull model, not push. File locks.
4. **Filesystem/git as the bus** — crash-safe, resumable.
5. **Role = markdown file with YAML frontmatter** — won.
6. **In-process subagent delegation** — good for research fanout, bad for long-lived parallel coders.

### 3.4 The pain points everyone hits

- **Token blowout** — 15× baseline. Hard budget caps are mandatory.
- **Merge collisions** on shared files — worktrees solve it.
- **Cascading errors** — "statefulness compounds errors." Checkpoint, don't retry-from-scratch.
- **Lead finishes early** or starts doing the work itself.
- **"50 agents for a 3-line fix"** — default small, scale only on complexity.
- **Multi-agent is wrong for most coding.** It wins for breadth-first research, cross-layer refactors, and competing-hypothesis debugging. For linear coding, single session + subagents is faster.

---

## 4. Deep code dives — what we learned from the top 3 repos

I cloned all three into `~/mc-research/` and had agents read the actual source.

### 4.1 `parallel-code` (the closest precedent)

**Architecture:** Electron main ↔ preload ↔ renderer. Main owns all PTY/git/fs. Renderer is stateless SolidJS. Communication via ~60 typed IPC channels in `electron/ipc/channels.ts`.

**Worktree lifecycle (`electron/ipc/git.ts`):**
- `createWorktree(repoRoot, branchName, symlinkDirs, baseBranch)` at line 366.
- Path convention: **`.worktrees/{branchName}`** relative to repo root.
- Branch naming: `{prefix}/{slug}-{6-char-uuid}` (line 6–30, `tasks.ts`).
- **Symlink list** (git.ts:94–104): `.claude`, `.cursor`, `.aider`, `.copilot`, `.codeium`, `.continue`, `.windsurf`, `.env`, `node_modules`. Only the ones that are git-ignored get symlinked (detected via `git check-ignore`).
- `.claude` uses **shallow symlink**: a real dir with individual entries linked *except* `plans` and `settings.local.json` (so each agent still gets its own local settings).
- **Per-repo lock** via Promise chaining (`withWorktreeLock` at git.ts:72–90) prevents concurrent merges on the same repo.
- **Safe merge** (`mergeTask` at git.ts:899–1005): verifies branch is not detached HEAD, verifies project root is clean, runs `git diff --numstat` for stats, checks out main, does `merge` or `merge --squash`, restores original branch on failure, aborts on conflict with `git merge --abort`, returns conflict list to UI.

**Agent spawning (`electron/ipc/pty.ts`):**
- Uses **`node-pty`**, not `child_process.spawn`. Each agent is a real PTY (`xterm-256color`, configurable rows/cols).
- Command is bare (`claude`, not `sh -c claude`), validated against shell metacharacters.
- **Output batching**: ≥64KB chunks flush immediately, <1KB chunks (interactive prompts) flush immediately, everything else batches on 8ms timer. Sends as `{ type: 'Data', data: base64 }` IPC messages.
- Also maintains a scrollback `RingBuffer` for remote monitoring (Tailscale/QR feature).
- **Idle detection is implicit** — renderer polls `CountRunningAgents` and infers from `lastOutput` recency.
- **Path fix** (`electron/main.ts:26–44`) — sources user's login shell PATH so PTY finds `claude`. Critical gotcha.

**Task model (`src/store/types.ts:35–60`):**
```ts
interface Task {
  id: string;
  name: string;
  projectId: string;
  branchName: string;
  worktreePath: string;
  agentIds: string[];
  shellAgentIds: string[];
  notes: string;
  lastPrompt: string;
  initialPrompt?: string;
  closingStatus?: 'closing' | 'removing' | 'error';
  gitIsolation: 'worktree' | 'direct';
  baseBranch?: string;
  dockerMode?: boolean;
  planContent?: string;
}
```
Persisted as JSON at `{appDataDir}/parallel-code/state.json`. No queue — tasks spawn immediately. Drag-reordered tiles.

**UI patterns:**
- `TilingLayout.tsx` — flex row of `ResizablePanel`s, drag-drop via custom `dragReorder` lib. No heavy grid library.
- `TaskPanel.tsx` — top = notes + branch info, bottom = terminal.
- `DiffViewerDialog.tsx` — uses Monaco Editor in read-only mode with custom `ScrollingDiffView`. Parses unified diff format. Fetches via `GetAllFileDiffsFromBranch` IPC.
- `MergeDialog.tsx` — squash toggle, cleanup toggle, custom message, conflict list with "View Diff" button.

**Remote access:**
- `electron/remote/server.ts` — HTTP + WebSocket on configurable port. Random 24-byte base64 token, timing-safe comparison.
- Scans `os.networkInterfaces()` for Tailscale (`100.*`) or WiFi IPs.
- Endpoints: `GET /`, `GET /api/agents`, `GET /api/agent/:id/output`, `WebSocket /ws`.
- QR code encodes `http://{ip}:{port}?token={base64}`.

**The 5 files worth reading:**
1. `electron/ipc/git.ts` (1198 lines)
2. `electron/ipc/pty.ts` (740 lines)
3. `src/store/tasks.ts` (584 lines)
4. `electron/ipc/channels.ts` (111 lines, single source of truth for RPC)
5. `src/components/TilingLayout.tsx` + `TaskPanel.tsx`

**What translates to Next.js, what doesn't:**
- ✅ Worktree + symlink strategy (1:1)
- ✅ Safe-merge pattern (1:1)
- ✅ Per-repo Promise-chain lock (1:1)
- ✅ Diff parsing (1:1)
- ✅ Output batching logic (1:1 — use same thresholds on the server side)
- ❌ node-pty on the client → we already use SSE + streaming on the server, so agents run server-side and we stream to the browser
- ❌ Electron IPC channels → replace with Next.js App Router API routes (`app/api/teams/*`) + SSE/WebSocket
- ❌ Direct `fs` from the UI → everything goes through API routes

### 4.2 `claude-squad` (the canonical worktree pattern)

**Architecture:** Go + Cobra + Bubble Tea TUI. `main.go` dispatches three modes: default TUI (`app.Run()`), `--daemon` (background auto-yes), and utility commands.

**Session = `Instance` struct (`session/instance.go:31–68`):**
```
Instance {
  Title, Path, Branch, Status (Running/Ready/Loading/Paused),
  Program, Height, Width, CreatedAt, UpdatedAt, AutoYes, Prompt,
  tmuxSession, gitWorktree
}
```

**Start flow (`instance.go:202–274`):**
1. `tmux.NewTmuxSession(title, program)`
2. `git.NewGitWorktree()` → `gitWorktree.Setup()` → `git worktree add -b <branch> <path> HEAD` (`worktree_ops.go:13–36`)
3. `tmuxSession.Start(worktreePath)` → `tmux new-session -d -s <name> -c <path> <program>` (`tmux.go:91–153`)
4. Sets `history-limit 10000` and enables mouse on the tmux session
5. Status → Running

**Worktree path convention:** `~/.claude-squad/worktrees/{sanitized_branch_name}_{nano_timestamp}/`
**Branch naming:** `{BranchPrefix}{SessionTitle}`, sanitized (spaces and dots removed).

**Status detection (the clever bit, `instance.go:326–331` → `tmux.go:235–256`):**
- Every **100ms**, capture tmux pane: `tmux capture-pane -p -t <session>`.
- SHA256 the output. If the hash changed since last tick → "updated."
- If it contains a known prompt string → "needs input." Prompt strings:
  - Claude: `"No, and tell Claude what to do differently"`
  - Aider: `"(Y)es/(N)o"`
  - Gemini: `"Yes, allow once"`
- This is how `--daemon` mode auto-taps Enter. No LLM, no OpenTelemetry — just string matching on pane output.

**Pause/Resume (`instance.go:412–525`):**
- **Pause:** if dirty, commit locally with auto-generated message. `git worktree remove`. **Preserves branch.**
- **Resume:** re-create worktree from same branch. Re-attach PTY to existing tmux session if alive.

**Persistence:** `~/.claude-squad/state.json` with `instances[]` array including `worktree` object and `diff_stats { added, removed, content }`. Loaded on startup via `storage.LoadInstances()` → calls `Start(false)` to re-attach.

**TUI event loop (`app/app.go:196–340`):**
- `previewTickMsg` fires every 100ms. Calls `instanceChanged()`, which kicks a background goroutine to run `ComputeDiff()` on all instances (async so render isn't blocked). Result posted back via `metadataUpdateDoneMsg`.
- Diff computed by running `git add -N .` then `git diff <base_commit_sha>`.

**Diff rendering (`ui/diff.go:18–137`):** ANSI-colored lipgloss output of raw `git diff`. Counts `+`/`-` lines. Scrollable viewport (shift+↑/↓ or wheel).

**Keybindings (`keys/keys.go:34–52`):**
- `n` / `N` — new (N = with initial prompt)
- `D` — kill selected
- `c` — checkout (pause + commit)
- `r` — resume
- `p` — push branch
- `↵/o` — attach interactively
- `tab` — toggle preview ↔ diff pane

**Daemon (`daemon/daemon.go:19–88`):**
- Loads all instances, sets `AutoYes=true`, polls every `DaemonPollInterval`, for each running instance: `HasUpdated()` → if pane changed and has prompt, `TapEnter()`. Recomputes diff stats on every tick. Saves on SIGINT/SIGTERM.
- Lifecycle: main TUI launches as detached child via `LaunchDaemon()` (`main.go:64`), PID stored at `~/.claude-squad/daemon.pid`, existing daemon killed on main TUI startup.

**The web folder is a marketing page.** Not a dashboard. No API.

**What translates:**
- ✅ `Instance` state machine → port to a TypeScript `Agent` class
- ✅ Pause/resume pattern (preserve branch, drop worktree, recreate on resume)
- ✅ Status detection via **output hash polling** — this is the cheapest and most reliable trick in the ecosystem. Poll the SSE stream buffer every 100–500ms, hash it, compare. Detect idle vs working vs needs-input.
- ✅ Diff stats via `git add -N . && git diff <base_sha>` with +/- counting
- ✅ Keyboard shortcuts and state machine (`stateDefault`, `stateNew`, `statePrompt`, `stateHelp`, `stateConfirm`)
- ✅ Persistence schema (instances array + diff stats)
- ❌ tmux — we don't need it. Agent SDK gives us a better abstraction. The only reason `claude-squad` uses tmux is because it wraps a CLI it can't control directly; we control the SDK.
- ❌ PTY attach — we use xterm.js in the browser hooked to the SSE stream instead.
- ❌ `send-keys` keystroke injection — Agent SDK `query()` takes prompts directly.

### 4.3 `claude-flow` (worth stealing selectively)

**Current code path:** `v3/@claude-flow/*` packages. `v2` and `ruflo` are legacy.

**Memory schema (`v3/@claude-flow/memory/src/sqlite-backend.ts:619–657`) — worth copying:**
```sql
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  content TEXT,
  type TEXT,
  namespace TEXT,
  tags TEXT,          -- JSON
  metadata TEXT,      -- JSON
  owner_id TEXT,
  access_level TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  expires_at INTEGER,
  version INTEGER,
  references TEXT,    -- JSON
  access_count INTEGER,
  last_accessed_at INTEGER
);
CREATE TABLE memory_embeddings (
  entry_id TEXT PRIMARY KEY,
  embedding BLOB      -- Float32Array
);
```
Indexes on `namespace`, `key`, `(namespace, key)`, `type`, `owner_id`, `created_at`, `updated_at`, `expires_at`. Uses SQLite WAL mode for concurrent writes — no broker needed.

**Agent definitions (`agents/*.yaml`):** Dead simple YAML — `type`, `version`, `capabilities`, `optimizations`. Registered in `AGENT_TYPE_MODEL_DEFAULTS` in `v3/@claude-flow/cli/src/mcp-tools/agent-tools.ts:74` which maps type → model tier. File-based store at `.claude-flow/agents/store.json`.

**Queen coordinator (`v3/@claude-flow/swarm/src/queen-coordinator.ts`):**
- Single class with `TaskAnalysis` → `DelegationPlan` pipeline.
- Scores agents against task capabilities, assigns primary + backup, parallelizes sub-tasks.
- Uses ReasoningBank for learned strategies.
- **There is no "Strategic Queen" vs "Tactical Queen" in code — just one coordinator with different modes.** The marketing is ahead of the code.

**Consensus (`v3/@claude-flow/swarm/src/consensus/`):** Raft, Byzantine, Gossip, CRDT are **all real code**, not stubs. Raft has leader election and log replication. But they're **over-engineered for <10 agents** — SQLite WAL is enough.

**How agents actually run:** claude-flow **does not spawn subprocesses**. It's an orchestration layer on top of Claude Code's `Task` tool. Users run `npx claude-flow agent spawn -t coder` to create a metadata record, then run `Task({ subagent_type: 'coder' })` inside Claude Code which does the actual execution. **So claude-flow's "hive mind" is really a persistence + routing layer.**

**Hooks (`v3/@claude-flow/hooks/src/`):** 17 lifecycle hooks (pre-edit, post-edit, pre-task, post-task, etc.), EventEmitter-based. Worth copying the dispatcher (~100 lines).

**What to steal:**
- ✅ The memory schema (exactly)
- ✅ File-based agent store pattern (`agents.json` + `AgentRecord`)
- ✅ Model routing by agent type (map agent type → Opus/Sonnet/Haiku)
- ✅ Hook dispatcher (~100 lines)
- ✅ Task decomposition logic from `queen-coordinator.ts`
- ✅ The lesson that a "queen" is just a task decomposer + dispatcher, not a consensus protocol

**What to skip:**
- ❌ Raft / Byzantine / Gossip / CRDT consensus
- ❌ SONA / ReasoningBank / WASM Agent Booster (cool but optional)
- ❌ Plugin registry (IPFS/Pinata)
- ❌ 150+ MCP tools
- ❌ Multiple memory backends (SQLite is enough)
- ❌ "60 agent types" — 10–15 is plenty

---

## 5. Architecture — Mission Control Teams

### 5.1 Data model

All in `memory.db` (add new tables — don't make a second database):

```sql
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_id TEXT NOT NULL,      -- workspace path
  main_branch TEXT NOT NULL,
  preset TEXT,                    -- 'review' | 'feature' | 'fullstack' | 'migration' | 'debug' | 'research' | 'custom'
  goal TEXT,                      -- plain-English mission
  status TEXT NOT NULL,           -- 'idle' | 'running' | 'paused' | 'review' | 'merged' | 'cancelled'
  budget_usd REAL,                -- hard cap per team
  spent_usd REAL DEFAULT 0,
  max_agents INTEGER DEFAULT 5,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE team_agents (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role TEXT NOT NULL,             -- 'coder' | 'reviewer' | 'tester' | 'architect' | ...
  role_file TEXT,                 -- path to .claude/agents/<role>.md
  model TEXT NOT NULL,            -- 'opus' | 'sonnet' | 'haiku'
  status TEXT NOT NULL,           -- 'spawning' | 'idle' | 'working' | 'needs_input' | 'blocked' | 'error' | 'done'
  session_id TEXT,                -- Agent SDK session id (resumable)
  worktree_path TEXT,
  branch_name TEXT,
  sse_session_key TEXT,           -- key into existing claude-chat-bridge activeQueries
  last_output_hash TEXT,          -- sha256 for idle detection
  last_activity_at INTEGER,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  started_at INTEGER,
  ended_at INTEGER
);

CREATE TABLE team_tasks (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,           -- 'pending' | 'claimed' | 'in_progress' | 'blocked' | 'review' | 'done' | 'cancelled'
  priority INTEGER DEFAULT 0,
  assigned_agent_id TEXT REFERENCES team_agents(id),
  depends_on TEXT,                -- JSON array of task ids
  files_touched TEXT,             -- JSON array of paths (populated after run)
  diff_summary TEXT,              -- "+42 -7"
  worktree_path TEXT,             -- where the work happens
  branch_name TEXT,               -- mc/<team>/<task-slug>
  result TEXT,                    -- final assistant message
  error TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  reviewed_at INTEGER,
  reviewer TEXT                   -- 'auto' | 'user'
);

CREATE TABLE team_messages (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  from_agent_id TEXT,             -- null = from human
  to_agent_id TEXT,                -- null = broadcast (use sparingly)
  type TEXT NOT NULL,             -- 'direct' | 'broadcast' | 'halt' | 'note'
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);

CREATE TABLE team_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES team_agents(id),
  task_id TEXT REFERENCES team_tasks(id),
  kind TEXT NOT NULL,             -- 'tool_call' | 'task_transition' | 'hook_blocked' | 'message' | 'status_change'
  payload TEXT,                   -- JSON
  created_at INTEGER NOT NULL
);

CREATE TABLE team_scratchpad (
  team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  content TEXT NOT NULL,          -- shared markdown, editable by human and agents
  updated_at INTEGER NOT NULL,
  updated_by TEXT                 -- agent id or 'user'
);

-- Task claim uses SQLite single-writer via:
-- UPDATE team_tasks SET status='claimed', assigned_agent_id=?, claimed_at=?
-- WHERE team_id=? AND status='pending' AND (depends_on IS NULL OR ...)
-- ORDER BY priority DESC, created_at ASC LIMIT 1 RETURNING *;
```

### 5.2 File layout

```
<workspace-root>/
  .mc-worktrees/
    <team-slug>/
      <agent-slug>/         ← git worktree, branch mc/<team>/<agent>
        node_modules       → symlink
        .next              → symlink
        .env               → symlink
        .claude            → shallow symlink (excludes plans/, settings.local.json)
        ... rest is real

<MC_DIR>/
  data/
    memory.db              ← existing, add teams tables via migration
    claude-code-sessions.json
    mc-subagents.json      ← existing
  lib/
    teams/
      worktree.ts          ← NEW: create/delete/lock/symlink
      dispatcher.ts        ← NEW: task claim + concurrency
      runner.ts            ← NEW: TeamRunner class, spawns N parallel query() calls
      roles.ts             ← NEW: loads .claude/agents/*.md with YAML frontmatter
      status.ts            ← NEW: output-hash polling for idle detection
      hooks.ts             ← NEW: runs TaskCompleted hooks per team
      cost.ts              ← NEW: token → USD conversion + budget check
      schema.ts            ← NEW: migration
    claude-chat-bridge.ts  ← existing, will factor runAgent() out of this
  app/api/teams/
    route.ts               ← list/create teams
    [teamId]/
      route.ts             ← get/update/delete team
      tasks/route.ts       ← CRUD tasks
      agents/route.ts      ← list agents, status
      stream/route.ts      ← SSE team firehose (status changes, events)
      diff/[taskId]/route.ts  ← git diff for a task worktree
      merge/route.ts       ← merge approved tasks
      scratchpad/route.ts  ← shared notes
  components/
    TeamsPanel.tsx         ← existing, rewrite as the main team view
    teams/
      TeamList.tsx         ← left: list of teams
      TeamOverview.tsx     ← center grid: agent tiles
      AgentTile.tsx        ← one agent card with status, tokens, files, action
      FocusPane.tsx        ← xterm.js for the selected agent
      TaskBoard.tsx        ← kanban
      TaskDiffDialog.tsx   ← review a task's diff
      TeamTimeline.tsx     ← unified activity feed
      TeamLauncher.tsx     ← "create team from template" modal
      CostBadge.tsx
      ScratchpadEditor.tsx
  .claude/agents/          ← seeded from VoltAgent/awesome-claude-code-subagents
    coder.md
    reviewer.md
    tester.md
    architect.md
    researcher.md
    ...
```

### 5.3 Runtime: how a team actually runs

```
User picks "Feature" preset ──▶ TeamLauncher creates:
                                 • team row
                                 • 4 team_agents (architect, coder, reviewer, tester)
                                 • initial task decomposition from the goal
                                 • 4 worktrees (one per agent) via WorktreeManager
                                 • 4 branches mc/<team>/<agent>

TeamRunner.start(teamId) ──────▶ For each agent:
                                   spawn an SDK session via query({
                                     cwd: agent.worktree_path,
                                     systemPrompt: buildSystemPrompt(agent.role_file, scratchpad),
                                     model: agent.model,
                                     allowedTools: [...roleTools, 'Agent'],
                                     resume: agent.session_id ?? undefined,
                                   })
                                 Each runs in its own async iterator on the server.
                                 The runner wires stream → SSE /api/teams/:id/stream.

Dispatcher loop ─────────────▶ Every 500ms:
                                • Fetch pending tasks for team where deps are done
                                • Atomically claim via SQL UPDATE ... RETURNING
                                • Post "work this task" as a user turn to that agent's session
                                • Agent picks it up, emits tool calls (observed via bridge)
                                • On completion, runs TaskCompleted hook (test/lint/typecheck)
                                  — exit 2 → task reverts to 'blocked' with feedback
                                  — exit 0 → task → 'review' (auto-merge if policy allows)

Status detector ─────────────▶ Every 500ms per agent:
                                • Hash last 4KB of SSE buffer
                                • Compare to previous hash
                                • Same for >5s → idle
                                • Contains known prompt string → needs_input
                                • Update team_agents.status + emit status_change event

Cost tracker ─────────────────▶ On every SDK message:
                                • Read usage from message
                                • Convert to USD via pricing table
                                • Atomically update team_agents.tokens_* + cost_usd
                                • If team_agents cost + spent_usd ≥ budget_usd → PAUSE
                                  entire team (close all activeQueries)

User clicks a tile ──────────▶ FocusPane binds xterm.js to the existing SSE stream
                                for that agent. User can type → server injects as
                                user turn into the SDK session via a direct message
                                endpoint (already exists in chat route conceptually).

User reviews a task ─────────▶ TaskDiffDialog fetches
                                git -C <worktree> diff main...<branch>
                                Renders via Monaco read-only with custom unified-diff
                                component. Approve → merge. Revise → sends a user
                                turn "please address these comments: …" to the agent.
                                Reject → marks task cancelled, worktree preserved.

User clicks Merge All ───────▶ For each approved task:
                                1. Acquire per-repo lock (Promise chain)
                                2. cd <repo-root>
                                3. git merge --no-ff mc/<team>/<agent> (or --squash)
                                4. If conflict → git merge --abort, emit blocked event
                                5. On success → optionally push + gh pr create
                                6. Mark task 'done', remove worktree (if clean)
```

### 5.4 Key design decisions (and why)

1. **Worktree per *agent*, not per *task*.** Why: long-lived coder agents stay in the same worktree across multiple tasks; resetting per-task would lose built state, hot reload, etc. Tradeoff: two agents can't safely edit the same file — so the dispatcher assigns tasks by ownership (reviewer ≠ coder file sets).
2. **Tasks live in SQLite, not filesystem.** parallel-code uses JSON, claude-flow uses `.swarm/tasks/*.json`, claude-squad uses JSON. We already have SQLite. SQLite's single-writer is enough for the claim race. `UPDATE ... RETURNING` is the atomic primitive.
3. **One `query()` session per agent, not per team.** The Agent SDK is session-scoped. Each agent gets its own resumable `session_id`. We extract `runAgent()` from `claude-chat-bridge.ts` so it can be called N times in parallel.
4. **Status via output-hash polling, not OpenTelemetry.** claude-squad's 100ms pane-hash trick works, is trivial, and has zero dependencies. We already buffer the SSE stream; hashing the last 4KB every 500ms is effectively free. OpenTelemetry is cleaner but adds infrastructure.
5. **Real xterm.js for focus pane.** The lesson from every tool: don't fake the terminal. When the user wants to steer an agent, they need to type into a real stream.
6. **Hooks for quality gates, not prompts.** "Tell the agent to run tests" is unreliable. A `TaskCompleted` hook that actually runs `pnpm test --filter <touched>` and returns exit 2 on failure is how every serious tool enforces it.
7. **Budget enforcement is first-class.** Anthropic's own data says multi-agent costs 15× single agent. Hard caps with `close()` on the SDK stream are mandatory.
8. **No peer consensus.** Skip Raft. SQLite single-writer + a lightweight dispatcher is enough for 8 agents.
9. **Messaging is point-to-point, broadcast is rare.** `team_messages.to_agent_id` is the mailbox. Broadcasts only for `halt`. Every message shows in the timeline.
10. **`.claude` is shallow-symlinked.** parallel-code's trick: real dir, most entries linked, but `plans/` and `settings.local.json` per-agent. Each agent keeps its own local settings while sharing skills.

---

## 6. Implementation plan — 4 phases

### Phase 1 — Foundations (3–5 days)

**Goal: `WorktreeManager` + DB schema + role library work, no UI yet.**

- [ ] `lib/teams/schema.ts` — write migration for 7 new tables, run on boot from `lib/memory-db.ts`. Back up `memory.db` first.
- [ ] `lib/teams/worktree.ts` — port `parallel-code/electron/ipc/git.ts`:
  - `createWorktree(teamId, agentSlug, repoRoot, baseBranch)` — `.mc-worktrees/<team>/<agent>/`, branch `mc/<team>/<agent>`, runs `git worktree add -b`, symlinks `node_modules`, `.next`, `.env`, shallow-symlinks `.claude`.
  - `removeWorktree(path, force?)` — refuses if dirty unless `force`.
  - `diffAgainstBase(worktreePath, baseBranch)` — `git add -N . && git diff --numstat` + full diff text.
  - `withRepoLock(repoRoot, fn)` — Promise-chain lock keyed by repo common dir.
  - `isDirty(worktreePath)` — wraps `git status --porcelain`.
- [ ] `lib/teams/roles.ts` — reads `.claude/agents/*.md` with YAML frontmatter parser, exposes `listRoles()`, `getRole(name)`. Seed the directory by copying 10–15 roles from `VoltAgent/awesome-claude-code-subagents` (clone into `mc-research`, copy the ones we care about: `backend-architect`, `code-reviewer`, `debugger`, `frontend-developer`, `test-automator`, `refactoring-specialist`, `security-auditor`, `database-admin`, `devops-troubleshooter`, `performance-engineer`).
- [ ] `lib/teams/cost.ts` — pricing table (Opus/Sonnet/Haiku per-million-token rates as of Apr 2026), `costFor(model, input, output)`, `addCost(agentId, input, output)` with atomic UPDATE.
- [ ] **Unit tests** for worktree create/delete/lock and cost math. Hit real git (use a tmp repo).

**Exit criterion:** from a Node REPL I can create a team row, create two worktrees, run diff, and delete them.

### Phase 2 — Parallel runner + dispatcher (5–7 days)

**Goal: actually run N agents in parallel against their worktrees.**

- [ ] Refactor `lib/claude-chat-bridge.ts`: extract `runAgent({ sessionKey, cwd, model, systemPrompt, resume, onEvent })` as a reusable async generator. `spawnClaudeStream()` becomes a thin caller.
- [ ] `lib/teams/runner.ts`:
  - `TeamRunner` class with `start(teamId)`, `stop(teamId)`, `pauseTeam`, `resumeTeam`.
  - For each agent row, launches `runAgent()` in its own async loop.
  - Builds system prompt from role file + shared scratchpad + team goal + project CLAUDE.md.
  - Wires stream → `team_events` insert + SSE broadcast.
  - Tracks active runners in a map keyed by teamId → `{ agentId: { close } }`.
- [ ] `lib/teams/dispatcher.ts`:
  - `claimNextTask(teamId, agentId, capabilities)` — atomic SQL with dep-checking.
  - `tick(teamId)` — called every 500ms while team is running; for each idle agent, try to claim a task, inject it as a user turn into that agent's running session.
  - `injectUserTurn(agentId, text)` — posts into the runner's input queue. Runner converts to the next SDK `query()` turn.
- [ ] `lib/teams/status.ts` — output-hash polling. Every 500ms, hash last 4KB of each agent's SSE buffer. Known prompt strings (from claude-squad, extended). Emit `status_change` events.
- [ ] `lib/teams/hooks.ts` — reads `team.hooks.taskCompleted` command (configurable). Runs it per task completion with env `MC_TASK_ID`, `MC_WORKTREE`, `MC_FILES_TOUCHED`. Exit 2 → task back to `blocked` with stdout/stderr as feedback. Default command: `pnpm -C $MC_WORKTREE test && pnpm -C $MC_WORKTREE lint` (override per team).
- [ ] API routes:
  - `POST /api/teams` — create team
  - `GET /api/teams` — list
  - `GET /api/teams/:id`, `PATCH`, `DELETE`
  - `POST /api/teams/:id/start`, `/stop`, `/pause`, `/resume`
  - `POST /api/teams/:id/tasks`, `GET /api/teams/:id/tasks`
  - `POST /api/teams/:id/tasks/:taskId/approve` / `/revise` / `/reject`
  - `GET /api/teams/:id/stream` — SSE firehose
  - `GET /api/teams/:id/diff/:taskId` — unified diff of task's worktree vs main
  - `POST /api/teams/:id/merge` — merges all approved tasks (takes per-repo lock)
  - `POST /api/teams/:id/message` — inject direct message or `@agent` mention

**Exit criterion:** headless — I can POST a team of 3 agents with 6 tasks, they run in parallel in their own worktrees, the dispatcher correctly sequences dependent tasks, and merged results end up on `main`.

### Phase 3 — Teams UI (5–7 days)

**Goal: make the above visible and controllable.**

- [ ] Rewrite `components/TeamsPanel.tsx` as the main page for `/teams`:
  - Left: `TeamList` (sidebar with team name, status dot, token burn, progress %).
  - Center: `TeamOverview` — grid of `AgentTile`s.
  - Right: `FocusPane` (visible only when a tile is selected) — xterm.js attached to SSE stream for that agent.
- [ ] `AgentTile.tsx`:
  - Role icon, name, model badge
  - Status pill: Working / Idle / Needs Input / Blocked / Error / Done (colors from existing SubAgentTracker)
  - Current task title (live)
  - Files touched count
  - Tokens in/out + $ spend
  - 3-line tail of last action
  - Quick actions: Pause, Kill, @-message, Jump to worktree
- [ ] `TaskBoard.tsx` — Kanban with columns `pending`, `in_progress`, `review`, `done`. Cards expand to show diff preview + Approve/Revise/Reject. Reuse existing `Workshop.tsx` styling.
- [ ] `TaskDiffDialog.tsx` — Monaco read-only with custom unified-diff viewer. Port the parser from parallel-code's `unified-diff-parser.ts`. Side-by-side for changed files.
- [ ] `TeamTimeline.tsx` — single feed of `team_events` with filters (tool calls, messages, status changes, hook rejections). Timestamp, agent, action, 1-line summary. Click to expand.
- [ ] `TeamLauncher.tsx` — modal. Picks project, picks preset (Review/Feature/Fullstack/Migration/Debug/Research/Custom) or writes a free-form goal. Editable draft task list. Budget slider. Submit → creates team + kicks off.
- [ ] `ScratchpadEditor.tsx` — shared team markdown. WebSocket/SSE-synced. Human edits flow into `team_scratchpad.content` and get injected into each agent's next system prompt.
- [ ] `CostBadge.tsx` — live $ with progress bar against budget. Red when ≥90%.
- [ ] Wire SSE firehose from `/api/teams/:id/stream` into React state via a single `useTeamStream(teamId)` hook.

**Exit criterion:** launch a team from the UI, watch 4 tiles update live, click a tile to interact in xterm, review a diff, click Merge.

### Phase 4 — Quality, polish, multi-project (3–5 days)

- [ ] Hooks UX — per-team config: `hooks.json` with `taskCompleted`, `preTask`, `postTask` commands. Defaults that make sense for the workspace.
- [ ] Three merge lanes: auto-merge (tests green + flagged auto), one-click, manual PR (`gh pr create`). Conflict → blocked with "Claude, rebase" action.
- [ ] Cross-project view: pin multiple projects in a single command-center. Teams listed grouped by project. Borrow clideck's chat-style sidebar pattern.
- [ ] Resumability: on server restart, `TeamRunner` enumerates `teams WHERE status='running'`, re-attaches via `runAgent({ resume: session_id })`.
- [ ] Remote access (optional, copy parallel-code's pattern): local HTTP + WS on configurable port with timing-safe token, QR code modal for phone. Only for Tailscale/LAN use.
- [ ] Budget caps, notification panel, cost history in `UsageStats.tsx`.
- [ ] Seed library: 6 preset team templates (Review, Feature, Fullstack, Migration, Debug-Hypotheses, Research) as JSON in `data/team-presets.json`. Each names its agents and a task-decomposition prompt for the user's goal.

**Exit criterion:** can launch a Fullstack team against the RevolveCore project, walk away, come back and merge 6 passing tasks with three clicks.

---

## 7. What to deliberately skip (and why)

- **Consensus (Raft/BFT/Gossip/CRDT)** — claude-flow has real code for all of these. Users still cap at 6–8 agents. SQLite single-writer is enough. Skip forever.
- **SONA / ReasoningBank / WASM Agent Booster** — real but optional. Revisit if MC has scale.
- **Dynamic topology switching** — mesh/hierarchical/ring/star. Stick with flat + one lead.
- **Broadcast-by-default messaging** — scales O(n²). Point-to-point only; broadcast reserved for `halt`.
- **Custom terminal multiplexer** — use real xterm.js with the SSE stream. Every abstraction leaks.
- **Auto-clean dirty worktrees** — parallel-code's rule is right: preserve for review.
- **In-process Agent Teams resume after crash** — Anthropic's docs say it doesn't work. We resume per-agent via `resume: session_id` on the SDK instead.
- **300+ MCP tools** — build ~5 MC-specific ones (scratchpad, team-state, file-touched tracker, cost probe, hook runner). Auto-generate more if needed.
- **Windows split-pane first-class** — Agent Teams itself doesn't support it. Ship in-process mode; split-pane is bonus.

---

## 8. Specific files to steal from (with paths)

| From | File | Take |
|---|---|---|
| parallel-code | `electron/ipc/git.ts:366–423` | `createWorktree` + symlink list |
| parallel-code | `electron/ipc/git.ts:899–1005` | `mergeTask` safe-merge flow |
| parallel-code | `electron/ipc/git.ts:72–90` | Per-repo Promise-chain lock |
| parallel-code | `electron/ipc/pty.ts:284–314` | Output batching thresholds (64KB/1KB/8ms) |
| parallel-code | `electron/main.ts:26–44` | `fixPath()` login-shell PATH trick |
| parallel-code | `src/lib/unified-diff-parser.ts` | Unified diff parser (port to TS) |
| parallel-code | `src/components/DiffViewerDialog.tsx` + `ScrollingDiffView` | Diff viewer pattern |
| parallel-code | `electron/remote/server.ts` | Token auth + QR remote pattern (optional) |
| claude-squad | `session/instance.go:326–331` + `tmux.go:235–256` | Pane-hash idle detection |
| claude-squad | Prompt strings for Claude/Aider/Gemini | Needs-input detection |
| claude-squad | `session/instance.go:412–525` | Pause/resume preserving branch |
| claude-squad | `app/app.go` `previewTickMsg` | 100ms tick + async diff compute pattern |
| claude-squad | `config/state.go` | Persistence schema shape (translate to SQL) |
| claude-flow | `v3/@claude-flow/memory/src/sqlite-backend.ts:619–657` | Memory table schema for scratchpad/episodes |
| claude-flow | `v3/@claude-flow/cli/src/mcp-tools/agent-tools.ts:74` | Model-tier-by-agent-type map |
| claude-flow | `v3/@claude-flow/hooks/src/*` | Hook dispatcher (~100 lines) |
| claude-flow | `v3/@claude-flow/swarm/src/queen-coordinator.ts` | Task-decomposition logic only |
| VoltAgent | `awesome-claude-code-subagents` | 10–15 seed role files |

All three repos are at `~/mc-research/`.

---

## 9. Risks and open questions

- **Session resume race** — if the server dies mid-task, the Agent SDK session may still be recoverable via `resume: session_id` but any half-written tool call is lost. Mitigation: after resume, re-send the task prompt with a "pick up where you left off" preamble.
- **File conflicts across agents in the same worktree** — we chose worktree-per-agent specifically to avoid this, but if a team is small (2 agents) we could share a worktree to save disk. Deferred: always separate in v1.
- **Symlinked `node_modules` + pnpm** — pnpm uses its own symlink farm; double-symlinking can confuse it. Test: if symlink breaks pnpm, fall back to a full `pnpm install` in each worktree (slow but reliable).
- **Cost visibility pre-run** — the SDK doesn't tell you upfront cost. We can estimate from role + task count but reality will vary. Show running estimate + hard cap.
- **Rate limits** — 8 parallel Opus sessions will hit rate limits on a single API key. Integrate `claude-code-router` (musistudio) later to fan out across multiple keys or mix in local models for grep-level agents. For v1: Opus for 1 lead role only, Sonnet for 2–3 coders, Haiku for ops/test/reviewer.
- **Stale memory.db migrations** — add a proper `schema_version` check before running the team migration.
- **Shadow RLS on Supabase** — not applicable, memory.db is local only.

---

## 10. The smallest usable slice (if we only have 3 days)

1. `lib/teams/schema.ts` — the 7 tables (1 day).
2. `lib/teams/worktree.ts` — create + merge + diff (0.5 day).
3. `lib/teams/runner.ts` minimal — spawn 3 parallel `query()` sessions, one per agent, all writing to the same output stream. No dispatcher yet, hand-assign one task per agent at team create time (0.5 day).
4. Rewrite `TeamsPanel.tsx` as a 3-tile overview with live status from existing SSE machinery + a "Merge all" button (1 day).

Even that minimum is more than `claude-squad` offers (no web UI) and in the same league as `parallel-code` (better because we have SQLite memory and the web UI works over a network).

---

## 11. The Team — introducing **"Constellation"**

### 11.1 The name

After auditioning a dozen options against Mission Control's NASA-control-room theme, the winner is **Constellation**.

- Each **team** is a named constellation — "Orion", "Lyra", "Cassiopeia". The user can run multiple in parallel.
- Each **agent** in a team is a *star* in that constellation.
- The tab name is simply **Constellation**. The page shows the active constellation(s); the header lets you switch between them.
- Plays well with the rest of the app's space metaphor (Mission Control, LaunchPad, Orbit).
- Alternatives considered and rejected: *Bridge* (singular, can't hold multiple teams), *Crew* (too generic), *Formation* (too military), *Squadron* (overused), *Hive* (overloaded by claude-flow), *Swarm* (same).

> **The Constellation tab.** One top-level tab in Mission Control. Inside it, you deploy and monitor named constellations of agents working on your projects.

### 11.2 The roster — 8 standard roles

Every constellation is assembled from a pool of 8 standard roles. A small constellation uses 3–4; a full-stack one uses 6–8. Roles are defined as markdown files in `.claude/agents/` with YAML frontmatter (standard Claude Code format), so they also work when you're outside the team feature.

| # | Role | Icon | Model | Writes code? | Primary job |
|---|---|---|---|---|---|
| 1 | **Commander** | ✦ | Opus | Sometimes | Mission lead. Talks to the human, decomposes goals, assigns tasks, merges results, reports back. Bound to the parent chat session. |
| 2 | **Architect** | ◆ | Opus | No | System design, API contracts, ADRs. Writes to the shared scratchpad. Only active at mission start and at major pivots. |
| 3 | **Builder** | ● | Sonnet | **Yes** — heavy | The workhorse coder. One worktree per instance. 1–4 Builders can run in parallel on independent task slices. |
| 4 | **Inspector** | ◎ | Sonnet + **Codex (MCP)** | **No** — read-only | **Cross-model reviewer.** Uses `openai/codex-plugin-cc` to run Codex against each Builder's diff in read-only mode. Posts findings as structured comments; never edits code. **This is the role that directly answers the user's question.** |
| 5 | **Sentinel** | ▲ | Haiku | No | Runs tests, lint, type-check, build. Wraps the `TaskCompleted` hook. Cheap, always-on, gates task completion. |
| 6 | **Scout** | ◇ | Sonnet | No | Research — web, docs, existing codebase, library source. Populates the shared scratchpad with findings. Used at mission start and whenever a Builder is blocked. |
| 7 | **Scribe** | ✎ | Haiku | **Yes** — docs only | Commit messages, PR descriptions, CHANGELOG, README updates. Runs after each task lands. Cheapest role, always on the critical path. |
| 8 | **Navigator** | ◈ | Haiku | **Yes** — deps only | Package.json edits, import paths, symlinks, node_modules fixups. A specialist subroutine — usually invoked once at setup and when deps change. |

**Why these 8 and not more:**
- Every additional role is another session and another 15× token multiplier. 8 is the practical ceiling (Anthropic's own multi-agent retrospective and claude-flow's default both land at 6–8).
- Specialization is real but has diminishing returns. You don't need a "CSS specialist" and a "JSX specialist" — Builder handles both. The divisions that *do* matter: read-only vs write, code vs docs, expensive model vs cheap model, deterministic (tests/lint) vs generative.
- Commander + Architect + 2 Builders + Inspector + Sentinel is the **default 6-agent "Feature" constellation**. Adding Scout + Scribe gets you to 8 for "Full-Stack". Smaller jobs can run 3 (Commander + Builder + Inspector).

### 11.3 Model routing (the pricing decision)

Based on Anthropic's own guidance and wshobson/agents' three-tier strategy:

| Tier | Model | Roles | Rationale |
|---|---|---|---|
| Critical reasoning | **Opus** (claude-opus-4-6) | Commander, Architect | Decomposition, design, merge decisions — errors here cascade. Worth the cost. |
| Bulk work | **Sonnet** (claude-sonnet-4-6) | Builder, Inspector, Scout | 80% of tokens spent. Sonnet is the sweet spot for code + review. |
| Ops | **Haiku** (claude-haiku-4-5) | Sentinel, Scribe, Navigator | Deterministic, narrow, high-volume. Haiku is ~20% of Sonnet's cost. |
| External | **GPT-5 Codex** via `codex-plugin-cc` | Inspector's reviewer tool | Cross-model = catches blind spots. Codex's pricing is independent of Anthropic usage. |

Model tier is set in the agent's markdown frontmatter and can be overridden per-team. The routing map lives in `lib/teams/roles.ts`.

---

## 12. The **Inspector** — cross-model Codex reviewer, in depth

This is the piece the user specifically asked about, so it gets its own section.

### 12.1 What exists in the wild (facts, not guesses)

Three real tools to pull from, all verified:

**(a) OpenAI's `openai/codex-plugin-cc`** — the **official** plugin. Installed with `/plugin marketplace add openai/codex-plugin-cc` → `/plugin install codex@openai-codex`. Wraps the local Codex CLI binary. Exposes slash commands inside Claude Code:
- **`/codex:review`** — "normal read-only Codex review of uncommitted changes or branches." Explicitly read-only, will not modify code.
- **`/codex:adversarial-review`** — "steerable challenge review," questions design decisions and assumptions. Also read-only.
- `/codex:rescue` — delegates a *task* (writes code) to a Codex subagent. Not used by Inspector — Inspector is review-only.
- `/codex:status`, `/codex:result`, `/codex:cancel` — job management.

Requires Node 18.18+ and either a ChatGPT subscription or an OpenAI API key.

**(b) `hamelsmu/claude-review-loop`** — community Claude Code plugin. Uses a **Stop Hook** to intercept Claude Code exit, spawns **up to 4 parallel Codex sub-reviewers** each with a different focus (Diff Review, Holistic Review, framework-specific like "Next.js Review", UX Review), deduplicates findings, writes a consolidated `reviews/review-<id>.md`. The Claude session blocks until the review finishes and the findings are addressed.

**(c) Anthropic's own hosted "Code Review"** (Team/Enterprise, research preview) — "a fleet of specialized agents examine the code changes in the context of your full codebase, each agent looking for a different class of issue," then a **verification step** checks candidate findings against actual code behavior to filter false positives. Findings posted as inline PR comments, tagged with severity **🔴 Important / 🟡 Nit / 🟣 Pre-existing**. Customizable via `CLAUDE.md` and `REVIEW.md` files. Average cost **$15–25 per review**, ~20 minutes.

### 12.2 Our Inspector design (combines all three)

The Inspector is a **Claude Sonnet agent** whose only tool is the Codex review command (plus read-only filesystem access). It cannot write, commit, or push. Its prompt is a condensed version of `REVIEW.md` + the team's review policy. Here's how it runs:

```
Task lands in "ready-for-review" (after Sentinel passes)
            ↓
Dispatcher hands task to Inspector (free or queued)
            ↓
Inspector's Sonnet session runs in the Builder's worktree (read-only mount)
            ↓
Inspector executes `/codex:review` with:
   - the task branch vs main diff
   - the task description
   - repo-level REVIEW.md
   - the team's custom review guidance (from TeamsPanel settings)
            ↓
Codex (GPT-5) reviews in its own sandbox, returns findings
   (For complex tasks, Inspector spawns 2–4 parallel sub-reviews
    like hamelsmu/claude-review-loop, each with a different lens:
    Diff | Holistic | Security | Framework/UX)
            ↓
Inspector consolidates findings, tags each with:
   🔴 Important  — blocks, auto-reverts task to 'blocked'
   🟡 Nit        — noted, does not block
   🟣 Pre-existing — noted, does not block
            ↓
Inspector writes a structured `task_review` row to DB
(one row per finding: file, line, severity, rationale, suggested fix)
            ↓
If any 🔴: task → 'blocked', feedback sent to Builder's session as a user turn:
   "Inspector found 2 blocking issues on this task. Please address:
    1. src/auth/session.ts:142 — token refresh races with logout…
    2. …
    Re-submit when fixed."
            ↓
If only 🟡 / 🟣 or clean: task → 'approved'
```

### 12.3 Schema addition for reviews

Append to the Teams schema in §5.1:

```sql
CREATE TABLE task_reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
  reviewer_agent_id TEXT REFERENCES team_agents(id),
  reviewer_model TEXT NOT NULL,          -- 'gpt-5-codex' | 'claude-sonnet-4-6' | 'claude-opus-4-6'
  review_kind TEXT NOT NULL,             -- 'diff' | 'holistic' | 'security' | 'framework' | 'adversarial'
  cost_usd REAL,
  duration_ms INTEGER,
  clean BOOLEAN NOT NULL,                -- no important findings
  raw_output TEXT,                       -- full Codex markdown output
  created_at INTEGER NOT NULL
);

CREATE TABLE task_review_findings (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES task_reviews(id) ON DELETE CASCADE,
  severity TEXT NOT NULL,                -- 'important' | 'nit' | 'pre_existing'
  file TEXT NOT NULL,
  line INTEGER,
  title TEXT NOT NULL,
  rationale TEXT,                        -- Codex's reasoning
  suggested_fix TEXT,
  status TEXT NOT NULL,                  -- 'open' | 'addressed' | 'waived' | 'false_positive'
  addressed_by TEXT,                     -- human rating: 'agent' | 'user'
  addressed_at INTEGER
);
```

Findings surface in three places: the task card (badge with count + worst severity), the task diff dialog (inline annotations on the diff lines), and the timeline.

### 12.4 The honest tradeoffs

- **Cost**: Codex review is its own bill. $15–25 per review at Anthropic's managed rates, probably cheaper if you BYO OpenAI key. For a 10-task mission that's $150–250 just in review. Inspector should be **skippable per-team** and **off by default for tasks marked "trivial"**.
- **Latency**: ~20 min per full review. For long tasks that's fine; for 1-file fixes it's a tax. Default: Inspector only runs on tasks touching ≥3 files or ≥100 LOC, configurable.
- **False positives**: Cross-model review is good at finding blind spots but also flags stylistic differences the Builder already considered and rejected. We need a "false positive" button on findings that (a) learns per-team and (b) feeds a suppression list into the next review's `REVIEW.md`.
- **Keyring management**: Users need to have Codex CLI installed and authenticated. Mission Control surfaces this as a first-run prerequisite check — a "Install Codex" button in the Constellation settings that walks through `npm i -g @openai/codex-cli` and login.
- **Why not just use Anthropic's hosted Code Review?** It's great but (a) requires Team/Enterprise, (b) runs on GitHub PRs only — not on local worktrees pre-merge, and (c) is not cross-model. For Mission Control we want review *before* push, on local worktrees, using a different model family.

---

## 13. How the crew works together — interaction model

Rule zero: **chatter is expensive**. Every inter-agent message is tokens. The system is designed to minimize coordination and maximize parallel work.

### 13.1 Communication topology

- **Commander is the hub.** Anyone can escalate to Commander. Commander can talk to anyone. Commander is bound to the parent chat and is the only agent the human talks to by default.
- **Peers do NOT talk directly.** Builder-1 and Builder-2 cannot message each other. If they need to coordinate they write to the shared scratchpad or escalate to Commander.
- **The shared scratchpad is the slow bus.** `team_scratchpad.content` is a markdown file. Architect writes ADRs here; Scout writes findings here; Commander writes policy here. Every agent reads it at the start of every turn.
- **The dispatcher is the fast bus.** Work claim happens via SQL UPDATE...RETURNING. No agent ever "asks for more work"; they pull from the queue when idle.
- **Inspector is a pipeline stage, not a peer.** It receives tasks from the queue (`status = ready_for_review`), produces findings, and either passes the task forward or bounces it back. It never chats.
- **Sentinel emits exit codes.** It's not a conversational agent — it's a hook runner. Output is `{passed, duration, output, affected_files}`.
- **Navigator is a subroutine.** Called by Builder via an explicit "ask Navigator to add this dependency" message; returns immediately.

### 13.2 The golden path (what actually happens)

```
┌──────────────────────────────────────────────────────────────────┐
│ USER: "Build an authentication flow with magic links"            │
└──────────┬───────────────────────────────────────────────────────┘
           │ (chat message → Commander's SDK session)
           ▼
┌──────────────────────────────────────────────────────────────────┐
│ COMMANDER reads the chat message + project CLAUDE.md             │
│ Decides: needs architect + scout + 2 builders + inspector        │
└──────────┬───────────────────────────────────────────────────────┘
           │
           ├─► SCOUT: "research best magic link libraries for Next 15"
           │         scout.search → scratchpad.append("findings…")
           │
           ├─► ARCHITECT: "design the auth flow given Supabase + Expo"
           │         architect writes ADR-001 to scratchpad
           │         writes 6 task cards to team_tasks (pending)
           │         returns
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│ DISPATCHER tick (every 500ms)                                    │
│   Builder-1 idle → claims task #1 ("DB schema + RLS")            │
│   Builder-2 idle → claims task #2 ("API route /auth/magic-link") │
└──────────┬───────────────────────────────────────────────────────┘
           │
           │ (two parallel Builders run in their own worktrees)
           │
           ├─► BUILDER-1 edits files → Sentinel (PostTask hook) runs
           │                           pnpm test → passes
           │                           → task #1 = ready_for_review
           │
           ├─► BUILDER-2 edits files → Sentinel runs pnpm test → FAIL
           │                           → task #2 = blocked
           │                           → feedback sent to Builder-2:
           │                             "test failed: expected 200"
           │                           Builder-2 revises → Sentinel passes
           │                           → task #2 = ready_for_review
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│ INSPECTOR claims #1 → /codex:review (read-only)                  │
│   Codex finds 1 🔴 + 1 🟡                                        │
│   Important finding → task #1 → blocked                          │
│   Feedback sent to Builder-1:                                    │
│     "Codex found a race condition in session refresh at L142…"   │
│   Builder-1 revises → Sentinel → Inspector → clean → approved    │
│                                                                  │
│ INSPECTOR claims #2 → /codex:review → clean → approved           │
└──────────┬───────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│ SCRIBE claims approved tasks → writes commit msgs + PR desc      │
│ COMMANDER acquires per-repo lock → merges each branch to main    │
│ COMMANDER posts to parent chat:                                  │
│   "★ Constellation Orion: 6/6 tasks complete, merged to main"    │
│   "Cost: $34.20. Inspector found and fixed 3 issues."            │
└──────────────────────────────────────────────────────────────────┘
```

### 13.3 Failure paths (and who handles them)

| Failure | Handled by | Action |
|---|---|---|
| Test failure in Sentinel | Sentinel hook | Task → `blocked`, feedback to assignee |
| Codex important finding | Inspector | Task → `blocked`, feedback to Builder |
| Merge conflict on main | Commander | Task → `blocked`, "Claude, rebase and resolve" action |
| Agent idle >5 min with no work | Dispatcher | Agent paused, cost reduction |
| Budget cap hit | Cost tracker | **Whole constellation pauses**, notification to user |
| API rate limit | Runner | Exponential backoff + switch to lower tier if available |
| SDK session stale | Runner | Auto-recover via existing `claude-chat-bridge.ts` logic |
| Commander crash | Watchdog | All builders pause, user notified, manual resume required |
| Human vetoes a task | User via UI | Task → `cancelled`, worktree preserved for review |

### 13.4 Memory scopes (no confusion)

Three distinct scopes, enforced:

1. **Project scope** — read-only to every agent. Source of truth: the project's `CLAUDE.md`, `REVIEW.md`, and shared docs. Loaded into each agent's system prompt.
2. **Team scope** — read-write. The `team_scratchpad.content` markdown. Architect and Scout write here; everyone reads here. Human can edit live in the UI — edits become `updated_by = 'user'` and propagate into the next system prompt for all agents.
3. **Agent scope** — ephemeral. Each agent's own SDK `session_id`. Dies when the worktree is removed. Do not persist in memory.db except for the session_id mapping.

No fourth scope. No broadcast messaging. No distributed state.

---

## 14. The **Constellation** tab — full UI spec

A new top-level tab in the Mission Control sidebar, between `Chat` and `Workshop`. Icon: a 6-point asterism/compass-rose. Route: `/constellation`.

### 14.1 Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ★ CONSTELLATION        [Orion ▼]    ● Running   $12.40 / $50   ▸ 3/8   ⚙ □ │  ← Header
├──────┬───────────────────────────────────────────────────────┬───────────────┤
│      │                                                       │               │
│ ★    │  ┌────────────┐ ┌────────────┐ ┌────────────┐         │    FOCUS      │
│ map  │  │ ✦ Commander│ │ ◆ Architect│ │ ● Builder-1│         │               │
│      │  │ Opus       │ │ Opus       │ │ Sonnet     │         │ ┌───────────┐ │
│ ✦ C  │  │ ● Working  │ │ ○ Idle     │ │ ● Working  │         │ │           │ │
│ ◆ A  │  │ Merging #3 │ │ ADR-001    │ │ API route  │         │ │  xterm.js │ │
│ ● B1 │  │ $1.20      │ │ $2.10      │ │ $3.40      │         │ │  attached │ │
│ ● B2 │  │ +42 -8     │ │ 0 files    │ │ +142 -0    │         │ │  to the   │ │
│ ◎ I  │  └────────────┘ └────────────┘ └────────────┘         │ │  selected │ │
│ ▲ S  │                                                       │ │  agent's  │ │
│ ✎ Sc │  ┌────────────┐ ┌────────────┐ ┌────────────┐         │ │  SSE      │ │
│ ◇ Sct│  │ ● Builder-2│ │ ◎ Inspector│ │ ▲ Sentinel │         │ │  stream   │ │
│ ◈ Nav│  │ Sonnet     │ │ Sonnet+Cdx │ │ Haiku      │         │ │           │ │
│      │  │ ○ Review   │ │ ● Working  │ │ ○ Idle     │         │ └───────────┘ │
│      │  │ Passed #2  │ │ Review #1  │ │ --         │         │               │
│      │  │ $1.80      │ │ $0.30+$12  │ │ $0.20      │         │ ┌───────────┐ │
│      │  │ +38 -4     │ │ 0 files    │ │ --         │         │ │ >_ send   │ │
│      │  └────────────┘ └────────────┘ └────────────┘         │ └───────────┘ │
│      │                                                       │               │
├──────┴───────────────────────────────────────────────────────┴───────────────┤
│  [Tasks]  [Timeline]  [Diffs]  [Scratchpad]  [Messages]  [Settings]         │  ← Bottom tabs
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  (bottom pane content)                                                       │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 14.2 Components

**Header**
- Constellation name picker (dropdown — lets you switch between multiple active constellations).
- Status: `● Running | ◐ Paused | ○ Idle | ◉ Review | ✓ Merged | ✕ Cancelled`.
- Live cost vs budget. Bar turns amber at 75%, red at 90%.
- Task progress chip `3/8`.
- Settings cog (hooks, budget, model routing, review policy).
- Maximize / minimize toggle.

**Left — Star Map** (`TeamSidebar.tsx`)
- Compact list of every agent in the constellation with status dot, model badge, and role glyph (✦ ◆ ● ◎ ▲ ✎ ◇ ◈). Click to focus.
- Button: **+ New Constellation** at the bottom.

**Center — Overview Grid** (`TeamOverview.tsx` + `AgentTile.tsx`)
- Responsive grid of `AgentTile`s, default 3-wide.
- Per tile: role glyph, name, model, status pill, current task title, live cost, diff stats, 3-line tail of current action.
- Quick actions on hover: `Pause`, `Kill`, `@-message`, `Open worktree`.
- Ctrl/Cmd-click to focus without losing grid; plain click replaces focus pane.

**Right — Focus Pane** (`FocusPane.tsx`)
- xterm.js attached to the focused agent's SSE stream (reuse existing `ClaudeCodeTerminal.tsx`).
- Inline prompt input at the bottom — sends a direct user turn to that agent.
- Header strip with agent metadata + "Detach" to close the pane.
- Collapsible; when collapsed, overview grid expands full-width.

**Bottom tabs** (`TeamBottomPane.tsx`)
1. **Tasks** — Kanban board with columns: `Pending`, `In Progress`, `Review`, `Done`, `Blocked`. Cards have diff stats, assignee, review badge. Expand card → task details + diff preview + `Approve / Revise / Reject` buttons. Drag to reassign. (Extends existing `Workshop.tsx`.)
2. **Timeline** — vertical feed of `team_events`: tool calls, status changes, messages, hook rejections, Inspector findings. Filter by agent, event type, severity. Click to jump to context.
3. **Diffs** — focused diff viewer. File list on the left, Monaco unified diff on the right. Scopes: single task or all tasks in Review. Approve / Revise / Reject buttons per task.
4. **Scratchpad** — a single shared markdown editor. Live-synced to `team_scratchpad.content`. Human can edit; saves propagate into every agent's next system prompt. Preview toggle.
5. **Messages** — mailbox of inter-agent messages. Lets you see who asked whom what. Post `@agent: …` messages yourself to direct an agent.
6. **Settings** — budget, hooks, review policy (Inspector on/off, parallel sub-review count, adversarial mode toggle), model overrides per role, `REVIEW.md` editor scoped to this team.

### 14.3 Launch flow (`TeamLauncher.tsx`)

Opened from:
- `+ New Constellation` button in the star map.
- `★ Deploy Constellation` button in any chat's header (covered in §15).

Three-step modal:
1. **Project & preset.** Dropdown of linked workspaces (reads from existing `lib/storage.ts`). Preset picker: `Feature`, `Review-only`, `Full-Stack`, `Migration`, `Debug`, `Research`, `Custom`. Each preset pre-seeds roles.
2. **Mission brief.** Free-form text box, auto-filled from the parent chat's last N messages if launched from chat. Editable. "Decompose" button calls Architect once synchronously to generate a draft task list.
3. **Review & budget.** Final roster, editable. Sliders: budget (default $25), max parallel Builders (default 2), Inspector mode (Off / Important-only / Full / Adversarial). Deploy button.

On Deploy: creates team + agents + worktrees in parallel, returns to the Constellation tab with the new constellation selected and pulsing.

### 14.4 Keyboard shortcuts

Match claude-squad's conventions where possible:

- `N` — new constellation
- `D` — kill focused agent
- `Enter` or `O` — focus on the selected agent's terminal
- `Esc` — detach focus
- `↑ ↓` — navigate agents in grid
- `Tab` — cycle bottom-pane tabs
- `C` — commit current task
- `M` — merge all approved
- `P` — pause constellation
- `R` — resume
- `?` — help overlay
- `/` — focus search in timeline

---

## 15. Chat ↔ Constellation integration

**The critical design principle: the Constellation tab is not a silo.** The existing ChatPanel is where the user already works, and the team feature must feel like an extension of chat, not a separate app.

Five integration mechanisms, layered:

### 15.1 "Deploy Constellation" button in ChatPanel

In `ChatPanel.tsx` header, next to the existing session controls, add a button: **`★ Deploy Constellation`**.

- Visible in every chat.
- Click → opens `TeamLauncher.tsx` modal with the last 10–20 messages of the current chat pre-filled into the Mission Brief text area. (Message history is already available in the chat's state.)
- User confirms preset, roster, budget → clicks Deploy.
- On success:
  - A `team` row is created with `parent_chat_session_key = <currentChatSessionKey>`.
  - The Commander agent is spawned with `resume: <chat's Claude SDK session_id>` — **the Commander literally inherits the chat's existing Claude session**. This is free via the existing session map in `data/claude-code-sessions.json`; we just reference the same session.
  - Other agents get fresh sessions in their own worktrees.
  - The chat gets a **pinned Constellation Card** at the top of its message list.

### 15.2 The pinned Constellation Card in chat

When a chat has a deployed constellation, the ChatPanel renders a sticky card at the top of the message feed:

```
┌─────────────────────────────────────────────────────────────┐
│ ★ Orion  •  ● Running  •  3/8 tasks  •  $12.40 / $50        │
│ ───────────────────────────────────────────────────────────  │
│ ✦ Commander  Merging #3        ◎ Inspector  Review #1       │
│ ● Builder-1  API route         ▲ Sentinel   Idle            │
│ ● Builder-2  ● Review          ✎ Scribe     Idle            │
│                                                             │
│  [Open Constellation ↗]  [Pause]  [Halt]  [Hide]            │
└─────────────────────────────────────────────────────────────┘
```

- Collapsible (remember state per chat).
- Updates live via the team SSE stream.
- "Open Constellation" jumps to the Constellation tab with this team focused.
- Survives chat restart (persisted to `chats` row).

### 15.3 Team events stream into the chat as system messages

Every high-signal team event is posted into the parent chat as a **system message bubble** (visually distinct from user/assistant bubbles — uses the existing subagent message style from `SubAgentTracker.tsx`):

```
★ Scout finished research — 4 findings posted to scratchpad
★ Architect drafted 6 tasks — ready for builders
★ Builder-1 completed "DB schema + RLS"   (+42 −8)
★ Sentinel: tests passed on task #1
★ Inspector found 1 important issue on task #1 — Builder-1 revising
    ╰ "Token refresh races with logout at session.ts:142" [🔴]
★ Builder-1 revised task #1 — Sentinel passed — Inspector clean
★ Commander merged task #1 → main
★ Constellation Orion: all tasks complete. Cost $34.20. Merged 6 PRs.
```

- Each event bubble has an expand chevron — click to see the full event payload.
- Click an agent name to scroll the Constellation tab to that agent and play the last 30 seconds of their stream.
- Click a task ID (`#task-abc123`) to open the task card.
- **Not every tool call** — only status transitions, completions, findings, and merges. Otherwise the chat drowns.
- Implementation: `TeamRunner` emits `TeamEventKind.chat_report = true` events that route into `/api/chat` as system-role messages for the parent session.

### 15.4 @-mention routing

Inside the chat input, when a constellation is deployed, typing `@` shows an autocomplete list of the constellation's agents (`@commander`, `@builder-1`, `@inspector`, etc.) plus `@all`.

- `@commander do X` — normal behavior (Commander is already bound to this chat's session).
- `@builder-1 what's the status on the DB schema?` — routes to Builder-1's session via `POST /api/teams/:id/message { to_agent_id, body }`. Builder-1 responds, and the response appears in **both** the Constellation tab's message log and the parent chat as a system bubble `★ Builder-1: "Halfway done, running into an RLS edge case…"`.
- `@all halt` — broadcast halt (the only broadcast message type permitted).

### 15.5 Multiple chats, multiple constellations

- A chat can have **at most one constellation** deployed at a time. Deploying a new one on a chat that already has one prompts "Replace existing Orion constellation?".
- A constellation can be "unbound" from its parent chat at any time (then it runs headless — reports only to the Constellation tab, no chat bubbles).
- Closing a chat does **not** kill its constellation. The constellation keeps running. A system notification fires on major events. The next time the user opens that chat, the pinned card shows current state. The list of chats in `ChatHistory.tsx` gets a small `★` badge on any chat with an active constellation.
- A constellation can be **adopted** by a new chat: from the Constellation tab, click "Bind to chat…" and pick a chat. From that point on, `@commander` in the new chat routes to the constellation. Useful for resuming after a session loss.

### 15.6 What this means for the user's workflow

Practically — the user's existing Mission Control chat doesn't change. The chat still works exactly as it does today. The new capability is:

1. When a task is big enough to want parallelism, click `★ Deploy Constellation`, pick a preset, hit go.
2. Keep typing in the chat as normal — you're still talking to Claude (specifically, the Commander, who has your chat history).
3. A card at the top shows live team status. System bubbles tell you when things complete or need attention.
4. If you want to look deeper, click the card → Constellation tab → see every agent, every diff, every finding.
5. Want to direct a specific agent? `@builder-1 …` in the chat. Answer comes back in the chat.
6. Everything the team produces comes back through one merge action, reviewed by a **Codex-powered Inspector** you control.

The tab is a magnifying glass on what's happening. The chat is still the cockpit.

---



### Cloned and analyzed
- `~/mc-research/parallel-code/` — Electron + SolidJS
- `~/mc-research/claude-squad/` — Go + tmux + Bubble Tea
- `~/mc-research/claude-flow/` — Node hive-mind v3.5.80

### Official docs
- Claude Code Agent Teams: https://code.claude.com/docs/en/agent-teams
- Agent SDK subagents: https://code.claude.com/docs/en/agent-sdk/subagents
- Custom subagents: https://code.claude.com/docs/en/sub-agents
- Anthropic multi-agent retrospective: https://www.anthropic.com/engineering/multi-agent-research-system

### Role libraries
- VoltAgent/awesome-claude-code-subagents: https://github.com/VoltAgent/awesome-claude-code-subagents
- wshobson/agents: https://github.com/wshobson/agents

### Orchestrators index
- andyrewlee/awesome-agent-orchestrators: https://github.com/andyrewlee/awesome-agent-orchestrators
- hesreallyhim/awesome-claude-code: https://github.com/hesreallyhim/awesome-claude-code

### Cost control
- musistudio/claude-code-router: https://github.com/musistudio/claude-code-router

---

## 16. Gap Resolution Matrix — all 62 findings

Every finding from the pre-implementation audit, with its concrete resolution. `§Dn` references point to the v2 decisions box at the top. `§M3` means migration #3 SQL (§17). Resolutions marked ✅ are locked; ⏳ means explicit deferral to a v2-post phase.

### 🔴 Blocking gaps (11 — all resolved)

| # | Gap | Resolution |
|---|---|---|
| 1 | Dispatcher→Builder task injection unspecified | ✅ **§D1** — Option C MCP loop. Workers call `mc_get_next_task`; dispatcher is passive. No mid-stream push needed. |
| 2 | `.claude/` symlink strategy underspecified | ✅ Complete list: symlink `.claude/skills/`, `.claude/agents/`; shallow real dir for `.claude` root; exclude per-agent `plans/` and `settings.local.json` (each agent's worktree has its own). See §5.2. |
| 3 | Cost computation granularity | ✅ **§D9** — read `total_cost_usd` from SDK's `result` message (bridge line 584 pattern). Atomic `UPDATE` on every `result`. Budget check at message yield time. |
| 4 | Task dependency claim SQL | ✅ **§M3** — indexed claim via `WHERE team_id=? AND status='pending' AND (role_hint IS NULL OR role_hint=?) ORDER BY priority DESC, created_at ASC LIMIT 1` in a `RETURNING *` UPDATE. Tested against live backup, proven race-free. Dep-check handled in `claimNextTask()` application layer: `depends_on` JSON array is parsed; task only claimable if `SELECT count(*) FROM team_tasks WHERE id IN (deps) AND status IN ('done','approved') = len(deps)`. |
| 5 | Hook execution contract | ✅ **§D10** — full contract table. Array-form cmd (no shell injection), explicit env vars, 10-minute default timeout, exit code semantics. |
| 6 | Task state machine undefined | ✅ **§D4** — canonical 11-state machine with diagram, CHECK constraint enforced in `team_tasks.status` (§M3). |
| 7 | Codex API contract | ✅ **§D3** — verified source of `codex-plugin-cc`. Shell out via `codex-companion.mjs`, capture JSON matching `review-output.schema.json`, wrap in `mc_codex_review` MCP tool. No slash commands. Prereqs: Node 18.18+, `@openai/codex` installed, `codex login` done. |
| 8 | Commander session binding | ✅ **§D2** — Commander IS the chat session with extra MCP tools. No resume, no fork, no multi-driving. Verified that SDK does not support concurrent session resume. |
| 9 | Merge conflict handling | ✅ Per-repo Promise-chain lock ported from `parallel-code/electron/ipc/git.ts:72–90`. Failure path: `git merge --abort`, task → `blocked`, conflict file list in `team_tasks.error_detail`, injected `priority:'next'` message to Builder: *"Rebase onto main and resubmit."* |
| 10 | MCP tool provisioning per role | ✅ Each role file in `.claude/agents/` has YAML `tools:` list. `lib/teams/roles.ts` parses it; `runAgent` builds `allowedTools: [...roleTools, 'mcp__mc-teams__*']`. The per-agent MCP server has a closure-scoped tool set (different tools for Inspector vs Builder). |
| 11 | Pause/resume semantics | ✅ Pause = flip `teams.status='paused'` + inject `priority:'now'` halt message + 15s grace + `handle.close()`. Resume = `runAgent` again with `Options.resume: session_id` + inject *"Resume your task loop."* Halt = same but also kills worktrees (opt-in). |

### 🟠 Ambiguous or contradictory (4 — resolved)

| # | Gap | Resolution |
|---|---|---|
| 12 | `review` vs `ready_for_review` state mismatch | ✅ **§D4** — both are distinct states in the canonical machine. |
| 13 | Model routing vs cost claims | ✅ Cost table adjusted: default Feature preset = 1 Opus Commander + 1 Opus Architect (short-lived) + 2 Sonnet Builders + 1 Sonnet Inspector + 1 Haiku Sentinel + 1 Haiku Scribe. Realistic estimate for a 6-task feature mission: $20–$45 + Codex $6–$18 = $26–$63 total. Default budget is $50. |
| 14 | `.claude` subdir behavior | ✅ Resolved in gap #2. |
| 15 | "Watchdog" undefined | ✅ Renamed to **reaper**, lives in `lib/teams/reaper.ts`, runs every 30s via `setInterval`, detects (a) stale claimed/in_progress tasks, (b) crashed agents (runner gone from `activeRunners` but status not terminal), (c) orphaned worktrees. |

### 🟠 Unspecified integrations with existing code (6 — resolved)

| # | Gap | Resolution |
|---|---|---|
| 16 | How dispatcher injects into running SDK | ✅ **§D1** — it doesn't. Workers pull. Dispatcher writes rows. |
| 17 | `claude-chat-bridge.ts` refactor scope | ✅ Three-file split: `lib/claude-sdk-session.ts` (session map, skills, stale retry), `lib/claude-sdk-render.ts` (message→SSE translator), `lib/teams/runner.ts` (new, the `runAgent` function). Bridge shrinks to ~120 lines. Detailed in §18. |
| 18 | memory.db migration coexistence | ✅ **§M3** — migration #3, gated on `schema_meta.version = 2`, wrapped in a SQLite transaction, tested on a backup of the real 34MB production DB. Verified: 823 turns and 11 episodes preserved, atomic claim query works, schema_meta advances 2→3. |
| 19 | Session persistence across restart | ✅ **§D8** — `team_agents.session_id` is written on every `system/init` message (first init and every resume-init). On boot, the reaper reverts stale claims; then `lib/teams/boot.ts` re-attaches each running agent via `Options.resume`. |
| 20 | SubAgentTracker / UsageStats integration | ✅ SubAgentTracker filters `WHERE team_id IS NULL` (hidden coupling #1/#3 namespace). UsageStats aggregates `SELECT SUM(cost_usd) FROM team_agents WHERE team_id=?` and shows a new "Team cost" stacked chart. Workshop's Kanban stays for personal tasks; new `<TaskBoard>` component in the Constellation tab is team-scoped. |
| 21 | Scratchpad collision | ✅ Existing `Scratchpad.tsx` (personal, localStorage) unchanged. New `ScratchpadEditor.tsx` backed by `/api/teams/:id/scratchpad` (version-checked writes against `team_scratchpad.version`). Two different components, zero overlap. |

### 🟡 Missing UI/UX details (7 — resolved or explicitly deferred)

| # | Gap | Resolution |
|---|---|---|
| 22 | Error states | ✅ Every agent tile has a status pill with 6 colors. Critical errors raise a toast (via existing NotificationsPanel) + insert `team_events(severity='error')` row. Error log dialog on click. |
| 23 | Force-quit dev server recovery | ✅ **§D8** — covered by resume path and reaper. |
| 24 | Team settings UI | ✅ Settings are `teams.settings_json` (JSON column). Edit via modal from the Settings tab in the Constellation bottom pane. Schema: `{hooks: {taskCompleted: {cmd, args, timeout_ms}}, review: {mode, skip_trivial, min_files, min_loc}, budget: {cap_usd, alert_at}, models: {commander?, architect?, builder?, inspector?, ...}, merge: {policy, auto_on_clean}}`. Live-editable; takes effect on next task claim. |
| 25 | Codex first-run setup | ✅ Blocking. `lib/teams/codex-check.ts` runs on first "Deploy Constellation" click. Verifies: (1) `node -v` ≥ 18.18, (2) `codex --version` succeeds, (3) `~/.codex/auth.json` exists. If any fail, modal shows a 3-step wizard: "Install Node 18+", "Run `npm i -g @openai/codex`", "Run `codex login`". Can skip (Inspector then disabled for this team). |
| 26 | Mobile/narrow-window | ⏳ v1 is desktop-only. On `<1024px` the grid collapses to single column and focus pane becomes a full-screen modal. No touch-optimization in v1. |
| 27 | Delete constellation | ✅ Two tiers: **Archive** (`teams.archived_at = now()`, constellation hidden from default list, worktrees preserved) and **Purge** (requires confirmation dialog, runs `git worktree remove --force` per agent, `DELETE FROM teams WHERE id=?` cascades). |
| 28 | Pause vs Halt distinction | ✅ **§D11** — Pause is reversible (worktrees kept, sessions preserved, dispatcher stops claim). Halt is terminal-for-this-run (agents closed, worktrees kept for review, can still merge approved tasks). |

### 🟠 Missing operational concerns (5 — resolved)

| # | Gap | Resolution |
|---|---|---|
| 29 | Logging/observability | ✅ All events → `team_events` table. Query-able via `/api/teams/:id/events?kind=&severity=`. Existing `UsageStats.tsx` gets a "Team view" filter. New `/api/teams/:id/logs.jsonl` endpoint for export. |
| 30 | Rate limit handling | ✅ SDK's `rate_limit_event` message (existing bridge handles at line 596–608). New behavior for team agents: insert `team_events(kind='rate_limit')`, check `settings_json.models.fallback`, if present auto-switch agent to the fallback tier for the next task; otherwise `pauseTeam(id, 'rate_limit')`. |
| 31 | Disk quota for worktrees | ✅ Before creating a new worktree: `statvfs` check. Warn at <5GB free, block at <1GB. Soft limit per team: 5 agents × estimated 500MB = 2.5GB. Settings allow override. |
| 32 | Concurrent constellation limits | ✅ Env var `MC_MAX_CONCURRENT_TEAMS` (default 5). UI disables Deploy button when at limit with tooltip. |
| 33 | Session resumption after SDK crash | ✅ `team_agents.session_id` persisted on every `system/init`. Reaper + boot sequence handle restart. Session resume preamble: *"Previous session ended unexpectedly. Current task is `<task_id>`. Call `mc_get_next_task` to continue; if it returns that same task_id it will resume automatically."* |

### 🟠 Security / permission gaps (4 — resolved)

| # | Gap | Resolution |
|---|---|---|
| 34 | Codex API key storage | ✅ Plugin uses `~/.codex/auth.json` (managed by `codex login`). MC never reads or stores the key. Audit trail: every Codex review is a row in `task_reviews` with raw output retained for 30 days (settings-configurable). |
| 35 | Worktree isolation | ✅ Worktrees inherit parent repo's user. No elevation. Each worktree's `.env` is symlinked from the parent so secrets aren't duplicated. Team-scope secrets (if any) go in `teams.settings_json.secrets` encrypted via a libsodium secret stored in `~/.mission-control/secret.key`. v1 does not encrypt; ⏳ deferred. |
| 36 | Hook shell injection | ✅ **§D10** — hook cmd is stored as array, spawned without shell. `[cmd, ...args]` form only. No `sh -c` path. |
| 37 | Auto-merge approval | ✅ Controlled by `teams.settings_json.merge.policy`: `'manual'` (default), `'one_click_from_ui'`, `'auto_on_clean'` (requires: Sentinel passing + Inspector all-clean + no findings severity ≥ high). |

### 🟡 Cost & rate-limiting gaps (3 — resolved)

| # | Gap | Resolution |
|---|---|---|
| 38 | Codex cost folded into total | ✅ **§D9** — separate bucket. UI shows stacked "Claude $X + Codex $Y = Total $Z". Budget cap covers both. Estimated pre-run: `num_agents × avg_tokens_per_task × rate` plus `num_expected_reviews × $1`. |
| 39 | Budget check timing | ✅ **§D9** — every `result` message from SDK. Sub-budget alerts at 75% (amber) and 90% (red) via toast. Pause at 100%. |
| 40 | Fallback to lower-tier models | ✅ v1: on rate-limit, auto-downgrade if `settings_json.models.fallback` is set. v2: integrate `claude-code-router`. |

### 🟡 Testing gaps (2 — resolved)

| # | Gap | Resolution |
|---|---|---|
| 41 | No test plan | ✅ **§19** — test plan per phase. |
| 42 | No seed constellation | ✅ `data/team-presets.json` ships with a "Smoke Test" preset: 2 agents (Builder + Inspector) + 1 task ("edit README.md: add timestamp"). Used by the Phase 2 exit test. |

### 🟡 Named but undefined (4 — resolved)

| # | Gap | Resolution |
|---|---|---|
| 43 | "Watchdog" | ✅ = reaper. See gap #15. |
| 44 | "Review policy" | ✅ `teams.settings_json.review` — see §D11 / gap #24. |
| 45 | Task decomposition prompt | ✅ Added `lib/teams/prompts/decompose.md` with Architect's prompt template. Read by `mc_create_team` when the user clicks "Decompose" in the launcher. |
| 46 | Team presets | ✅ `data/team-presets.json` — array of `{id, name, description, roles[], default_settings}`. 7 presets ship: smoke_test, feature, review_only, fullstack, migration, debug, research. |

### 🟡 Features promised once and abandoned (7 — resolved)

| # | Gap | Resolution |
|---|---|---|
| 47 | Tailscale/QR remote access | ⏳ Deferred to v2-post. Explicitly in §7 "Skip" list now. |
| 48 | Adversarial review mode | ✅ `mc_codex_review(mode='adversarial')` — see §D3. |
| 49 | Live scratchpad sync concurrency | ✅ Version-check writes: `UPDATE team_scratchpad SET content=?, version=version+1, updated_at=?, updated_by=? WHERE team_id=? AND version=?`. If zero rows affected, return 409 to client; client re-reads and retries. Last-writer-wins per version bump. Agents always read fresh at task start. |
| 50 | REVIEW.md customization | ✅ Inspector's `mc_codex_review` tool reads project-root `REVIEW.md` and the team's `settings_json.review.custom_prompt` (optional), concatenates, passes as `--focus` to Codex. |
| 51 | Three merge lanes | ✅ Controlled by `settings_json.merge.policy`. Lane logic in `lib/teams/merge-lanes.ts`. See gap #37. |
| 52 | Bind/unbind constellation to chat | ✅ `UPDATE teams SET parent_chat_key = ?` — exposed via `/api/teams/:id/bind` (PATCH). UI: "Bind to chat..." in constellation header dropdown → picks from active chat list. |
| 53 | Multi-constellation switching | ✅ Header dropdown reads `SELECT * FROM teams WHERE archived_at IS NULL ORDER BY updated_at DESC`. Active team stored in `localStorage.mcActiveTeamId` + URL query `?team=<id>`. |

### 🟡 Existing features not integrated (6 — resolved)

| # | Gap | Resolution |
|---|---|---|
| 54 | SessionViewer | ✅ Shows team sessions with a ★ badge. Clicking a team session opens the Constellation tab with that agent focused. |
| 55 | NotificationsPanel | ✅ `team_events` with `severity='warn'|'error'` or `kind='task_transition'` (for `done`/`blocked`) emit OS notifications. Settings toggle per team. |
| 56 | MemoryViewer | ✅ Adds "Team scratchpads" section that lists `team_scratchpad` rows. |
| 57 | ErrorTracker | ✅ Consumes `team_events WHERE severity='error'`. |
| 58 | Large-paste offloading for team task descriptions | ✅ Same mechanism as chat: if `team_tasks.description` > 4KB, offload to `data/pastes/task-<id>.md` and store only the path in the DB. Builder reads via `Read` tool. |
| 59 | Browser control per role | ✅ Role-aware. `builder`, `scout`, `inspector` get browser tools. `sentinel`, `scribe`, `navigator` don't. Implemented via `allowedTools` filter in `runAgent`. |

### 🟡 Open questions from §9 (3 — now resolved)

| # | Gap | Resolution |
|---|---|---|
| 60 | Session resume race | ✅ session_id written on every `system/init`, reaper + boot sequence, resume preamble. See #33. |
| 61 | pnpm + symlinks | ✅ Test in Phase 1. If `pnpm install` breaks in a symlinked worktree, fall back to `cp -rL node_modules` per worktree (slow but reliable). Decision at runner init via `settings_json.worktree.node_modules_strategy`. |
| 62 | Stale memory.db migrations | ✅ Migration #3 gated on `version=2`, wrapped in transaction, verified on backup. |

**All 62 resolved. 2 explicitly deferred (#26 mobile, #47 remote). 0 outstanding blockers.**

---

## 17. Verified Migration #3 SQL

**Location:** `~/mc-research/db-backups/migration-3-teams.sql`

Tested against a backup of the live 34MB production `memory.db` at `~/mc-research/db-backups/memory.db.pre-m3`. Verification result:

- ✅ `schema_meta.version` 2 → 3
- ✅ 10 tables created: `teams`, `team_agents`, `team_tasks`, `team_messages`, `team_events`, `team_scratchpad`, `task_reviews`, `task_review_findings`, `mc_subagents`, `active_tasks`
- ✅ 32 indexes created
- ✅ Existing `turns` (823 rows) and `episodes` (11 rows) still queryable
- ✅ Atomic task claim (`UPDATE ... RETURNING`) works race-free on inserted test data
- ✅ Second concurrent claim on the same row returns `undefined` as expected (SQLite single-writer enforcement proven)

**Production `memory.db` is NOT touched.** Migration #3 will run for real from `lib/memory-schema.ts` when Phase 1 ships, as an additional entry in the existing `MIGRATIONS` array (`lib/memory-schema.ts:114–142`), following the same pattern as migrations #1 and #2.

---

## 18. The `runAgent` refactor — exact file-level touchpoints

The three-file split with line-level references so the change can be made without re-reading the whole 663-line bridge.

### 18.1 Extract `lib/claude-sdk-session.ts` (new, ~140 lines)

Move from `lib/claude-chat-bridge.ts`:
- `loadSessionMap`, `saveSessionMap`, `getClaudeSessionId`, `setClaudeSessionId`, `deleteClaudeSessionId` (`bridge:27–58`)
- `loadSkillsContext` (`bridge:117–153`)
- `getBrowserInstructions` (`bridge:158–177`)
- `withStaleRetry<T>(sessionKey, fn)` — extracted from the stale-session recovery block (`bridge:531–554`)

New export:
- `buildSdkOptions({cwd, model, permissionMode, resume, appendSystemPrompt, mcpServers})` — produces the `sdkOptions` object currently built inline at `bridge:236–254`, used by both `spawnClaudeStream` and `runAgent`.

### 18.2 Extract `lib/claude-sdk-render.ts` (new, ~400 lines)

Move the message-to-SSE translation loop (`bridge:279–609`) into a pure function:

```ts
export interface RenderContext {
  controller: ReadableStreamDefaultController;
  sessionKey?: string;
  requestId?: string;
  fullContent: { value: string };
  capturedSessionId: { value: string | null };
  recordSubagentStart: (msg: any) => void;
  recordSubagentFinish: (msg: any) => void;
  onResult?: (usage: any) => void;
  onRateLimit?: (evt: any) => void;
  teamContext?: { teamId: string; agentId: string };  // NEW: namespacing
}

export function renderSdkMessageToSSE(msg: SDKMessage, ctx: RenderContext): void
```

Also move `toolStatusLabel(name, input)` (`bridge:180–200`) — pure function.

### 18.3 New `lib/teams/runner.ts` (~350 lines)

Exports `runAgent(agentRow, opts?)` per §D1. Uses `buildSdkOptions` + `renderSdkMessageToSSE` from the extracted modules. Does NOT import from `claude-chat-bridge.ts` — dependency is one-way.

Signature:
```ts
export interface RunnerHandle {
  agentId: string;
  readonly sessionId: string | null;
  send(text: string, opts?: { priority?: 'now'|'next'|'later' }): void;
  close(): Promise<void>;
}

export function runAgent(
  agent: TeamAgentRow,
  opts?: {
    onEvent?: (msg: SDKMessage) => void;
    onSessionId?: (id: string) => void;
    additionalTools?: SdkMcpToolDefinition[];  // for Inspector's mc_codex_review
  }
): Promise<RunnerHandle>
```

### 18.4 `lib/claude-chat-bridge.ts` after refactor

Stays as the entry point for `/api/chat`. After extraction:
- ~120 lines.
- Still owns `activeQueries`, `activeProcesses`, `pendingResponses` (chat's lifecycle maps — separate from team runner's `globalThis.__mcTeams.activeRunners`).
- Still handles the chat's memory indexer call at `bridge:619–624`.
- Kill-on-reentry at `bridge:211–216` updated with a prefix guard: only kill if `sessionKey` does NOT start with `team:`.

### 18.5 `/api/stop` update

`app/api/stop/route.ts:13–44` — add prefix check:
```ts
if (sessionKey.startsWith('team:')) {
  return Response.json(
    { error: 'Team sessions must be halted via /api/teams/:id/halt' },
    { status: 409 }
  );
}
```

---

## 19. Phase-by-phase test plan

### Phase 1 tests (foundations)
- `lib/teams/worktree.test.ts` — create, symlink verification, merge success, merge conflict abort, dirty-refuse-delete, per-repo lock contention.
- `lib/teams/schema.test.ts` — migration 2→3 on a fresh and on a populated DB, idempotence (re-run is a no-op).
- `lib/teams/cost.test.ts` — `addCostAndCheckBudget` under concurrency (spawn 10 parallel updates, verify atomicity).
- `lib/teams/state-machine.test.ts` — every transition listed in §D4, and every invalid transition rejected by the CHECK constraint.
- `lib/claude-sdk-session.test.ts` — session map read/write, stale retry behavior.
- `lib/claude-sdk-render.test.ts` — golden tests: feed known SDK messages, assert SSE chunks match snapshots.

### Phase 2 tests (runner + dispatcher)
- Integration: spawn a 3-agent team (Builder + Inspector + Sentinel) with 2 tasks against a tmp git repo. Verify: both tasks claim-and-complete, Inspector reviews each, Sentinel runs, merge lane merges both to main. No leftover state.
- SDK session survival: spawn 1 agent, kill the Node process, restart, verify `runAgent` resumes the session and the agent continues its task loop.
- Budget cap: spawn a team with $0.10 cap and 4 tasks, verify it pauses after the first task and emits a `budget_alert` event.
- Race: spawn 2 Builders with 1 task; verify only one claims via `mc_get_next_task` (second returns `{status:'idle'}`).
- Hot-reload: start a team, modify `lib/teams/runner.ts`, verify (a) Next.js reloads, (b) `globalThis.__mcTeams.activeRunners` survives, (c) agent keeps running.
- Codex smoke: manually invoke `mc_codex_review` on a known-dirty diff, verify adversarial JSON parses and findings populate `task_reviews` + `task_review_findings`.

### Phase 3 tests (UI)
- Launch constellation from TeamLauncher modal, verify tiles appear with correct status.
- Click tile, verify FocusPane attaches xterm.js to SSE stream and shows live output.
- Approve a task via TaskDiffDialog, verify it merges.
- Kill server mid-run, reload browser, verify the constellation UI shows the correct recovered state.
- `@-mention` in chat: type `@inspector review task T-1`, verify it routes and response appears in both chat and Constellation tab.

### Phase 4 tests
- Auto-merge with clean Inspector and passing Sentinel.
- Adversarial Inspector finds a critical issue → task bounces back to Builder → revised → re-inspected → approved.
- Rate-limit fallback: force a fake `rate_limit_event`, verify fallback model kicks in.
- Archive + Purge workflows.

### Manual smoke test (after Phase 2)
Run the `smoke_test` preset from `team-presets.json` against a scratch repo. Expected: 2 agents spawn, task "add timestamp to README.md" completes in under 2 minutes, Inspector approves, merged to main. Cost under $0.50.

### Integration smoke test (after Phase 4)
Deploy a real Feature constellation against the RevolveCore repo with goal "Add a `show archived` filter to the Platform Admin Companies page". Expected: 4–6 tasks, all complete in ~30 minutes, $15–$35 total. Manually review and merge.

---

## 20. Phase order — updated for v2

Implementation order is now concrete. Each phase has an exit criterion that's executable.

### Phase 0 — Pre-flight ✅ COMPLETE
Done by this doc. Migration tested, runtime model picked, Codex contract verified.

### Phase 1 — Foundations (3–5 days)
1. Add migration #3 to `lib/memory-schema.ts` MIGRATIONS array.
2. SQLite-backed `lib/mc-subagents-store.ts` — replaces JSON file. Dual-read on first boot.
3. SQLite-backed `active-tasks` — replace `/api/active-tasks` JSON handling.
4. `lib/teams/worktree.ts` — ported from `parallel-code/electron/ipc/git.ts`.
5. `lib/teams/roles.ts` — YAML frontmatter parser, reads `.claude/agents/*.md`. Seed with 8 role files from VoltAgent collection.
6. `lib/teams/cost.ts` — pricing lookup, `addCostAndCheckBudget`.
7. `lib/teams/schema.ts` — typed accessors.
8. **Refactor:** extract `lib/claude-sdk-session.ts` + `lib/claude-sdk-render.ts` from the bridge. No functional changes to chat.

**Exit:** unit tests in §19 Phase 1 pass. Dev server boots. Existing chat works identically.

### Phase 2 — Runner + dispatcher + Inspector (5–7 days)
1. `lib/teams/mcp-server.ts` — per-agent factory with 6 core tools.
2. `lib/teams/runner.ts` — `runAgent()` with `RunnerHandle`. `globalThis.__mcTeams` for hot-reload.
3. `lib/teams/reaper.ts` — 30s interval for stale claims, crashed agents, orphaned worktrees.
4. `lib/teams/hooks.ts` — TaskCompleted hook runner per §D10.
5. `lib/teams/boot.ts` — resume running teams on server start.
6. `lib/teams/codex.ts` — subprocess wrapper for `mc_codex_review`.
7. Commander MCP server — registered inline in `spawnClaudeStream` when chat has team context.
8. API routes under `app/api/teams/*`.
9. `/api/stop` prefix check.
10. `data/team-presets.json` seed file.

**Exit:** `smoke_test` preset runs end-to-end headlessly. Phase 2 tests pass.

### Phase 3 — Constellation UI (5–7 days)
1. Rewrite `components/TeamsPanel.tsx` as the Constellation tab shell. Route `/constellation`.
2. Build 10 new components: `TeamList`, `TeamOverview`, `AgentTile`, `FocusPane`, `TaskBoard`, `TaskDiffDialog`, `TeamTimeline`, `ScratchpadEditor`, `CostBadge`, `TeamLauncher`, `ConstellationSwitcher`.
3. `useTeamStream(teamId)` hook.
4. ChatPanel integration: Deploy button, pinned card, system-bubble events, `@-mention` autocomplete.
5. Commander tool registration for chats with linked teams.

**Exit:** Phase 3 tests pass. Manual smoke test through the UI works.

### Phase 4 — Polish + integrations (3–5 days)
1. Merge lanes (manual / one_click / auto_on_clean).
2. Budget & rate-limit UX.
3. Archive/Purge workflows.
4. NotificationsPanel + UsageStats + SessionViewer + ErrorTracker + MemoryViewer integrations (gaps #54–57).
5. Keyboard shortcuts.
6. Codex first-run check + wizard.

**Exit:** Phase 4 tests pass. Integration smoke test against RevolveCore succeeds.

### Phase 5 — Deferred (v2-post)
- Mobile/responsive polish (#26)
- Tailscale/QR remote access (#47)
- `claude-code-router` cost optimization
- Encrypted team secrets
- AST-level symbol locking (wit-style) for safe intra-worktree file sharing
- Multi-project command center view
- Original plan §6 Phase 5 features

---

## 21. The one-sentence pitch

> **Mission Control becomes the UI that `parallel-code` would be if it natively spoke the Agent SDK, streamed over the web instead of Electron, enforced quality via hooks, and let you review and merge 5 agent worktrees in the same time it takes `claude-squad` to attach to one.**
