/**
 * GET /api/remote-chat/result?requestId=X
 *
 * Returns the persisted state of a remote-chat turn — either in-progress
 * (with partial assistantText) or done (with final result or error). This
 * is the recovery surface for callers that disconnected mid-stream and
 * want to fetch the eventual result without re-triggering the peer turn.
 *
 * State written by /api/remote-chat (sibling route) every 3 seconds while
 * streaming, plus a terminal snapshot when the upstream completes or errors.
 *
 * Bearer auth identical to the main remote-chat route.
 *
 * 1 hour TTL — files older than that are treated as not-found and pruned
 * lazily as they're requested.
 */

import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { isInboundAuthorized } from '../../../../lib/remote/config';

export const dynamic = 'force-dynamic';

const PENDING_DIR = path.join(process.cwd(), 'data', 'pending', 'remote-chat');
const TTL_MS = 60 * 60 * 1000; // 1 hour

export async function GET(request: NextRequest) {
  if (!isInboundAuthorized(request.headers.get('authorization'))) {
    return jsonError(401, 'unauthorized');
  }
  const url = new URL(request.url);
  const requestId = url.searchParams.get('requestId');
  if (!requestId) return jsonError(400, 'requestId required');
  // Defense against path traversal — requestId must be alphanumerics/hyphens
  // only. The generator uses the shape `remote-req-<ts>-<rand>` so this is
  // enforced upstream too, but mirror the check at the boundary.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
    return jsonError(400, 'invalid requestId shape');
  }

  const file = path.join(PENDING_DIR, `${requestId}.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      return jsonError(404, 'no such requestId (may have been pruned or never existed)');
    }
    return jsonError(500, `read failed: ${e?.message ?? String(e)}`);
  }

  let state: any;
  try {
    state = JSON.parse(raw);
  } catch (e: any) {
    return jsonError(500, `corrupt pending file: ${e?.message ?? String(e)}`);
  }

  // TTL prune — if the snapshot is older than the cutoff, delete and return
  // 404. Keeps the pending dir from accumulating forever.
  const age = Date.now() - (state?.updatedAt ?? state?.startedAt ?? 0);
  if (age > TTL_MS) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    return jsonError(404, `requestId expired (${Math.round(age / 60_000)} min old)`);
  }

  return new Response(JSON.stringify(state), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
