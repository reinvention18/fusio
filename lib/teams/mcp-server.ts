/**
 * Per-agent MCP server factory for Constellation teams.
 *
 * Creates an in-process MCP server (via `createSdkMcpServer`) with closure-
 * scoped tools bound to a specific agent's identity. Each agent gets its own
 * server instance so tool calls resolve to the correct team/agent/task context.
 *
 * Core tools (all agents):
 *   mc_get_next_task     — atomic task claim from the team queue
 *   mc_submit_task_result — commit result + trigger state transitions
 *   mc_update_scratchpad  — write to shared team markdown
 *   mc_read_scratchpad    — read shared team markdown
 *   mc_notify_commander   — send message to the parent chat
 *
 * Inspector-only tool:
 *   mc_codex_review       — run Codex adversarial/standard review (added externally)
 */

import 'server-only';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getDb } from '../memory-db';
import type { TeamAgentRow, TeamTaskRow } from './schema';
import {
  claimNextTask,
  claimReviewTask,
  transitionTask,
  getTeam,
  getTeamTask,
  createTeamTask,
  getScratchpad,
  updateScratchpad,
  enqueueMessage,
  claimUndeliveredMessages,
  listTeamAgents,
  listTeamPhases,
  appendEvent,
  createTeamDecision,
  updateTeamAgentStatus,
  updateTeamAgentCurrentTask,
  activateNextPhase,
} from './schema';

const REVIEWER_ROLES = new Set(['architect', 'inspector', 'sentinel', 'security', 'tester']);

function sleep(ms: number, signal?: { stopped: boolean }): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const check = setInterval(() => {
        if (signal.stopped) { clearTimeout(t); clearInterval(check); resolve(); }
      }, 100);
    }
  });
}

export interface McpServerContext {
  agent: TeamAgentRow;
  signal: { stopped: boolean };
  isTeamPaused: () => boolean;
  getCurrentTaskId: () => string | null;
  setCurrentTaskId: (id: string | null) => void;
}

