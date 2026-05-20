import { NextRequest } from 'next/server';
import { generateSessionSummary } from '../../../../lib/mem/api';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session_id } = body ?? {};
  if (!session_id) return Response.json({ error: 'session_id required' }, { status: 400 });
  try {
    const r = await generateSessionSummary(session_id);
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
