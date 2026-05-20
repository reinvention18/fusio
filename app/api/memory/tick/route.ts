import type { NextRequest } from 'next/server';
import { pumpAllChats } from '../../../../lib/memory-indexer';
import { addDownRank } from '../../../../lib/memory-down-ranks';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

export async function POST(request: NextRequest) {
  try {
    // Lightweight signal pipe: the client posts { kind: 'down_rank', ... }
    // when the user thumbs-down an assistant message. Other kinds fall
    // through to the default background-pump behaviour.
    let body: any = null;
    try { body = await request.json(); } catch { /* empty body = pump call */ }
    if (body && body.kind === 'down_rank' && typeof body.sessionKey === 'string' && typeof body.hint === 'string') {
      addDownRank(body.sessionKey, body.hint);
      return Response.json({ ok: true, kind: 'down_rank' });
    }

    const result = await pumpAllChats();
    return Response.json(result);
  } catch (e: any) {
    return Response.json({ error: e?.message ?? 'unknown error' }, { status: 500 });
  }
}
