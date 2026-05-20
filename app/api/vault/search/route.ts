import { NextRequest } from 'next/server';
import { searchVault, isConfigured } from '../../../../lib/vault/service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!isConfigured()) return Response.json({ error: 'vault not configured', hits: [] }, { status: 200 });
  const q = req.nextUrl.searchParams.get('q') ?? '';
  const limit = Number(req.nextUrl.searchParams.get('limit') ?? 20);
  if (!q || q.length < 2) return Response.json({ error: 'q required (min 2 chars)' }, { status: 400 });
  const hits = searchVault(q, { limit });
  return Response.json({ hits });
}
