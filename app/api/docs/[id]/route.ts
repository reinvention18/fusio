/**
 * /api/docs/[id] — read, update, delete.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readDoc, writeDoc, deleteDoc } from '../../../../lib/docs/service';
import { isInboundAuthorized, loadRemoteConfig } from '../../../../lib/remote/config';

export const dynamic = 'force-dynamic';

function isAllowed(request: NextRequest): boolean {
  const auth = request.headers.get('authorization');
  if (auth) return isInboundAuthorized(auth);
  return true; // local UI
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isAllowed(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const doc = readDoc(id);
  if (!doc) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ doc });
}

export async function PUT(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isAllowed(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'bad JSON' }, { status: 400 }); }
  const existing = readDoc(id);
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const cfg = loadRemoteConfig();
  const doc = writeDoc({
    id,
    type: (body.type === 'plan' || body.type === 'note') ? body.type : existing.type,
    title: typeof body.title === 'string' ? body.title : existing.title,
    content: typeof body.content === 'string' ? body.content : existing.content,
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 10).map(String) : existing.tags,
    chatOrigin: typeof body.chatOrigin === 'string' ? body.chatOrigin : existing.chatOrigin,
    authorHost: existing.authorHost || cfg?.myLabel || 'local',
  });
  return NextResponse.json({ doc });
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isAllowed(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const ok = deleteDoc(id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
