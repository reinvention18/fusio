import { NextRequest } from 'next/server';
import { timeline } from '../../../../lib/mem/api';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const observationId = req.nextUrl.searchParams.get('observation_id');
  const sessionId = req.nextUrl.searchParams.get('session_id');
  const limit = Number(req.nextUrl.searchParams.get('limit') ?? 20);
  const entries = timeline({
    observationId: observationId ? Number(observationId) : undefined,
    sessionId: sessionId ?? undefined,
    limit,
  });
  return Response.json({ entries });
}
