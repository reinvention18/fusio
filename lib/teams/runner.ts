/**
 * Constellation TeamRunner — spawns and manages parallel agent sessions.
 *
 * Each agent is one long-lived `query()` call whose input is an AsyncIterable
 * we control. The agent pulls work via `mc_get_next_task` (Option C pattern);
 * we inject messages via the escape hatch (Option B) for human overrides,
 * halts, and budget alerts.
 *
 * The `globalThis.__mcTeams` guard survives Next.js hot-reloads so running
 * agents don't die on code changes during development.
 */

import 'server-only';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TeamAgentRow, TeamRow, ChatContext } from './schema';
import {
  getTeam,
  updateTeamStatus,
  updateTeamAgentStatus,
  updateTeamAgentSessionId,
  appendEvent,
  listTeamAgents,
  activateNextPhase,
} from './schema';
import { createTeamMcpServer, type McpServerContext } from './mcp-server';
import { loadSkillsContext, getBrowserInstructions } from '../claude-sdk-session';
import { costFor, addCostAndCheckBudget } from './cost';
import { loadProjectContext } from './project-context';
import { resolveAllowedTools, getRole, modelFromTier } from './roles';
import { createHash } from 'node:crypto';
import { createMemMcpServer, MEM_TOOL_NAMES } from '../mem/mcp-tools';
import { createVaultMcpServer, VAULT_TOOL_NAMES } from '../vault/mcp-tools';
import {
  ensureAgentSession,
  ensureTeamMetaSession,
  captureToolUse as memCaptureToolUse,
  captureToolResult as memCaptureToolResult,
  captureAssistantText as memCaptureAssistantText,
  injectContext as memInjectContext,
  compressPendingForSession,
} from '../mem/api';

// ─── AsyncQueue — the input stream for the long-lived query() ────────────

class AsyncQueue<T> {
  private queue: T[] = [];
  private resolve: ((value: IteratorResult<T>) => void) | null = null;
  private done = false;

  enqueue(item: T): void {
    if (this.done) return;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  finish(): void {
    this.done = true;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise(resolve => { this.resolve = resolve; });
      },
      [Symbol.asyncIterator]() { return this; },
    };
  }
}

// ─── RunnerHandle — the control surface returned to callers ──────────────

export interface RunnerHandle {
  agentId: string;
  teamId: string;
  readonly sessionId: string | null;
  send(text: string, opts?: { priority?: 'now' | 'next' | 'later' }): void;
  close(): Promise<void>;
}

// ─── Global runtime state (survives Next.js hot-reload) ──────────────────

declare global {
  // eslint-disable-next-line no-var
  var __mcTeams: {
    activeRunners: Map<string, RunnerHandle>;
  } | undefined;
}

function getRuntime() {
  if (!globalThis.__mcTeams) {
    globalThis.__mcTeams = { activeRunners: new Map() };
  }
  return globalThis.__mcTeams;
}

export function getActiveRunners(): Map<string, RunnerHandle> {
  return getRuntime().activeRunners;
}

export function getRunnerForAgent(agentId: string): RunnerHandle | undefined {
  return getRuntime().activeRunners.get(agentId);
}

// ─── Build system prompt for a role ──────────────────────────────────────

