import { NextRequest } from 'next/server';
import { getTeam, listEvents } from '../../../../../lib/teams/schema';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// GET /api/teams/:id/stream — SSE firehose of team events.
// The client connects once and receives real-time updates as new events are
// written to team_events by the runner, hooks, and merge lane.
// This is a polling-based SSE (checks DB every 500ms) rather than a push-based
// one — it's simpler and sufficient for the Constellation UI.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  if (!getTeam(teamId)) {
    return new Response(JSON.stringify({ error: 'Team not found' }), { status: 404 });
  }

  const encoder = new TextEncoder();
  let lastEventId = 0;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        try { controller.enqueue(encoder.encode(`data: ${data}\n\n`)); } catch { closed = true; }
      };

      send(JSON.stringify({ type: 'connected', teamId }));

      const poll = async () => {
        while (!closed) {
          try {
            const events = listEvents(teamId, 50);
            const newEvents = events.filter(e => e.id > lastEventId).reverse();
            for (const evt of newEvents) {
              send(JSON.stringify({ type: 'team_event', ...evt }));
              if (evt.id > lastEventId) lastEventId = evt.id;
            }
          } catch (err: any) {
            send(JSON.stringify({ type: 'error', message: err.message }));
          }
          await new Promise(r => setTimeout(r, 500));
        }
      };

      poll().catch(() => { closed = true; });
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
    },
  });
}
