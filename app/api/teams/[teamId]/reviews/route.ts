import { NextRequest, NextResponse } from 'next/server';
import { getTeam, listTeamReviews, listTeamFindings } from '../../../../../lib/teams/schema';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  if (!getTeam(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const reviewLimit = Math.min(Math.max(1, Number(request.nextUrl.searchParams.get('limit') ?? '100')), 500);
  const reviews = listTeamReviews(teamId, reviewLimit);
  const findings = listTeamFindings(teamId, reviewLimit * 3);
  return NextResponse.json({ reviews, findings });
}
