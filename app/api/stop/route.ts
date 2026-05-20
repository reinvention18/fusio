/**
 * /api/stop — Abort a running Claude Code CLI process.
 *
 * Replaces the old WebSocket-based gateway abort with a simple process kill.
 * The ChatPanel calls this when the user clicks the stop button.
 */

import { NextRequest } from 'next/server';
import { activeProcesses } from '../../../lib/claude-chat-bridge';
import { isTeamSessionKey } from '../../../lib/claude-sdk-session';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionKey } = body;

    if (!sessionKey) {
      return new Response(JSON.stringify({ error: 'sessionKey required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Constellation team sessions are owned by the team runner and must be
    // halted via /api/teams/:id/halt — never by this chat-scoped stop endpoint.
    // (Resolves hidden coupling #5: prevents accidentally killing a Commander.)
    if (isTeamSessionKey(sessionKey)) {
      return new Response(
        JSON.stringify({ error: 'Team sessions must be halted via /api/teams/:id/halt' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const proc = activeProcesses.get(sessionKey);
    if (!proc) {
      // No running process — that's fine, maybe it already finished
      return new Response(JSON.stringify({ success: true, note: 'no active process' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Send SIGTERM first for graceful shutdown
    try {
      proc.kill('SIGTERM');
    } catch (err: any) {
      console.warn('[Stop] SIGTERM failed:', err.message);
    }

    activeProcesses.delete(sessionKey);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
