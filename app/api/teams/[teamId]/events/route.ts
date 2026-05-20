import { NextRequest, NextResponse } from 'next/server';
import { listEvents, getTeam } from '../../../../../lib/teams/schema';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  if (!getTeam(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const limit = parseInt(request.nextUrl.searchParams.get('limit') || '200', 10);
  const kind = request.nextUrl.searchParams.get('kind') || undefined;
  const events = listEvents(teamId, limit, kind);
  return NextResponse.json({ events });
}
