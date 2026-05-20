import { NextRequest } from 'next/server';
import { retrieve } from '../../../../lib/memory-retrieve';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { chatId, query, attachedChatIds, k, budgetTokens, ceilingTokens } = body ?? {};
    if (!chatId || !query) return Response.json({ error: 'chatId and query required' }, { status: 400 });
    const result = retrieve(chatId, query, { attachedChatIds, k, budgetTokens, ceilingTokens });
    return Response.json(result);
  } catch (e: any) {
    return Response.json({ error: e?.message ?? 'unknown error' }, { status: 500 });
  }
}
