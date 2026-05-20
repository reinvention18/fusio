/**
 * /api/session-reset — Delete a CLI session mapping so the next message
 * starts a fresh Claude Code session.
 */

import { NextRequest, NextResponse } from 'next/server';
import { deleteClaudeSessionId } from '../../../lib/claude-chat-bridge';

export async function POST(request: NextRequest) {
  try {
    const { sessionKey } = await request.json();
    if (!sessionKey) {
      return NextResponse.json({ error: 'sessionKey required' }, { status: 400 });
    }
    deleteClaudeSessionId(sessionKey);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
