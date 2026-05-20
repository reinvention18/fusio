import { NextRequest } from 'next/server';
import { listNotes, writeNote, isConfigured } from '../../../../lib/vault/service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!isConfigured()) return Response.json({ error: 'vault not configured', notes: [] });
  const limit = Number(req.nextUrl.searchParams.get('limit') ?? 100);
  const prefix = req.nextUrl.searchParams.get('prefix') ?? undefined;
  return Response.json({ notes: listNotes({ limit, prefix: prefix ?? undefined }) });
}

export async function POST(req: NextRequest) {
  if (!isConfigured()) return Response.json({ error: 'vault not configured' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const { path, content, frontmatter, overwrite } = body ?? {};
  if (!path || !content) return Response.json({ error: 'path and content required' }, { status: 400 });
  try {
    const note = writeNote({ path, content, frontmatter, overwrite });
    return Response.json({ note });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
