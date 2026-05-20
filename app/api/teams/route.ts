import { NextRequest, NextResponse } from 'next/server';
import { listTeams, createTeam, createTeamAgent, createTeamTask, createTeamPhase, createTeamDecision, type CreateTeamInput, type ChatContext } from '../../../lib/teams/schema';
import { ensureChatSession, ensureTeamMetaSession, ensureAgentSession } from '../../../lib/mem/api';
import { createWorktree, defaultWorktreePath, slug } from '../../../lib/teams/worktree';
import { modelFromTier } from '../../../lib/teams/roles';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';

// GET /api/teams — list teams
export async function GET(request: NextRequest) {
  try {
    const status = request.nextUrl.searchParams.get('status') as any;
    const includeArchived = request.nextUrl.searchParams.get('includeArchived') === 'true';
    const teams = listTeams({ status, includeArchived });
    return NextResponse.json({ teams });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST /api/teams — create a new constellation
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      name,
      preset: presetId,
      goal,
      project_id,
      main_branch = 'main',
      parent_chat_key,
      budget_usd,
      roles: customRoles,
      tasks: initialTasks,
      settings,
      chat_context,
    } = body;

    if (!project_id) {
      return NextResponse.json({ error: 'project_id (workspace path) is required' }, { status: 400 });
    }

    // Resolve roles + phases from preset or custom
    let roles: Array<{ role: string; handle: string; model: string }> = customRoles || [];
    let presetPhases: Array<{ name: string; roles: string[]; description?: string }> = [];
    if (presetId) {
      const presetsPath = join(process.cwd(), 'data', 'team-presets.json');
      if (existsSync(presetsPath)) {
        const presets = JSON.parse(readFileSync(presetsPath, 'utf-8'));
        const preset = presets.find((p: any) => p.id === presetId);
        if (preset) {
          if (roles.length === 0) roles = preset.roles;
          if (Array.isArray(preset.phases)) presetPhases = preset.phases;
          // Merge preset defaults with user-provided settings (user wins on conflict)
          if (preset.default_settings) {
            body.settings = { ...preset.default_settings, ...(settings || {}) };
          }
        }
      }
    }

    if (roles.length === 0) {
      return NextResponse.json({ error: 'No roles specified and no valid preset found' }, { status: 400 });
    }

    const teamName = name || `${presetId || 'custom'}-${Date.now().toString(36)}`;
    const teamSlug = slug(teamName);

    const teamInput: CreateTeamInput = {
      name: teamName,
      constellation: teamName,
      project_id,
      main_branch,
      parent_chat_key: parent_chat_key || null,
      preset: presetId,
      goal,
      budget_usd: budget_usd ?? null,
      settings: body.settings || settings,
      chat_context: chat_context as ChatContext | undefined,
    };

    const team = createTeam(teamInput);

    // Link memory graph: chat → team_meta → (agent sessions, created per-agent below).
    // This is what makes Chat N's observations flow into the constellation and
    // vice versa. Non-fatal if memory subsystem is unavailable.
    try {
      const chatSessionId = parent_chat_key ? ensureChatSession(parent_chat_key).id : undefined;
      ensureTeamMetaSession(team.id, team.constellation || team.name, chatSessionId);
    } catch (e: any) {
      console.warn('[mem] team memory link failed:', e?.message);
    }

    // Persist preset phases (if any) so PhaseBar has data
    for (let i = 0; i < presetPhases.length; i++) {
      const ph = presetPhases[i];
      createTeamPhase({
        team_id: team.id,
        name: ph.name,
        description: ph.description,
        ordering: i,
        roles: Array.isArray(ph.roles) ? ph.roles : [],
      });
    }

    // Log team composition decision
    createTeamDecision({
      team_id: team.id,
      decision_type: 'team_composition',
      summary: `Deployed ${presetId || 'custom'} constellation with ${roles.length} agent${roles.length === 1 ? '' : 's'}${presetPhases.length > 0 ? ` across ${presetPhases.length} phase${presetPhases.length === 1 ? '' : 's'}` : ''}.`,
      details: {
        preset: presetId || null,
        roles: roles.map(r => ({ role: r.role, handle: r.handle, model: r.model })),
        phases: presetPhases.map(p => ({ name: p.name, roles: p.roles })),
      },
    });

    // Create agents + worktrees
    const agents = [];
    for (const r of roles) {
      const handle = r.handle || `${r.role}-1`;
      const worktreePath = defaultWorktreePath(project_id, teamSlug, handle);
      const branchName = `mc/${teamSlug}/${handle}`;
      const model = modelFromTier(r.model as any, r.role as any);

      try {
        await createWorktree({
          repoRoot: project_id,
          branchName,
          worktreePath,
          baseBranch: main_branch,
          forceClean: true,
        });
      } catch (err: any) {
        console.warn(`[Teams] Worktree creation failed for ${handle}:`, err.message);
      }

      const agent = createTeamAgent({
        team_id: team.id,
        role: r.role as any,
        role_handle: handle,
        model,
        worktree_path: worktreePath,
        branch_name: branchName,
      });
      agents.push(agent);

      // Pre-create the per-agent mem session so it shows up in /api/mem/sessions
      // immediately and is parented to this team_meta (which itself is parented
      // to the linked chat). The runner will also call ensureAgentSession when
      // it spawns, but doing it here makes the linkage visible before spawn.
      try {
        ensureAgentSession({ teamId: team.id, agentId: agent.id, role: r.role });
      } catch (e: any) {
        console.warn('[mem] agent session create failed:', e?.message);
      }
    }

    // Create initial tasks if provided
    const tasks = [];
    if (initialTasks && Array.isArray(initialTasks)) {
      for (const t of initialTasks) {
        const task = createTeamTask({
          team_id: team.id,
          title: t.title,
          description: t.description,
          priority: t.priority,
          role_hint: t.role_hint,
          depends_on: t.depends_on,
        });
        tasks.push(task);
      }
    }

    return NextResponse.json({
      team,
      agents,
      tasks,
    }, { status: 201 });
  } catch (error: any) {
    console.error('[Teams] Create error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
