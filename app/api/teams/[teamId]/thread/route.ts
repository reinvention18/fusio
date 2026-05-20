import { NextRequest, NextResponse } from 'next/server';
import { getTeam, listCommanderThread } from '../../../../../lib/teams/schema';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  if (!getTeam(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  return NextResponse.json({ thread: listCommanderThread(teamId) });
}
