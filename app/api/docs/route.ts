/**
 * /api/docs — list + create.
 *
 * GET: public-on-localhost; if request comes with Bearer mc-remote-hosts.json
 *   token, peer access is allowed (this is how mc_docs_list({host:...})
 *   reaches across the bridge).
 *
 * POST: create or upsert. Same auth model.
 */

import { NextRequest, NextResponse } from 'next/server';
import { listDocs, writeDoc, type DocType } from '../../../lib/docs/service';
import { isInboundAuthorized, loadRemoteConfig } from '../../../lib/remote/config';

export const dynamic = 'force-dynamic';

function isAllowed(request: NextRequest): boolean {
  // Same-origin (localhost) is implicitly trusted — UI in MC.
  // Cross-machine peer access requires the bearer token.
  const auth = request.headers.get('authorization');
  if (auth) return isInboundAuthorized(auth);
  // No auth header — only allow if the request is from this machine.
  // We can't reliably tell from headers, so we permit; the inbound port
  // is bound to localhost-or-Tailscale anyway.
  return true;
}

export async function GET(request: NextRequest) {
  if (!isAllowed(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const url = request.nextUrl;
  const type = url.searchParams.get('type');
  const limit = parseInt(url.searchParams.get('limit') || '0', 10) || undefined;
  const docs = listDocs({
    type: type === 'note' || type === 'plan' ? (type as DocType) : undefined,
    limit,
  });
  return NextResponse.json({ docs, host: loadRemoteConfig()?.myLabel || 'local' });
}

export async function POST(request: NextRequest) {
  if (!isAllowed(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'bad JSON' }, { status: 400 }); }
  const type = body.type === 'plan' ? 'plan' : body.type === 'note' ? 'note' : null;
  if (!type) return NextResponse.json({ error: 'type required (note|plan)' }, { status: 400 });
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content : '';
  if (!title) return NextResponse.json({ error: 'title required' }, { status: 400 });
  const cfg = loadRemoteConfig();
  const doc = writeDoc({
    type,
    title,
    content,
    id: typeof body.id === 'string' ? body.id : undefined,
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 10).map(String) : undefined,
    chatOrigin: typeof body.chatOrigin === 'string' ? body.chatOrigin : undefined,
    authorHost: typeof body.authorHost === 'string' ? body.authorHost : (cfg?.myLabel || 'local'),
  });
  return NextResponse.json({ doc });
}
