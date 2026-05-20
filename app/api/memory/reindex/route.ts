import { NextRequest } from 'next/server';
import {
  indexChatIncremental,
  reindexChatFull,
  reembedChat,
} from '../../../../lib/memory-indexer';
import { summarizeAllEpisodes } from '../../../../lib/memory-episodes';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { chatId, mode = 'incremental' } = body ?? {};
    if (!chatId) return Response.json({ error: 'chatId required' }, { status: 400 });
    let result;
    if (mode === 'full') result = await reindexChatFull(chatId);
    else if (mode === 'incremental') result = await indexChatIncremental(chatId);
    else if (mode === 'embeddings') result = await reembedChat(chatId);
    else if (mode === 'episodes') result = await summarizeAllEpisodes(chatId);
    else return Response.json({ error: `unknown mode: ${mode}` }, { status: 400 });
    return Response.json(result);
  } catch (e: any) {
    return Response.json({ error: e?.message ?? 'unknown error' }, { status: 500 });
  }
}
