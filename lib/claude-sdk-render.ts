/**
 * Shared SSE + SDK message rendering helpers.
 *
 * Phase 1 of the Constellation refactor extracts only the pure helpers —
 * `toolStatusLabel` and the SSE-frame formatters. The big
 * message-to-SSE drain loop (`claude-chat-bridge.ts:279–609`) is NOT moved
 * here yet because it's entangled with the chat bridge's closure state
 * (`fullContent`, `capturedSessionId`, `recordSubagentStart/Finish`,
 * `pendingResponses`, memory indexing). That extraction happens in Phase 2
 * when `lib/teams/runner.ts` also needs to call it and the interface can be
 * designed around both callers.
 */

import 'server-only';

// ─── SSE frame helpers (stateless) ──────────────────────────────────────

export function sseChunk(content: string, id?: string): string {
  return `data: ${JSON.stringify({
    id: id || `cc-${Date.now()}`,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

export function sseStatus(status: string): string {
  return `data: ${JSON.stringify({ type: 'status', status })}\n\n`;
}

export function sseDone(): string {
  return 'data: [DONE]\n\n';
}

/** Generic SSE wrapper for any JSON payload — used by team runner for team_event frames. */
export function sseEnvelope(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// ─── Tool activity label builder ────────────────────────────────────────
// Identical output to the original `claude-chat-bridge.ts:180–200`.

export function toolStatusLabel(name: string, input: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  if (name === 'Read') {
    const fp = inp.file_path as string | undefined;
    return fp ? `📄 Reading \`${fp.split('/').slice(-2).join('/')}\`` : '📄 Reading file...';
  }
  if (name === 'Edit') {
    const fp = inp.file_path as string | undefined;
    return fp ? `✏️ Editing \`${fp.split('/').slice(-2).join('/')}\`` : '✏️ Editing file...';
  }
  if (name === 'Write') {
    const fp = inp.file_path as string | undefined;
    return fp ? `📝 Writing \`${fp.split('/').slice(-2).join('/')}\`` : '📝 Writing file...';
  }
  if (name === 'Bash') {
    const cmd = ((inp.command as string) || '').slice(0, 80);
    return cmd ? `💻 \`${cmd}\`` : '💻 Running command...';
  }
  if (name === 'Grep' || name === 'Glob') {
    const pat = (inp.pattern as string) || '';
    return pat ? `🔍 Searching \`${pat.slice(0, 60)}\`` : '🔍 Searching...';
  }
  if (name === 'Agent' || name === 'Task') {
    const desc = (inp.description as string) || '';
    return desc ? `🚀 Agent: ${desc.slice(0, 80)}` : '🚀 Launching agent...';
  }
  if (name === 'WebSearch' || name === 'WebFetch') {
    return `🌐 ${name === 'WebSearch' ? 'Searching web...' : 'Fetching URL...'}`;
  }
  return `🔧 ${name}...`;
}
