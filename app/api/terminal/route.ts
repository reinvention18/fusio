/**
 * /api/terminal — Execute shell commands with streaming output.
 *
 * POST { command, cwd? }  → SSE stream of stdout/stderr chunks
 * GET  ?action=kill&pid=X → kill a running command
 *
 * Uses child_process.spawn with a shell for interactive-like behavior.
 */

import { NextRequest } from 'next/server';
import { spawn } from 'child_process';
import os from 'os';

const GLOBAL_WORKSPACE = os.homedir();

// Active terminal processes
const activeTerminals = new Map<string, ReturnType<typeof spawn>>();

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get('action');
  const pid = request.nextUrl.searchParams.get('pid');

  if (action === 'kill' && pid) {
    const proc = activeTerminals.get(pid);
    if (proc) {
      try { proc.kill('SIGTERM'); } catch {}
      activeTerminals.delete(pid);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'Process not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Invalid action' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { command, cwd } = body;

    if (!command || typeof command !== 'string') {
      return new Response(JSON.stringify({ error: 'command required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const workDir = cwd || GLOBAL_WORKSPACE;
    const termId = `term-${Date.now()}`;

    const proc = spawn('bash', ['-c', command], {
      cwd: workDir,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
        COLUMNS: '120',
        LINES: '40',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    proc.stdin.end();
    activeTerminals.set(termId, proc);

    const enc = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        // Send terminal ID first
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'init', termId, pid: proc.pid })}\n\n`));

        proc.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'stdout', data: text })}\n\n`));
        });

        proc.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'stderr', data: text })}\n\n`));
        });

        proc.on('close', (code) => {
          activeTerminals.delete(termId);
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'exit', code })}\n\n`));
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          try { controller.close(); } catch {}
        });

        proc.on('error', (err) => {
          activeTerminals.delete(termId);
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`));
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          try { controller.close(); } catch {}
        });

        // 5 min timeout
        setTimeout(() => {
          if (!proc.killed) {
            try { proc.kill('SIGTERM'); } catch {}
          }
        }, 300_000);
      },
      cancel() {
        try { proc.kill('SIGTERM'); } catch {}
        activeTerminals.delete(termId);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