async function buildRoleSystemPrompt(agent: TeamAgentRow, team: TeamRow): Promise<string> {
  const role = await getRole(agent.role as any);
  const roleBody = role?.body || `You are a ${agent.role} agent. Do your assigned work.`;
  const skills = loadSkillsContext();
  const browserRoles = new Set(['builder', 'scout', 'inspector']);
  const browser = browserRoles.has(agent.role) ? getBrowserInstructions() : '';

  // ── Inherit parent chat's context ──────────────────────────────────
  // When a constellation is deployed from a chat, the chat's full context
  // (workspace, key facts, credentials, environment, compressed history)
  // is stored on the team as `chat_context`. Every agent inherits this so
  // they have the same project knowledge the user built up in chat.
  let chatContextBlock = '';
  if (team.chat_context) {
    try {
      const ctx: ChatContext = JSON.parse(team.chat_context);

      const parts: string[] = ['## Inherited Project Context (from parent chat)\n'];

      if (ctx.environment) {
        parts.push(`**Environment:** ${ctx.environment.name.toUpperCase()}`);
        parts.push(`- SaaS URL: ${ctx.environment.saasUrl}`);
        parts.push(`- App URL: ${ctx.environment.appUrl}`);
        parts.push(`- Git branch: ${ctx.environment.branch}`);
        parts.push(`- Supabase: ${ctx.environment.supabaseRef}`);
        parts.push('');
      }

      if (ctx.keyFacts && ctx.keyFacts.length > 0) {
        parts.push('**Key Facts (credentials, URLs, config):**');
        for (const f of ctx.keyFacts) {
          parts.push(`- [${f.category}] ${f.label}: ${f.value}`);
        }
        parts.push('');
      }

      if (ctx.githubRepo) {
        parts.push(`**GitHub:** ${ctx.githubRepo.fullName} (${ctx.githubRepo.url}), default branch: ${ctx.githubRepo.defaultBranch}`);
        parts.push('');
      }

      if (ctx.contextSnapshot) {
        parts.push('**Compressed conversation context:**');
        // Truncate to 8KB to avoid bloating every agent's prompt
        parts.push(ctx.contextSnapshot.slice(0, 8192));
        if (ctx.contextSnapshot.length > 8192) parts.push('...[truncated]');
        parts.push('');
      }

      if (ctx.recentMessages && ctx.recentMessages.length > 0) {
        parts.push('**Recent chat messages (for continuity):**');
        for (const m of ctx.recentMessages.slice(-5)) {
          parts.push(`[${m.role.toUpperCase()}] ${m.content.slice(0, 500)}`);
        }
        parts.push('');
      }

      chatContextBlock = parts.join('\n');
    } catch { /* ignore parse errors */ }
  }

  // ── Load project context docs (app-context-v2, .context/, etc.) ────
  let projectContextBlock = '';
  try {
    const projCtx = loadProjectContext(team.project_id);
    if (projCtx) {
      projectContextBlock = projCtx.formatted;
      console.log(`[Runner] Loaded project context for ${agent.role_handle}: ${projCtx.files.length} files, ${Math.round(projCtx.totalChars / 1024)}KB from ${projCtx.source}`);
    }
  } catch (e) {
    console.warn('[Runner] Failed to load project context:', (e as Error).message);
  }

  // ── Retrieve learned skills for this project ───────────────────────
  let learnedSkillsBlock = '';
  try {
    const { retrieveRelevantSkills, formatSkillsForPrompt } = require('./learned-skills');
    // Generate tags from the team's goal + agent role
    const tags: string[] = [agent.role];
    if (team.goal) {
      const words = team.goal.toLowerCase().split(/\W+/).filter((w: string) => w.length > 3);
      tags.push(...words.slice(0, 8));
    }
    const relevant = retrieveRelevantSkills(team.project_id, tags, 3);
    learnedSkillsBlock = formatSkillsForPrompt(relevant);
  } catch { /* learned skills module not yet migrated — skip */ }

  // ── mem/api context — scope = this agent + team_meta + sibling agents ──
  let memContextBlock = '';
  try {
    const agentMemSession = ensureAgentSession({ teamId: team.id, agentId: agent.id, role: agent.role });
    const q = team.goal || `${agent.role} ${agent.role_handle}`;
    const r = await memInjectContext({ sessionId: agentMemSession.id, query: q, maxObservations: 6, maxTokens: 2500 });
    memContextBlock = r.block;
  } catch (e) {
    console.warn('[mem] agent context inject failed:', (e as Error).message);
  }

  return [
    roleBody,
    '',
    `## Team context`,
    `- Constellation: ${team.constellation || team.name}`,
    `- Your role: ${agent.role} (${agent.role_handle})`,
    `- Team ID: ${team.id}`,
    `- Project: ${team.project_id}`,
    `- Main branch: ${team.main_branch}`,
    `- Your worktree: ${agent.worktree_path}`,
    `- Your branch: ${agent.branch_name}`,
    team.goal ? `- Mission: ${team.goal}` : '',
    '',
    '## MANDATORY: Scratchpad collaboration',
    'You are part of a TEAM. Other agents read what you write to the scratchpad.',
    '1. BEFORE starting work: call `mc_read_scratchpad` to see what other agents found.',
    '2. AFTER completing work: call `mc_update_scratchpad` (mode: append) to write your findings.',
    '   Write under a section header: `## <YourRole>: <Topic>`',
    '3. THEN call `mc_submit_task_result` with a brief summary.',
    'If you skip the scratchpad, your work is invisible to the team.',
    '',
    '## Your task loop',
    'Call `mc_get_next_task` to pull work. Read scratchpad. Do the work. Write to scratchpad. Call `mc_submit_task_result` when done. Repeat.',
    'If `mc_get_next_task` returns `{status:"halt"}`, stop — do not call it again.',
    'If it returns `{status:"idle"}`, call `mc_wait_for_work(timeout_seconds=60)` to BLOCK efficiently until new work appears. Do NOT spam mc_get_next_task in a tight loop — it wastes context. After mc_wait_for_work returns `{ready:true}`, call mc_get_next_task to claim it.',
    '',
    chatContextBlock,
    projectContextBlock,
    learnedSkillsBlock,
    memContextBlock,
    browser,
    skills,
    '',
    '## Available CLIs (installed on this system)',
    'You have Bash access. These CLIs are available:',
    '- `vercel` (v50) — Vercel deployments, env vars, domains, logs',
    '- `npx supabase` (v2.89) — Supabase DB, migrations, edge functions, auth',
    '- `codex` (v0.120) — OpenAI Codex CLI for code review and exec tasks',
    '- `gh` (v2.86) — GitHub CLI for issues, PRs, repos, actions',
    '- `eas` (v18.5) — Expo Application Services: builds, submissions, updates',
    '- `claude` (v2.1) — Claude Code CLI for sub-agent tasks',
    '- `browser` — Headless Chrome automation (navigate, click, fill, getText)',
    '- `pnpm` (v10) — Package manager (preferred over npm)',
    '- `git` (v2.43) — Version control',
    '- `node` (v22) — Node.js runtime',
    '- `npx playwright` — Browser automation and E2E testing',
    'Use these tools when your task requires deployment, database operations, CI/CD, or external service interaction.',
  ].filter(Boolean).join('\n');
}

