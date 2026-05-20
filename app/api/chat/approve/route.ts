/**
 * /api/chat/approve — resolve a pending tool-approval gate.
 *
 * POST body: { id: string, allow: boolean, note?: string }
 * Returns: { ok: boolean }
 *
 * GET ?sessionKey=... — list pending approvals (debug / recovery).
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveApproval, listPendingForSession } from '../../../../lib/approval-gate';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const sessionKey = request.nextUrl.searchParams.get('sessionKey') || undefined;
  const pending = listPendingForSession(sessionKey).map(p => ({
    id: p.id,
    sessionKey: p.sessionKey,
    toolName: p.toolName,
    reason: p.reason,
    title: p.title,
    createdAt: p.createdAt,
    input: p.input,
  }));
  return NextResponse.json({ pending });
}

export async function POST(request: NextRequest) {
  try {
    const { id, allow, note } = await request.json();
    if (typeof id !== 'string' || typeof allow !== 'boolean') {
      return NextResponse.json({ error: 'id + allow required' }, { status: 400 });
    }
    const ok = resolveApproval(id, allow, typeof note === 'string' ? note : undefined);
    return NextResponse.json({ ok });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
