# Mission Control — Complete Layout & Flow Map

> Every page, every panel, every button, every option — and where each thing sits on screen.
> Snapshot: HEAD `722e947` · 2026-05-17.

---

## Top-level architecture

Mission Control is a **single-page Next.js App Router app**. There are three routes:

| Route | Purpose |
|---|---|
| `/` | Main app shell — header + tab nav + active panel + mobile bottom nav + footer |
| `/memory-vault` | Standalone Memory & Vault inspector (no app shell) |
| `/reset` | Hard-reset of `localStorage` (debug recovery) |

All tab switching happens client-side inside `/` via `activeTab` state — no route changes. The URL accepts `?tab=<id>` and `?embed=1` (used by the REMOTE iframe).

---

## 1 · Global header (top of every screen)

`<header>` along the top, **`max-w-[1800px]`**, fixed height, `border-b border-terminal-border`.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ [🟢 Terminal] MISSION CONTROL          [📁 workspace] [⏱ time] [🟢 CONNECTED] [⚙ Settings]│
│              OpenClaw Command Center v2.0                                                │
│                                                                                          │
│ [DASHBOARD] [CHAT] [📝 SEO] [🛰️ LUKE'S CHAT] [✦ CONSTELLATION] [📋 DOCS] [📝 ACTIVITY]   │
│ [🛰 REMOTE]   [🛠 Build ▾]   [📊 Monitor ▾]   [🧠 Knowledge ▾]      [Mem/Vault badge →]  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Header bar — left side

| Element | Behavior |
|---|---|
| **Lobster / Terminal icon** | Static logo |
| **`MISSION CONTROL` title** (desktop) · `MC` (mobile) | Static |
| `OpenClaw Command Center v2.0` subtitle | Hidden on small mobile |
| **Active tab label** | Mobile-only — shows `/ CHAT`, `/ DOCS`, etc. |

### 1.2 Header bar — right side

| Element | Behavior |
|---|---|
| **Workspace pill** (`📁 <last-segment>`) | Click → opens Settings modal. Hidden on mobile. |
| **Time** (`HH:MM:SS`) | Updates live. Hidden on small mobile. |
| **Connection badge** (`🟢 CONNECTED` / `🔴 OFFLINE`) | Reflects gateway WebSocket status. Compact on mobile. |
| **⚙ Settings** button | Opens Settings modal. |

### 1.3 Top tab nav (desktop only — `hidden md:flex`)

**Eight primary tabs** rendered flat, three category dropdowns rendered as `<TopNavDropdown>`, then a status badge.

| Order | Label | id | Notes |
|---|---|---|---|
| 1 | **DASHBOARD** | `dashboard` | Default tab |
| 2 | **CHAT** | `chat` | Main agent chat |
| 3 | **📝 SEO** | `seo-chat` | Locked workspace = `~/<your-seo-workspace>`, namespace `seo`, hides constellation UI |
| 4 | **🛰️ LUKE'S CHAT** | `lukes-chat` | Namespace `missions`, adds `MissionsDashboard` above the chat |
| 5 | **✦ CONSTELLATION** | `teams` | TeamsPanel |
| 6 | **📋 DOCS** | `docs` | DocsPanel |
| 7 | **📝 ACTIVITY** | `edit-activity` | Cross-machine edit log |
| 8 | **🛰 REMOTE** | `remote` | Iframes a peer MC's chat |

| Dropdown | Items |
|---|---|
| **🛠 Build ▾** | 🔧 Dev · Workshop · Files · 🌐 Browser · 🐙 GitHub |
| **📊 Monitor ▾** | Activity · Logs · 🐛 Reports · QA · History · Digest |
| **🧠 Knowledge ▾** | 🧠 Memory & Vault · Skills · 🔐 Credentials · Agents · 💡 Radar |

| Right-aligned | Behavior |
|---|---|
| **MemVault status badge** | Click → jumps to Memory & Vault tab |

### 1.4 Settings modal

Opens centered over the page (`fixed inset-0 z-50 bg-black/80`). Sections (top to bottom):

1. **ACTIVE WORKSPACE**
   - Text input for path (`C:\Projects\…` or `/home/user/…`)
   - Folder picker button (FileSystem Access API)
   - Green confirmation `✓ Working in: <path>`
2. **THEME**
   - 2-column grid of theme cards (preview swatch + name + description + ✓ on active)
3. **GATEWAY CONNECTION**
   - URL input (`ws://localhost:18789`)
   - Auth token input (password field)
4. Footer: `Cancel` · `Save`

---

## 2 · Mobile bottom nav (`<MobileNav>`)

Visible only on mobile (`<md`). Fixed to viewport bottom.

| Slot | Tab | Icon | Label |
|---|---|---|---|
| 1 | `chat` | MessageSquare | Chat |
| 2 | `docs` | ClipboardList | Docs |
| 3 | `edit-activity` | FileEdit | Edits |
| 4 | `remote` | Wifi | Remote |
| 5 | **MORE** | overflow | opens a drawer with all remaining tabs |

The MORE drawer lists, in order: Dash · SEO · Constel · Agents · Radar · Skills · History · QA · Workshop · Activity · Logs · Files · Vault · Mem/Vault · Digest · Reports · Browser · GitHub.

---

## 3 · Desktop footer (`<md`-hidden)

Fixed to viewport bottom (`fixed bottom-0 left-0 right-0`).

| Left | Right |
|---|---|
| `📁 <workspace>` · `● Online` / `○ Offline` | Press `?` for help |

---

## 4 · Tab: DASHBOARD

Three-column grid (`md:grid-cols-12`) inside `max-w-[1800px]`.

| Col | Width | Stack (top to bottom) |
|---|---|---|
| **Left** | `md:col-span-3` | `StatusPanel` · `SystemHealth` · `CommandBar` (desktop) · `NotificationsPanel` (desktop) |
| **Middle** | `md:col-span-6` | `ChatHistory` · `SessionViewer` · `UsageStats` · `CommandBar` (mobile) · `NotificationsPanel` (mobile) |
| **Right** | `md:col-span-3` | `CronJobs` · `CronCalendar` (desktop) · `SkillsManager` · `QuickLinks` (desktop) · `Scratchpad` (desktop) |

---

## 5 · Tab: CHAT (and variants — SEO, LUKE'S CHAT)

The `<ChatPanel>` is **the most complex surface in MC**. Same component renders three tabs with different props:

| Tab | Props |
|---|---|
| CHAT | (default) |
| SEO | `namespace="seo"` `lockedWorkspace="~/<your-seo-workspace>"` `panelTitle="SEO"` `hideConstellationUi` |
| LUKE'S CHAT | `namespace="missions"` `panelTitle="Luke's Chat"` `hideConstellationUi` (with MissionsDashboard above) |

### 5.1 ChatPanel layout (desktop)

```
┌─Sessions Sidebar──┬─────Main Chat Area─────────────────────┬─Task Panel─┐
│ CONVERSATIONS  ➕  │ ┌ Header Row ───────────────────────┐ │ (collapsed │
│ ┌ Search ────────┐│ │ 💬 Chat name  [🟢 LIVE] [NOTEPAD] │ │  toggle)   │
│ │ filter chats   ││ │   ⋯ workspace · model · pair · …  │ │            │
│ └────────────────┘│ │   [✦ Constellation] [🛠 Tools ▾] │ │            │
│ • Chat 1   ✎ 🗑   │ └──────────────────────────────────┘ │            │
│ • Chat 2          │ ┌ Messages (Virtuoso scroll) ──────┐ │            │
│ • Chat 3 (active) │ │ user / assistant / sub-agent / … │ │            │
│ • …               │ │ approval cards · plan cards ·    │ │            │
│                   │ │ phase-stuck cards · autopilot    │ │            │
│                   │ └──────────────────────────────────┘ │            │
│                   │ ┌ Optional: ActivityStrip · Undo · │ │            │
│                   │ │ DiagnoseLoop · OnboardingStrip · │ │            │
│                   │ │ ApprovalModal · CodexQuestion …  │ │            │
│                   │ └──────────────────────────────────┘ │            │
│                   │ ┌ Composer ────────────────────────┐ │            │
│                   │ │ [📎] [🖼] [textarea]  [✦Spawn]   │ │            │
│                   │ │                         [✨][▶]   │ │            │
│                   │ └──────────────────────────────────┘ │            │
└───────────────────┴──────────────────────────────────────┴────────────┘
```

### 5.2 Sessions sidebar (left)

Width: `w-64` desktop, `w-[85vw] max-w-[320px]` mobile overlay.

**Header row:**
- `CONVERSATIONS` title (green)
- `➕` New session button
- `X` close button (mobile only)

**Body — list of chat sessions**, each row:
- Click body → switch to that session
- Editable name (✎) — opens inline `<input>` + ✓ save
- Trash (🗑) — delete with confirmation
- Active session highlighted in `bg-terminal-green/10`

**Per-row metadata:**
- Name (truncated)
- Pin indicator (📌) if pinned
- Last message preview (`text-terminal-dim` truncated)
- Workspace folder (cyan)

### 5.3 Chat header row (top of main area)

Desktop, in order:

| Element | Behavior |
|---|---|
| `💬` icon + **chat name** | Inline editable on long-press / right-click |
| `🟢 LIVE` badge | Always present |
| **NOTEPAD** pill button | Toggles SharedNotepad drawer (was added 2026-05-17) |
| Hidden inline: Active Skills, Pair Mode chip, Workspace selector, GitHub-repo chip, Key Facts badge, Pull-latest dropdown, Constellation deploy chip | All surfaced through the Tools menu instead |
| **🛠 Tools ▾** menu | The big dropdown — full inventory in section 5.6 |

Mobile, in order:
- `MessageSquare` button → open sessions sidebar
- Chat name (truncated, flex-1)
- `🟢` running pulse (when isLoading)
- `⚡ Tasks (N)` badge button (visible when tasks exist)
- `📓 Notebook` button → opens SharedNotepad bottom sheet
- `↻ Reset` button
- `⚙ Settings` → opens mobile-tools drawer

The **mobile-tools drawer** mirrors most of the desktop Tools menu items as flex-wrap pill buttons (Workspace · Model · Pair mode · Skills · Reports · …).

### 5.4 Messages area

Virtualized list (`react-virtuoso`). Each message can render:

| Element | When |
|---|---|
| `MessageBubble` (`role: user | assistant`) | Default |
| Sub-agent badges | When `voice === 'codex' \| 'orchestrator' \| ...` |
| **PlanCard** | `protocol: pair-build` or `autopilot` |
| **Autopilot events list** | `autopilotEvents` present |
| **PhaseStuckCard** | When a phase exceeds rework cap; offers `Retry with bumped cap` or `Skip to next phase` |
| **Autopilot finish banner** | 🏁 success at end of run |
| **ApprovalModal** (modal) | When the agent requests destructive Bash approval |
| **CodexQuestionCard** | When Codex consult asks a question |

Above the input, conditionally:

| Strip | Trigger |
|---|---|
| **Undo last turn** pill | Last exchange exists and is safely revertible |
| **Diagnose this loop** pill | User typed "still broken / doesn't work / again" |
| **ActivityStrip** | Recent agent activity (always-on when active) |
| **OnboardingStrip** | First-run users |
| **SessionStatusBar** | When session token usage is high or context is degraded |

### 5.5 Composer (input row)

Anchored at the bottom of the main chat area, `border-t border-terminal-border`.

```
┌────────────────────────────────────────────────────────────────────┐
│  [📎]  [🖼]   ┌────────────────────────────────────┐  [✦Spawn]    │
│              │  textarea — autosizes 1→200px       │   [✨ Wand]  │
│              │  @-mention autocomplete dropdown    │   [▶ Send]   │
│              └────────────────────────────────────┘   [⏹ Stop]    │
└────────────────────────────────────────────────────────────────────┘
```

| Button | Icon | Behavior |
|---|---|---|
| Attach file | `Paperclip` | Hidden inline on desktop (moved to Tools menu); functional on mobile via Tools menu |
| Project assets | `ImageIcon` | Toggles workspace asset browser |
| Delegate | `Users` | Surfaced via Tools menu |
| **Spawn task** | `Zap` purple | Hidden inline; surfaced in Tools menu. Disabled when input empty |
| **✨ Wand** | `Wand2` purple | **NEW** — Sonnet rewrites your draft with skills + agents (added 2026-05-17). Disabled when input empty. Spinning Loader2 while enhancing |
| **▶ Send** | `Send` green | Always enabled — primary action |
| **⏹ Stop** | `X` red | Shown only while `isLoading` (mid-stream). Replaces Send |
| Steer button | `Send` yellow | Shown while `isLoading` instead of Send — sends a steering interjection to the in-flight agent |

### 5.6 Tools menu (the big one — `<HeaderToolsMenu>`)

Dropdown anchored to the **🛠 Tools** button. Width `w-80`. Six titled sections:

#### Section: **Active**
| Item | Type | Options/Behavior |
|---|---|---|
| **Model** | select | Default (Sonnet 4.6) · Opus 4.7 · Opus 4.7 · 1M context · Sonnet 4.6 · Haiku 4.5 |
| **Permission** | 3-way pill | Normal (green) · Plan (purple) · Auto (amber) |

#### Section: **Agents**
| Item | Behavior |
|---|---|
| **Pair mode** | `PairModeChip` — solo / pair-build / pair-codex / orchestrator / autopilot |
| **Sub-agents** | Badge shows `N running` / `N total`. Opens AgentsPanel modal |
| **Delegate to Claude Code** | Opens delegate modal (disabled if claude not installed) |
| **Spawn background task** | Runs the current draft as a TaskPanel background task |
| **Constellation** | Deploy a team of parallel agents (hidden when `hideConstellationUi`) |

#### Section: **Context**
| Item | Behavior |
|---|---|
| **Compress context** | Open compress modal — requires 6+ messages |
| **Key facts** | Surfaces the keyFacts badge dropdown |
| **Memory panel** | Opens turns / episodes / search overlay |
| **Link another chat** | Cross-references another chat in the same namespace |
| **Pull chat context** | Cross-MC pull from Linux, PC, SEO, Luke's |
| **🤖 Ask Codex** | Opens CodexChatModal |
| **Gateway session** | Attach a Claude Code CLI session |

#### Section: **Composer**
| Item | Behavior |
|---|---|
| **Attach file** | Opens file picker (image/PDF/text → attached to next message) |
| **Project assets** | Toggles workspace asset browser |
| **Pull latest** | `PullLatestButton` dropdown — fast-forward managed git repos |
| **Attach GitHub repo** | Prompts for `owner/name`, pins to this chat |

#### Section: **History**
| Item | Behavior |
|---|---|
| **Reports** | Bug-report dropdown |
| **Browser notifications** | Toggle on/off; if off, requests permission |
| **Reset session** | Starts fresh CLI session, keeps local messages |
| **Clear chat** | Removes all messages (danger red, confirm) |

### 5.7 Shared notepad drawer (NEW)

Slides over the chat from the right (desktop) or as a bottom sheet (mobile). Triggered by the `NOTEPAD` header pill or mobile Notebook icon. Backed by `/api/notepad?id=default` + SSE at `/api/notepad/listen`. Real-time across Linux, PC, mobile. Header has title + close X; body is a single full-height `<textarea>`.

Status row above textarea: `Wifi/WifiOff` · `Loader2` (saving) · `Save` (saved) · `AlertTriangle` (merged remote edit) · version + last-editor + relative time.

### 5.8 Task panel (desktop only — right side of chat)

Toggle inside chat header (shows `[💬 Chat | ⚡ Tasks]`). Displays:
- **Task History Header** with count
- **Task History List** (collapsed cards, click to expand)
- **Active Task Panel** when a task is in progress — streams sub-agent activity
- **Minimized Task Panel** — floating bottom-right when minimized

On mobile, tasks open as a full-screen overlay.

### 5.9 Inline Claude Code terminal

When `showClaudeTerminal` is set, a `<ClaudeCodeTerminal>` slides in below the messages list with:
- Terminal Header (status badge: running/stopped/error · stop button)
- The xterm.js terminal output

### 5.10 Other modals reachable from chat

| Modal | Trigger | Contents |
|---|---|---|
| `CodexChatModal` | Tools → Ask Codex | Persistent-goal Codex session |
| `CrossChatPullModal` | Tools → Pull chat context | Choose source MC + chat + N msgs |
| `ApprovalModal` | Agent asks for destructive Bash approval | Approve · Deny |
| `PhaseStuckCard` | In-message | Retry-with-bumped-cap · Skip-to-next-phase |
| Compress confirm | Tools → Compress context | Summary preview + confirm |
| Agents Panel | Tools → Sub-agents | List of running + completed sub-agents |
| Delegate Modal | Tools → Delegate | Claude Code Teams orchestration |
| GitHub picker | Tools → Attach GitHub repo | Prompt for `owner/name` |
| Reports dropdown | Tools → Reports | List of attached reports |
| Session dropdown | Tools → Gateway session | Pick existing CLI session |
| Mention dropdown | `@` in composer when linkedTeamId set | Suggests team members |

---

## 6 · Tab: SEO (`seo-chat`)

Same `<ChatPanel>` as CHAT, but:
- Workspace locked to `~/<your-seo-workspace>`
- Memory namespace `seo` (separate chat list)
- Constellation UI hidden
- `panelTitle="SEO"`

---

## 7 · Tab: LUKE'S CHAT (`lukes-chat`)

Same `<ChatPanel>` as CHAT, but:
- Namespace `missions` (separate chat list)
- Above the chat: `<MissionsDashboard>` — list of running multi-agent missions + Phase 0-11 status, checkpoint timeline, role-config selector, hibernate/resume buttons
- Constellation UI hidden

---

## 8 · Tab: ✦ CONSTELLATION (`teams`)

`<TeamsPanel>`. List of constellation deployments. Each card:
- Team id + status (running / done / halted)
- Active sub-agents
- Recent broadcasts
- Halt button, merge-all-approved button

---

## 9 · Tab: 📋 DOCS (`docs`)

`<DocsPanel>`. Cross-machine doc store backed by `data/docs/<id>.md`.

- Left: sidebar list of docs (search · new doc · per-doc rename/delete)
- Right: markdown editor + preview tabs
- Top bar: peer host selector (Linux / PC) · sync indicator

---

## 10 · Tab: 📝 ACTIVITY (`edit-activity`)

`<ActivityPanel>`. Cross-machine edit log.

- Filter row: host selector · time range · file pattern · diff type
- List of edits (file · linesAdded/Removed · summary · preview hover)
- Click an entry → opens the file in CodeEditor

---

## 11 · Tab: 🛰 REMOTE (`remote`)

`<RemotePanel>`. Iframes a peer MC's chat into MC.

- Host selector (`linux` / `pc`)
- Iframe of `http://<peer>:3001/?tab=chat&embed=1` (the `embed=1` strips peer's chrome)
- Loading spinner

---

## 12 · 🛠 Build dropdown — tabs

### 12.1 `dev` — Dev panel
- `<EnvironmentBar>` along the top
- Three-column grid:
  - Left: DeployDashboard · GitPanel
  - Middle: TestRunner · ApiTester
  - Right: ErrorTracker · DatabaseExplorer · CodeSnippets
- Full-width `<XTerminalPanel>` below (400px)

### 12.2 `workshop` — Workshop
`<Workshop>` panel. Scratch space for code experiments. Multiple sub-tabs.

### 12.3 `files` — Files
Two-column:
- Left (col-span-4): `<FileBrowser>` tree
- Right (col-span-8): when a file is open → `<CodeEditor>` (Monaco). Otherwise → MemoryViewer + Scratchpad

### 12.4 `browser` — 🌐 Browser
`<BrowserPanel>`. Embedded Chrome via `browser` CLI bridge — URL bar + screenshot view + element inspector + console.

### 12.5 `github` — 🐙 GitHub
`<GitHubPanel>`. Repo browser. Click "Attach" → dispatches event to ChatPanel + jumps user to CHAT tab.

---

## 13 · 📊 Monitor dropdown — tabs

### 13.1 `activity` — Activity
`<ActivityFeed>` (max-w-4xl). Real-time stream of agent/system events.

### 13.2 `logs` — Logs
- Left (col-span-9): `<LogsViewer>` — pm2 logs across all MC apps
- Right (col-span-3, desktop): `<MemoryViewer>` sidebar

### 13.3 `reports` — 🐛 Reports
`<ReportsPanel>` (max-w-6xl). Bug reports submitted from any chat.

### 13.4 `qa` — QA
`<QAPanel>` (max-w-6xl). Quality assurance dashboard — test results + canary watches.

### 13.5 `history` — History
`<HistoryPanel>` (max-w-6xl). Long-term chat history across all sessions.

### 13.6 `digest` — Digest
`<PdfDigester>` (max-w-3xl). Upload a PDF → AI summary.

---

## 14 · 🧠 Knowledge dropdown — tabs

### 14.1 `memory-vault` — 🧠 Memory & Vault
`<MemoryVaultPanel>` (max-w-4xl).

Two columns / vertical sections:
- **Memory section** — observations (decision · pattern · blocker · fact · skill · finding · summary), FTS search, episode timeline
- **Vault section** — Obsidian config (vault path, indexed folders), peer host selector

### 14.2 `skills` — Skills
`<SkillsPanel>` (max-w-4xl). 418-skill catalog across the 5 priority repos. Filter by source · search · view body inline.

### 14.3 `credentials` — 🔐 Credentials
`<CredentialsPanel>` (max-w-5xl). Encrypted credential store (`data/.secrets.json`). Per-credential: name · type · masked value · copy · edit · delete.

### 14.4 `agents` — Agents
`<AgentHub>`. 165 subagent personas (ruflo + ECC). Filter by category, browse, copy persona body.

### 14.5 `innovation` — 💡 Radar
`<InnovationRadar>`. Curated list of new tools / libraries / research with status badges.

---

## 15 · Standalone subpages

### 15.1 `/memory-vault`
No app shell. Just:
- Header: `Memory & Vault` title + description
- `<MemoryVaultPanel>` (chatId from `?chat=` or localStorage)

### 15.2 `/reset`
Hard-reset escape hatch when the chat sessions become corrupted.
- `Clear Chat Sessions` (yellow) — `localStorage.removeItem('chatSessions')`
- `Clear All Data` (red) — also removes gateway config

Both redirect to `/` after.

---

## 16 · Service Worker + PWA

`/sw.js` runs in the browser:

- **Cache name**: `mc-v46-notepad-tab` (current). Bumped on every UI release that needs to invalidate stale bundles.
- **Strategy**:
  - API routes (`/api/*`): pass-through, never cached.
  - Navigation requests (HTML): NETWORK-ONLY with 4s timeout, fallback to a minimal "MC offline" inline HTML.
  - Static assets (`/_next/*`, icons): NETWORK-FIRST with cache fallback.
- **Push notifications**: SW listens for `push` events, shows native notifications with lobster icon.
- **Click handler**: focuses existing window or opens a new one to the notification's URL.

### Mobile PWA access
Linux runs an HTTPS proxy at `https://<your-tailscale-host>:3443` (Tailscale cert), forwarding to Next.js on `:3001`. Add to home screen → app icon = `lobster.svg`.

---

## 17 · Cross-machine surface

| What | Where | Behavior |
|---|---|---|
| `mc-remote` MCP | Both MCs | Peer-to-peer agent-to-agent ask (`mc_remote_ask(host:"pc", message)`) |
| `mc-vault` MCP | Both MCs | Read/write peer's Obsidian vault (`vault_read({host:"pc"})`) |
| `mc-docs` MCP | Both MCs | Shared doc store backed by `data/docs/` |
| `mc-edits` MCP | Both MCs | Cross-machine edit log (`/api/edits/recent`) |
| `mc-skills` MCP | Both MCs | 418-skill catalog + on-demand load |
| `mc-agents` MCP | Both MCs | 165 persona catalog + on-demand load |
| `mc-design` MCP | Both MCs | 150 brand design systems |
| `mc-memory` MCP | Both MCs | Per-chat durable observations |
| `mc-commander` MCP | Both MCs (chat only) | Constellation team control |
| **Shared notepad** | Linux only by default | All clients should connect to Linux to share one pad |
| **Trust file** | `~/.config/mc-remote-hosts.json` | Bearer token + peer list (sync'd) |
| **Wiki** | `~/<your-wiki-dir>` (git: `<your-wiki-repo>`) | 30s debounced commit + 5min auto-pull |

---

## 18 · API surface (high-level)

| Endpoint | Purpose |
|---|---|
| `POST /api/chat` | Send a message, returns SSE stream |
| `GET /api/chat/listen?chatId=&clientId=` | Cross-tab/device SSE subscribe |
| `GET /api/chat?requestId=` | Poll buffered partial reply (crash recovery) |
| `POST /api/chat/enhance-prompt` | **Wand button** — Sonnet rewrites draft |
| `POST /api/chat/pair` | Pair-mode turn |
| `GET /api/chat/codex` | Codex consult |
| `POST /api/chat/approve` | Approve/deny agent tool call |
| `GET /api/chats` (lite / full / by id) | Chat session storage |
| `POST /api/chats` (save-all / save-one / create-session / delete) | Chat session mutations |
| `GET /api/notepad?id=` | Load shared notepad |
| `POST /api/notepad?id=` | Save shared notepad + broadcast |
| `GET /api/notepad/listen?id=&clientId=` | Notepad SSE subscribe |
| `GET /api/git/status` | Multi-repo status (mission-control + frap + <your-web-app> + …) |
| `GET /api/edits/recent` | Cross-machine edit log |
| `GET /api/docs` `POST /api/docs` | Doc store |
| `GET /api/teams` `POST /api/teams` | Constellation teams |
| `GET /api/mem/*` | Memory observations + FTS search |
| `GET /api/vault/*` | Obsidian vault access |
| `GET /api/debug/match-probe?text=` | Skill/agent/design-system auto-load probe (read-only debug) |
| `GET /api/status?gateway=` | Gateway health |
| `GET /api/subagents` | Active sub-agent list |

---

## 19 · State management snapshot

Per-session state (each tracked by `activeSessionId`):
- `messages`
- `input` (composer draft)
- `model` (default · Opus 4.7 · Opus 4.7-1M · Sonnet 4.6 · Haiku 4.5 · codex-*)
- `permissionMode` (default · plan · bypassPermissions)
- `pairMode` (solo · pair-build · pair-codex · orchestrator · autopilot)
- `workspace`
- `githubRepo`
- `linkedTeamId`
- `attachedDocs[]`
- `keyFacts[]`
- `contextSnapshot`
- `enhancing` (wand button in-flight)
- `claudeSessionId` (Agent SDK resume token)

Global state:
- `activeTab`
- `showSettings` / `showNotepad` / `showAssets` / `showMobileSidebar` / `showMobileTools` / `showMobileTaskPanel` / `showAgentsPanel` / `showMemoryPanel` / `showCodexModal` / `showCrossChatPull` / `showConstellationDeploy` / `showLinkDropdown` / `showSessionDropdown` / `showReportDropdown`
- `taskHistory[]`
- `activeTask`
- `isTaskMinimized`
- `connected` (gateway WS status)
- `theme`

---

## 20 · Notification toasts

`<NotificationToasts>` is mounted globally. Listens for constellation events (task done, phase stuck, sub-agent finished, deploy success/failure, …) and shows transient toast notifications top-right. Each toast has icon + title + body + auto-dismiss (5s).

---

*This document is generated from the live codebase at HEAD `722e947`. When you change a tab, button, or modal, update the relevant section.*
