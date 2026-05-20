import { NextRequest, NextResponse } from 'next/server';
import { haltTeam } from '../../../../../lib/teams/runner';
import { getTeam } from '../../../../../lib/teams/schema';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  const team = getTeam(teamId);
  if (!team) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  try {
    await haltTeam(teamId, body.reason);
    return NextResponse.json({ halted: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
