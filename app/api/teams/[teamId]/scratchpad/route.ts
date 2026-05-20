import { NextRequest, NextResponse } from 'next/server';
import { getScratchpad, updateScratchpad, getTeam } from '../../../../../lib/teams/schema';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  if (!getTeam(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  return NextResponse.json(getScratchpad(teamId));
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  if (!getTeam(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const { content, expected_version, updated_by } = await request.json();
  const newVersion = updateScratchpad(teamId, content, expected_version ?? 0, updated_by ?? 'user');
  if (newVersion === null) {
    return NextResponse.json({ error: 'Version conflict — re-read and retry' }, { status: 409 });
  }
  return NextResponse.json({ version: newVersion });
}
