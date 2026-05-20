import { NextRequest } from 'next/server';
import { disableChat, enableChat } from '../../../../lib/memory-retrieve';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { chatId, action = 'disable' } = body ?? {};
    if (!chatId) return Response.json({ error: 'chatId required' }, { status: 400 });
    if (action === 'enable') enableChat(chatId);
    else disableChat(chatId);
    return Response.json({ chatId, action });
  } catch (e: any) {
    return Response.json({ error: e?.message ?? 'unknown error' }, { status: 500 });
  }
}
