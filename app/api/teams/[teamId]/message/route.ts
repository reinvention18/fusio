import { NextRequest, NextResponse } from 'next/server';
import { getTeam, getTeamAgentBySessionKey, enqueueMessage } from '../../../../../lib/teams/schema';
import { getRunnerForAgent } from '../../../../../lib/teams/runner';

export const dynamic = 'force-dynamic';

// POST /api/teams/:id/message — send a direct message to a specific agent
export async function POST(request: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  if (!getTeam(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });

  const { to_agent_id, body, priority } = await request.json();
  if (!to_agent_id || !body) {
    return NextResponse.json({ error: 'to_agent_id and body required' }, { status: 400 });
  }

  const msg = enqueueMessage({
    team_id: teamId,
    from_agent_id: null,
    to_agent_id,
    type: 'direct',
    priority: priority || 'next',
    body,
  });

  // Also inject into the runner's input queue if the agent is running
  const handle = getRunnerForAgent(to_agent_id);
  if (handle) {
    handle.send(`[@commander] ${body}`, { priority: priority || 'next' });
  }

  return NextResponse.json({ message: msg });
}
