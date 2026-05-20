import { NextRequest } from 'next/server';
import { getStats } from '../../../../lib/memory-retrieve';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const chatId = req.nextUrl.searchParams.get('chatId');
    if (!chatId) return Response.json({ error: 'chatId required' }, { status: 400 });
    return Response.json(getStats(chatId));
  } catch (e: any) {
    return Response.json({ error: e?.message ?? 'unknown error' }, { status: 500 });
  }
}