// ─── Core: runAgent ──────────────────────────────────────────────────────

export interface RunAgentOptions {
  onEvent?: (msg: SDKMessage) => void;
  onSessionId?: (id: string) => void;
  additionalMcpTools?: any[];
}

export async function runAgent(
  agent: TeamAgentRow,
  opts: RunAgentOptions = {},
): Promise<RunnerHandle> {
  const runtime = getRuntime();
  const team = getTeam(agent.team_id);
  if (!team) throw new Error(`Team ${agent.team_id} not found`);

  const inputQueue = new AsyncQueue<SDKUserMessage>();
  let sessionId: string | null = agent.session_id ?? null;
  let currentTaskId: string | null = agent.current_task_id ?? null;
  const signal = { stopped: false };

  const mcpCtx: McpServerContext = {
    agent,
    signal,
    isTeamPaused: () => {
      const t = getTeam(agent.team_id);
      return t?.status === 'paused';
    },
    getCurrentTaskId: () => currentTaskId,
    setCurrentTaskId: (id) => { currentTaskId = id; },
  };

  const mcpServer = createTeamMcpServer(mcpCtx);

  // Per-agent mem session + scoped MCP servers.
  const agentMemSession = ensureAgentSession({ teamId: team.id, agentId: agent.id, role: agent.role });
  const memServer = createMemMcpServer({ sessionId: agentMemSession.id, label: `${agent.role}:${agent.id.slice(0, 8)}` });
  const vaultServer = createVaultMcpServer();

  const systemPrompt = await buildRoleSystemPrompt(agent, team);

  inputQueue.enqueue({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: agent.session_id
        ? 'Server restarted. Resume your task loop — call mc_get_next_task now.'
        : 'Begin your mission. Call mc_get_next_task() now and keep looping until it returns {status:"halt"}.',
    },
  } as SDKUserMessage);

  const role = await getRole(agent.role as any);
  const allowedTools = resolveAllowedTools(
    role || { role: agent.role as any, file: '', frontmatter: { name: agent.role, description: '' }, body: '' },
    [
      'mcp__mc-team__mc_get_next_task',
      'mcp__mc-team__mc_wait_for_work',
      'mcp__mc-team__mc_submit_task_result',
      'mcp__mc-team__mc_update_scratchpad',
      'mcp__mc-team__mc_read_scratchpad',
      'mcp__mc-team__mc_notify_commander',
      'mcp__mc-team__mc_ask_commander',
      'mcp__mc-team__mc_propose_tasks',
      'mcp__mc-team__mc_propose_team',
      'mcp__mc-team__mc_record_plan_approval',
      'mcp__mc-team__mc_read_messages',
      'mcp__mc-team__mc_send_message',
      'mcp__mc-team__mc_request_rework',
      'mcp__mc-team__mc_approve_task',
      ...MEM_TOOL_NAMES,
      ...VAULT_TOOL_NAMES,
      ...(opts.additionalMcpTools?.map((t: any) => `mcp__mc-team__${t.name}`) || []),
    ],
  );

  const q: Query = query({
    prompt: inputQueue as AsyncIterable<SDKUserMessage>,
    options: {
      pathToClaudeCodeExecutable: '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      cwd: agent.worktree_path,
      model: agent.model,
      resume: sessionId ?? undefined,
      tools: { type: 'preset', preset: 'claude_code' },
      allowedTools: [...allowedTools, 'Agent'],
      // Role-based tool restrictions
      disallowedTools: [
        // Architect must delegate via mc_propose_tasks, not spawn invisible sub-agents
        ...(agent.role === 'architect' ? ['Agent'] : []),
        // Read-only roles must not edit code — block Edit, Write, AND Bash (Bash can sed/echo files)
        ...(['scout', 'uxreviewer'].includes(agent.role)
          ? ['Edit', 'Write', 'NotebookEdit', 'Bash'] : []),
        // These roles need Bash for running commands but must not edit files
        ...(['sentinel', 'inspector', 'perfanalyst'].includes(agent.role)
          ? ['Edit', 'Write', 'NotebookEdit'] : []),
      ],
      mcpServers: {
        'mc-team': mcpServer,
        'mc-memory': memServer,
        'mc-vault': vaultServer,
      } as any,
      permissionMode: (agent.permission_mode as any) ?? 'bypassPermissions',
      includePartialMessages: true,
      agentProgressSummaries: true,
      settingSources: ['project', 'user'] as any,
      persistSession: true,
      env: {
        ...process.env,
        MC_TEAM_ID: agent.team_id,
        MC_AGENT_ID: agent.id,
        MC_AGENT_ROLE: agent.role,
      },
    },
  });

  updateTeamAgentStatus(agent.id, 'working');

  let lastOutputHash = '';
  let lastActivityBump = 0;
  const bumpLastActivity = (): void => {
    // Throttle to once per 30s — this is a liveness heartbeat, not a metric.
    const now = Date.now();
    if (now - lastActivityBump < 30_000) return;
    lastActivityBump = now;
    try {
      const { getDb } = require('../memory-db');
      getDb().prepare('UPDATE team_agents SET last_activity_at = ? WHERE id = ?').run(now, agent.id);
    } catch { /* non-critical */ }
  };

  const drain = (async () => {
    try {
      for await (const msg of q) {
        if (signal.stopped) break;

        if (msg.type === 'system' && (msg as any).subtype === 'init') {
          const newSessionId = (msg as any).session_id as string;
          if (newSessionId && newSessionId !== sessionId) {
            sessionId = newSessionId;
            updateTeamAgentSessionId(agent.id, newSessionId);
            opts.onSessionId?.(newSessionId);
          }
        }

        if (msg.type === 'result' && (msg as any).usage) {
          const usage = (msg as any).usage;
          const totalCost = (msg as any).total_cost_usd;
          const cost = totalCost ?? costFor(agent.model, usage);
          // Track token usage for telemetry (no budget enforcement — subscription mode)
          addCostAndCheckBudget(agent.id, cost, {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheWrite: usage.cache_creation_input_tokens ?? 0,
          });
        }

        // Status detection: hash last output chunk for idle detection
        if (msg.type === 'assistant') {
          bumpLastActivity();
          const text = JSON.stringify(msg).slice(-4096);
          const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
          if (hash !== lastOutputHash) {
            lastOutputHash = hash;
          }
          // Capture assistant text + tool uses to mem queue.
          try {
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 60) {
                  memCaptureAssistantText(agentMemSession.id, block.text);
                } else if (block?.type === 'tool_use') {
                  memCaptureToolUse({ sessionId: agentMemSession.id, toolName: block.name || 'tool', input: block.input || {} });
                }
              }
            }
          } catch {}
        }

        if (msg.type === 'user') {
          bumpLastActivity();
          try {
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block?.type === 'tool_result') {
                  const txt = typeof block.content === 'string'
                    ? block.content
                    : (Array.isArray(block.content)
                      ? block.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
                      : '');
                  memCaptureToolResult({
                    sessionId: agentMemSession.id,
                    toolName: 'tool_result',
                    output: txt,
                    isError: !!block.is_error,
                  });
                }
              }
            }
          } catch {}
        }

        opts.onEvent?.(msg);
      }
    } catch (err: any) {
      appendEvent({
        team_id: agent.team_id,
        agent_id: agent.id,
        task_id: currentTaskId,
        kind: 'system',
        severity: 'error',
        payload: { error: err.message || String(err) },
        chat_report: true,
      });
      updateTeamAgentStatus(agent.id, signal.stopped ? 'done' : 'crashed', err.message);
    } finally {
      runtime.activeRunners.delete(agent.id);
      if (!signal.stopped) {
        updateTeamAgentStatus(agent.id, 'crashed', 'generator exited unexpectedly');
      }
    }
  })();

  const handle: RunnerHandle = {
    agentId: agent.id,
    teamId: agent.team_id,
    get sessionId() { return sessionId; },
    send(text: string, sendOpts?: { priority?: 'now' | 'next' | 'later' }) {
      inputQueue.enqueue({
        type: 'user',
        parent_tool_use_id: null,
        priority: sendOpts?.priority ?? 'next',
        message: { role: 'user', content: text },
      } as SDKUserMessage);
    },
    async close() {
      signal.stopped = true;
      updateTeamAgentStatus(agent.id, 'done');
      inputQueue.finish();
      try { await q.interrupt(); } catch { /* ignore */ }
      try { q.return(undefined as any); } catch { /* ignore */ }
      await drain.catch(() => {});
      // Compress this agent's pending observations so team_meta aggregation
      // sees them when the orchestrator generates a team summary.
      compressPendingForSession(agentMemSession.id).catch((e: any) => {
        console.warn('[mem] agent compress failed:', e?.message);
      });
    },
  };

  runtime.activeRunners.set(agent.id, handle);
  return handle;
}

