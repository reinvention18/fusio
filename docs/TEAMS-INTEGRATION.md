# Claude Code Teams Integration

Mission Control now has full integration with Claude Code's Agent Teams feature.

## What Was Built

### 1. TeamsPanel (`components/TeamsPanel.tsx`)
- **Overview Tab**: Shows active teams, members, tasks, and agent chatter
- **Tasks Tab**: Kanban board view (Pending → In Progress → Completed)
- **Messages Tab**: Full message log between agents
- **Prompts Tab**: Pre-built team prompts with **Launch** buttons
- **Runner Tab**: Embedded Claude Code terminal for direct session management

### 2. Claude Code Runner (`components/ClaudeCodeTerminal.tsx`)
- Spawn Claude Code sessions directly from Mission Control
- Toggle between Solo mode and Team mode
- Real-time output streaming
- Session management (start/stop/clear)
- Split view for multiple sessions

### 3. Claude Code API (`app/api/claude-code/route.ts`)
- `GET ?action=check` - Check if Claude Code is installed, get version
- `GET ?action=list` - List running sessions
- `GET ?action=output&sessionId=xxx` - Stream session output
- `POST action=start` - Start a new Claude Code session
- `POST action=stop` - Stop a running session
- `POST action=clear` - Remove a stopped session

### 4. Session Runner Library (`lib/claude-code-runner.ts`)
- Session state management
- Event system for real-time updates
- Output parsing for team-related events

## How to Use

### From the Teams Tab

1. Open Mission Control at http://localhost:3001
2. Click the **🤖 TEAMS** tab
3. Go to **PROMPTS** sub-tab
4. Either:
   - Use the **Quick Launch** box to enter a custom prompt
   - Or click **Launch** on any pre-built template
5. Switch to the **RUNNER** sub-tab to see output
6. Switch to **OVERVIEW** to monitor team activity

### Pre-Built Team Templates

| Template | Agents | Purpose |
|----------|--------|---------|
| Debug Investigation | 5 | Explore different bug hypotheses, debate findings |
| Feature Implementation | 5 | Full-stack development with specialized roles |
| Code Review | 3 | Security, performance, architecture analysis |
| Refactoring Sprint | 4 | Coordinated large-scale refactoring |
| Bug Hunt | 4 | Systematic bug tracking and fixing |

### Requirements

1. **Claude Code v2.1.34+** installed and in PATH
2. **Workspace configured** in Mission Control settings
3. Environment variable auto-set: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     MISSION CONTROL                          │
├──────────────────────┬───────────────────────────────────────┤
│   CHAT PANEL         │   TEAMS PANEL                         │
│   (talks to Rev)     │   ├── Overview (file watcher)         │
│         │            │   ├── Tasks (kanban)                   │
│         ▼            │   ├── Messages (agent chatter)         │
│   OpenClaw Gateway   │   ├── Prompts (launch templates)       │
│         │            │   └── Runner (terminal)                │
│         ▼            │             │                          │
│   Rev (AI Agent)     │             ▼                          │
│                      │   Claude Code Sessions                 │
│                      │   ├── spawn with --teammate-mode       │
│                      │   ├── env: TEAMS=1                     │
│                      │   └── captures stdout/stderr           │
└──────────────────────┴───────────────────────────────────────┘
                                    │
           ┌────────────────────────┘
           │  (file watcher monitors)
           ▼
   .claude/teams/*.json    - Team configurations
   .claude/tasks/*.json    - Task list & status
   .claude/inbox/*.json    - Agent messages
```

## Team Communication Flow

When you launch a team:

1. **team_create** - Main agent creates team config
2. **task_create** - Creates task list with dependencies
3. **task (spawn)** - Spins up teammate Claude Code sessions
4. **send_message** - Agents communicate findings
5. **task_update** - Agents update task status
6. **shutdown_request** - Lead closes teammate sessions
7. **team_delete** - Cleans up team

## Chat Integration

The Chat panel continues to work with Rev (OpenClaw AI). For Claude Code Teams:
- Use the **TEAMS** tab directly
- Or ask Rev to help you craft a team prompt

## Files Modified/Created

- `components/TeamsPanel.tsx` - Enhanced with Runner tab & Launch buttons
- `components/ClaudeCodeTerminal.tsx` - New session terminal component
- `app/api/claude-code/route.ts` - New API for Claude Code control
- `lib/claude-code-runner.ts` - Session management library

## Troubleshooting

**Claude Code not detected:**
- Ensure `claude` is in your PATH
- Run `claude --version` in terminal to verify

**Teams not starting:**
- Check workspace is set in Settings
- Look at Runner tab output for errors

**No team activity showing:**
- Teams data appears in `.claude/` folder of your workspace
- Make sure TeamsPanel is set to the correct workspace
