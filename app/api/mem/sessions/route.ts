import { NextRequest } from 'next/server';
import {
  listSessions,
  ensureChatSession,
  ensureTeamMetaSession,
  ensureAgentSession,
  getMemSession,
} from '../../../../lib/mem/api';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get('kind') ?? undefined;
  const limit = Number(req.nextUrl.searchParams.get('limit') ?? 50);
  const rows = listSessions({ kind: kind as any, limit });
  return Response.json({ sessions: rows });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { kind, chat_id, team_id, agent_id, title, role } = body ?? {};
  try {
    let row;
    if (kind === 'chat' && chat_id) {
      row = ensureChatSession(chat_id, title);
    } else if (kind === 'team_meta' && team_id) {
      row = ensureTeamMetaSession(team_id, title);
    } else if (kind === 'team_agent' && team_id && agent_id) {
      row = ensureAgentSession({ teamId: team_id, agentId: agent_id, title, role });
    } else {
      return Response.json({ error: 'kind + ids required' }, { status: 400 });
    }
    return Response.json({ session: row });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
