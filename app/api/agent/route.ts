/**
 * /api/agent — External headless agent API.
 *
 * Accepts prompts from external tools, CI, automation, etc.
 * Uses the same Claude Code CLI bridge as /api/chat.
 *
 * Authentication: Bearer token matching the gateway token in openclaw.json.
 *
 * Modes:
 *   SSE (default, Accept: text/event-stream) — streams response chunks
 *   JSON (Accept: application/json)          — waits for completion, returns full result
 *
 * POST body: {
 *   prompt: string,         // required
 *   workspace?: string,     // working directory (default: ~/.openclaw/workspace)
 *   model?: string,         // opus | sonnet | haiku
 *   sessionId?: string,     // resume a previous session
 *   permissionMode?: string // default | plan | bypassPermissions
 * }
 */

import { NextRequest } from 'next/server';
import {
  spawnClaudeStream,
  getGatewayToken,
  GLOBAL_WORKSPACE,
} from '../../../lib/claude-chat-bridge';

export const maxDuration = 3600;
export const dynamic = 'force-dynamic';

function authenticate(request: NextRequest): boolean {
  const expectedToken = getGatewayToken();
  if (!expectedToken) return true; // No token configured = open access

  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token === expectedToken) return true;

  // Also check query param
  const qToken = request.nextUrl.searchParams.get('token') || '';
  return qToken === expectedToken;
}

export async function POST(request: NextRequest) {
  // Auth check
  if (!authenticate(request)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const { prompt, workspace, model, sessionId, permissionMode } = body;

    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify({ error: 'prompt is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const requestId = `agent-${Date.now()}`;

    const { stream, process: proc } = spawnClaudeStream({
      prompt,
      sessionKey: sessionId,
      workspace: workspace || GLOBAL_WORKSPACE,
      model,
      permissionMode,
      requestId,
    });

    // Check Accept header for response mode
    const accept = request.headers.get('accept') || '';
    const wantJSON = accept.includes('application/json') && !accept.includes('text/event-stream');

    if (wantJSON) {
      // Collect full response and return JSON
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let usageInfo: any = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          // Parse SSE events from the stream
          for (const line of text.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'usage') {
                usageInfo = parsed;
              } else if (parsed.choices?.[0]?.delta?.content) {
                fullContent += parsed.choices[0].delta.content;
              }
            } catch {}
          }
        }
      } finally {
        reader.releaseLock();
      }

      return new Response(
        JSON.stringify({
          content: fullContent,
          sessionId: usageInfo?.session_id || sessionId,
          usage: usageInfo?.usage,
          cost: usageInfo?.cost,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // SSE mode (default)
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error: any) {
    console.error('[Agent API] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
