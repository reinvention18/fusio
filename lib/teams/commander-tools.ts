/**
 * Commander MCP tools — registered into the chat's `spawnClaudeStream` when
 * the chat has an active Constellation. This lets the user's regular Claude
 * session call mc_create_team, mc_team_status, mc_halt_team, etc. directly
 * from natural chat messages, making the chat "speak Constellation" natively.
 */

import 'server-only';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  createTeam, getTeam, listTeams, listTeamAgents, listTeamTasks,
  createTeamAgent, createTeamTask, transitionTask, getTeamTask,
  appendEvent, enqueueMessage, getScratchpad, updateScratchpad,
} from './schema';
import { startTeam, haltTeam, getRunnerForAgent, spawnSingleAgent } from './runner';
import { mergeBranch, diffAgainstBase, createWorktree, defaultWorktreePath, slug } from './worktree';
import { costBreakdown } from './cost';
import { modelFromTier } from './roles';
import { readFileSync, existsSync } from 'node:fs';
import { parseImplementationPrompts } from './scratchpad-parser';
import { join } from 'node:path';

function loadPresetRoles(presetId: string): Array<{ role: string; handle: string; model: string }> {
  try {
    const presetsPath = join(process.cwd(), 'data', 'team-presets.json');
    if (!existsSync(presetsPath)) return [];
    const presets = JSON.parse(readFileSync(presetsPath, 'utf-8'));
    const preset = presets.find((p: any) => p.id === presetId);
    return preset?.roles || [];
  } catch { return []; }
}

