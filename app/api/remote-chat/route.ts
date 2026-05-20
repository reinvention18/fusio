/**
 * /api/remote-chat — inbound endpoint for cross-MC chat bridging.
 *
 * The peer MC POSTs here with:
 *   { message: string, chatId?: string, asNewChat?: boolean, model?: string }
 *
 * Bearer auth via Authorization: Bearer <token>.
 *
 * Response shape is content-negotiated:
 *   • Accept: text/event-stream → SSE stream of upstream events + a final
 *     `event: remote-done` carrying the assembled assistant text + metadata.
 *     Use this for long peer turns — the connection stays alive because data
 *     keeps flowing, so router/NAT/proxy idle timeouts don't kill the RPC.
 *   • Anything else → legacy single-shot JSON drained server-side. Kept for
 *     compatibility with any caller that still hits us with `application/json`.
 *
 * History: the original implementation was JSON-only and held one HTTP socket
 * open for the entire peer turn. A 10+ minute turn would hit any number of
 * intermediary timeouts and silently drop. Switching to SSE lets the same
 * upstream stream flow through to the caller chunk-by-chunk; the caller still
 * gets a synchronous-feeling "final reply" at the end via the remote-done
 * event, but the underlying transport is no longer a long-idle request.
 */

import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { spawnClaudeStream, GLOBAL_WORKSPACE } from '../../../lib/claude-chat-bridge';
import { isInboundAuthorized } from '../../../lib/remote/config';
import { generateId } from '../../../lib/generateId';

// Peer-side persistence dir for in-flight remote chat turns. Mirrors the
// pending-buffer pattern from the main chat bridge but lives in its own
// subdirectory so the cleanup sweep can never touch bridge state. The
// bridge writes `data/pending/<requestId>.json` directly with requestIds
// like `remote-req-…` — namespacing prevents an accidental delete.
const PENDING_DIR = path.join(process.cwd(), 'data', 'pending', 'remote-chat');
function ensurePendingDir(): void {
  try { fs.mkdirSync(PENDING_DIR, { recursive: true }); } catch { /* exists or race */ }
}
function pendingPath(requestId: string): string {
  return path.join(PENDING_DIR, `${requestId}.json`);
}
interface PendingRemoteState {
  ok: true;
  requestId: string;
  chatId: string;
  sessionKey: string;
  assistantText: string;
  chars: number;
  done: boolean;
  error?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  framesSeen: number;
  bytesSeen: number;
}
function writePending(state: PendingRemoteState): void {
  try {
    ensurePendingDir();
    fs.writeFileSync(pendingPath(state.requestId), JSON.stringify(state), 'utf-8');
  } catch (e: any) {
    console.warn('[remote-chat] pending write failed requestId=%s err=%s',
      state.requestId, e?.message ?? String(e));
  }
}

export const maxDuration = 600;
export const dynamic = 'force-dynamic';

interface RemoteChatBody {
  message?: unknown;
  chatId?: unknown;
  model?: unknown;
  asNewChat?: unknown;
  /** Optional caller-supplied requestId. If provided we mirror it so the
   *  caller can recover the result via /api/remote-chat/result?requestId=X
   *  after a disconnect/restart. */
  requestId?: unknown;
}

