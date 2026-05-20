import { NextRequest } from 'next/server';
import { readNote, writeNote, deleteNote, isConfigured } from '../../../../lib/vault/service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!isConfigured()) return Response.json({ error: 'vault not configured' }, { status: 400 });
  const p = req.nextUrl.searchParams.get('path');
  if (!p) return Response.json({ error: 'path required' }, { status: 400 });
  try { return Response.json({ note: readNote(p) }); } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}

export async function PUT(req: NextRequest) {
  if (!isConfigured()) return Response.json({ error: 'vault not configured' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const { path, content, frontmatter } = body ?? {};
  if (!path || !content) return Response.json({ error: 'path and content required' }, { status: 400 });
  try {
    const note = writeNote({ path, content, frontmatter, overwrite: true });
    return Response.json({ note });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!isConfigured()) return Response.json({ error: 'vault not configured' }, { status: 400 });
  const p = req.nextUrl.searchParams.get('path');
  if (!p) return Response.json({ error: 'path required' }, { status: 400 });
  try { deleteNote(p); return Response.json({ ok: true }); } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
