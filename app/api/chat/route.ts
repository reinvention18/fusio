/**
 * /api/chat — Claude Code CLI bridge
 *
 * Uses the shared spawnClaudeStream() helper from claude-chat-bridge.ts.
 * Request/response contract is IDENTICAL to the old gateway version so
 * ChatPanel needs ZERO changes.
 */

import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

import {
  pendingResponses,
  loadPendingFromDisk,
  spawnClaudeStream,
  getClaudeSessionId,
  GLOBAL_WORKSPACE,
  getRateLimitGate,
} from '../../../lib/claude-chat-bridge';
import { ensureChatSession, captureUserMessage } from '../../../lib/mem/api';
import { retrieveCombined } from '../../../lib/retrieve-context';
import { listRecentEdits, type EditLogEntry } from '../../../lib/edit-log';
import { listHosts as listRemoteHosts, findHost } from '../../../lib/remote/config';
import { commitUserMessageIfMissing } from '../../../lib/chat-storage';
import { broadcastUserMessage } from '../../../lib/chat-broadcast';

// ─── Large message offloading ──────────────────────────────────────
// When a user message exceeds this threshold, save it to a file and tell
// the agent to Read it. This saves context tokens and works better for
// console logs, stack traces, large code dumps, etc.
const LARGE_MSG_THRESHOLD = 4000; // ~1K tokens
const PASTES_DIR = path.join(process.cwd(), 'data', 'pastes');

function offloadLargeMessage(content: string, sessionKey?: string): string {
  if (content.length <= LARGE_MSG_THRESHOLD) return content;

  // Ensure pastes directory exists
  if (!fs.existsSync(PASTES_DIR)) fs.mkdirSync(PASTES_DIR, { recursive: true });

  // Generate a descriptive filename
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = (sessionKey || 'chat').slice(0, 20);
  const filename = `paste-${slug}-${ts}.md`;
  const filePath = path.join(PASTES_DIR, filename);

  // Save the full content
  fs.writeFileSync(filePath, content, 'utf-8');

  // Extract the first few lines as a preview for context
  const lines = content.split('\n');
  const preview = lines.slice(0, 5).join('\n');
  const charCount = content.length;
  const lineCount = lines.length;

  console.log('[Chat] Offloaded large message (%d chars, %d lines) to %s', charCount, lineCount, filePath);

  // Smart paste: one tight header + preview. The agent can pull the full body
  // with Read if the preview isn't enough — no more "You MUST Read" scolding
  // that bloats every paste turn in the context window.
  return `📎 Pasted ${lineCount.toLocaleString()} lines / ${charCount.toLocaleString()} chars → \`${filePath}\`\n\nPreview:\n\`\`\`\n${preview}\n\`\`\`\n\n(Read the file if the preview cuts off something load-bearing.)`;
}

export const maxDuration = 3600;
export const dynamic = 'force-dynamic';

