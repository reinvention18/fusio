import { NextRequest, NextResponse } from 'next/server';
import {
  getTeam,
  listTeamAgents,
  enqueueMessage,
  appendEvent,
  createTeamDecision,
  updateTeamStatus,
} from '../../../../../lib/teams/schema';
import { getRunnerForAgent } from '../../../../../lib/teams/runner';

export const dynamic = 'force-dynamic';

/**
 * Commander → Architect message. Enqueues a direct message for the architect,
 * injects into the live runner queue if the architect is running, logs a
 * decision, and optionally resumes the team so the architect can act on it.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  try {
    const { teamId } = await params;
    const team = getTeam(teamId);
    if (!team) return NextResponse.json({ error: 'Team not found' }, { status: 404 });

    const raw = await request.json().catch(() => ({}));
    const text = String(raw?.body || '').trim();
    const resume = Boolean(raw?.resume);
    const kind = String(raw?.kind || 'message'); // 'message' | 'revision'
    if (!text) return NextResponse.json({ error: 'body is required' }, { status: 400 });

    const agents = listTeamAgents(teamId);
    const architect = agents.find(a => a.role === 'architect');
    if (!architect) {
      return NextResponse.json({ error: 'This team has no architect to message.' }, { status: 409 });
    }

    const message = enqueueMessage({
      team_id: teamId,
      from_agent_id: null,
      to_agent_id: architect.id,
      type: 'direct',
      priority: kind === 'revision' ? 'now' : 'next',
      body: text,
      metadata: { from: 'commander', kind },
    });

    // Deliver to the architect. If its runner isn't active, spawn one — the
    // message sits in the queue otherwise and the architect never sees it.
    try {
      let handle = getRunnerForAgent(architect.id);
      if (!handle) {
        // Flip any terminal agent-status back to idle so spawnSingleAgent doesn't skip.
        try {
          const { getDb } = await import('../../../../../lib/memory-db');
          getDb().prepare(
            "UPDATE team_agents SET status = 'idle' WHERE id = ? AND status IN ('done','crashed','error')"
          ).run(architect.id);
        } catch {}
        const { spawnSingleAgent } = await import('../../../../../lib/teams/runner');
        handle = (await spawnSingleAgent(architect.id)) || undefined as any;
      }
      if (handle && typeof handle.send === 'function') {
        const prefix = kind === 'revision' ? '[@commander REVISION] ' : '[@commander] ';
        handle.send(prefix + text, { priority: kind === 'revision' ? 'now' : 'next' });
      }
    } catch (e: any) {
      console.warn('[ask-architect] deliver failed:', e?.message);
    }

    appendEvent({
      team_id: teamId,
      agent_id: architect.id,
      kind: 'commander_message',
      severity: 'info',
      payload: { kind, preview: text.slice(0, 200) },
      chat_report: false,
    });

    createTeamDecision({
      team_id: teamId,
      decision_type: kind === 'revision' ? 'revision_requested' : 'commander_input',
      summary: text.slice(0, 180),
      details: { body: text, kind, architect_id: architect.id },
    });

    // Resume team if user asked for it and status is terminal/paused.
    let resumed = false;
    if (resume && ['paused', 'done', 'completed', 'error', 'cancelled'].includes(team.status)) {
      try {
        const runner = await import('../../../../../lib/teams/runner');
        updateTeamStatus(teamId, 'running');
        if (typeof runner.resumeTeam === 'function') {
          await runner.resumeTeam(teamId).catch(async () => {
            if (typeof runner.startTeam === 'function') await runner.startTeam(teamId);
          });
        } else if (typeof runner.startTeam === 'function') {
          await runner.startTeam(teamId);
        }
        resumed = true;
      } catch (err: any) {
        return NextResponse.json({ message, resumed: false, resumeError: err?.message || String(err) }, { status: 200 });
      }
    }

    return NextResponse.json({ message, resumed });
  } catch (err: any) {
    console.error('[ask-architect] error:', err);
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}
