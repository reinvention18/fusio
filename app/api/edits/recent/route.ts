/**
 * /api/edits/recent — list recent file edits captured by edit-log.
 *
 * GET ?since=<ms>&file=<path>&limit=<n>  → { edits: EditLogEntry[] }
 *
 * Cross-machine: same auth model as /api/docs — bearer token required for
 * peer requests, local UI calls allowed without auth.
 */

import { NextRequest, NextResponse } from 'next/server';
import { listRecentEdits } from '../../../../lib/edit-log';
import { isInboundAuthorized, loadRemoteConfig } from '../../../../lib/remote/config';

export const dynamic = 'force-dynamic';

function isAllowed(req: NextRequest): boolean {
  const auth = req.headers.get('authorization');
  if (auth) return isInboundAuthorized(auth);
  return true;
}

export async function GET(request: NextRequest) {
  if (!isAllowed(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const url = request.nextUrl;
  const since = parseInt(url.searchParams.get('since') || '0', 10) || undefined;
  const file = url.searchParams.get('file') || undefined;
  const limit = parseInt(url.searchParams.get('limit') || '50', 10) || 50;
  const edits = listRecentEdits({ since, file, limit });
  return NextResponse.json({
    edits,
    host: loadRemoteConfig()?.myLabel || 'local',
  });
}
