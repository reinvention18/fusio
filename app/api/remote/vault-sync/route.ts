/**
 * /api/remote/vault-sync — proxy: trigger a git pull on a peer's MC.
 *
 * The DOCS panel "Sync Now" button calls this for each configured peer so a
 * single click forces the whole tailnet to fast-forward to origin/HEAD.
 */

import { NextRequest, NextResponse } from 'next/server';
import { findHost } from '../../../../lib/remote/config';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const host = request.nextUrl.searchParams.get('host');
  if (!host) return NextResponse.json({ error: 'host param required' }, { status: 400 });
  const peer = findHost(host);
  if (!peer) return NextResponse.json({ error: `unknown peer host: ${host}` }, { status: 404 });

  const url = peer.url.replace(/\/+$/, '') + '/api/vault/sync';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${peer.token}` },
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.ok ? 200 : 502 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message || 'peer unreachable' }, { status: 502 });
  }
}
