import { NextRequest, NextResponse } from 'next/server';
import { getTeam, listTeamMessages } from '../../../../../lib/teams/schema';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  if (!getTeam(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const limit = Number(request.nextUrl.searchParams.get('limit') ?? '500');
  const messages = listTeamMessages(teamId, Math.min(Math.max(1, limit), 1000));
  return NextResponse.json({ messages });
}
