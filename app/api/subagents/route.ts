/**
 * /api/subagents — list Task subagents launched from the current chat session.
 *
 * Data source: `data/mc-subagents.json`, written by `lib/claude-chat-bridge.ts`
 * as it observes Task tool_use / tool_result events in the stream-json output
 * of spawned `claude -p` processes.
 *
 * (Previous versions of this route read from ~/.openclaw/subagents/runs.json
 * and ~/.claude/sessions/. Both are dead sources now — OpenClaw is deprecated
 * and the spawned CLI doesn't create per-subagent session files.)
 */

import { NextRequest, NextResponse } from 'next/server';
import { listRuns, gc, McSubagentRun } from '../../../lib/mc-subagents-store';

export const dynamic = 'force-dynamic';

function serialize(run: McSubagentRun) {
  return {
    key: run.toolUseId,
    runId: run.toolUseId,
    label: run.label || run.subagentType || 'Subagent',
    status: run.status,
    subagentType: run.subagentType,
    task: (run.task || '').slice(0, 500),
    requester: run.sessionKey,
    startedAt: new Date(run.startedAt).toISOString(),
    endedAt: run.endedAt ? new Date(run.endedAt).toISOString() : null,
    durationMs: run.endedAt ? run.endedAt - run.startedAt : null,
    model: 'default',
    resultPreview: run.resultFull ? run.resultFull.slice(0, 300) : '',
    resultFull: run.resultFull || '',
    error: run.error || null,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    gc(); // opportunistic cleanup of stale records

    const sessionFilter: string | null = body.sessionKey || null;
    const runs = listRuns(sessionFilter || undefined);
    const subAgents = runs.map(serialize);

    return NextResponse.json({
      subAgents,
      source: 'mc-local',
      total: subAgents.length,
      running: subAgents.filter(s => s.status === 'running').length,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to fetch sub-agents' },
      { status: 500 }
    );
  }
}

export async function GET() {
  gc();
  const runs = listRuns();
  return NextResponse.json({
    total: runs.length,
    running: runs.filter(r => r.status === 'running').length,
    source: 'mc-local',
    subAgents: runs.map(serialize),
  });
}