// ─── Team-level operations ───────────────────────────────────────────────

export async function startTeam(teamId: string): Promise<RunnerHandle[]> {
  const team = getTeam(teamId);
  if (!team) throw new Error(`Team ${teamId} not found`);
  if (team.status === 'running') throw new Error(`Team ${teamId} already running`);

  // Seed the team_meta memory session (idempotent). When the team was deployed
  // from a chat, link it under that chat's mem session so the Commander sees
  // cross-team observations in its regular mem_search scope.
  try {
    const { ensureChatSession } = await import('../mem/api');
    const parent = team.parent_chat_key ? ensureChatSession(team.parent_chat_key) : null;
    ensureTeamMetaSession(teamId, team.name, parent?.id);
  } catch (e) {
    console.warn('[mem] ensureTeamMetaSession failed:', (e as Error).message);
  }

  const settings = JSON.parse(team.settings_json || '{}');
  const planFirst = settings.plan_first === true;

  const agents = listTeamAgents(teamId);
  const handles: RunnerHandle[] = [];

  if (planFirst) {
    // Phase 1: only spawn architect agent(s). Builders wait until architect finishes.
    updateTeamStatus(teamId, 'planning');
    appendEvent({ team_id: teamId, kind: 'system', payload: { action: 'start_planning' }, chat_report: true });

    const architects = agents.filter(a => a.role === 'architect');
    if (architects.length === 0) {
      // No architect in the roster — fall through to full start
      console.warn(`[Runner] plan_first enabled but no architect in team ${teamId}, starting all agents`);
      updateTeamStatus(teamId, 'running');
      appendEvent({ team_id: teamId, kind: 'system', payload: { action: 'start', note: 'plan_first fallback — no architect' }, chat_report: true });
      for (const agent of agents) {
        if (['done', 'error', 'cancelled'].includes(agent.status)) continue;
        try {
          handles.push(await runAgent(agent));
        } catch (err: any) {
          console.error(`[Runner] Failed to start agent ${agent.role_handle}:`, err.message);
          updateTeamAgentStatus(agent.id, 'error', err.message);
        }
      }
    } else {
      for (const arch of architects) {
        if (['done', 'error', 'cancelled'].includes(arch.status)) continue;
        try {
          handles.push(await runAgent(arch));
        } catch (err: any) {
          console.error(`[Runner] Failed to start architect ${arch.role_handle}:`, err.message);
          updateTeamAgentStatus(arch.id, 'error', err.message);
        }
      }
    }
  } else {
    // Standard mode: all agents spawn at once
    updateTeamStatus(teamId, 'running');
    appendEvent({ team_id: teamId, kind: 'system', payload: { action: 'start' }, chat_report: true });

    for (const agent of agents) {
      if (['done', 'error', 'cancelled'].includes(agent.status)) continue;
      try {
        handles.push(await runAgent(agent));
      } catch (err: any) {
        console.error(`[Runner] Failed to start agent ${agent.role_handle}:`, err.message);
        updateTeamAgentStatus(agent.id, 'error', err.message);
      }
    }
  }

  // Activate the first phase with tasks (handles teams seeded with initial
  // tasks at create time, plus architect-less presets like smoke_test).
  // Architect-led teams will additionally re-trigger this from mc_propose_tasks.
  try { activateNextPhase(teamId); } catch (e) {
    console.warn(`[Runner] activateNextPhase failed for ${teamId}:`, (e as Error).message);
  }

  return handles;
}

