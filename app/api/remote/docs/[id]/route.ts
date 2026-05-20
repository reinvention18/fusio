/**
 * /api/remote/docs/[id] — server-side proxy: fetch one doc from a peer.
 * Mirror of /api/remote/docs but for individual reads.
 *
 * GET /api/remote/docs/<id>?host=<peerId>  → { doc }
 */

import { NextRequest, NextResponse } from 'next/server';
import { findHost } from '../../../../../lib/remote/config';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const host = request.nextUrl.searchParams.get('host');
  if (!host) return NextResponse.json({ error: 'host param required' }, { status: 400 });
  const peer = findHost(host);
  if (!peer) return NextResponse.json({ error: `unknown peer host: ${host}` }, { status: 404 });

  const url = peer.url.replace(/\/+$/, '') + '/api/docs/' + encodeURIComponent(id);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${peer.token}` },
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json({ error: `peer returned ${res.status}` }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'peer unreachable' }, { status: 502 });
  }
}
