import { NextRequest } from 'next/server';
import { search } from '../../../../lib/mem/api';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? '';
  const sessionId = req.nextUrl.searchParams.get('session_id') ?? undefined;
  const type = req.nextUrl.searchParams.get('type') ?? undefined;
  const limit = Number(req.nextUrl.searchParams.get('limit') ?? 10);
  if (!q || q.length < 2) {
    return Response.json({ error: 'q required (min 2 chars)' }, { status: 400 });
  }
  const hits = await search({ query: q, sessionId, type: type as any, limit });
  return Response.json({ hits });
}
