/**
 * GET /api/cross-chat/messages?source=<source>&id=<chatId>&limit=<N>
 *
 * Pulls the last `limit` messages (default 8) from a chat in another MC
 * instance / namespace. Used by Luke's Chat's "Pull Chat Context" tool to
 * inject another chat's recent context as a prepared block.
 *
 * The list endpoint already returns full message arrays for each session,
 * so for non-PC sources we could in theory just slice from /list output.
 * We keep this as a separate endpoint so:
 *   • the list payload stays small for the picker
 *   • per-chat pull doesn't refetch every chat in the namespace
 *   • we can target a single id rather than scanning a whole index
 *
 * Returns: { source, id, name, messages: [{ role, content, ts }] }
 */

import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOURCES = {
  'linux-mc':  'http://localhost:3001/api/chats',
  'linux-seo': 'http://localhost:3001/api/seo-chats',
  'pc-mc':     'http://<pc-peer>:3001/api/chats',
  'pc-seo':    'http://<pc-peer>:3001/api/seo-chats',
  'lukes':     'http://localhost:3005/api/lukes-chats',
} as const;

export async function GET(req: NextRequest) {
  const source = req.nextUrl.searchParams.get('source') || '';
  const id = req.nextUrl.searchParams.get('id') || '';
  const limit = Math.min(50, Math.max(1, parseInt(req.nextUrl.searchParams.get('limit') || '8', 10) || 8));
  const url = (SOURCES as Record<string, string>)[source];
  if (!url) return Response.json({ error: 'unknown_source' }, { status: 400 });
  if (!id) return Response.json({ error: 'missing_id' }, { status: 400 });

  // The current MC chat APIs (/api/chats, /api/seo-chats, /api/lukes-chats)
  // return all sessions in one payload. We fetch the index and locate the
  // target by id. For a future per-id endpoint we'd switch to that.
  // 25s — same rationale as /list: the upstream returns ~20 MB JSON for
  // every-chat-with-every-message; a single fetch can take 5-15s.
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(new Error('timeout')), 25_000);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) return Response.json({ source, id, error: `upstream_http_${r.status}` }, { status: 502 });
    const data = await r.json() as { sessions?: any[] };
    const session = Array.isArray(data?.sessions) ? data.sessions.find((s: any) => s?.id === id) : null;
    if (!session) return Response.json({ source, id, error: 'chat_not_found' }, { status: 404 });
    const allMessages = Array.isArray(session.messages) ? session.messages : [];
    const tail = allMessages.slice(Math.max(0, allMessages.length - limit));
    const messages = tail.map((m: any) => ({
      role: typeof m?.role === 'string' ? m.role : 'user',
      content: typeof m?.content === 'string' ? m.content : '',
      ts: typeof m?.timestamp === 'string' ? m.timestamp : (typeof m?.createdAt === 'string' ? m.createdAt : undefined),
    })).filter((m: any) => m.content);
    return Response.json({
      source,
      id,
      name: typeof session?.name === 'string' ? session.name : undefined,
      total_messages: allMessages.length,
      returned: messages.length,
      messages,
    });
  } catch (err: any) {
    return Response.json({
      source, id,
      error: 'upstream_unreachable',
      hint: String(err?.message || err).slice(0, 200),
    }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