/** Spawn a single agent mid-flight (for dynamic team composition via mc_propose_team or mc_spawn_agent). */
export async function spawnSingleAgent(agentId: string): Promise<RunnerHandle | null> {
  const { getTeamAgent } = require('./schema');
  const agent = getTeamAgent(agentId);
  if (!agent) {
    console.error(`[Runner] spawnSingleAgent: agent ${agentId} not found`);
    return null;
  }
  const runtime = getRuntime();
  if (runtime.activeRunners.has(agent.id)) {
    console.warn(`[Runner] spawnSingleAgent: agent ${agent.role_handle} already running`);
    return null;
  }
  try {
    const handle = await runAgent(agent);
    console.log(`[Runner] spawnSingleAgent: spawned ${agent.role_handle}`);
    return handle;
  } catch (err: any) {
    console.error(`[Runner] spawnSingleAgent failed for ${agent.role_handle}:`, err.message);
    updateTeamAgentStatus(agent.id, 'error', err.message);
    return null;
  }
}

/** Promote a team from `planning` → `running`, spawning all non-architect agents. */
export async function promoteToRunning(teamId: string): Promise<RunnerHandle[]> {
  const team = getTeam(teamId);
  if (!team) throw new Error(`Team ${teamId} not found`);
  if (team.status !== 'planning') {
    console.warn(`[Runner] promoteToRunning called but team ${teamId} is ${team.status}, not planning`);
    return [];
  }

  updateTeamStatus(teamId, 'running');
  appendEvent({ team_id: teamId, kind: 'system', payload: { action: 'promote_to_running' }, chat_report: true });

  const runtime = getRuntime();
  const agents = listTeamAgents(teamId);
  const handles: RunnerHandle[] = [];

  for (const agent of agents) {
    // Skip architect (already running/done) and terminated agents
    if (agent.role === 'architect') continue;
    if (['done', 'error', 'cancelled'].includes(agent.status)) continue;
    if (runtime.activeRunners.has(agent.id)) continue;

    try {
      const handle = await runAgent(agent);
      handles.push(handle);
      console.log(`[Runner] Promoted: spawned ${agent.role_handle}`);
    } catch (err: any) {
      console.error(`[Runner] Failed to spawn ${agent.role_handle} on promote:`, err.message);
      updateTeamAgentStatus(agent.id, 'error', err.message);
    }
  }

  return handles;
}

export async function haltTeam(teamId: string, reason?: string): Promise<void> {
  const runtime = getRuntime();

  appendEvent({
    team_id: teamId,
    kind: 'system',
    severity: 'warn',
    payload: { action: 'halt', reason: reason || 'user' },
    chat_report: true,
  });

  const agents = listTeamAgents(teamId);
  const closePromises: Promise<void>[] = [];

  for (const agent of agents) {
    const handle = runtime.activeRunners.get(agent.id);
    if (handle) {
      handle.send(`Team halt requested${reason ? ': ' + reason : ''}. Finish current tool call and call mc_submit_task_result with status=blocked and blocker="halted". Do not claim more work.`, { priority: 'now' });
    }
  }

  // Grace period
  await new Promise(r => setTimeout(r, 15_000));

  for (const agent of agents) {
    const handle = runtime.activeRunners.get(agent.id);
    if (handle) closePromises.push(handle.close());
  }

  await Promise.allSettled(closePromises);
  updateTeamStatus(teamId, 'paused', reason || 'user');
}

export async function resumeTeam(teamId: string): Promise<RunnerHandle[]> {
  return startTeam(teamId);
}
