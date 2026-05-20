/**
 * /api/notepad?id=<padId> — shared notepad load/save.
 *
 *   GET  → { content, version, updatedAt, updatedBy }
 *   POST { content, baseVersion, clientId }
 *        → { ok, version, conflicted: bool }   (conflicted=true means
 *          someone else saved while you were typing; we still accept LWW
 *          but the client can show a quick toast.)
 *
 * When this MC instance is a PROXY (see lib/notepad-peer.ts) it forwards
 * the entire request to the canonical host (Linux). When it is the
 * canonical host, it reads/writes data/notepads/<id>.json locally and
 * broadcasts via in-process SSE.
 */

import { NextRequest } from 'next/server';
import { loadPad, savePad } from '../../../lib/notepad-storage';
import { broadcast } from '../../../lib/notepad-broadcast';
import { getNotepadPeerUrl } from '../../../lib/notepad-peer';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const id = (request.nextUrl.searchParams.get('id') || 'default').trim();

  // Proxy mode (e.g. PC MC → Linux MC). Forward and stream the response
  // straight back. Cache-control header is preserved by the upstream.
  const peer = getNotepadPeerUrl();
  if (peer) {
    try {
      const r = await fetch(`${peer}/api/notepad?id=${encodeURIComponent(id)}`, {
        method: 'GET',
        signal: request.signal,
      });
      return new Response(await r.text(), {
        status: r.status,
        headers: {
          'Content-Type': r.headers.get('Content-Type') || 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: 'peer_unreachable',
        peer,
        message: String(e?.message || e),
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  }

  const doc = loadPad(id);
  return new Response(JSON.stringify(doc), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

interface SaveBody {
  content?: string;
  baseVersion?: number;
  clientId?: string;
}

export async function POST(request: NextRequest) {
  const id = (request.nextUrl.searchParams.get('id') || 'default').trim();
  const raw = await request.text();

  const peer = getNotepadPeerUrl();
  if (peer) {
    try {
      const r = await fetch(`${peer}/api/notepad?id=${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
        signal: request.signal,
      });
      return new Response(await r.text(), {
        status: r.status,
        headers: {
          'Content-Type': r.headers.get('Content-Type') || 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: 'peer_unreachable',
        peer,
        message: String(e?.message || e),
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  }

  let body: SaveBody;
  try { body = JSON.parse(raw); }
  catch { return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

  const content = typeof body.content === 'string' ? body.content : '';
  // Cap pad size — protect against accidental megabyte pastes that would
  // make the whole-content broadcast slow. ~256 KB is more than anyone
  // needs in a quick shared scratchpad.
  if (content.length > 256_000) {
    return new Response(JSON.stringify({ error: 'too_large', max: 256_000 }), {
      status: 413, headers: { 'Content-Type': 'application/json' },
    });
  }
  const baseVersion = typeof body.baseVersion === 'number' ? body.baseVersion : 0;
  const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 60) : undefined;

  const prev = loadPad(id);
  const conflicted = baseVersion !== prev.version;

  // Last-write-wins: still accept even on conflict.
  const next = savePad(id, content, clientId);

  // Broadcast to everyone EXCEPT the originator.
  broadcast(id, {
    type: 'update',
    content: next.content,
    version: next.version,
    updatedAt: next.updatedAt,
    updatedBy: next.updatedBy,
  }, clientId);

  return new Response(JSON.stringify({
    ok: true,
    version: next.version,
    updatedAt: next.updatedAt,
    conflicted,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
