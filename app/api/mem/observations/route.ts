import { NextRequest } from 'next/server';
import { get as getObs, putObservation } from '../../../../lib/mem/api';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const idStr = req.nextUrl.searchParams.get('id');
  if (!idStr) return Response.json({ error: 'id required' }, { status: 400 });
  const obs = getObs(Number(idStr));
  if (!obs) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json({
    ...obs,
    tags: safeParse(obs.tags, []),
    source_turn_ids: safeParse(obs.source_turn_ids, []),
    files_involved: safeParse(obs.files_involved, []),
    embedding: undefined,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { session_id, type, title, content, tags, files_involved } = body ?? {};
  if (!session_id || !type || !title || !content) {
    return Response.json({ error: 'session_id, type, title, content required' }, { status: 400 });
  }
  const row = await putObservation({
    sessionId: session_id,
    type,
    title,
    content,
    tags,
    filesInvolved: files_involved,
  });
  return Response.json({ id: row.id, created_at: row.created_at });
}

function safeParse<T>(s: string | null, fb: T): T {
  if (!s) return fb;
  try { return JSON.parse(s) as T; } catch { return fb; }
}
