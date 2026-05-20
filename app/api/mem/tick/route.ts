import { NextRequest } from 'next/server';
import { tickAllActiveSessions } from '../../../../lib/mem/tick';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const max = Number(body?.max_sessions_per_tick ?? 10);
  const r = await tickAllActiveSessions({ maxSessionsPerTick: max });
  return Response.json(r);
}

export async function GET() {
  const r = await tickAllActiveSessions({ maxSessionsPerTick: 5 });
  return Response.json(r);
}
