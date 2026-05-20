import { NextRequest, NextResponse } from 'next/server';
import { getTeam } from '../../../../../lib/teams/schema';
import { getLatestFinalAudit, runAndStoreFinalAudit } from '../../../../../lib/teams/final-audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

// GET — return the latest Codex mission audit for this team (or 404 if none yet).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  if (!getTeam(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const audit = getLatestFinalAudit(teamId);
  if (!audit) return NextResponse.json({ audit: null });
  return NextResponse.json({ audit });
}

// POST — (re)run the audit now. Blocking — takes ~1-3 min while Codex is running.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  if (!getTeam(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  try {
    const audit = await runAndStoreFinalAudit(teamId);
    if (!audit) return NextResponse.json({ error: 'Team has no goal to audit against' }, { status: 400 });
    return NextResponse.json({ audit });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Audit failed' }, { status: 500 });
  }
}
