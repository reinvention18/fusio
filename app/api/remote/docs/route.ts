/**
 * /api/remote/docs — server-side proxy: fetch a peer's doc list.
 * UI uses this to avoid mixed-content/CORS when the peer is on http but this MC is on https.
 *
 * GET /api/remote/docs?host=<peerId>&type=plan&limit=50  → { docs: DocSummary[] }
 * GET /api/remote/docs/<id>?host=<peerId>                → { doc: Doc }    (handled in [id]/route.ts)
 */

import { NextRequest, NextResponse } from 'next/server';
import { findHost } from '../../../../lib/remote/config';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const host = request.nextUrl.searchParams.get('host');
  if (!host) return NextResponse.json({ error: 'host param required' }, { status: 400 });
  const peer = findHost(host);
  if (!peer) return NextResponse.json({ error: `unknown peer host: ${host}` }, { status: 404 });

  const params = new URLSearchParams();
  const type = request.nextUrl.searchParams.get('type');
  const limit = request.nextUrl.searchParams.get('limit');
  if (type) params.set('type', type);
  if (limit) params.set('limit', limit);

  const url = peer.url.replace(/\/+$/, '') + '/api/docs?' + params.toString();
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${peer.token}` },
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json({ error: `peer returned ${res.status}` }, { status: 502 });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'peer unreachable' }, { status: 502 });
  }
}