export function createTeamMcpServer(ctx: McpServerContext) {
  const { agent, signal } = ctx;

  const coreTool = <S extends z.ZodRawShape>(
    name: string,
    desc: string,
    schema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
  ) => tool(name, desc, schema, handler as any);

  const coreTools = [
    coreTool(
      'mc_get_next_task',
      'Claim the next pending task for this agent. Returns a task object, {status:"idle"} (no work right now — call mc_wait_for_work to block efficiently), or {status:"halt"} (team is done/paused).',
      {},
      async () => {
        // Architect bootstrap: on first call, when team is in `planning` and
        // no tasks have been proposed yet, return a synthetic "plan the mission"
        // task with the preset's exact phase names + roster injected so the
        // architect can't guess wrong on mc_propose_tasks. Without this,
        // architects sit polling/waiting forever AND/OR loop on rejections.
        if (agent.role === 'architect') {
          const teamNow = getTeam(agent.team_id);
          if (teamNow && teamNow.status === 'planning') {
            const taskCount = (getDb().prepare(
              'SELECT COUNT(*) as c FROM team_tasks WHERE team_id = ?'
            ).get(agent.team_id) as { c: number }).c;
            if (taskCount === 0) {
              updateTeamAgentStatus(agent.id, 'working');

              // Pull THIS team's actual phases + roster so the architect can't
              // confuse audit_then_fix's "Audit" with research_then_build's "Research".
              const phasesForTeam = listTeamPhases(agent.team_id);
              const phaseLines = phasesForTeam.length > 0
                ? phasesForTeam.map(p => {
                    let roles: string[] = [];
                    try { roles = JSON.parse(p.roles_json || '[]'); } catch { /* ignore */ }
                    return `  - "${p.name}" → roles: ${roles.join(', ') || '(any)'}`;
                  }).join('\n')
                : '  (none defined for this preset — tasks may omit the phase field)';

              const roster = getDb().prepare(
                `SELECT role, role_handle FROM team_agents WHERE team_id = ? ORDER BY role, role_handle`
              ).all(agent.team_id) as Array<{ role: string; role_handle: string }>;
              const handlesByRole: Record<string, string[]> = {};
              for (const r of roster) (handlesByRole[r.role] ||= []).push(r.role_handle);
              const rosterLines = Object.entries(handlesByRole)
                .map(([role, handles]) => `  - role="${role}" → handles: ${handles.join(', ')}`)
                .join('\n');

              const settings = teamNow.settings_json ? JSON.parse(teamNow.settings_json) : {};
              const requireApproval = settings?.require_plan_approval === true;

              const desc = [
                `WHAT: This is your planning turn. The Commander's goal is in your system prompt under "Mission". Read it carefully, do recon, write the ADR to the scratchpad, and propose tasks via mc_propose_tasks for the rest of the team.`,
                ``,
                `═══ THIS TEAM'S EXACT PHASES (use these names verbatim, case matters) ═══`,
                phaseLines,
                ``,
                `═══ THIS TEAM'S ROSTER (role_hint must be the BASE ROLE, not the handle) ═══`,
                rosterLines,
                ``,
                `═══ MANDATORY mc_propose_tasks RULES ═══`,
                `- Every task MUST have a "phase" field matching one of the phase names above EXACTLY.`,
                `- Every task's "role_hint" MUST be the BASE ROLE (e.g. "scout"), NOT the handle (e.g. "scout-code"). Handles auto-resolve based on role + first-available agent.`,
                `- Every Verify-phase task MUST depend on at least one upstream-phase task BY TITLE (audit, fix, build, migrate, optimize, test, OR report — verifying a published artifact is allowed).`,
                `- Every Report-phase task (scribe) gets its depends_on auto-filled with every other task — you don't need to enumerate them.`,
                `- Every task SHOULD have an "acceptance" field describing what proves it's done.`,
                ``,
                `═══ STEPS ═══`,
                `1. (Optional but recommended if goal is ambiguous) Call mc_ask_commander with up to 3 targeted questions; wait for reply.`,
                `2. Call mc_read_scratchpad to see what's already there.`,
                `3. Use Read/Grep/Glob to do quick recon (5-15 min budget).`,
                `4. Call mc_update_scratchpad mode='append' with the ADR (## Architect: ADR — Mission, Requirement Coverage Matrix, Phases, Decisions, Risks).`,
                requireApproval
                  ? `5. Post the plan via mc_notify_commander urgency='milestone' body STARTING WITH "🔒 PLAN APPROVAL REQUIRED". Poll mc_read_messages until commander replies "approve". Then call mc_record_plan_approval.`
                  : `5. (No plan-approval gate on this team — skip to step 6.)`,
                `6. Call mc_propose_tasks with the full task list. Every task: title (string), description (with WHAT/WHERE/OUTPUT/READS), role_hint (base role), phase (exact name from list above), depends_on (titles of dependent tasks), acceptance (what proves done), priority (number).`,
                `7. Call mc_submit_task_result(task_id="planning-bootstrap", status="ready_for_review", summary="<one-line plan summary>"). This auto-resolves and triggers team promotion.`,
                ``,
                `═══ SELF-CHECK BEFORE mc_propose_tasks ═══`,
                `Before clicking submit on mc_propose_tasks, scan your task list:`,
                `□ Does every task have a "phase" matching exactly one of: ${phasesForTeam.map(p => `"${p.name}"`).join(', ') || '(none)'}?`,
                `□ Does every "role_hint" match exactly one of: ${Object.keys(handlesByRole).join(', ')}?`,
                `□ Does every Verify-phase task have at least one depends_on title pointing to an upstream-phase task?`,
                `If any answer is no, fix it BEFORE calling mc_propose_tasks. Each rejection costs you a full re-write turn.`,
                ``,
                `DO NOT call mc_wait_for_work during planning — this synthetic task IS your work.`,
              ].join('\n');

              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    status: 'task',
                    task_id: 'planning-bootstrap',
                    title: 'Plan the mission',
                    description: desc,
                    worktree: agent.worktree_path,
                    branch: agent.branch_name,
                    is_planning_bootstrap: true,
                  }),
                }],
              };
            }
          }
        }

        // Bounded internal poll: 5 short retries (≈4s total) so a brief race
        // between submit + new-task creation resolves without round-tripping
        // through the agent. After that, return idle and let the agent call
        // mc_wait_for_work for an event-style block.
        const MAX_INNER_RETRIES = 5;
        let innerRetries = 0;
        while (!signal.stopped && innerRetries < MAX_INNER_RETRIES) {
          let claimed = claimNextTask(agent.team_id, agent.id, agent.role as any);
          let claimedAsReview = false;
          // Reviewer roles: if no pending task matches, try to claim a
          // ready_for_review task to verify. Keeps the team self-progressing
          // without human intervention.
          if (!claimed && REVIEWER_ROLES.has(agent.role)) {
            const rev = claimReviewTask(agent.team_id, agent.id, agent.role as any);
            if (rev) {
              claimed = rev;
              claimedAsReview = true;
            }
          }
          if (claimed) {
            ctx.setCurrentTaskId(claimed.id);
            updateTeamAgentStatus(agent.id, 'working');
            updateTeamAgentCurrentTask(agent.id, claimed.id);
            appendEvent({
              team_id: agent.team_id,
              agent_id: agent.id,
              task_id: claimed.id,
              kind: 'task_transition',
              payload: claimedAsReview
                ? { from: 'ready_for_review', to: 'review', agent_role: agent.role, reviewer: agent.role_handle }
                : { from: 'pending', to: 'claimed', agent_role: agent.role },
              chat_report: true,
            });
            let depResults: Record<string, string> = {};
            try {
              const deps: string[] = JSON.parse(claimed.depends_on || '[]');
              for (const depId of deps) {
                const dep = getTeamTask(depId);
                if (dep?.result_summary) depResults[depId] = dep.result_summary;
              }
            } catch { /* ignore parse errors */ }

            // Auto-inject scratchpad sections the task explicitly READS.
            // Agents often forget to call mc_read_scratchpad first — deliver
            // the prerequisite context inline so they can't miss it. Parses
            // a line of the form: `READS: ## Scout: Architecture, ## Inspector: Findings`.
            const scratchpadContext: Record<string, string> = {};
            try {
              const readsMatch = (claimed.description || '').match(/^\s*READS:\s*(.+?)(?:\n|$)/im);
              if (readsMatch) {
                const sections = readsMatch[1]
                  .split(/[,;]/)
                  .map(s => s.trim().replace(/^##\s*/, ''))
                  .filter(Boolean);
                if (sections.length > 0) {
                  const full = getScratchpad(agent.team_id).content || '';
                  // Split scratchpad by H2 headers and bucket by title.
                  const sectionMap: Record<string, string> = {};
                  const re = /^##\s+(.+?)\s*$/gm;
                  let m: RegExpExecArray | null;
                  const hits: Array<{ title: string; start: number }> = [];
                  while ((m = re.exec(full)) !== null) {
                    hits.push({ title: m[1].trim(), start: m.index });
                  }
                  for (let i = 0; i < hits.length; i++) {
                    const end = i + 1 < hits.length ? hits[i + 1].start : full.length;
                    sectionMap[hits[i].title.toLowerCase()] = full.slice(hits[i].start, end).trim();
                  }
                  for (const want of sections) {
                    const hit = sectionMap[want.toLowerCase()];
                    if (hit) scratchpadContext[want] = hit.slice(0, 4000); // cap per section
                  }
                }
              }
            } catch (e) {
              console.warn('[mcp] scratchpad auto-inject failed:', (e as Error).message);
            }

            // Also deliver any pending messages from other agents
            const pendingMessages = claimUndeliveredMessages(agent.id);
            const messagesForAgent = pendingMessages.map(m => ({
              from: m.from_agent_id,
              body: m.body,
              priority: m.priority,
            }));

            if (claimedAsReview) {
              // Look up original author's handle for clarity.
              const db = getDb();
              const author = claimed.assigned_agent_id
                ? (db.prepare('SELECT role_handle, role FROM team_agents WHERE id = ?').get(claimed.assigned_agent_id) as { role_handle: string; role: string } | undefined)
                : null;
              const reviewInstructions = [
                `REVIEW TASK — a teammate submitted work you need to verify.`,
                ``,
                `**Author:** ${author?.role_handle || 'unknown'} (${author?.role || '?'})`,
                `**Commit:** ${claimed.commit_sha}`,
                `**Worktree:** ${claimed.worktree_path || agent.worktree_path}`,
                `**Files touched:** ${claimed.files_touched || '[]'}`,
                ``,
                `**Original task:**`,
                claimed.title,
                claimed.description?.slice(0, 1200) || '',
                ``,
                `**Author's summary:**`,
                claimed.result_summary?.slice(0, 1500) || '(none)',
                ``,
                `## How to review`,
                `1. cd to the worktree. Run \`git show ${claimed.commit_sha}\` to inspect the diff.`,
                `2. Verify the fix actually resolves the original task.`,
                `3. If it's good → call \`mc_approve_task(task_id="${claimed.id}", summary="<one-line review note>")\`.`,
                `4. If issues → call \`mc_request_rework(task_id="${claimed.id}", findings="...", severity="critical|high|medium")\`.`,
                `5. Write your review notes to the scratchpad first (mc_update_scratchpad).`,
              ].join('\n');
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    status: 'task',
                    mode: 'review',
                    task_id: claimed.id,
                    title: `Review: ${claimed.title}`,
                    description: reviewInstructions,
                    worktree: claimed.worktree_path || agent.worktree_path,
                    branch: claimed.branch_name || agent.branch_name,
                    commit_sha: claimed.commit_sha,
                    original_description: claimed.description,
                    author_summary: claimed.result_summary,
                    depends_on_results: depResults,
                    ...(messagesForAgent.length > 0 ? { messages: messagesForAgent } : {}),
                  }),
                }],
              };
            }

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'task',
                  task_id: claimed.id,
                  title: claimed.title,
                  description: claimed.description,
                  acceptance: (claimed as any).acceptance || undefined,
                  model_hint: (claimed as any).model_override || undefined,
                  worktree: claimed.worktree_path || agent.worktree_path,
                  branch: claimed.branch_name || agent.branch_name,
                  depends_on_results: depResults,
                  ...(Object.keys(scratchpadContext).length > 0 ? { scratchpad_context: scratchpadContext } : {}),
                  ...(messagesForAgent.length > 0 ? { messages: messagesForAgent } : {}),
                }),
              }],
            };
          }
          if (ctx.isTeamPaused()) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'halt', reason: 'paused' }) }] };
          }
          // Check if the TEAM itself is marked completed — that's the only
          // reason to halt an agent. A momentary "no active tasks" lull is
          // NOT a halt condition: rework/retest flow can spawn new work
          // asynchronously.
          const teamNow = getTeam(agent.team_id);
          if (teamNow && ['completed', 'cancelled', 'archived'].includes(teamNow.status)) {
            updateTeamAgentStatus(agent.id, 'idle');
            return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'halt', reason: `team_${teamNow.status}` }) }] };
          }
          await sleep(800, signal);
          innerRetries++;
        }
        // Either signal.stopped or exhausted inner retries → return idle
        if (signal.stopped) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'halt', reason: 'shutdown' }) }] };
        }
        updateTeamAgentStatus(agent.id, 'idle');
        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'idle', hint: 'No work right now. Call mc_wait_for_work(timeout_seconds=60) to block until something appears, then mc_get_next_task again.' }) }] };
      },
    ),

    coreTool(
      'mc_wait_for_work',
      'Block until new work is available for this agent OR timeout (default 60s, max 180s). Use this in your idle loop instead of repeatedly calling mc_get_next_task — it returns instantly when a task lands, and uses near-zero tokens while waiting. Returns {ready:true} when work shows up (then call mc_get_next_task), {ready:false, reason:"timeout"} otherwise, or {ready:false, reason:"halt"} if the team finished.',
      {
        timeout_seconds: z.number().int().min(5).max(180).default(60),
      },
      async (args) => {
        const startedAt = Date.now();
        const deadline = startedAt + args.timeout_seconds * 1000;
        while (!signal.stopped && Date.now() < deadline) {
          if (ctx.isTeamPaused()) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ ready: false, reason: 'halt', sub_reason: 'paused' }) }] };
          }
          const teamNow = getTeam(agent.team_id);
          if (teamNow && ['completed', 'cancelled', 'archived'].includes(teamNow.status)) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ ready: false, reason: 'halt', sub_reason: `team_${teamNow.status}` }) }] };
          }

          // Availability probe — must mirror claimNextTask's filters
          // (role + active phase + deps satisfied) so we don't wake an agent
          // that immediately gets `idle` from mc_get_next_task. The previous
          // version only checked role and caused tester/scribe spin loops
          // when their phase wasn't active yet.
          const db = getDb();
          const candidates = db.prepare(
            `SELECT id, role_hint, phase, depends_on FROM team_tasks
               WHERE team_id = ? AND status = 'pending'
                 AND (role_hint IS NULL OR role_hint = ?)`
          ).all(agent.team_id, agent.role) as Array<{ id: string; role_hint: string | null; phase: string | null; depends_on: string | null }>;
          const activePhaseIds = new Set(
            (db.prepare(
              `SELECT id FROM team_phases WHERE team_id = ? AND status = 'active'`
            ).all(agent.team_id) as Array<{ id: string }>).map(r => r.id)
          );
          const claimable = candidates.some(c => {
            if (c.phase && !activePhaseIds.has(c.phase)) return false;
            let deps: string[] = [];
            try { deps = JSON.parse(c.depends_on || '[]'); } catch { return true; }
            if (deps.length === 0) return true;
            const placeholders = deps.map(() => '?').join(',');
            const row = db.prepare(
              `SELECT COUNT(*) AS n FROM team_tasks WHERE id IN (${placeholders}) AND status IN ('done','approved')`
            ).get(...deps) as { n: number };
            return row.n === deps.length;
          });
          if (claimable) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ ready: true, kind: 'task', waited_seconds: Math.round((Date.now() - startedAt) / 1000) }) }] };
          }
          if (REVIEWER_ROLES.has(agent.role)) {
            const reviewCount = (db.prepare(
              `SELECT COUNT(*) AS n FROM team_tasks
                 WHERE team_id = ? AND status = 'ready_for_review'
                   AND commit_sha IS NOT NULL
                   AND (assigned_agent_id IS NULL OR assigned_agent_id != ?)`
            ).get(agent.team_id, agent.id) as { n: number }).n;
            if (reviewCount > 0) {
              return { content: [{ type: 'text' as const, text: JSON.stringify({ ready: true, kind: 'review', waited_seconds: Math.round((Date.now() - startedAt) / 1000) }) }] };
            }
          }
          // Check for direct messages
          const msgCount = (db.prepare(
            `SELECT COUNT(*) AS n FROM team_messages
               WHERE to_agent_id = ? AND delivered_at IS NULL`
          ).get(agent.id) as { n: number }).n;
          if (msgCount > 0) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ ready: true, kind: 'message', waited_seconds: Math.round((Date.now() - startedAt) / 1000) }) }] };
          }

          await sleep(2500, signal);
        }
        if (signal.stopped) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ ready: false, reason: 'halt', sub_reason: 'shutdown' }) }] };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ready: false, reason: 'timeout', waited_seconds: args.timeout_seconds }) }] };
      },
    ),

    coreTool(
      'mc_submit_task_result',
      'Submit the result of the current task. Status should be "ready_for_review" (completed), "blocked" (hit a wall), or "failed" (broken). Always include files_touched and a commit_sha.',
      {
        task_id: z.string(),
        status: z.enum(['ready_for_review', 'blocked', 'failed']),
        summary: z.string(),
        files_touched: z.array(z.string()).default([]),
        commit_sha: z.string().optional(),
        blocker: z.string().optional(),
      },
      async (args) => {
        // Guard: architect MUST propose tasks before submitting during planning.
        // Without this, the architect does all the work itself and other agents starve.
        if (agent.role === 'architect') {
          const team = getTeam(agent.team_id);
          if (team && team.status === 'planning') {
            const db = getDb();
            const taskCount = db.prepare(
              'SELECT COUNT(*) as c FROM team_tasks WHERE team_id = ? AND id != ?'
            ).get(agent.team_id, args.task_id) as { c: number };
            if (taskCount.c === 0) {
              return {
                content: [{
                  type: 'text' as const,
                  text: 'REJECTED: You must call mc_propose_tasks to create tasks for your team (scouts, inspector, sentinel, scribe) BEFORE submitting your result. Your team is waiting for tasks. Do not do the work yourself — delegate it. Call mc_propose_tasks now with 4-8 tasks, then call mc_submit_task_result again.',
                }],
              };
            }
          }
        }

        // Check if agent wrote to scratchpad. For read-only roles, this is a
        // hard requirement — their entire deliverable IS the scratchpad write.
        // Warn (non-blocking) for everyone else.
        let scratchpadWarning = '';
        const SCRATCHPAD_REQUIRED_ROLES = new Set(['scout', 'inspector', 'security', 'perfanalyst', 'uxreviewer', 'dba', 'scribe']);
        if (args.status === 'ready_for_review' && agent.role !== 'architect') {
          const sp = getScratchpad(agent.team_id);
          const handlePattern = `## ${agent.role_handle}`;
          const rolePattern = `## ${agent.role.charAt(0).toUpperCase() + agent.role.slice(1)}`;
          const agentWrote = sp.content
            ? sp.content.includes(handlePattern) || sp.content.includes(rolePattern)
            : false;

          if (!agentWrote && SCRATCHPAD_REQUIRED_ROLES.has(agent.role)) {
            // Hard reject — don't transition the task. Force the agent to write findings first.
            return {
              content: [{
                type: 'text' as const,
                text: `REJECTED: Submission blocked. Your role (${agent.role}) MUST write findings to the scratchpad before submitting. Your deliverable IS the scratchpad section.\n\nDO THIS:\n1. Call mc_update_scratchpad with mode='append' and content starting with: \`## ${agent.role_handle}: <Topic>\`\n2. Include your full findings — other agents (and the scribe) read this to do their work.\n3. THEN call mc_submit_task_result again.\n\nWithout the scratchpad write, your work is invisible to the team and the scribe will produce an incomplete deliverable.`,
              }],
            };
          }
          if (!agentWrote) {
            scratchpadWarning = '\n\nWARNING: You did not write your findings to the scratchpad. Other agents cannot see your work. Next time, call mc_update_scratchpad BEFORE submitting.';
          }
        }

        // Auto-promote ready_for_review → done when there's no commit.
        // No commit = read-only task (review/research) — no human approval needed.
        // Tasks with a commit stay at ready_for_review for human approval/merge.
        const isReadOnly = args.status === 'ready_for_review' && !args.commit_sha;
        const finalStatus = isReadOnly ? 'done' : args.status;

        transitionTask(args.task_id, finalStatus as any, {
          result_summary: args.summary,
          files_touched: args.files_touched,
          error_detail: args.blocker ?? null,
          commit_sha: args.commit_sha ?? null,
        });
        ctx.setCurrentTaskId(null);
        updateTeamAgentCurrentTask(agent.id, null);
        updateTeamAgentStatus(agent.id, 'idle');
        appendEvent({
          team_id: agent.team_id,
          agent_id: agent.id,
          task_id: args.task_id,
          kind: 'task_transition',
          payload: { to: finalStatus, summary: args.summary.slice(0, 200) },
          chat_report: finalStatus !== 'done',
        });

        // Wake reviewers: when a task lands in ready_for_review with a commit,
        // broadcast to every reviewer role on the team so their next
        // mc_get_next_task poll finds the work. Without this, reviewers sit
        // in their 800ms sleep loop until a safety tick or human nudge.
        if (finalStatus === 'ready_for_review' && args.commit_sha) {
          const teammates = listTeamAgents(agent.team_id);
          const reviewers = teammates.filter(a =>
            REVIEWER_ROLES.has(a.role) && a.id !== agent.id && !['done', 'error', 'cancelled'].includes(a.status)
          );
          for (const r of reviewers) {
            enqueueMessage({
              team_id: agent.team_id,
              from_agent_id: agent.id,
              to_agent_id: r.id,
              type: 'direct',
              priority: 'next',
              body: `New work ready for review: "${(getTeamTask(args.task_id)?.title || '').slice(0, 100)}" (commit ${args.commit_sha.slice(0, 8)}). Call mc_get_next_task — if it returns status:'review', verify the commit and approve/rework.`,
              metadata: { kind: 'review_nudge', task_id: args.task_id, commit: args.commit_sha },
            });
          }
        }

        // If this is the architect finishing during the planning phase,
        // promote the team to running and spawn the remaining agents.
        if (agent.role === 'architect') {
          const team = getTeam(agent.team_id);
          if (team && team.status === 'planning') {
            // Lazy require to avoid circular dependency (runner imports mcp-server)
            const { promoteToRunning } = require('./runner');
            promoteToRunning(agent.team_id).catch((err: any) => {
              console.error('[MCP] Failed to promote team to running:', err.message);
              appendEvent({
                team_id: agent.team_id,
                kind: 'system',
                severity: 'error',
                payload: { action: 'promote_failed', error: err.message },
                chat_report: true,
              });
            });
          }
        }

        // If this is a rework fix (child task with parent), auto-create a
        // re-test task AND transition the parent out of needs_rework so any
        // downstream tasks (verify/scribe/etc.) unblock. Without this, the
        // parent stays in needs_rework forever and downstream deps deadlock.
        const completedTask = getTeamTask(args.task_id);
        if (completedTask?.parent_task_id && (finalStatus === 'done' || finalStatus === 'ready_for_review')) {
          const parentTask = getTeamTask(completedTask.parent_task_id);
          if (parentTask && parentTask.status === 'needs_rework') {
            // Mark parent done — the fix is the resolution. The re-test (below)
            // is the verification gate; if it fails, a new rework cycle starts.
            transitionTask(parentTask.id, 'done' as any, {
              status_reason: `Resolved by Fix task ${completedTask.id} (${agent.role_handle})`,
              result_summary: `Rework completed. Fix summary: ${args.summary.slice(0, 500)}`,
            });
            appendEvent({
              team_id: agent.team_id,
              agent_id: agent.id,
              task_id: parentTask.id,
              kind: 'task_transition',
              payload: { from: 'needs_rework', to: 'done', reason: 'fix_completed', fix_task: completedTask.id },
              chat_report: true,
            });
            // No role_hint — any capable agent (sentinel, tester, inspector,
            // architect) can claim the re-test. Hardcoding sentinel caused a
            // serial bottleneck when multiple reworks completed at once.
            createTeamTask({
              team_id: agent.team_id,
              title: `Re-test: ${parentTask.title}`,
              description: `Builder fixed the issues. Re-run verification (inspect the commit, run relevant tests if applicable, confirm the original findings are resolved).\n\nOriginal findings:\n${parentTask.error_detail || 'See parent task'}\n\nFix summary:\n${args.summary}`,
              priority: 8,
              depends_on: [completedTask.id],
              parent_task_id: parentTask.id,
            });
            appendEvent({
              team_id: agent.team_id,
              agent_id: agent.id,
              task_id: parentTask.id,
              kind: 'rework_retest',
              payload: { action: 'auto_retest_created', fix_task: completedTask.id },
              chat_report: false,
            });
          }
        }

        // Check if all tasks in the team are now complete — if so, mark team as completed.
        {
          const db = getDb();
          const active = db.prepare(
            "SELECT COUNT(*) as c FROM team_tasks WHERE team_id = ? AND status IN ('pending','claimed','in_progress','needs_rework','rework_in_progress','re_testing','review')"
          ).get(agent.team_id) as { c: number };
          const reviewOrDone = db.prepare(
            "SELECT COUNT(*) as c FROM team_tasks WHERE team_id = ? AND status IN ('ready_for_review','approved','done')"
          ).get(agent.team_id) as { c: number };
          if (active.c === 0 && reviewOrDone.c > 0) {
            const becameCompleted = db.prepare(
              "UPDATE teams SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'running'"
            ).run(Date.now(), agent.team_id).changes === 1;
            if (becameCompleted) {
              appendEvent({
                team_id: agent.team_id,
                kind: 'system',
                payload: { action: 'team_completed', total_tasks: reviewOrDone.c },
                chat_report: true,
              });
              // Kick off the Codex cross-model mission audit — non-blocking.
              // Result is stored as a team_decision + observation + available
              // via /api/teams/:id/final-audit.
              void (async () => {
                try {
                  const mod = await import('./final-audit');
                  await mod.runAndStoreFinalAudit(agent.team_id);
                } catch (e: any) {
                  console.warn('[final-audit] failed:', e?.message);
                }
              })();
            }
          }
        }

        return { content: [{ type: 'text' as const, text: 'acknowledged' + scratchpadWarning }] };
      },
    ),

    coreTool(
      'mc_update_scratchpad',
      'Append to or replace a section of the team scratchpad. Visible to all agents and the human.',
      {
        content: z.string(),
        mode: z.enum(['append', 'replace']).default('append'),
      },
      async (args) => {
        const current = getScratchpad(agent.team_id);
        const newContent = args.mode === 'append'
          ? current.content + '\n\n' + args.content
          : args.content;
        const newVersion = updateScratchpad(agent.team_id, newContent, current.version, agent.id);
        if (newVersion === null) {
          return { content: [{ type: 'text' as const, text: 'conflict — read scratchpad and retry' }] };
        }
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    ),

    coreTool(
      'mc_read_scratchpad',
      'Read the current team scratchpad content.',
      {},
      async () => {
        const sp = getScratchpad(agent.team_id);
        return { content: [{ type: 'text' as const, text: sp.content || '(empty)' }] };
      },
    ),

    coreTool(
      'mc_ask_commander',
      'BEFORE planning, ask the commander up to 3 targeted clarifying questions if the goal is ambiguous. Blocks for up to 60s waiting for a reply, then returns the answer (or {answered:false} so you can proceed with stated assumptions). Use ONCE on the first turn — if the goal is clear, skip this and go straight to mc_propose_tasks.',
      {
        questions: z.array(z.string()).min(1).max(3).describe('Up to 3 specific yes/no or short-answer questions. Be concrete: "Should this fix mobile too, or just web?" not "Any preferences?"'),
        timeout_seconds: z.number().int().min(10).max(120).default(60),
      },
      async (args) => {
        const askedAt = Date.now();
        const isPlanning = agent.role === 'architect';
        const intro = isPlanning
          ? 'Before I plan the team, I need quick answers to:'
          : `I'm blocked and need a quick decision before continuing:`;
        const body = [
          `❓ CLARIFICATION NEEDED (${agent.role_handle || agent.role})`,
          '',
          intro,
          ...args.questions.map((q, i) => `${i + 1}. ${q}`),
          '',
          `(I'll wait ${args.timeout_seconds}s, then proceed with reasonable defaults if no reply.)`,
        ].join('\n');

        enqueueMessage({
          team_id: agent.team_id,
          from_agent_id: agent.id,
          to_agent_id: null,
          type: 'chat_report',
          priority: 'now',
          body,
          metadata: { urgency: 'blocker', agent_role: agent.role, kind: 'clarify_request', questions: args.questions },
        });
        appendEvent({
          team_id: agent.team_id,
          agent_id: agent.id,
          kind: 'commander_clarify_asked',
          severity: 'info',
          payload: { questions: args.questions, asked_at: askedAt },
          chat_report: true,
        });

        const deadline = askedAt + args.timeout_seconds * 1000;
        while (!signal.stopped && Date.now() < deadline) {
          const msgs = claimUndeliveredMessages(agent.id);
          // Find the first message from the commander (no from_agent_id) sent after we asked.
          const reply = msgs.find(m => !m.from_agent_id && m.created_at >= askedAt);
          if (reply) {
            appendEvent({
              team_id: agent.team_id,
              agent_id: agent.id,
              kind: 'commander_clarify_answered',
              payload: { reply: reply.body.slice(0, 500) },
              chat_report: true,
            });
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ answered: true, reply: reply.body, waited_seconds: Math.round((Date.now() - askedAt) / 1000) }),
              }],
            };
          }
          await sleep(2000, signal);
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ answered: false, note: 'No reply within timeout. Proceed with reasonable defaults and document them in the ADR.' }),
          }],
        };
      },
    ),

    coreTool(
      'mc_notify_commander',
      'Send a message to the Commander (the user-facing chat). Use sparingly — only for blockers and milestone updates.',
      {
        urgency: z.enum(['info', 'blocker', 'milestone']),
        body: z.string(),
      },
      async (args) => {
        enqueueMessage({
          team_id: agent.team_id,
          from_agent_id: agent.id,
          to_agent_id: null,
          type: 'chat_report',
          priority: args.urgency === 'blocker' ? 'now' : 'next',
          body: args.body,
          metadata: { urgency: args.urgency, agent_role: agent.role },
        });
        appendEvent({
          team_id: agent.team_id,
          agent_id: agent.id,
          kind: 'message_sent',
          severity: args.urgency === 'blocker' ? 'warn' : 'info',
          payload: { to: 'commander', urgency: args.urgency, body: args.body.slice(0, 200) },
          chat_report: true,
        });
        return { content: [{ type: 'text' as const, text: 'sent' }] };
      },
    ),

    // ─── Agent-to-Agent Messaging ──────────────────────────────────────────
    coreTool(
      'mc_read_messages',
      'Read undelivered messages from other agents. Returns an array of messages or empty array.',
      {},
      async () => {
        const messages = claimUndeliveredMessages(agent.id);
        if (messages.length === 0) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ messages: [] }) }] };
        }
        const formatted = messages.map(m => {
          // Resolve sender role handle
          const db = getDb();
          const sender = m.from_agent_id
            ? (db.prepare('SELECT role_handle FROM team_agents WHERE id = ?').get(m.from_agent_id) as { role_handle: string } | undefined)
            : null;
          return {
            from: sender?.role_handle || 'commander',
            body: m.body,
            priority: m.priority,
            sent_at: m.created_at,
          };
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ messages: formatted }) }] };
      },
    ),

    coreTool(
      'mc_send_message',
      'Send a message to another agent on the team. Use to_role to broadcast to all agents of a role, or to_handle for a specific agent.',
      {
        to_role: z.string().optional().describe('Role to broadcast to (e.g., "builder", "scout")'),
        to_handle: z.string().optional().describe('Specific agent handle (e.g., "builder-1")'),
        body: z.string(),
        urgency: z.enum(['info', 'action_required', 'blocker']).default('info'),
      },
      async (args) => {
        if (!args.to_role && !args.to_handle) {
          return { content: [{ type: 'text' as const, text: 'Must specify to_role or to_handle' }] };
        }
        const teammates = listTeamAgents(agent.team_id);
        const targets = args.to_handle
          ? teammates.filter(a => a.role_handle === args.to_handle)
          : teammates.filter(a => a.role === args.to_role && a.id !== agent.id);

        if (targets.length === 0) {
          return { content: [{ type: 'text' as const, text: `No agents found matching ${args.to_role || args.to_handle}` }] };
        }

        for (const target of targets) {
          enqueueMessage({
            team_id: agent.team_id,
            from_agent_id: agent.id,
            to_agent_id: target.id,
            type: 'direct',
            priority: args.urgency === 'blocker' ? 'now' : 'next',
            body: args.body,
            metadata: { from_role: agent.role, from_handle: agent.role_handle, urgency: args.urgency },
          });
        }

        appendEvent({
          team_id: agent.team_id,
          agent_id: agent.id,
          kind: 'agent_message',
          payload: {
            to: args.to_handle || args.to_role,
            body: args.body.slice(0, 200),
            urgency: args.urgency,
            recipients: targets.length,
          },
          chat_report: false,
        });

        return { content: [{ type: 'text' as const, text: `Sent to ${targets.length} agent(s)` }] };
      },
    ),

    // ─── Feedback Loop: Request Rework ────────────────────────────────────
    coreTool(
      'mc_request_rework',
      'Request that a completed task be reworked due to issues found during review. Creates a child task for a builder to fix, and auto-creates a re-test task after the fix. Available to inspector, sentinel, security, and tester roles.',
      {
        task_id: z.string().describe('The task that needs reworking'),
        findings: z.string().describe('What is wrong — be specific with file:line references'),
        severity: z.enum(['critical', 'high', 'medium']),
        suggested_fix: z.string().optional().describe('Guidance for the builder on how to fix'),
      },
      async (args) => {
        // Review/verification roles + architect (team lead) can request rework.
        if (!REVIEWER_ROLES.has(agent.role)) {
          return { content: [{ type: 'text' as const, text: 'Only architect/inspector/sentinel/security/tester can request rework' }] };
        }

        const task = getTeamTask(args.task_id);
        if (!task) {
          return { content: [{ type: 'text' as const, text: 'Task not found' }] };
        }

        // Check rework cycle limit
        const settings = JSON.parse(getTeam(agent.team_id)?.settings_json || '{}');
        const maxCycles = settings.max_rework_cycles ?? 2;
        if ((task.rework_count ?? 0) >= maxCycles) {
          // Escalate to commander instead
          enqueueMessage({
            team_id: agent.team_id,
            from_agent_id: agent.id,
            type: 'chat_report',
            priority: 'now',
            body: `ESCALATION: Task "${task.title}" has exceeded ${maxCycles} rework cycles. Latest findings: ${args.findings.slice(0, 500)}`,
            metadata: { task_id: task.id, rework_count: task.rework_count, severity: args.severity },
          });
          return { content: [{ type: 'text' as const, text: `Escalated to commander — rework limit (${maxCycles}) exceeded` }] };
        }

        // Transition original task to needs_rework
        transitionTask(args.task_id, 'needs_rework' as any, {
          error_detail: args.findings,
          status_reason: `Rework requested by ${agent.role_handle}: ${args.severity}`,
        });

        // Increment rework count
        const db = getDb();
        db.prepare('UPDATE team_tasks SET rework_count = rework_count + 1 WHERE id = ?').run(args.task_id);

        // Create child task for builder to fix.
        // NO depends_on on the parent: parent is in `needs_rework` status which
        // never satisfies deps, so depending on it would deadlock the Fix.
        // The parent_task_id link already encodes the relationship.
        const fixTask = createTeamTask({
          team_id: agent.team_id,
          title: `Fix: ${task.title}`,
          description: `## Rework Required (${args.severity})\n\n**Findings:**\n${args.findings}\n\n${args.suggested_fix ? `**Suggested fix:**\n${args.suggested_fix}\n\n` : ''}**Original task:** ${task.title}\n**Original description:** ${task.description?.slice(0, 500)}`,
          role_hint: 'builder' as any,
          priority: args.severity === 'critical' ? 10 : args.severity === 'high' ? 8 : 5,
          parent_task_id: args.task_id,
        });

        appendEvent({
          team_id: agent.team_id,
          agent_id: agent.id,
          task_id: args.task_id,
          kind: 'rework_requested',
          severity: args.severity === 'critical' ? 'error' : 'warn',
          payload: {
            action: 'rework_requested',
            severity: args.severity,
            fix_task_id: fixTask.id,
            findings: args.findings.slice(0, 300),
            rework_cycle: (task.rework_count ?? 0) + 1,
          },
          chat_report: true,
        });

        // Release the reviewer — they finished this review, let them claim more.
        if (ctx.getCurrentTaskId() === args.task_id) {
          ctx.setCurrentTaskId(null);
          updateTeamAgentCurrentTask(agent.id, null);
          updateTeamAgentStatus(agent.id, 'idle');
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'rework_created',
              fix_task_id: fixTask.id,
              rework_cycle: (task.rework_count ?? 0) + 1,
              max_cycles: maxCycles,
            }),
          }],
        };
      },
    ),

    // ─── Approve a reviewed task (reviewer roles) ────────────────────────
    coreTool(
      'mc_approve_task',
      'Approve a task currently in "review" status. Transitions the task to "done". Call this after verifying a teammate\'s commit addresses the original task. Available to architect/inspector/sentinel/security/tester.',
      {
        task_id: z.string().describe('The task you are approving (must be in "review" status, claimed by you via mc_get_next_task).'),
        summary: z.string().describe('Brief review note — what you verified and why it\'s good.'),
      },
      async (args) => {
        if (!REVIEWER_ROLES.has(agent.role)) {
          return { content: [{ type: 'text' as const, text: 'Only architect/inspector/sentinel/security/tester can approve tasks' }] };
        }
        const task = getTeamTask(args.task_id);
        if (!task) return { content: [{ type: 'text' as const, text: 'Task not found' }] };
        // Idempotent: if a previous approval transitioned the task to done but
        // a non-critical step crashed, treat the retry as a no-op success.
        if (task.status === 'done' || task.status === 'approved') {
          if (ctx.getCurrentTaskId() === args.task_id) {
            ctx.setCurrentTaskId(null);
            updateTeamAgentCurrentTask(agent.id, null);
            updateTeamAgentStatus(agent.id, 'idle');
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'already_done', task_id: task.id }) }] };
        }
        if (task.status !== 'review' && task.status !== 'ready_for_review') {
          return { content: [{ type: 'text' as const, text: `Cannot approve — task is ${task.status}, expected 'review' or 'ready_for_review'. Claim it via mc_get_next_task first.` }] };
        }

        transitionTask(args.task_id, 'done' as any, {
          status_reason: `Approved by ${agent.role_handle}`,
        });

        // Decision logging is non-critical — never let a CHECK constraint or
        // schema mismatch swallow an otherwise-valid approval.
        try {
          createTeamDecision({
            team_id: agent.team_id,
            decision_type: 'review_approved' as any,
            summary: `${agent.role_handle} approved "${task.title}"`,
            details: { task_id: task.id, reviewer_id: agent.id, reviewer_role: agent.role, note: args.summary.slice(0, 500) },
          });
        } catch (e) {
          console.warn('[mc_approve_task] decision log failed (non-fatal):', (e as Error).message);
        }

        appendEvent({
          team_id: agent.team_id,
          agent_id: agent.id,
          task_id: args.task_id,
          kind: 'task_transition',
          payload: { to: 'done', action: 'approved', reviewer: agent.role_handle, note: args.summary.slice(0, 200) },
          chat_report: true,
        });

        // If this approval unblocked a parent-task re-test chain, auto-create
        // one + resolve parent out of needs_rework.
        if (task.parent_task_id) {
          const parentTask = getTeamTask(task.parent_task_id);
          if (parentTask && parentTask.status === 'needs_rework') {
            transitionTask(parentTask.id, 'done' as any, {
              status_reason: `Resolved by approved Fix task ${task.id}`,
              result_summary: `Rework completed (approved by ${agent.role_handle}).`,
            });
            createTeamTask({
              team_id: agent.team_id,
              title: `Re-test: ${parentTask.title}`,
              description: `Reviewer approved the fix. Run verification (inspect the commit, run relevant tests, confirm the original findings are resolved).\n\nOriginal findings:\n${parentTask.error_detail || 'See parent task'}\n\nFix summary:\n${task.result_summary || args.summary}`,
              priority: 8,
              depends_on: [task.id],
              parent_task_id: parentTask.id,
            });
          }
        }

        // Release the reviewer.
        if (ctx.getCurrentTaskId() === args.task_id) {
          ctx.setCurrentTaskId(null);
          updateTeamAgentCurrentTask(agent.id, null);
          updateTeamAgentStatus(agent.id, 'idle');
        }

        // Check if team is now complete (mirrors mc_submit_task_result).
        {
          const db = getDb();
          const active = db.prepare(
            "SELECT COUNT(*) as c FROM team_tasks WHERE team_id = ? AND status IN ('pending','claimed','in_progress','needs_rework','rework_in_progress','re_testing','review')"
          ).get(agent.team_id) as { c: number };
          const reviewOrDone = db.prepare(
            "SELECT COUNT(*) as c FROM team_tasks WHERE team_id = ? AND status IN ('ready_for_review','approved','done')"
          ).get(agent.team_id) as { c: number };
          if (active.c === 0 && reviewOrDone.c > 0) {
            const becameCompleted = db.prepare(
              "UPDATE teams SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'running'"
            ).run(Date.now(), agent.team_id).changes === 1;
            if (becameCompleted) {
              appendEvent({
                team_id: agent.team_id,
                kind: 'system',
                payload: { action: 'team_completed', total_tasks: reviewOrDone.c },
                chat_report: true,
              });
              void (async () => {
                try {
                  const mod = await import('./final-audit');
                  await mod.runAndStoreFinalAudit(agent.team_id);
                } catch (e: any) {
                  console.warn('[final-audit] failed:', e?.message);
                }
              })();
            }
          }
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'approved', task_id: task.id }) }] };
      },
    ),

    // ─── Plan Approval (architect-only) ────────────────────────────────────
    coreTool(
      'mc_record_plan_approval',
      'Architect-only. Call this AFTER the commander replies "approve" (or equivalent) to your 🔒 PLAN APPROVAL REQUIRED message. Stamps the team so mc_propose_tasks unlocks. Pass the commander message id you just read.',
      {
        commander_message_id: z.string().optional().describe('The id of the commander message that approved the plan. Optional — used for audit trail.'),
        commander_message_excerpt: z.string().optional().describe('A short excerpt (<200 chars) of the approving message. Optional.'),
      },
      async (args) => {
        if (agent.role !== 'architect') {
          return { content: [{ type: 'text' as const, text: 'REJECTED: Only the architect can record plan approval.' }] };
        }
        try {
          const db = getDb();
          const teamRow = getTeam(agent.team_id);
          const settings = teamRow?.settings_json ? JSON.parse(teamRow.settings_json) : {};
          if (!settings?.require_plan_approval) {
            return { content: [{ type: 'text' as const, text: 'Noted — but this team does not require plan approval. You can proceed to mc_propose_tasks whenever you\'re ready.' }] };
          }
          settings.plan_approved_at = Date.now();
          settings.plan_approved_by_message_id = args.commander_message_id ?? null;
          settings.plan_approval_excerpt = (args.commander_message_excerpt ?? '').slice(0, 200);
          db.prepare('UPDATE teams SET settings_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(settings), Date.now(), agent.team_id);
          createTeamDecision({
            team_id: agent.team_id,
            agent_id: agent.id,
            decision_type: 'commander_input',
            summary: 'Commander approved the architect\'s plan — proceeding to task creation.',
            details: {
              approved_at: settings.plan_approved_at,
              commander_message_id: args.commander_message_id ?? null,
              excerpt: settings.plan_approval_excerpt,
            },
          });
          appendEvent({
            team_id: agent.team_id,
            agent_id: agent.id,
            kind: 'system',
            severity: 'info',
            payload: { action: 'plan_approved', by: 'commander' },
            chat_report: true,
          });
          return { content: [{ type: 'text' as const, text: 'Plan approval recorded. mc_propose_tasks is now unlocked — call it with the approved task list.' }] };
        } catch (e: any) {
          return { content: [{ type: 'text' as const, text: `Failed to record approval: ${e?.message}` }] };
        }
      },
    ),

    // ─── Dynamic Team Composition ──────────────────────────────────────────
    coreTool(
      'mc_propose_team',
      'Override the preset roster by spawning additional agents. Call this during planning if the mission needs roles not in the preset. Only available to the architect.',
      {
        add_roles: z.array(z.object({
          role: z.string().describe('One of 16 roles: builder, scout, inspector, sentinel, security, dba, tester, perfanalyst, uxreviewer, deployer, apidesigner, refactorer, scribe, navigator'),
          handle: z.string().optional().describe('Custom handle (auto-generated if omitted)'),
          model: z.enum(['opus', 'sonnet', 'haiku']).default('sonnet'),
          reason: z.string().describe('Why this role is needed'),
        })),
      },
      async (args) => {
        if (agent.role !== 'architect') {
          return { content: [{ type: 'text' as const, text: 'Only the architect can propose team changes' }] };
        }

        const team = getTeam(agent.team_id);
        if (!team) return { content: [{ type: 'text' as const, text: 'Team not found' }] };

        const { createTeamAgent } = require('./schema');
        const { createWorktree, defaultWorktreePath, slug } = require('./worktree');
        const { modelFromTier } = require('./roles');
        const { createTeamDecision } = require('./schema');

        const teamSlug = slug(team.name);
        const spawned: string[] = [];

        for (const r of args.add_roles) {
          const handle = r.handle || `${r.role}-${Date.now().toString(36).slice(-4)}`;
          try {
            const wtPath = defaultWorktreePath(team.project_id, teamSlug, handle);
            await createWorktree({ repoRoot: team.project_id, worktreePath: wtPath, baseBranch: team.main_branch, branchName: `mc/${teamSlug}/${handle}` });

            createTeamAgent({
              team_id: agent.team_id,
              role: r.role,
              role_handle: handle,
              model: modelFromTier(r.model, r.role),
              worktree_path: wtPath,
              branch_name: `mc/${teamSlug}/${handle}`,
            });

            spawned.push(`${handle} (${r.role}): ${r.reason}`);
          } catch (err: any) {
            spawned.push(`FAILED ${handle} (${r.role}): ${err.message}`);
          }
        }

        createTeamDecision({
          team_id: agent.team_id,
          agent_id: agent.id,
          decision_type: 'team_composition',
          summary: `Architect added ${spawned.length} agents: ${args.add_roles.map(r => r.role).join(', ')}`,
          details: { added: args.add_roles },
        });

        appendEvent({
          team_id: agent.team_id,
          agent_id: agent.id,
          kind: 'team_composition_changed',
          payload: { action: 'propose_team', added: spawned },
          chat_report: true,
        });

        return { content: [{ type: 'text' as const, text: `Team updated:\n${spawned.join('\n')}\n\nNew agents will spawn when planning completes.` }] };
      },
    ),

    // ─── Task Proposal ───────────────────────────────────────────────────
    coreTool(
      'mc_propose_tasks',
      'Create a batch of tasks in the team queue. Typically called by the Architect after writing the ADR. Tasks with depends_on can reference earlier task titles from this same batch. Optionally tag each task with a phase name from the preset (e.g. "Research", "Build", "Verify", "Report") to drive the phased workflow UI.',
      {
        tasks: z.array(z.object({
          title: z.string(),
          description: z.string(),
          role_hint: z.string().optional(),
          priority: z.number().optional(),
          phase: z.string().optional().describe('Phase name from the preset (case-insensitive match). Tasks without a phase still work but skip the phase pipeline UI.'),
          depends_on: z.array(z.string()).optional().describe('Task titles (from this batch) this task depends on'),
          acceptance: z.string().optional().describe('Concrete acceptance criteria — what proves "this task is done correctly?". Reviewers verify against this. Example: "All API responses match the OpenAPI schema; manual smoke test of /signup passes; no console errors."'),
          model: z.enum(['haiku', 'sonnet', 'opus']).optional().describe('Override the assigned agent\'s model for this task. Use "haiku" for trivial mechanical work (cheap+fast), "sonnet" for normal coding/research, "opus" for deep reasoning. If omitted, the agent\'s default model is used.'),
        })),
      },
      async (args) => {
        // Auto-wire scribe dependencies. The architect should not have to
        // manually enumerate every task the scribe depends on — the scribe
        // ALWAYS runs last and depends on every other proposed task. Mutating
        // args here keeps the architect's prompt simple and unblocks the
        // existing "scribe must have depends_on" validation below.
        const allTitles = args.tasks.map(t => t.title);
        for (const t of args.tasks) {
          const isScribe = t.role_hint === 'scribe' || (t.phase && /^report$/i.test(t.phase));
          if (!isScribe) continue;
          const existing = new Set(t.depends_on || []);
          const auto = allTitles.filter(title => title !== t.title);
          for (const a of auto) existing.add(a);
          t.depends_on = Array.from(existing);
        }

        if (agent.role === 'architect') {
          // Plan-approval gate: presets with require_plan_approval=true must
          // go through commander approval before the architect's task proposal
          // is accepted. This matches the user's ask: do recon → post plan →
          // wait for commander OK → THEN spawn the team.
          try {
            const teamRow = getTeam(agent.team_id);
            const settings = teamRow?.settings_json ? JSON.parse(teamRow.settings_json) : {};
            if (settings?.require_plan_approval === true && !settings?.plan_approved_at) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `REJECTED: This team requires commander plan approval before tasks can be created.\n\nDO THIS FIRST:\n1. Finish your recon (reading project context, quick Read/Grep/Glob to confirm scope).\n2. Write the ADR to the scratchpad via mc_update_scratchpad.\n3. Send the plan to the commander via mc_notify_commander with urgency='milestone' and body that STARTS WITH \`🔒 PLAN APPROVAL REQUIRED\`. Include: (a) one-paragraph summary, (b) the proposed task breakdown with role assignments, (c) any clarifying questions, (d) a final line saying "Reply 'approve' to proceed, 'modify: …' to change, or 'reject' to halt."\n4. Poll mc_read_messages until the commander replies.\n5. When the commander approves, call mc_record_plan_approval(commander_message_id=...) — this stamps the team and UNLOCKS mc_propose_tasks.\n6. Then call mc_propose_tasks with the approved task list.\n\nDo NOT call mc_propose_tasks again until step 5 is done.`,
                }],
              };
            }
          } catch (e) {
            console.warn('[mc_propose_tasks] plan-approval check failed:', (e as Error).message);
          }

          // Valid role hints — the 16 defined roles
          const VALID_ROLES = new Set([
            'commander', 'architect', 'builder', 'inspector', 'sentinel', 'scout', 'scribe', 'navigator',
            'security', 'dba', 'tester', 'perfanalyst', 'uxreviewer', 'deployer', 'apidesigner', 'refactorer',
          ]);
          // Common aliases → correct role
          const ROLE_ALIASES: Record<string, string> = {
            'frontend': 'builder', 'backend': 'builder', 'dev': 'builder', 'developer': 'builder',
            'qa': 'tester', 'test': 'tester', 'testing': 'tester',
            'review': 'inspector', 'reviewer': 'inspector', 'auditor': 'inspector',
            'sec': 'security', 'securityauditor': 'security',
            'database': 'dba', 'db': 'dba',
            'perf': 'perfanalyst', 'performance': 'perfanalyst',
            'ux': 'uxreviewer', 'ui': 'uxreviewer', 'design': 'uxreviewer',
            'deploy': 'deployer', 'devops': 'deployer', 'cicd': 'deployer',
            'api': 'apidesigner',
            'refactor': 'refactorer',
            'docs': 'scribe', 'documentation': 'scribe', 'report': 'scribe',
            'research': 'scout', 'explore': 'scout',
            'deps': 'navigator', 'dependencies': 'navigator',
          };

          // Auto-fix invalid role hints
          for (const t of args.tasks) {
            if (t.role_hint && !VALID_ROLES.has(t.role_hint)) {
              const mapped = ROLE_ALIASES[t.role_hint.toLowerCase()];
              if (mapped) {
                t.role_hint = mapped;
              } else {
                return {
                  content: [{
                    type: 'text' as const,
                    text: `REJECTED: Invalid role_hint "${t.role_hint}" on task "${t.title}". Valid roles: ${[...VALID_ROLES].join(', ')}. Fix the role_hint and try again.`,
                  }],
                };
              }
            }
          }

          // Validate: read-only roles must not get code-editing tasks
          const READ_ONLY_ROLES = new Set(['scout', 'inspector', 'sentinel', 'uxreviewer', 'perfanalyst', 'scribe']);
          const CODE_VERBS = /^(Fix|Add|Implement|Create|Wire|Build|Refactor|Update|Remove|Delete|Replace|Rewrite|Migrate)\b/i;
          for (const t of args.tasks) {
            if (t.role_hint && READ_ONLY_ROLES.has(t.role_hint) && CODE_VERBS.test(t.title)) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `REJECTED: Task "${t.title}" starts with a code-editing verb but is assigned to ${t.role_hint} (a read-only role). ${t.role_hint} cannot edit files. Reassign to builder, refactorer, dba, tester, apidesigner, or navigator. For ${t.role_hint}, use verbs like: Research, Analyze, Map, Investigate, Review, Audit, Verify, Document, Run.`,
                }],
              };
            }
          }

          // Strict-phase validation: when the team has phases defined, EVERY
          // proposed task must include an explicit `phase` field. Auto-tagging
          // by role_hint is silent and masks architect mistakes — better to
          // surface them as a hard rejection.
          const teamPhasesForStrict = listTeamPhases(agent.team_id);
          if (teamPhasesForStrict.length > 0) {
            const validPhaseNames = teamPhasesForStrict.map(p => p.name);
            const validPhaseSet = new Set(validPhaseNames.map(n => n.toLowerCase()));
            const tasksWithoutPhase = args.tasks.filter(t => !t.phase);
            if (tasksWithoutPhase.length > 0) {
              const titles = tasksWithoutPhase.map(t => `"${t.title}"`).join(', ');
              return {
                content: [{
                  type: 'text' as const,
                  text: `REJECTED: ${tasksWithoutPhase.length} task${tasksWithoutPhase.length === 1 ? ' is' : 's are'} missing the required \`phase\` field: ${titles}. This team has phases defined: ${validPhaseNames.join(', ')}. Add the matching phase to each task and re-propose. Phases drive task ordering — without them, builders can run before scouts finish.`,
                }],
              };
            }
            const tasksWithBadPhase = args.tasks.filter(t => t.phase && !validPhaseSet.has(t.phase.toLowerCase()));
            if (tasksWithBadPhase.length > 0) {
              const list = tasksWithBadPhase.map(t => `"${t.title}" → "${t.phase}"`).join('; ');
              return {
                content: [{
                  type: 'text' as const,
                  text: `REJECTED: These tasks have unknown phase labels: ${list}. Valid phases for this team: ${validPhaseNames.join(', ')}. Use one of those exact names.`,
                }],
              };
            }
          }

          // Validate: tasks must cover all non-architect roles in the team
          const teamRoles = getDb().prepare(
            "SELECT DISTINCT role FROM team_agents WHERE team_id = ? AND role != 'architect'"
          ).all(agent.team_id).map((r: any) => r.role as string);
          const teamRolesSet = new Set(teamRoles);

          // Reject tasks assigned to roles not in the team — otherwise they sit
          // un-claimable forever (no agent matches the role_hint).
          const orphanedTasks = args.tasks.filter(t => t.role_hint && !teamRolesSet.has(t.role_hint));
          if (orphanedTasks.length > 0) {
            const orphanList = orphanedTasks.map(t => `"${t.title}" → ${t.role_hint}`).join('; ');
            return {
              content: [{
                type: 'text' as const,
                text: `REJECTED: These tasks target roles that aren't on this team: ${orphanList}. Available team roles: ${teamRoles.join(', ')}. Reassign each task to one of the available roles (builder for code/db work, scribe for docs, scout for research, navigator if on team, etc.) and re-call mc_propose_tasks.`,
              }],
            };
          }

          const proposedHints = new Set(args.tasks.map(t => t.role_hint).filter(Boolean));
          const missingRoles = teamRoles.filter(r => !proposedHints.has(r));

          if (missingRoles.length > 0) {
            return {
              content: [{
                type: 'text' as const,
                text: `REJECTED: Your task list is missing tasks for these team members: ${missingRoles.join(', ')}. Every agent on the team needs at least one task or they sit idle. Add tasks with role_hint for: ${missingRoles.join(', ')}. Then call mc_propose_tasks again with the COMPLETE list (including the tasks you already had).`,
              }],
            };
          }

          // Validate: scribe must depend on at least one other task
          const scribeTasks = args.tasks.filter(t => t.role_hint === 'scribe');
          for (const st of scribeTasks) {
            if (!st.depends_on || st.depends_on.length === 0) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `REJECTED: Scribe task "${st.title}" has no depends_on. The scribe MUST depend on other tasks so it runs last and can compile their findings. Add depends_on with at least the scout and inspector task titles.`,
                }],
              };
            }
          }

          // Validate: phase ordering — for preset phase names that encode an
          // audit→act→verify flow, later-phase tasks MUST depend on at least
          // one earlier-phase task. Without this guard, the architect ships
          // Fix tasks that run in parallel with Audit tasks — which defeats
          // the whole point of audit_then_fix / research_then_build.
          //
          // Policy table (keyed by downstream phase):
          //   'fix'       ← audit         (Audit → Fix)
          //   'build'     ← research | synthesize  (Research → Build)
          //   'migrate'   ← research | prepare    (Research → Prepare → Migrate)
          //   'optimize'  ← profile              (Profile → Optimize)
          //   'verify'    ← build | fix | migrate | optimize
          //   'report'    ← any earlier phase
          const phaseRowsForOrder = listTeamPhases(agent.team_id);
          const phaseRoleMap: Record<string, string[]> = {};
          const phaseOrder: Record<string, number> = {};
          for (const ph of phaseRowsForOrder) {
            phaseOrder[ph.name.toLowerCase()] = ph.ordering;
            try { phaseRoleMap[ph.name.toLowerCase()] = JSON.parse(ph.roles_json || '[]'); } catch { phaseRoleMap[ph.name.toLowerCase()] = []; }
          }

          const PHASE_REQUIRES_UPSTREAM: Record<string, string[]> = {
            fix: ['audit'],
            build: ['research', 'synthesize'],
            migrate: ['research', 'prepare'],
            optimize: ['profile'],
            // Verify can depend on any phase that produces something verifiable
            // — including 'report' (verifying a published artifact is the
            // architect's standard pattern: audit → scribe → inspector verifies).
            verify: ['audit', 'build', 'fix', 'migrate', 'optimize', 'test', 'report'],
            report: ['audit', 'analysis', 'build', 'fix', 'migrate', 'verify', 'research', 'recon', 'profile', 'synthesize', 'design'],
            analysis: ['research', 'audit', 'recon'],
          };

          // Collect each proposed task's phase label (explicit or inferred from role).
          const taskPhase: Record<string, string> = {};
          for (const t of args.tasks) {
            let phase: string | null = null;
            if (t.phase) phase = t.phase.toLowerCase();
            else if (t.role_hint) {
              // Use the preset's first phase that includes this role
              for (const [name, roles] of Object.entries(phaseRoleMap)) {
                if (roles.includes(t.role_hint)) { phase = name; break; }
              }
            }
            if (phase) taskPhase[t.title] = phase;
          }

          for (const t of args.tasks) {
            const phase = taskPhase[t.title];
            if (!phase) continue;
            const required = PHASE_REQUIRES_UPSTREAM[phase];
            if (!required || required.length === 0) continue;
            // Does this phase actually exist in the preset? If the preset has
            // no Audit phase, we shouldn't require deps on one.
            const anyUpstreamExists = required.some(up => phaseOrder[up] !== undefined);
            if (!anyUpstreamExists) continue;

            const deps = t.depends_on || [];
            const hasValidUpstreamDep = deps.some(depTitle => {
              const depPhase = taskPhase[depTitle];
              return depPhase ? required.includes(depPhase) : false;
            });

            if (!hasValidUpstreamDep) {
              const presentUpstream = required.filter(up => phaseOrder[up] !== undefined);
              const availableDepTitles = args.tasks
                .filter(x => presentUpstream.includes(taskPhase[x.title] || ''))
                .map(x => `"${x.title}"`);
              return {
                content: [{
                  type: 'text' as const,
                  text: `REJECTED: Task "${t.title}" is in the ${phase.toUpperCase()} phase but has no depends_on pointing to a ${presentUpstream.join('/').toUpperCase()} phase task. ${phase.toUpperCase()} work must depend on upstream findings — otherwise the team fixes things before the audit runs. ${availableDepTitles.length > 0 ? `Add depends_on referencing one of: ${availableDepTitles.join(', ')}.` : 'Add at least one ' + presentUpstream.join('/') + ' task first, then re-call mc_propose_tasks with the full plan.'}`,
                }],
              };
            }
          }

          // Validate: phase label (if explicit) must match the role's preset phase.
          // e.g. labeling a "security" task as "Verify" when the preset places
          // security in "Audit" is wrong and creates misleading phase bars.
          for (const t of args.tasks) {
            if (!t.phase || !t.role_hint) continue;
            const declaredPhase = t.phase.toLowerCase();
            // Which phase SHOULD this role be in per the preset?
            const expectedPhases: string[] = [];
            for (const [name, roles] of Object.entries(phaseRoleMap)) {
              if (roles.includes(t.role_hint)) expectedPhases.push(name);
            }
            if (expectedPhases.length === 0) continue; // role isn't in any phase — skip
            if (!expectedPhases.includes(declaredPhase)) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `REJECTED: Task "${t.title}" (role ${t.role_hint}) is tagged phase "${t.phase}" but the preset puts ${t.role_hint} in phase${expectedPhases.length > 1 ? 's' : ''} ${expectedPhases.map(p => `"${p}"`).join(' or ')}. Fix the phase tag to match.`,
                }],
              };
            }
          }

          // Validate: inspector must depend on scout tasks
          const inspectorTasks = args.tasks.filter(t => t.role_hint === 'inspector');
          const scoutTitles = args.tasks.filter(t => t.role_hint === 'scout').map(t => t.title);
          for (const it of inspectorTasks) {
            if (scoutTitles.length > 0 && (!it.depends_on || it.depends_on.length === 0)) {
              return {
                content: [{
                  type: 'text' as const,
                  text: `REJECTED: Inspector task "${it.title}" has no depends_on but there are scout tasks. The inspector should depend on scout tasks so it reviews their findings. Add depends_on referencing scout task titles.`,
                }],
              };
            }
          }
        }

        // Resolve phase names → phase IDs (case-insensitive).
        // Also build a role → first-matching-phase map so tasks without an
        // explicit phase get auto-tagged based on their role_hint.
        const phases = listTeamPhases(agent.team_id);
        const phaseByName: Record<string, string> = {};
        const phaseByRole: Record<string, string> = {};
        for (const ph of phases) {
          phaseByName[ph.name.toLowerCase()] = ph.id;
          try {
            const roles: string[] = JSON.parse(ph.roles_json || '[]');
            for (const r of roles) {
              if (!phaseByRole[r]) phaseByRole[r] = ph.id;
            }
          } catch { /* ignore bad json */ }
        }

        // Map title → id so later tasks can reference earlier ones by title
        const titleToId: Record<string, string> = {};
        const created: string[] = [];
        const phaseBuckets: Record<string, string[]> = {};

        for (const t of args.tasks) {
          const resolvedDeps = (t.depends_on || [])
            .map(ref => titleToId[ref] || ref)
            .filter(Boolean);

          const explicit = t.phase ? phaseByName[t.phase.toLowerCase()] : null;
          const byRole = t.role_hint ? phaseByRole[t.role_hint] : null;
          const phaseId = explicit || byRole || null;

          const task = createTeamTask({
            team_id: agent.team_id,
            title: t.title,
            description: t.description,
            role_hint: t.role_hint as any,
            priority: t.priority,
            depends_on: resolvedDeps,
            phase: phaseId,
            acceptance: t.acceptance ?? null,
            model_override: (t as any).model ?? null,
          });
          titleToId[t.title] = task.id;
          created.push(task.id);
          if (t.phase) {
            const key = t.phase;
            (phaseBuckets[key] ||= []).push(t.title);
          }
        }

        appendEvent({
          team_id: agent.team_id,
          agent_id: agent.id,
          kind: 'tasks_proposed',
          payload: { count: args.tasks.length, titles: args.tasks.map(t => t.title) },
          chat_report: true,
        });

        // Activate the earliest pending phase that now has tasks. Without
        // this, claimNextTask's phase gate would block every claim until a
        // task happened to land in an already-active phase.
        try { activateNextPhase(agent.team_id); } catch (e) {
          console.warn('[mcp] activateNextPhase failed:', (e as Error).message);
        }

        // Log the architect's plan as a decision
        if (agent.role === 'architect') {
          createTeamDecision({
            team_id: agent.team_id,
            agent_id: agent.id,
            decision_type: 'architect_plan',
            summary: `Proposed ${args.tasks.length} task${args.tasks.length === 1 ? '' : 's'}${Object.keys(phaseBuckets).length > 0 ? ` across ${Object.keys(phaseBuckets).length} phase${Object.keys(phaseBuckets).length === 1 ? '' : 's'}` : ''}.`,
            details: {
              tasks: args.tasks.map(t => ({ title: t.title, role_hint: t.role_hint, phase: t.phase })),
              phaseBuckets,
            },
          });
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ created: created.length, task_ids: titleToId }),
          }],
        };
      },
    ),
  ];

  // Codex tools — available to reviewer/analysis roles
  const codexReviewRoles = ['inspector', 'security', 'tester'];
  const codexExecRoles = ['scout', 'architect', 'inspector', 'security'];

  if (codexReviewRoles.includes(agent.role)) {
    (coreTools as any[]).push(
      coreTool(
        'mc_codex_review',
        'Run an OpenAI Codex (GPT) adversarial or standard code review on the current worktree. Cross-model review catches bugs that Claude misses. Returns structured findings.',
        {
          mode: z.enum(['adversarial', 'standard']).default('adversarial').describe('adversarial = thorough security review ($1-3), standard = quick quality check'),
          focus: z.string().optional().describe('Specific file or directory to focus the review on'),
        },
        async (args) => {
          try {
            const { runCodexReview } = require('./codex');
            const result = await runCodexReview({
              mode: args.mode,
              focus: args.focus,
              cwd: agent.worktree_path,
              taskId: ctx.getCurrentTaskId() || 'unknown',
              teamId: agent.team_id,
              reviewerAgentId: agent.id,
            });
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  verdict: result.verdict,
                  summary: result.summary,
                  findings: result.findings,
                  next_steps: result.next_steps,
                  duration_ms: result.duration_ms,
                }),
              }],
            };
          } catch (err: any) {
            return {
              content: [{
                type: 'text' as const,
                text: `Codex review failed: ${err.message}. Continue your review manually using Read/Grep/Glob.`,
              }],
            };
          }
        },
      ),
    );
  }

  if (codexExecRoles.includes(agent.role)) {
    (coreTools as any[]).push(
      coreTool(
        'mc_codex_exec',
        'Run a focused question/task via OpenAI Codex (GPT model). Use for a second opinion on code analysis, security review, or architecture questions. Cheaper than spawning another agent.',
        {
          prompt: z.string().describe('The question or task for Codex to analyze'),
        },
        async (args) => {
          try {
            const { spawn } = require('node:child_process');
            const startTime = Date.now();

            const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
              const proc = spawn('codex', ['exec', args.prompt, '--json'], {
                cwd: agent.worktree_path,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
                windowsHide: true,
              });
              let stdout = '';
              let stderr = '';
              proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
              proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
              proc.on('close', (code: number) => resolve({ stdout, stderr, code: code ?? -1 }));
              proc.on('error', reject);
              setTimeout(() => {
                try { proc.kill('SIGTERM'); } catch { /* ignore */ }
                reject(new Error('Codex exec timed out after 5 minutes'));
              }, 5 * 60 * 1000);
            });

            const duration_ms = Date.now() - startTime;

            appendEvent({
              team_id: agent.team_id,
              agent_id: agent.id,
              kind: 'codex_exec',
              payload: { prompt: args.prompt.slice(0, 200), duration_ms, exit_code: result.code },
              chat_report: false,
            });

            return {
              content: [{
                type: 'text' as const,
                text: result.code === 0
                  ? result.stdout.slice(0, 50000)
                  : `Codex exec failed (code ${result.code}): ${result.stderr.slice(-1000)}`,
              }],
            };
          } catch (err: any) {
            return {
              content: [{
                type: 'text' as const,
                text: `Codex exec failed: ${err.message}`,
              }],
            };
          }
        },
      ),
    );
  }

  return createSdkMcpServer({
    name: `mc-team-${agent.team_id}-${agent.role_handle}`,
    version: '1.0.0',
    tools: coreTools as any,
  });
}