export async function POST(request: NextRequest) {
  if (!isInboundAuthorized(request.headers.get('authorization'))) {
    return jsonError(401, 'unauthorized');
  }

  let body: RemoteChatBody;
  try {
    body = (await request.json()) as RemoteChatBody;
  } catch {
    return jsonError(400, 'invalid JSON body');
  }

  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) return jsonError(400, 'message required');

  const chatId: string =
    typeof body.chatId === 'string' && body.chatId ? body.chatId : `remote-${generateId()}`;
  const sessionKey = `mc-remote-${chatId}`;
  // Honor caller-supplied requestId (validated for safety) so the caller
  // can recover the result by the same id. Falls back to generating one.
  const callerRequestId = typeof body.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.requestId)
    ? body.requestId : null;
  const requestId = callerRequestId ?? `remote-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const model: string | undefined = typeof body.model === 'string' ? body.model : undefined;

  // Spawn the upstream chat turn. Same pipeline as a local user message —
  // peer-issued turns get full skills/agents/memory auto-load + the same MCP
  // server fabric. clientId='remote-bridge' lets downstream code distinguish
  // these from real user-driven turns if it ever needs to.
  const { stream: upstream } = spawnClaudeStream({
    prompt: message,
    sessionKey,
    workspace: GLOBAL_WORKSPACE,
    model,
    requestId,
    chatId,
    clientId: 'remote-bridge',
  });

  const wantsSse = (request.headers.get('accept') || '').toLowerCase().includes('text/event-stream');
  console.log('[remote-chat] inbound chatId=%s sessionKey=%s mode=%s msgChars=%d model=%s',
    chatId.slice(0, 12), sessionKey.slice(0, 20), wantsSse ? 'sse' : 'json', message.length, model || 'default');

  if (wantsSse) {
    return streamResponse(upstream, { chatId, sessionKey, requestId });
  }
  return jsonResponse(upstream, { chatId, sessionKey, requestId });
}

// ─── SSE response — preferred path for long peer turns ─────────────────────

interface RemoteMeta {
  chatId: string;
  sessionKey: string;
  requestId: string;
}

function streamResponse(upstream: ReadableStream<Uint8Array>, meta: RemoteMeta): Response {
  const enc = new TextEncoder();
  const startedAt = Date.now();

  // Initial pending snapshot so a caller that disconnects before the first
  // chunk can still find the requestId on disk.
  writePending({
    ok: true,
    requestId: meta.requestId,
    chatId: meta.chatId,
    sessionKey: meta.sessionKey,
    assistantText: '',
    chars: 0,
    done: false,
    startedAt,
    updatedAt: startedAt,
    framesSeen: 0,
    bytesSeen: 0,
  });

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let assistantText = '';
      let seq = 0;
      let buf = '';
      let alive = true;
      let framesSeen = 0;
      let bytesSeen = 0;
      let lastPersist = startedAt;
      const dec = new TextDecoder();

      // Emit a kickoff frame so the caller knows we're alive and has the
      // request metadata before any model output arrives. Useful if the
      // first model token is slow — without this, the caller would wait
      // for the first upstream chunk before getting anything.
      controller.enqueue(
        enc.encode(
          `event: remote-start\ndata: ${JSON.stringify({ seq: seq++, ...meta, ts: Date.now() })}\n\n`,
        ),
      );

      // Per-15s keepalive comment frame — most intermediaries treat any byte
      // arrival as "this connection isn't idle." Belt + suspenders alongside
      // the actual model output frames.
      const keepalive = setInterval(() => {
        if (!alive) return;
        try {
          controller.enqueue(enc.encode(`: keepalive ${Date.now()}\n\n`));
        } catch {
          alive = false;
          clearInterval(keepalive);
        }
      }, 15_000);

      const reader = upstream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!alive) break;

          framesSeen++;
          bytesSeen += value.byteLength;

          // Forward the raw upstream bytes verbatim so the caller sees the
          // exact same SSE event types it would see from a local turn
          // (chat.completion.chunk, status, heartbeat, subagent, usage, …).
          // A disconnected caller doesn't break us — they just stop reading;
          // we still finish the upstream and persist the result.
          if (alive) {
            try {
              controller.enqueue(value);
            } catch {
              alive = false;
            }
          }

          // In parallel, parse text deltas out of the buffered stream so we
          // can assemble the final assistantText for the remote-done event.
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 2);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload);
              const delta = parsed?.choices?.[0]?.delta?.content;
              if (typeof delta === 'string') assistantText += delta;
            } catch {
              /* skip malformed */
            }
          }

          // Persist a snapshot every 3 seconds while in-flight. Lets a
          // returning caller fetch partial progress via the /result endpoint
          // even before this turn finishes. Cheap (single sync write of a
          // small JSON file).
          const now = Date.now();
          if (now - lastPersist > 3_000) {
            writePending({
              ok: true,
              requestId: meta.requestId,
              chatId: meta.chatId,
              sessionKey: meta.sessionKey,
              assistantText,
              chars: assistantText.length,
              done: false,
              startedAt,
              updatedAt: now,
              framesSeen,
              bytesSeen,
            });
            lastPersist = now;
          }
        }
      } catch (e: any) {
        // Surface the upstream error to the caller as a typed event before
        // closing. The caller's askTool can decide what to do.
        const errMsg = e?.message ?? String(e);
        try {
          controller.enqueue(
            enc.encode(
              `event: remote-error\ndata: ${JSON.stringify({
                seq: seq++,
                message: errMsg,
                ts: Date.now(),
              })}\n\n`,
            ),
          );
        } catch {
          /* ignore */
        }
        // Persist error terminal state so /result can return it.
        writePending({
          ok: true,
          requestId: meta.requestId,
          chatId: meta.chatId,
          sessionKey: meta.sessionKey,
          assistantText,
          chars: assistantText.length,
          done: true,
          error: errMsg,
          startedAt,
          updatedAt: Date.now(),
          completedAt: Date.now(),
          framesSeen,
          bytesSeen,
        });
      } finally {
        clearInterval(keepalive);
        // Emit the final remote-done event with the assembled assistant text.
        // This is the event consumers should key on — the upstream frames
        // before it are noise the agent can ignore.
        const completedAt = Date.now();
        try {
          controller.enqueue(
            enc.encode(
              `event: remote-done\ndata: ${JSON.stringify({
                seq: seq++,
                ok: true,
                ...meta,
                assistantText,
                chars: assistantText.length,
                ts: completedAt,
              })}\n\n`,
            ),
          );
        } catch {
          /* connection already closed — that's fine, result is on disk */
        }
        // Persist done terminal state. The pending file is now the source
        // of truth for /api/remote-chat/result?requestId=X for the next
        // hour. This is what makes caller-restart resumability work: even
        // if the caller's MC restarts mid-stream, the result still gets
        // captured and the caller can recover it via the result endpoint.
        writePending({
          ok: true,
          requestId: meta.requestId,
          chatId: meta.chatId,
          sessionKey: meta.sessionKey,
          assistantText,
          chars: assistantText.length,
          done: true,
          startedAt,
          updatedAt: completedAt,
          completedAt,
          framesSeen,
          bytesSeen,
        });
        console.log('[remote-chat] done requestId=%s chars=%d frames=%d elapsedMs=%d',
          meta.requestId, assistantText.length, framesSeen, completedAt - startedAt);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx/proxy buffering if any
    },
  });
}

// ─── Legacy JSON response — kept for callers that don't request SSE ─────

async function jsonResponse(upstream: ReadableStream<Uint8Array>, meta: RemoteMeta): Promise<Response> {
  const startedAt = Date.now();
  // Snapshot the initial pending state so the result endpoint works for the
  // legacy JSON path too — same recovery semantics regardless of transport.
  writePending({
    ok: true,
    requestId: meta.requestId,
    chatId: meta.chatId,
    sessionKey: meta.sessionKey,
    assistantText: '',
    chars: 0,
    done: false,
    startedAt,
    updatedAt: startedAt,
    framesSeen: 0,
    bytesSeen: 0,
  });

  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let assistantText = '';
  let framesSeen = 0;
  let bytesSeen = 0;
  let lastPersist = startedAt;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    framesSeen++;
    bytesSeen += value.byteLength;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 2);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') assistantText += delta;
      } catch {
        /* skip malformed */
      }
    }
    const now = Date.now();
    if (now - lastPersist > 3_000) {
      writePending({
        ok: true,
        requestId: meta.requestId,
        chatId: meta.chatId,
        sessionKey: meta.sessionKey,
        assistantText,
        chars: assistantText.length,
        done: false,
        startedAt,
        updatedAt: now,
        framesSeen,
        bytesSeen,
      });
      lastPersist = now;
    }
  }
  const completedAt = Date.now();
  writePending({
    ok: true,
    requestId: meta.requestId,
    chatId: meta.chatId,
    sessionKey: meta.sessionKey,
    assistantText,
    chars: assistantText.length,
    done: true,
    startedAt,
    updatedAt: completedAt,
    completedAt,
    framesSeen,
    bytesSeen,
  });
  console.log('[remote-chat] done (json) requestId=%s chars=%d frames=%d elapsedMs=%d',
    meta.requestId, assistantText.length, framesSeen, completedAt - startedAt);
  return new Response(
    JSON.stringify({
      ok: true,
      chatId: meta.chatId,
      sessionKey: meta.sessionKey,
      requestId: meta.requestId,
      assistantText,
      chars: assistantText.length,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
