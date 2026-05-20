import { NextRequest, NextResponse } from 'next/server';
import { getTeam } from '../../../../../lib/teams/schema';
import { getLatestFinalAudit, triggerAuditRemediation } from '../../../../../lib/teams/final-audit';

export const dynamic = 'force-dynamic';

/**
 * Force the auto-remediation flow to fire for the most recent Codex audit on
 * this team. Intended for operator use when an audit fired but remediation
 * didn't (e.g., team was pre-fix, or the trigger was skipped). Idempotent.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  if (!getTeam(teamId)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const audit = getLatestFinalAudit(teamId);
  if (!audit) return NextResponse.json({ error: 'No audit found for this team' }, { status: 400 });
  if (audit.verdict !== 'partial' && audit.verdict !== 'missed') {
    return NextResponse.json({ error: `Audit verdict is "${audit.verdict}" — no remediation needed` }, { status: 400 });
  }
  if (!audit.missing_work || audit.missing_work.length === 0) {
    return NextResponse.json({ error: 'Audit has no missing_work items' }, { status: 400 });
  }
  try {
    const result = await triggerAuditRemediation(teamId, audit);
    return NextResponse.json({ audit, result });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Remediation failed' }, { status: 500 });
  }
}
