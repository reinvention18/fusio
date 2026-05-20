/**
 * spawnCodexStream — drop-in replacement for spawnClaudeStream when the user
 * has picked an OpenAI Codex model from the chat's model dropdown. Emits the
 * same SSE frame shape the existing chat panel already understands so the
 * frontend doesn't need to know whether the turn was Anthropic or OpenAI.
 *
 * Frames produced (matching claude-chat-bridge):
 *   data: {"choices":[{"delta":{"content":"<chunk>"}}]}\n\n     — text deltas
 *   data: {"type":"status","status":"<msg>"}\n\n                 — status
 *   data: {"type":"usage","usage":{...},"cost":<n>}\n\n          — at end
 *   data: [DONE]\n\n
 *
 * Why a separate helper rather than baking codex into spawnClaudeStream:
 *   • spawnClaudeStream is built around the @anthropic-ai/claude-agent-sdk
 *     module and its session-resume + tool-dispatch model. Codex is a
 *     CLI subprocess with a completely different lifecycle.
 *   • Keeping them parallel makes the dispatch in /api/chat trivial:
 *     `model.startsWith('codex')` → spawnCodexStream, else spawnClaudeStream.
 *
 * Codex's `goals` feature flag is enabled via --enable goals so the agent
 * loop treats persistent context the way it would in the dedicated
 * "Ask Codex" modal — same code path, same goals-feature behavior.
 */

import 'server-only';
import { spawn } from 'node:child_process';

export interface SpawnCodexOptions {
  /** Composed prompt text — same shape we'd hand to claude (with prior
   *  conversation turns + the current user message stitched together). */
  prompt: string;
  /** Working directory codex runs in. Defaults to process cwd. */
  workspace?: string;
  /** Optional model id. The chat dropdown values are 'codex' and
   *  'codex-default' for the account default; 'codex-gpt-5-codex' for the
   *  explicit gpt-5-codex model. We strip the 'codex-' prefix and pass
   *  the rest as -m, with 'default' meaning skip -m entirely. */
  model?: string;
  /** read-only (default) | workspace-write. Read-only is the safe choice
   *  for chat — the user can opt into workspace-write per turn via the
   *  permission-mode toggle. */
  sandbox?: 'read-only' | 'workspace-write';
}

export interface SpawnCodexResult {
  stream: ReadableStream;
  process: { kill: (sig?: string) => void };
}

