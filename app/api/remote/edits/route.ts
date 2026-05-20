/**
 * /api/remote/edits — server-side proxy: fetch a peer's recent edits.
 * UI uses this to merge local + peer edit logs without CORS pain.
 *
 * GET ?host=<peerId>&since=<ms>&file=<path>&limit=<n>  → { edits, host }
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
  for (const k of ['since', 'file', 'limit']) {
    const v = request.nextUrl.searchParams.get(k);
    if (v) params.set(k, v);
  }
  const url = peer.url.replace(/\/+$/, '') + '/api/edits/recent?' + params.toString();
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${peer.token}` },
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json({ error: `peer returned ${res.status}` }, { status: 502 });
    }
    return NextResponse.json(await res.json());
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'peer unreachable' }, { status: 502 });
  }
}
