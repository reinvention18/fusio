/**
 * /api/chat-ai-sdk — AI SDK v6 adapter around spawnClaudeStream.
 *
 * Parallel path to /api/chat that emits the Vercel AI SDK UI Message Stream
 * protocol so `useChat` can consume it directly (with `experimental_resume`
 * etc). Existing /api/chat keeps working untouched — ChatPanel opts in per
 * feature flag when it's safe to migrate fully (planned P3 follow-up).
 *
 * The adapter translates the current internal SSE shape:
 *   data: {"choices":[{"delta":{"content":"…"}}]}   → text-delta
 *   data: {"type":"status",...}                     → data-tool-status
 *   data: {"type":"subagent",...}                   → data-subagent
 *   data: {"type":"heartbeat",...}                  → data-heartbeat
 *   data: {"type":"usage",...}                      → finish w/ metadata
 *   data: [DONE]                                    → stream close
 */

import { NextRequest } from 'next/server';
import { createUIMessageStream, createUIMessageStreamResponse, generateId } from 'ai';
import {
  spawnClaudeStream,
  GLOBAL_WORKSPACE,
} from '../../../lib/claude-chat-bridge';

export const maxDuration = 3600;
export const dynamic = 'force-dynamic';

interface UseChatBody {
  id?: string;
  messages?: Array<{
    id?: string;
    role: string;
    parts?: Array<{ type: string; text?: string }>;
    content?: string;
  }>;
  // Mission Control extras passed through
  sessionKey?: string;
  workspace?: string;
  model?: string;
  permissionMode?: string;
}

function lastUserText(messages: UseChatBody['messages']): string {
  if (!messages) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (m.parts?.length) {
      return m.parts
        .filter(p => p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text!)
        .join('\n');
    }
    if (typeof m.content === 'string') return m.content;
  }
  return '';
}

export async function POST(request: NextRequest) {
  let body: UseChatBody = {};
  try { body = await request.json(); } catch { /* tolerate empty */ }

  const prompt = lastUserText(body.messages);
  if (!prompt.trim()) {
    return new Response(JSON.stringify({ error: 'empty prompt' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { stream: internalStream } = spawnClaudeStream({
    prompt,
    sessionKey: body.sessionKey,
    workspace: body.workspace || GLOBAL_WORKSPACE,
    model: body.model,
    permissionMode: body.permissionMode,
    requestId: `ai-sdk-${Date.now()}`,
  });

  const uiStream = createUIMessageStream({
    execute: async ({ writer }) => {
      const textId = generateId();
      writer.write({ type: 'start' } as any);
      writer.write({ type: 'text-start', id: textId } as any);

      const reader = internalStream.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let done = false;

      while (!done) {
        const { value, done: d } = await reader.read();
        if (d) { done = true; break; }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const raw of lines) {
          if (!raw.startsWith('data: ')) continue;
          const data = raw.slice(6).trim();
          if (!data) continue;
          if (data === '[DONE]') { done = true; break; }

          let parsed: any;
          try { parsed = JSON.parse(data); } catch { continue; }

          // OpenAI-chunk shape: text deltas
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            writer.write({ type: 'text-delta', id: textId, delta } as any);
            continue;
          }

          // Structured custom events → data parts (transient: true so they
          // stream without accumulating in the final message).
          if (parsed?.type === 'status') {
            writer.write({ type: 'data-status', data: { status: parsed.status }, transient: true } as any);
          } else if (parsed?.type === 'heartbeat') {
            writer.write({
              type: 'data-heartbeat',
              data: {
                status: parsed.status,
                elapsedSec: parsed.elapsedSec,
                subagentsRunning: parsed.subagentsRunning,
                subagentsDone: parsed.subagentsDone,
                toolsUsed: parsed.toolsUsed,
              },
              transient: true,
            } as any);
          } else if (parsed?.type === 'subagent') {
            writer.write({
              type: 'data-subagent',
              data: parsed,
              transient: true,
            } as any);
          } else if (parsed?.type === 'usage') {
            writer.write({
              type: 'message-metadata',
              messageMetadata: {
                usage: parsed.usage,
                cost: parsed.cost,
                sessionId: parsed.session_id,
              },
            } as any);
          }
        }
      }

      writer.write({ type: 'text-end', id: textId } as any);
      writer.write({ type: 'finish' } as any);
    },
    onError: (err) => {
      console.error('[chat-ai-sdk] stream error:', err);
      return err instanceof Error ? err.message : String(err);
    },
  });

  return createUIMessageStreamResponse({ stream: uiStream });
}
