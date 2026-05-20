/**
 * POST /api/vault/save — "Save to Vault" action endpoint.
 *
 * Used by the chat UI's save-to-vault button. Writes a markdown note with
 * default frontmatter (source=chat, chatId, timestamp).
 */
import { NextRequest } from 'next/server';
import { writeNote, isConfigured } from '../../../../lib/vault/service';
import { noteSlug } from '../../../../lib/vault/obsidian-md';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!isConfigured()) return Response.json({ error: 'vault not configured' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const { title, content, chatId, messageId, tags = [] } = body ?? {};
  if (!content) return Response.json({ error: 'content required' }, { status: 400 });

  const safeTitle = noteSlug((title as string) || `Chat note ${new Date().toISOString().slice(0, 10)}`);
  const datePrefix = new Date().toISOString().slice(0, 10);

  const frontmatter: Record<string, unknown> = {
    source: 'mission-control-chat',
    chatId: chatId ?? null,
    messageId: messageId ?? null,
    created: new Date().toISOString(),
    tags: Array.isArray(tags) ? tags : [],
  };

  try {
    const note = writeNote({
      path: `inbox/${datePrefix} — ${safeTitle}`,
      content,
      frontmatter,
    });
    return Response.json({ note });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
