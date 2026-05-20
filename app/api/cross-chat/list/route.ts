/**
 * GET /api/cross-chat/list?source=<source>
 *
 * Proxies a chat-index list from another mission-control instance / namespace
 * so Luke's Chat (and any other chat surface in mission-control-dev) can pull
 * context from chats that don't live in this process.
 *
 * Sources:
 *   linux-mc   → http://localhost:3001/api/chats         (prod MC, mc namespace — chat 41 lives here)
 *   linux-seo  → http://localhost:3001/api/seo-chats     (prod MC, seo namespace)
 *   pc-mc      → http://<pc-peer>:3001/api/chats     (PC peer over Tailscale)
 *   pc-seo     → http://<pc-peer>:3001/api/seo-chats (PC peer SEO)
 *   lukes      → http://localhost:3005/api/lukes-chats   (this instance — for completeness)
 *
 * Returns a normalized shape: { source, sessions: [{ id, name, messageCount,
 * preview, updatedAt }] }. Heavy fields like full message arrays are stripped
 * to keep the picker UI snappy. Use /api/cross-chat/messages to pull the
 * actual messages once a chat is selected.
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

export type CrossChatSource = keyof typeof SOURCES;

interface SessionSummary {
  id: string;
  name?: string;
  message_count: number;
  preview?: string;
  updated_at?: string;
  workspace?: string;
}

// 30s in-process cache. The MC chat APIs return the FULL message arrays of
// every chat (the prod MC index is ~21 MB), so a single hit costs 3-6s on
// localhost and longer over Tailscale. Caching by source means the user can
// flip between sources in the picker without re-paying the cost each time.
const LIST_CACHE_MS = 30_000;
type CacheEntry = { ts: number; payload: { source: string; sessions: SessionSummary[] } };
const listCache = new Map<string, CacheEntry>();

export async function GET(req: NextRequest) {
  const source = (req.nextUrl.searchParams.get('source') || '') as CrossChatSource;
  const force = req.nextUrl.searchParams.get('refresh') === '1';
  const url = SOURCES[source];
  if (!url) {
    return Response.json({ error: 'unknown_source', valid: Object.keys(SOURCES) }, { status: 400 });
  }

  const cached = listCache.get(source);
  if (!force && cached && Date.now() - cached.ts < LIST_CACHE_MS) {
    return Response.json({ ...cached.payload, cached: true });
  }

  // 25s timeout: the upstream MC indexes can return ~20 MB of JSON; localhost
  // takes ~5s, Tailscale (PC peer) can take 15s+. The picker UI shows a
  // "Loading…" spinner, so a longer timeout is far better than a false
  // "unreachable" error — which was the chat 41 case.
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(new Error('timeout')), 25_000);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) {
      return Response.json({ source, error: `upstream_http_${r.status}` }, { status: 502 });
    }
    const data = await r.json() as { sessions?: any[] };
    const sessions = Array.isArray(data?.sessions) ? data.sessions.map(normalize) : [];
    const payload = { source, sessions };
    listCache.set(source, { ts: Date.now(), payload });
    return Response.json(payload);
  } catch (err: any) {
    // Don't poison the cache on failure — let the next request retry fresh.
    return Response.json({
      source,
      error: 'upstream_unreachable',
      hint: String(err?.message || err).slice(0, 200),
    }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

function normalize(s: any): SessionSummary {
  const messages = Array.isArray(s?.messages) ? s.messages : [];
  return {
    id: String(s?.id || ''),
    name: typeof s?.name === 'string' ? s.name : undefined,
    message_count: typeof s?._messageCount === 'number' ? s._messageCount : messages.length,
    preview: typeof s?._lastMessagePreview === 'string'
      ? s._lastMessagePreview
      : (messages[messages.length - 1]?.content
        ? String(messages[messages.length - 1].content).slice(0, 120)
        : undefined),
    updated_at: typeof s?.updatedAt === 'string' ? s.updatedAt : undefined,
    workspace: typeof s?.workspace === 'string' ? s.workspace : undefined,
  };
}
