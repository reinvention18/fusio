/**
 * POST /api/chat/codex
 *
 * Chat-side Codex turn. Wraps the codex CLI as a streaming SSE endpoint so
 * the ChatPanel's Tools modal can ask Codex a question (with an optional
 * persistent goal) and watch the response stream in.
 *
 * Body:
 *   {
 *     prompt: string,        // user's question / task
 *     goal?: string,         // ambient goal — prepended to the prompt as
 *                            //   `## Goal\n<goal>` for context. Persists
 *                            //   in the client (localStorage) across turns.
 *     cwd?: string,          // working directory (codex needs a real one)
 *     model?: string,        // 'default' to use the codex account default
 *     sandbox?: 'read-only' | 'workspace-write',  // default read-only
 *   }
 *
 * SSE events:
 *   { type: 'codex-start', goals_enabled: true }
 *   { type: 'codex-chunk', text: '...' }       — incremental agent_message text
 *   { type: 'codex-event', event: {...} }      — raw codex event for debugging
 *   { type: 'codex-end', exit_code, duration_ms }
 *   { type: 'codex-error', message }
 *
 * The `goals` feature flag is enabled via `--enable goals` so Codex's
 * agent loop tracks the goal across turns of its internal session. The
 * flag is currently 'under development' — having it on costs nothing
 * and gives us the integration the moment Codex ships the surface.
 */

import { NextRequest } from 'next/server';
import { spawn } from 'node:child_process';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CodexBody {
  prompt?: string;
  goal?: string;
  cwd?: string;
  model?: string;
  sandbox?: 'read-only' | 'workspace-write';
}

export async function POST(req: NextRequest) {
  let body: CodexBody = {};
  try { body = await req.json(); } catch { /* invalid */ }
  const prompt = String(body?.prompt || '').trim();
  if (!prompt) {
    return Response.json({ error: 'invalid_input', need: ['prompt'] }, { status: 400 });
  }
  const goal = String(body?.goal || '').trim();
  const cwd = String(body?.cwd || process.cwd());
  const model = body?.model && body.model !== 'default' ? body.model : undefined;
  const sandbox = body?.sandbox === 'workspace-write' ? 'workspace-write' : 'read-only';

  // Compose the actual prompt sent to codex. Goal is rendered as a
  // dedicated section so codex's agent loop (and the goals feature) can
  // pick it up as ambient context that persists across turns.
  const composed = goal
    ? `## Goal (persistent context for this conversation)\n${goal}\n\n## This turn\n${prompt}`
    : prompt;

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (frame: string) => { try { controller.enqueue(enc.encode(frame)); } catch { /* closed */ } };
      const sendData = (obj: unknown) => send(`data: ${JSON.stringify(obj)}\n\n`);

      sendData({ type: 'codex-start', goals_enabled: true, sandbox, has_goal: !!goal });

      const args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '-s', sandbox,
        // Phase: enable the goals feature flag so codex's internal agent
        // loop treats `## Goal …` as persistent context. No-op when the
        // codex build doesn't have the goals surface wired in yet, which
        // is fine — costs nothing.
        '--enable', 'goals',
      ];
      if (model) args.push('-m', model);

      const started = Date.now();
      const proc = spawn('codex', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });

      let stdoutBuf = '';
      let lastErr = '';

      // Wire abort: if the client disconnects mid-stream, kill codex.
      const abortReq = (req as { signal?: AbortSignal }).signal;
      const onAbort = () => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } };
      abortReq?.addEventListener?.('abort', onAbort, { once: true });

      proc.stdout.on('data', (d: Buffer) => {
        stdoutBuf += d.toString();
        // Codex --json emits one JSON object per line. Pull complete lines
        // off the buffer, parse, and stream the agent_message text chunks.
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            // Surface user-readable agent text as 'codex-chunk' so the UI
            // can render it like a streaming reply. Keep the raw event for
            // debugging via 'codex-event'.
            const text = ev?.item?.text;
            const itemType = ev?.item?.type;
            if (typeof text === 'string' && itemType === 'agent_message') {
              sendData({ type: 'codex-chunk', text });
            } else if (ev?.type === 'item.completed' && typeof text === 'string') {
              sendData({ type: 'codex-chunk', text });
            } else {
              // Forward most events (turn.started/completed, errors, etc.)
              // so the UI can show what codex is actually doing.
              sendData({ type: 'codex-event', event: ev });
            }
          } catch {
            // Not JSON — codex preface line ("Reading prompt from stdin..."
            // and similar). Skip silently.
          }
        }
      });
      proc.stderr.on('data', (d: Buffer) => { lastErr += d.toString(); });

      proc.on('close', (code) => {
        abortReq?.removeEventListener?.('abort', onAbort);
        sendData({
          type: 'codex-end',
          exit_code: code ?? -1,
          duration_ms: Date.now() - started,
          stderr_tail: lastErr.slice(-1500) || undefined,
        });
        send(`data: [DONE]\n\n`);
        try { controller.close(); } catch { /* already closed */ }
      });
      proc.on('error', (err) => {
        sendData({ type: 'codex-error', message: String((err as Error)?.message || err) });
        try { controller.close(); } catch { /* already closed */ }
      });

      // Hand the composed prompt to codex via stdin (avoids arg-length
      // limits and shell escaping).
      try {
        proc.stdin.write(composed);
        proc.stdin.end();
      } catch {
        sendData({ type: 'codex-error', message: 'failed to write prompt to codex stdin' });
      }
    },
    cancel() { /* the abort listener handles process kill */ },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
