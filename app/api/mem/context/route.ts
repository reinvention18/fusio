import { NextRequest } from 'next/server';
import { injectContext, ensureChatSession } from '../../../../lib/mem/api';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('session_id');
  const chatId = req.nextUrl.searchParams.get('chat_id');
  const query = req.nextUrl.searchParams.get('q') ?? '';
  const max = Number(req.nextUrl.searchParams.get('max') ?? 8);

  let resolved = sessionId;
  if (!resolved && chatId) {
    resolved = ensureChatSession(chatId).id;
  }
  if (!resolved) return Response.json({ error: 'session_id or chat_id required' }, { status: 400 });

  const r = await injectContext({ sessionId: resolved, query, maxObservations: max });
  return Response.json(r);
}
