import { NextRequest, NextResponse } from 'next/server';
import { listTeamTasks, createTeamTask, getTeam } from '../../../../../lib/teams/schema';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  if (!getTeam(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const status = request.nextUrl.searchParams.get('status') as any;
  const tasks = listTeamTasks(teamId, status ? { status } : undefined);
  return NextResponse.json({ tasks });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  if (!getTeam(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const body = await request.json();
  const task = createTeamTask({ team_id: teamId, ...body });
  return NextResponse.json({ task }, { status: 201 });
}
