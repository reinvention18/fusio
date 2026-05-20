import { NextRequest, NextResponse } from 'next/server';
import {
  loadIndex,
  loadChat,
  loadAllChats,
  saveChat,
  saveAllChats,
  deleteChat,
  getVersion,
  type ChatSession,
} from '../../../lib/chat-storage';

// GET — retrieve chats.
//   ?check=version        → { version }
//   ?sessionId=<id>       → { session }
//   ?lite=true            → { sessions: LiteSession[], lite: true }
//   (no params)           → { sessions: ChatSession[] }
export async function GET(request: NextRequest) {
  try {
    const check = request.nextUrl.searchParams.get('check');
    if (check === 'version') {
      return NextResponse.json({ version: getVersion() }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const sessionId = request.nextUrl.searchParams.get('sessionId');
    if (sessionId) {
      const session = loadChat(sessionId);
      if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });
      return NextResponse.json({ session }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const lite = request.nextUrl.searchParams.get('lite');
    if (lite === 'true') {
      const index = loadIndex();
      // Preserve the existing shape: include an empty `messages: []` stub so the
      // client's hydration path keeps working without a code change.
      const liteSessions = index.map(s => ({ ...s, messages: [] as any[] }));
      return NextResponse.json({ sessions: liteSessions, lite: true }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    // Full read — rarely needed now that the UI uses lite + on-demand hydration,
    // but we keep it for /api/chats consumers that still expect the full shape.
    return NextResponse.json({ sessions: loadAllChats() }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST — actions: save-all, save-one, create-session, delete.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'save-all') {
      const sessions: ChatSession[] = body.sessions || [];
      const result = saveAllChats(sessions);
      if (!result.saved) {
        return NextResponse.json(
          { success: false, error: result.reason },
          { status: 409 }
        );
      }
      return NextResponse.json({ success: true, ...(result.blockedDrops ? { protected: result.blockedDrops } : {}) });
    }

    if (action === 'save-one') {
      const session: ChatSession = body.session;
      if (!session?.id) return NextResponse.json({ error: 'session.id required' }, { status: 400 });
      const result = saveChat(session);
      return NextResponse.json({ success: true, ...(result.blockedDrops ? { protected: result.blockedDrops } : {}) });
    }

    if (action === 'create-session') {
      const session: ChatSession = body.session;
      if (!session?.id) return NextResponse.json({ error: 'session.id required' }, { status: 400 });
      saveChat(session, { force: true });
      return NextResponse.json({ success: true, sessionId: session.id });
    }

    if (action === 'delete') {
      const sessionId: string | undefined = body.sessionId;
      if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
      deleteChat(sessionId);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