export function spawnCodexStream(opts: SpawnCodexOptions): SpawnCodexResult {
  const { prompt, workspace, model, sandbox } = opts;
  const cwd = workspace || process.cwd();
  const sandboxArg = sandbox === 'workspace-write' ? 'workspace-write' : 'read-only';

  // Derive codex-side model id from the chat-side model value. The chat
  // dropdown uses 'codex' / 'codex-default' for "let codex pick" and
  // 'codex-<id>' for an explicit pin (e.g. 'codex-gpt-5-codex').
  let codexModel: string | undefined;
  if (model && model.startsWith('codex')) {
    const rest = model === 'codex' ? '' : model.slice('codex-'.length);
    if (rest && rest !== 'default') codexModel = rest;
  }

  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-s', sandboxArg,
    '--enable', 'goals',
  ];
  if (codexModel) args.push('-m', codexModel);

  let killed = false;
  const enc = new TextEncoder();
  const started = Date.now();
  // Tiny shared ref so the cancel handler can reach the spawned codex
  // process without race conditions. MUST be declared BEFORE the
  // ReadableStream's `start` references it (was a TDZ bug previously).
  // Each spawnCodexStream call closes over its own ref so concurrent
  // codex turns each have their own kill switch.
  const processRef: { current: ReturnType<typeof spawn> | null } = { current: null };

  const stream = new ReadableStream({
    async start(controller) {
      const send = (frame: string) => { try { controller.enqueue(enc.encode(frame)); } catch { /* closed */ } };
      const sendStatus = (status: string) => send(`data: ${JSON.stringify({ type: 'status', status })}\n\n`);
      const sendChunk = (text: string) => send(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);

      sendStatus('🤖 Codex spawning…');

      const proc = spawn('codex', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });

      // Track kill for the returned handle so the chat panel's abort
      // controller can short-circuit a long codex turn the same way it
      // shorts the agent-SDK on Anthropic.
      processRef.current = proc;

      let stdoutBuf = '';
      let stderrBuf = '';
      let usage: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number; reasoning_output_tokens?: number } = {};
      let lastSeenAgentMessage = '';

      proc.stdout.on('data', (d: Buffer) => {
        stdoutBuf += d.toString();
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }

          // codex --json event taxonomy:
          //   { type: 'thread.started', thread_id }
          //   { type: 'turn.started' }
          //   { type: 'item.completed', item: { id, type: 'agent_message'|'reasoning'|..., text } }
          //   { type: 'turn.completed', usage: { input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens } }
          //   { type: 'error', message }
          if (ev?.type === 'thread.started') {
            sendStatus('🧠 Codex thread started');
          } else if (ev?.type === 'turn.started') {
            sendStatus('🤖 Codex thinking…');
          } else if (ev?.type === 'item.completed' && typeof ev.item?.text === 'string') {
            const itemType = ev.item?.type;
            // agent_message is the user-facing reply. Anything else (tool
            // calls, reasoning chain) is internal — surface it as a status
            // line so the chat shows "Codex used tool X" without dumping
            // the raw content into the assistant bubble.
            if (itemType === 'agent_message') {
              const text = ev.item.text;
              // Codex returns the full agent message in one chunk. Slice
              // any prior partial we may have seen so we don't double-emit
              // when codex re-emits the same item.
              if (text.startsWith(lastSeenAgentMessage) && lastSeenAgentMessage) {
                const delta = text.slice(lastSeenAgentMessage.length);
                if (delta) sendChunk(delta);
              } else {
                sendChunk(text);
              }
              lastSeenAgentMessage = text;
            } else if (itemType === 'reasoning') {
              // Reasoning is ambient — render as a dim status, not a chunk.
              sendStatus(`💭 Codex reasoning (${ev.item.text.length} chars)`);
            } else {
              sendStatus(`🔧 Codex ${itemType ?? 'event'}`);
            }
          } else if (ev?.type === 'turn.completed' && ev?.usage) {
            usage = ev.usage;
          } else if (ev?.type === 'error' && typeof ev.message === 'string') {
            sendChunk(`\n\n⚠️ Codex error: ${ev.message}\n`);
          }
          // Other events are silently dropped — they'd just be noise in
          // the chat. (Network panel still shows them via /api/chat/codex
          // if the user wants the raw stream.)
        }
      });

      proc.stderr.on('data', (d: Buffer) => { stderrBuf += d.toString(); });

      proc.on('close', (code) => {
        if (killed) return;
        // Emit the same usage frame the claude-bridge ships at end-of-turn
        // so the existing token meter / mission accumulator picks it up.
        // Rough cost estimate — accurate-enough for a meter; pricing
        // varies by model + plan. We use OpenAI's published $5/$10 per
        // 1M input/output as the ceiling.
        const inTok = usage.input_tokens ?? 0;
        const outTok = usage.output_tokens ?? 0;
        const cachedIn = usage.cached_input_tokens ?? 0;
        const fresh = Math.max(0, inTok - cachedIn);
        const cost = (fresh * 5 + outTok * 10) / 1_000_000;
        send(`data: ${JSON.stringify({
          type: 'usage',
          usage: {
            input_tokens: inTok,
            output_tokens: outTok,
            cache_read_input_tokens: cachedIn,
            cache_creation_input_tokens: 0,
            reasoning_output_tokens: usage.reasoning_output_tokens ?? 0,
          },
          cost,
          duration_ms: Date.now() - started,
        })}\n\n`);
        if (code !== 0) {
          send(`data: ${JSON.stringify({ choices: [{ delta: { content: `\n\n⚠️ Codex exited ${code}: ${stderrBuf.slice(-500)}` } }] })}\n\n`);
        }
        send(`data: [DONE]\n\n`);
        try { controller.close(); } catch { /* already closed */ }
      });

      proc.on('error', (err) => {
        sendChunk(`\n\n⚠️ Codex spawn failed: ${(err as Error)?.message || err}`);
        send(`data: [DONE]\n\n`);
        try { controller.close(); } catch { /* ignore */ }
      });

      try {
        proc.stdin.write(prompt);
        proc.stdin.end();
      } catch (err: any) {
        sendChunk(`\n\n⚠️ Failed to write prompt to codex stdin: ${err?.message || err}`);
        send(`data: [DONE]\n\n`);
        try { controller.close(); } catch { /* ignore */ }
      }
    },
    cancel() {
      // Reader cancelled — kill the underlying process so we don't leak
      // a long-running codex turn after the client disconnected.
      if (processRef.current && !killed) {
        killed = true;
        try { processRef.current.kill('SIGTERM'); } catch { /* ignore */ }
      }
    },
  });

  return {
    stream,
    process: {
      kill: (sig?: string) => {
        if (processRef.current && !killed) {
          killed = true;
          try { processRef.current.kill((sig as any) || 'SIGTERM'); } catch { /* ignore */ }
        }
      },
    },
  };
}