// ─── GET: poll for buffered response (crash recovery) ───────────────
export async function GET(request: NextRequest) {
  const requestId = request.nextUrl.searchParams.get('requestId');
  if (!requestId) {
    return new Response(JSON.stringify({ error: 'requestId required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Memory first; if missed (likely after a server restart), check disk.
  // This is what makes long tasks recoverable across deploys/crashes.
  let pending = pendingResponses.get(requestId);
  if (!pending) {
    pending = loadPendingFromDisk(requestId);
    if (pending) {
      // Re-seed in-memory so subsequent polls hit the fast path
      pendingResponses.set(requestId, pending);
    }
  }
  if (!pending) {
    return new Response(JSON.stringify({ found: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify({
      found: true,
      content: pending.content,
      done: pending.done,
      error: pending.error,
      chars: pending.content.length,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

// ─── POST: stream chat via Claude Code CLI ──────────────────────────
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      messages = [],
      sessionKey,
      requestId,
      workspace,
      model,
      permissionMode,
      attachedChatIds,
      mode,
      chatId,
      clientId,
    } = body;
    const composerMode: 'quick' | 'work' | 'constellation' =
      mode === 'quick' || mode === 'constellation' ? mode : 'work';

    // 429 cooldown gate — short-circuit doomed sends. If this sessionKey
    // recently hit a rate limit, refuse new requests for the cooldown
    // window instead of spawning another query that's almost certain to
    // fail too. Lets the UI render a calm banner instead of writing
    // another error into the chat.
    if (sessionKey) {
      const gate = getRateLimitGate(sessionKey);
      if (gate.active) {
        return new Response(
          JSON.stringify({
            error: 'rate_limited',
            secondsRemaining: gate.secondsRemaining,
            hitCount: gate.hitCount,
            reason: gate.reason,
            message: `This chat is rate-limited. Try again in ${gate.secondsRemaining}s, or compress the chat (header → Compress) to lighten future turns.`,
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(gate.secondsRemaining),
            },
          },
        );
      }
    }

    // Mem session bookkeeping — one session per chat; user message captured for FTS/timeline.
    if (sessionKey) {
      try {
        const memSession = ensureChatSession(sessionKey);
        const lastUser = [...messages].reverse().find(
          (m: any) => m.role === 'user' && typeof m.content !== 'undefined',
        );
        const userText = lastUser ? extractText(lastUser.content) : '';
        if (userText) captureUserMessage(memSession.id, userText.slice(0, 8000));
      } catch (e) {
        console.warn('[mem] chat session/capture failed:', (e as Error).message);
      }
    }

    // Server-side user-message persistence — fixes the "I sent on mobile,
    // closed the app, and my message disappeared" bug. The client
    // optimistically appends to React state and saves the chat file via a
    // debounced PUT /api/chats; if the client closes before that timer fires,
    // the message is lost. Committing here, BEFORE running the agent, makes
    // the user prompt durable. Idempotent — no-op if the client already
    // saved a matching prompt at the chat tail.
    if (chatId) {
      try {
        const lastUserMsg = [...messages].reverse().find(
          (m: any) => m.role === 'user' && typeof m.content !== 'undefined' && !isContextMessage(m.content),
        );
        const lastUserText = lastUserMsg ? extractText(lastUserMsg.content) : '';
        if (lastUserText) {
          commitUserMessageIfMissing({
            chatId,
            content: lastUserText,
            sessionKey,
            workspace,
          });
          // Fan out to other tabs/devices viewing this chat so they see the
          // prompt instantly. The origin client (clientId) is filtered server-
          // side so it doesn't double-render.
          broadcastUserMessage(chatId, lastUserText);
        }
      } catch (e) {
        console.warn('[chat] user-msg server-commit failed:', (e as Error).message);
      }
    }

    // Build prompt from the messages array. Also get a fresh-seeded fallback
    // the bridge can use if the Agent SDK reports a stale session on retry.
    const { prompt, freshFallbackPrompt } = await buildPrompt(messages, sessionKey, attachedChatIds, composerMode);
    if (!prompt.trim()) {
      return new Response(JSON.stringify({ error: 'Empty prompt' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Codex routing: when the user picks a 'codex' or 'codex-<id>' model
    // from the chat dropdown, dispatch to the codex CLI instead of the
    // Anthropic agent-SDK. spawnCodexStream emits the same SSE frame
    // shape so the chat panel needs no changes beyond adding the option.
    let stream: ReadableStream;
    if (typeof model === 'string' && model.startsWith('codex')) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { spawnCodexStream } = require('@/lib/codex-chat-stream') as typeof import('@/lib/codex-chat-stream');
      const codexResult = spawnCodexStream({
        prompt,
        workspace: workspace || GLOBAL_WORKSPACE,
        model,
        sandbox: permissionMode === 'workspace-write' ? 'workspace-write' : 'read-only',
      });
      stream = codexResult.stream;
    } else {
      const claudeResult = spawnClaudeStream({
        prompt,
        freshFallbackPrompt,
        sessionKey,
        workspace: workspace || GLOBAL_WORKSPACE,
        model,
        permissionMode,
        requestId,
        chatId,
        clientId,
      });
      stream = claudeResult.stream;
    }

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error: any) {
    console.error('[Chat API] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ─── Prompt builder ─────────────────────────────────────────────────
// Returns BOTH the primary prompt (minimal when resumed) and a fallback
// "seeded" prompt that carries the full recent history — the bridge falls
// back to the seeded form if the Agent SDK reports the resumed session
// expired (e.g. after a server restart during development).
async function buildPrompt(
  messages: any[],
  sessionKey?: string,
  attachedChatIds?: string[],
  mode: 'quick' | 'work' | 'constellation' = 'work',
): Promise<{ prompt: string; freshFallbackPrompt: string }> {
  const hasExistingSession = sessionKey ? !!getClaudeSessionId(sessionKey) : false;

  const userMsgs = messages.filter(
    (m: any) => m.role === 'user' && !isContextMessage(m.content),
  );
  const lastUserMsg = userMsgs[userMsgs.length - 1];
  const rawLastContent = extractText(lastUserMsg?.content);
  // Offload large pastes (console logs, stack traces, etc.) to a file
  const lastContent = offloadLargeMessage(rawLastContent, sessionKey);

  // Unified retrieval: one budget across turns + observations + vault.
  // Quick mode skips long-term recall entirely — trades answer depth for speed.
  async function recall(resumed: boolean): Promise<string> {
    if (!sessionKey || !lastContent) return '';
    if (mode === 'quick') return '';
    try {
      const r = await retrieveCombined({
        sessionKey,
        query: lastContent,
        attachedChatIds: attachedChatIds ?? [],
        budgetTokens: resumed ? 5000 : 7000,
        resumed,
        timeoutMs: 500,
      });
      return r.block;
    } catch (e) {
      console.error('[retrieve] combined failed:', e);
      return '';
    }
  }

  // Recent edits across machines — best-effort, ~600ms peer timeout.
  // Injected into BOTH the fresh and resumed prompt paths so the agent
  // always knows what the peer just touched. Falls through to '' on no edits.
  const editsBlock = await buildEditsAwarenessBlock();

  // Always build the fresh/seeded form — includes env, workspace, key
  // facts, and a compact tail of the conversation so the agent has full
  // context when it has no prior session memory.
  const buildFreshPrompt = async (): Promise<string> => {
    const recalledBlock = await recall(false);
    const p: string[] = [];
    const history: string[] = [];
    for (const msg of messages) {
      if (msg === lastUserMsg) continue;
      const text = extractText(msg.content);
      if (!text) continue;
      if (msg.role === 'system' || isContextMessage(text)) {
        p.push(text);
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        // Use a wider window in the fresh form (12 exchanges, 700 chars each)
        // so a dropped-and-retried turn doesn't lose the thread.
        history.push(`${role}: ${text.slice(0, 700)}`);
      }
    }
    const recentHistory = history.slice(-12);
    if (recentHistory.length > 0) {
      p.push(`[Recent conversation for context — the agent session was just re-initialised; these are real exchanges you (the assistant) already had with this user. Treat them as your own memory and continue from the LATEST user message below:]\n${recentHistory.join('\n\n')}\n[End of recent conversation]`);
    }
    if (editsBlock) p.push(editsBlock);
    p.push(recalledBlock ? recalledBlock + '\n\n' + lastContent : lastContent);
    return p.filter(Boolean).join('\n\n');
  };

  const freshFallbackPrompt = await buildFreshPrompt();

  if (hasExistingSession) {
    // Resumed session: SDK already has the transcript — send only the
    // new user message (with retrieval hints) to keep input tokens lean.
    const envMsg = messages.find(
      (m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[Environment:'),
    );
    const parts: string[] = [];
    if (envMsg) parts.push(extractText(envMsg.content));
    parts.push('[Tool reminders: (1) `browser` CLI for controlling Chrome — use `browser connect` then navigate/click/fill/getText. (2) `gh` CLI for GitHub — already authenticated as <your-github-user>. Use `gh pr list`, `gh issue list`, `gh api repos/OWNER/REPO/contents/PATH` etc. When user mentions any website — use browser. When user mentions GitHub repos/PRs/issues — use gh CLI.]');
    if (editsBlock) parts.push(editsBlock);

    const combined = await recall(true);
    parts.push(combined ? combined + '\n\n' + lastContent : lastContent);
    return { prompt: parts.filter(Boolean).join('\n\n'), freshFallbackPrompt };
  }

  return { prompt: freshFallbackPrompt, freshFallbackPrompt };
}

/**
 * Build a one-paragraph "[Recent edits across machines]" block to prepend to
 * the prompt. Reads local + every peer's edit log. Best-effort: peer fetches
 * are bounded to 600ms each so a slow peer doesn't slow down chat.
 *
 * Skipped silently when there are no peers AND no local edits in the window.
 */
async function buildEditsAwarenessBlock(): Promise<string> {
  const since = Date.now() - 30 * 60_000; // last 30 min
  const limit = 25;

  const local = listRecentEdits({ since, limit });

  // Fetch peer edits in parallel with a short timeout
  const peers = listRemoteHosts();
  const peerLists: EditLogEntry[][] = await Promise.all(
    peers.map(async (peer) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 600);
      try {
        const params = new URLSearchParams({ since: String(since), limit: String(limit) });
        const url = peer.url.replace(/\/+$/, '') + '/api/edits/recent?' + params.toString();
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${peer.token}` },
          signal: ctrl.signal,
        });
        if (!res.ok) return [];
        const data = await res.json() as any;
        return (data.edits || []) as EditLogEntry[];
      } catch { return []; }
      finally { clearTimeout(t); }
    }),
  );

  const all = [...local, ...peerLists.flat()];
  if (all.length === 0) return '';

  // Newest first, capped
  all.sort((a, b) => b.ts - a.ts);
  const top = all.slice(0, 20);

  // Group by file so the agent can see "PC edited 3 things in X.tsx then 1 in Y.tsx"
  const lines = top.map(e => {
    const when = new Date(e.ts).toISOString().slice(11, 19);
    const stats = (e.linesAdded || e.linesRemoved)
      ? ` (+${e.linesAdded || 0}/-${e.linesRemoved || 0})`
      : '';
    return `  [${e.host} ${when}] ${e.op} ${e.file}${stats} — ${e.summary}`;
  }).join('\n');

  // Nudge: "X files were touched on the PC since you last touched them"
  const peerHostLabels = new Set(top.filter(e => peers.some(p => p.label === e.host)).map(e => e.host));
  const peerNote = peerHostLabels.size > 0
    ? `\n\n  Note: edits from peer machine(s) ${[...peerHostLabels].join(', ')} are listed. If you're about to touch any of those files, READ them first — they may have changed since your last context snapshot.`
    : '';

  return `[Recent edits across machines (last 30 min, ${top.length} entries):\n${lines}${peerNote}\n]`;
}

function isContextMessage(content: any): boolean {
  if (typeof content !== 'string') return false;
  return (
    content.startsWith('[Environment:') ||
    content.startsWith('[Context:') ||
    content.startsWith('[Linked Chat') ||
    content.startsWith('[Compressed context')
  );
}

function extractText(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
  }
  return JSON.stringify(content);
}