export function createCommanderMcpServer(parentChatKey: string) {
  const coreTool = <S extends z.ZodRawShape>(
    name: string,
    desc: string,
    schema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
  ) => tool(name, desc, schema, handler as any);

  const tools = [
    coreTool(
      'mc_create_team',
      'Create and start a new Constellation (team of parallel agents). Returns the team ID. Agents will begin pulling tasks immediately.',
      {
        name: z.string().describe('Constellation name, e.g. "Orion"'),
        preset: z.enum(['smoke_test', 'feature', 'review_only', 'fullstack', 'migration', 'debug', 'research', 'code_review', 'custom']).default('feature'),
        goal: z.string().describe('Mission brief — what the team should accomplish'),
        project_id: z.string().describe('Absolute path to the project/repo root'),
        main_branch: z.string().default('main'),
        chat_context: z.any().optional().describe('Inherited context from parent chat: key facts, environment, compressed history. Pass the full object from the chat session.'),
        plan_first: z.boolean().default(false).describe('When true, the Architect explores and creates tasks before other agents spawn'),
        tasks: z.array(z.object({
          title: z.string(),
          description: z.string(),
          role_hint: z.string().optional(),
          priority: z.number().optional(),
          depends_on: z.array(z.string()).optional(),
        })).optional().describe('Initial task list for the team queue'),
      },
      async (args) => {
        const roles = args.preset !== 'custom' ? loadPresetRoles(args.preset) : [];
        if (roles.length === 0 && args.preset !== 'custom') {
          return { content: [{ type: 'text' as const, text: `Preset "${args.preset}" not found or has no roles.` }] };
        }

        const teamSlug = slug(args.name);
        const team = createTeam({
          name: args.name,
          constellation: args.name,
          project_id: args.project_id,
          main_branch: args.main_branch,
          parent_chat_key: parentChatKey,
          preset: args.preset,
          goal: args.goal,
          settings: { plan_first: args.plan_first },
          chat_context: args.chat_context as any,
        });

        for (const r of roles) {
          const handle = r.handle || `${r.role}-1`;
          const worktreePath = defaultWorktreePath(args.project_id, teamSlug, handle);
          const branchName = `mc/${teamSlug}/${handle}`;
          try {
            await createWorktree({ repoRoot: args.project_id, branchName, worktreePath, baseBranch: args.main_branch, forceClean: true });
          } catch (e: any) {
            console.warn(`[Commander] Worktree for ${handle}:`, e.message);
          }
          createTeamAgent({
            team_id: team.id,
            role: r.role as any,
            role_handle: handle,
            model: modelFromTier(r.model as any, r.role as any),
            worktree_path: worktreePath,
            branch_name: branchName,
          });
        }

        if (args.tasks) {
          const taskIds: Record<string, string> = {};
          for (const t of args.tasks) {
            const task = createTeamTask({
              team_id: team.id,
              title: t.title,
              description: t.description,
              role_hint: t.role_hint as any,
              priority: t.priority,
              depends_on: t.depends_on?.map(ref => taskIds[ref] || ref),
            });
            taskIds[t.title] = task.id;
          }
        }

        await startTeam(team.id);
        const agents = listTeamAgents(team.id);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              team_id: team.id,
              name: team.name,
              status: 'running',
              agents: agents.map(a => ({ role: a.role, handle: a.role_handle, model: a.model })),
              task_count: args.tasks?.length ?? 0,
            }),
          }],
        };
      },
    ),

    coreTool(
      'mc_list_teams',
      'List all Constellations (active and recent). Returns team IDs, names, and statuses.',
      { status: z.string().optional() },
      async (args) => {
        const teams = listTeams({ status: args.status as any });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(teams.map(t => ({
              id: t.id, name: t.name, status: t.status,
              preset: t.preset, updated_at: t.updated_at,
            }))),
          }],
        };
      },
    ),

    coreTool(
      'mc_team_status',
      'Get detailed status of a Constellation including all agents and tasks.',
      { team_id: z.string() },
      async (args) => {
        const team = getTeam(args.team_id);
        if (!team) return { content: [{ type: 'text' as const, text: 'Team not found' }] };
        const agents = listTeamAgents(args.team_id);
        const tasks = listTeamTasks(args.team_id);
        const cost = costBreakdown(args.team_id);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              team: { id: team.id, name: team.name, status: team.status, goal: team.goal },
              agents: agents.map(a => ({ id: a.id, role: a.role, handle: a.role_handle, status: a.status, current_task_id: a.current_task_id })),
              tasks: tasks.map(t => ({ id: t.id, title: t.title, status: t.status, assigned: t.assigned_agent_id, diff: t.diff_numstat })),
              summary: {
                pending: tasks.filter(t => t.status === 'pending').length,
                in_progress: tasks.filter(t => ['claimed', 'in_progress'].includes(t.status)).length,
                review: tasks.filter(t => ['ready_for_review', 'review'].includes(t.status)).length,
                done: tasks.filter(t => t.status === 'done').length,
                total: tasks.length,
              },
            }),
          }],
        };
      },
    ),

    coreTool(
      'mc_list_tasks',
      'List tasks for a Constellation, optionally filtered by status.',
      { team_id: z.string(), status: z.string().optional() },
      async (args) => {
        const tasks = listTeamTasks(args.team_id, args.status ? { status: args.status as any } : undefined);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(tasks.map(t => ({
              id: t.id, title: t.title, status: t.status,
              assigned: t.assigned_agent_id, result: t.result_summary,
              error: t.error_detail, diff: t.diff_numstat,
            }))),
          }],
        };
      },
    ),

    coreTool(
      'mc_diff_task',
      'Get the git diff of a task\'s worktree vs main branch.',
      { team_id: z.string(), task_id: z.string() },
      async (args) => {
        const team = getTeam(args.team_id);
        const task = getTeamTask(args.task_id);
        if (!team || !task) return { content: [{ type: 'text' as const, text: 'Not found' }] };
        if (!task.worktree_path) return { content: [{ type: 'text' as const, text: 'Task has no worktree' }] };
        try {
          const diff = await diffAgainstBase(task.worktree_path, team.main_branch);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ numstat: diff.numstat, files: diff.filesChanged, diff: diff.unifiedDiff.slice(0, 50000) }) }] };
        } catch (e: any) {
          return { content: [{ type: 'text' as const, text: `Diff failed: ${e.message}` }] };
        }
      },
    ),

    coreTool(
      'mc_approve_task',
      'Approve a task that\'s in review status. Optionally auto-merge it.',
      { team_id: z.string(), task_id: z.string(), merge: z.boolean().default(false) },
      async (args) => {
        transitionTask(args.task_id, 'approved');
        appendEvent({ team_id: args.team_id, task_id: args.task_id, kind: 'task_transition', payload: { to: 'approved', by: 'commander' }, chat_report: true });
        if (args.merge) {
          const team = getTeam(args.team_id)!;
          const task = getTeamTask(args.task_id)!;
          if (task.branch_name) {
            transitionTask(args.task_id, 'merging');
            const result = await mergeBranch({ repoRoot: team.project_id, branchName: task.branch_name, mainBranch: team.main_branch });
            if (result.ok) {
              transitionTask(args.task_id, 'done');
              return { content: [{ type: 'text' as const, text: `Approved and merged. +${result.linesAdded} -${result.linesRemoved}` }] };
            } else {
              transitionTask(args.task_id, 'blocked', { error_detail: result.error });
              return { content: [{ type: 'text' as const, text: `Approved but merge failed: ${result.error}` }] };
            }
          }
        }
        return { content: [{ type: 'text' as const, text: 'Approved' }] };
      },
    ),

    coreTool(
      'mc_halt_team',
      'Halt a running Constellation. Agents finish current tool call then stop.',
      { team_id: z.string(), reason: z.string().optional() },
      async (args) => {
        try {
          await haltTeam(args.team_id, args.reason);
          return { content: [{ type: 'text' as const, text: 'Team halted' }] };
        } catch (e: any) {
          return { content: [{ type: 'text' as const, text: `Halt failed: ${e.message}` }] };
        }
      },
    ),

    coreTool(
      'mc_send_to_agent',
      'Send a direct message to a specific agent in a running Constellation.',
      { team_id: z.string(), agent_id: z.string(), message: z.string(), priority: z.enum(['now', 'next', 'later']).default('next') },
      async (args) => {
        enqueueMessage({ team_id: args.team_id, from_agent_id: null, to_agent_id: args.agent_id, type: 'direct', priority: args.priority as any, body: args.message });
        const handle = getRunnerForAgent(args.agent_id);
        if (handle) handle.send(`[@commander] ${args.message}`, { priority: args.priority as any });
        return { content: [{ type: 'text' as const, text: 'Sent' }] };
      },
    ),

    coreTool(
      'mc_merge_all_approved',
      'Merge all approved tasks in a Constellation to the main branch.',
      { team_id: z.string(), squash: z.boolean().default(false) },
      async (args) => {
        const team = getTeam(args.team_id);
        if (!team) return { content: [{ type: 'text' as const, text: 'Team not found' }] };
        const tasks = listTeamTasks(args.team_id, { status: 'approved' });
        const results: string[] = [];
        for (const task of tasks) {
          if (!task.branch_name) continue;
          transitionTask(task.id, 'merging');
          const result = await mergeBranch({ repoRoot: team.project_id, branchName: task.branch_name, mainBranch: team.main_branch, squash: args.squash });
          if (result.ok) {
            transitionTask(task.id, 'done');
            results.push(`${task.title}: merged +${result.linesAdded} -${result.linesRemoved}`);
          } else {
            transitionTask(task.id, 'blocked', { error_detail: result.error });
            results.push(`${task.title}: CONFLICT — ${result.error}`);
          }
        }
        return { content: [{ type: 'text' as const, text: results.length ? results.join('\n') : 'No approved tasks to merge' }] };
      },
    ),

    coreTool(
      'mc_add_tasks',
      'Add new tasks to an existing Constellation\'s queue.',
      {
        team_id: z.string(),
        tasks: z.array(z.object({
          title: z.string(),
          description: z.string(),
          role_hint: z.string().optional(),
          priority: z.number().optional(),
        })),
      },
      async (args) => {
        const ids: string[] = [];
        for (const t of args.tasks) {
          const task = createTeamTask({ team_id: args.team_id, title: t.title, description: t.description, role_hint: t.role_hint as any, priority: t.priority });
          ids.push(task.id);
        }
        return { content: [{ type: 'text' as const, text: `Added ${ids.length} tasks: ${ids.join(', ')}` }] };
      },
    ),
    // ─── Dynamic Team Management ──────────────────────────────────────────

    coreTool(
      'mc_spawn_agent',
      'Dynamically add an agent to a running constellation. Creates worktree and spawns the agent.',
      {
        team_id: z.string(),
        role: z.string().describe('One of the 16 roles: builder, scout, inspector, sentinel, security, dba, tester, perfanalyst, uxreviewer, deployer, apidesigner, refactorer, scribe, navigator'),
        handle: z.string().optional().describe('Custom handle (e.g., "builder-3"). Auto-generated if omitted.'),
        model: z.enum(['opus', 'sonnet', 'haiku']).default('sonnet'),
      },
      async (args) => {
        const team = getTeam(args.team_id);
        if (!team) return { content: [{ type: 'text' as const, text: 'Team not found' }] };

        const handle = args.handle || `${args.role}-${Date.now().toString(36).slice(-4)}`;
        const teamSlug = slug(team.name);

        try {
          const wtPath = defaultWorktreePath(team.project_id, teamSlug, handle);
          await createWorktree({ repoRoot: team.project_id, worktreePath: wtPath, baseBranch: team.main_branch, branchName: `mc/${teamSlug}/${handle}` });

          const agent = createTeamAgent({
            team_id: args.team_id,
            role: args.role as any,
            role_handle: handle,
            model: modelFromTier(args.model, args.role as any),
            worktree_path: wtPath,
            branch_name: `mc/${teamSlug}/${handle}`,
          });

          await spawnSingleAgent(agent.id);

          appendEvent({ team_id: args.team_id, kind: 'system', payload: { action: 'agent_spawned', role: args.role, handle }, chat_report: true });

          return { content: [{ type: 'text' as const, text: `Spawned ${handle} (${args.role}) with model ${args.model}` }] };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `Failed to spawn: ${err.message}` }] };
        }
      },
    ),

    coreTool(
      'mc_reassign_task',
      'Move a pending or blocked task to a different role.',
      {
        team_id: z.string(),
        task_id: z.string(),
        new_role_hint: z.string().describe('New role to assign this task to'),
      },
      async (args) => {
        const task = getTeamTask(args.task_id);
        if (!task) return { content: [{ type: 'text' as const, text: 'Task not found' }] };
        if (!['pending', 'blocked'].includes(task.status)) {
          return { content: [{ type: 'text' as const, text: `Can only reassign pending/blocked tasks. Task is ${task.status}` }] };
        }

        const { getDb } = require('../memory-db');
        const db = getDb();
        db.prepare("UPDATE team_tasks SET role_hint = ?, status = 'pending', assigned_agent_id = NULL, error_detail = NULL WHERE id = ?")
          .run(args.new_role_hint, args.task_id);

        appendEvent({ team_id: args.team_id, task_id: args.task_id, kind: 'task_reassigned', payload: { new_role: args.new_role_hint }, chat_report: true });

        return { content: [{ type: 'text' as const, text: `Reassigned to ${args.new_role_hint}` }] };
      },
    ),

    coreTool(
      'mc_launch_from_research',
      'Parse the scratchpad\'s "Implementation Prompts" section from a research constellation and create implementation tasks. Optionally starts a new constellation or adds to the current one.',
      {
        team_id: z.string().describe('The research team to read prompts from'),
        add_to_existing: z.boolean().default(true).describe('Add tasks to this team (true) or create a new one (false)'),
      },
      async (args) => {
        const sp = getScratchpad(args.team_id);
        if (!sp.content) return { content: [{ type: 'text' as const, text: 'Scratchpad is empty' }] };

        const prompts = parseImplementationPrompts(sp.content);
        if (prompts.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No "## Implementation Prompts" section found in scratchpad. The scribe must write this section first.' }] };
        }

        const created: string[] = [];
        for (const p of prompts) {
          createTeamTask({
            team_id: args.team_id,
            title: p.title,
            description: `From research findings:\n\n${p.description}${p.acceptance ? `\n\n**Acceptance:** ${p.acceptance}` : ''}`,
            role_hint: p.role as any,
            priority: p.priority,
          });
          created.push(`[${p.severity}] ${p.title} → ${p.role}`);
        }

        appendEvent({ team_id: args.team_id, kind: 'system', payload: { action: 'research_to_impl', tasks_created: created.length }, chat_report: true });

        return { content: [{ type: 'text' as const, text: `Created ${created.length} implementation tasks:\n${created.join('\n')}` }] };
      },
    ),
  ];

  return createSdkMcpServer({
    name: 'mc-commander',
    version: '1.0.0',
    tools: tools as any,
  });
}
