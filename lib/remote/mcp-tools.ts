/**
 * mc-remote MCP server — tools that let the local chat agent talk to a peer
 * MC instance over Tailscale. Registered alongside mc-vault / mc-skills /
 * mc-memory in claude-chat-bridge.ts.
 *
 * Tools:
 *   mc_remote_list_hosts       — see who I can talk to
 *   mc_remote_list_chats       — list active chats on a peer
 *   mc_remote_ask              — send a message, get the assistant reply (streams over SSE)
 *   mc_remote_read             — peek at the last N turns of a peer chat
 *   mc_remote_recover          — fetch results of in-flight peer calls after a caller restart
 */

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { findHost, listHosts } from './config';
import * as broadcast from '../chat-broadcast';

// Outbound-pending dir — when askTool fires a peer call, we persist
// metadata here so a caller-side restart (or a user-initiated recovery)
// can find in-flight calls and fetch their results via mc_remote_recover.
//
// Namespaced into data/pending/remote-chat/out/ so the cleanup sweep can
// target only our files and never touch the main chat bridge's
// pending-<requestId>.json files (the bridge writes them directly at the
// data/pending/ root with requestIds that for remote callers START WITH
// `remote-req-`, so a "starts with remote-" filter would collide).
const OUTBOUND_DIR = path.join(process.cwd(), 'data', 'pending', 'remote-chat', 'out');
const INBOUND_DIR = path.join(process.cwd(), 'data', 'pending', 'remote-chat');
function ensureOutboundDir(): void {
  try { fs.mkdirSync(OUTBOUND_DIR, { recursive: true }); } catch { /* exists */ }
}
function outboundPath(requestId: string): string {
  return path.join(OUTBOUND_DIR, `${requestId}.json`);
}
interface OutboundPending {
  requestId: string;
  host: string;
  parentChatId?: string;
  message: string;
  sentAt: number;
  status: 'in-flight' | 'done' | 'error';
  error?: string;
  completedAt?: number;
}
function writeOutbound(state: OutboundPending): void {
  try {
    ensureOutboundDir();
    fs.writeFileSync(outboundPath(state.requestId), JSON.stringify(state), 'utf-8');
  } catch (e: any) {
    console.warn('[mc_remote_ask] outbound persist failed requestId=%s err=%s',
      state.requestId, e?.message ?? String(e));
  }
}
function deleteOutbound(requestId: string): void {
  try { fs.unlinkSync(outboundPath(requestId)); } catch { /* ignore */ }
}
function listOutbound(): OutboundPending[] {
  try {
    ensureOutboundDir();
    const files = fs.readdirSync(OUTBOUND_DIR).filter(f => f.endsWith('.json'));
    const out: OutboundPending[] = [];
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(OUTBOUND_DIR, f), 'utf-8');
        out.push(JSON.parse(raw));
      } catch { /* skip corrupt */ }
    }
    return out.sort((a, b) => b.sentAt - a.sentAt);
  } catch { return []; }
}

/**
 * Periodic sweep of stale pending files. Two retention policies:
 *   • done/error records → 1 hour (caller has had time to recover by then)
 *   • in-flight records → 7 days (rare — only orphaned by hard crashes; we
 *     keep these long enough that a user coming back from vacation can still
 *     find them in mc_remote_recover)
 *
 * Targets BOTH the outbound (caller-side remote-out-*.json) and the inbound
 * (peer-side remote-<requestId>.json without -out- in the name) files. Other
 * files in data/pending/ are NOT touched — the main chat bridge has its own
 * pending-<requestId>.json files that this must never delete.
 *
 * Idempotent + safe to call concurrently with read/write operations: unlinks
 * one file at a time, ignores ENOENT (another sweep raced us), tolerates
 * unparseable files (skip).
 *
 * Returns counts for log visibility.
 */
export function sweepRemotePending(): { kept: number; pruned: number; errors: number } {
  const now = Date.now();
  const DONE_TTL_MS = 60 * 60 * 1000;          // 1 hour
  const IN_FLIGHT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  let kept = 0, pruned = 0, errors = 0;

  const sweepDir = (dir: string, kind: 'inbound' | 'outbound') => {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch (e: any) {
      // Dir doesn't exist yet — nothing to sweep. Don't count as error.
      if (e?.code === 'ENOENT') return;
      errors++;
      return;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const raw = fs.readFileSync(full, 'utf-8');
        const state = JSON.parse(raw);
        // Outbound (caller-side) shape uses status/sentAt/completedAt;
        // inbound (peer-side) shape uses done/updatedAt/completedAt.
        const isTerminal = kind === 'outbound'
          ? (state.status === 'done' || state.status === 'error')
          : !!state.done;
        const lastTouch = (state.updatedAt ?? state.completedAt ?? state.sentAt ?? state.startedAt) || 0;
        const ageMs = now - lastTouch;
        const ttl = isTerminal ? DONE_TTL_MS : IN_FLIGHT_TTL_MS;
        if (ageMs > ttl) {
          fs.unlinkSync(full);
          pruned++;
        } else {
          kept++;
        }
      } catch (e: any) {
        if (e?.code === 'ENOENT') continue; // raced
        errors++;
      }
    }
  };

  // Outbound first (deeper path) so the inbound walk doesn't also
  // recurse into out/. Both dirs are siblings in the layout:
  //   data/pending/remote-chat/<requestId>.json    ← inbound (peer)
  //   data/pending/remote-chat/out/<requestId>.json ← outbound (caller)
  sweepDir(OUTBOUND_DIR, 'outbound');

  // For the inbound dir we have to filter out the `out` subdirectory
  // entry that readdirSync would include — readdirSync returns it as a
  // directory, but the `.endsWith('.json')` filter already strips it.
  sweepDir(INBOUND_DIR, 'inbound');

  return { kept, pruned, errors };
}

/** Boot one periodic sweep (every 30 minutes) — called from instrumentation.ts.
 *  Uses a global guard so HMR doesn't stack multiple intervals. */
const SWEEP_INSTALL_KEY = Symbol.for('mc.remote.sweepInstalled');
export function startRemotePendingSweep(): void {
  if ((globalThis as any)[SWEEP_INSTALL_KEY]) return;
  (globalThis as any)[SWEEP_INSTALL_KEY] = true;
  const tick = () => {
    try {
      const r = sweepRemotePending();
      if (r.pruned > 0 || r.errors > 0) {
        console.log('[remote-sweep] pruned=%d kept=%d errors=%d', r.pruned, r.kept, r.errors);
      }
    } catch (e: any) {
      console.warn('[remote-sweep] failed: %s', e?.message ?? String(e));
    }
  };
  // First sweep at +60s (let MC finish booting), then every 30 minutes.
  setTimeout(() => { tick(); setInterval(tick, 30 * 60 * 1000); }, 60_000);
}

// Generate the requestId on the caller side so we can persist it BEFORE
// the fetch starts (so a crash between send and recv still has a record).
// The peer mirrors this requestId for its own pending file, giving us a
// clean key to recover by.
function makeRequestId(): string {
  return `remote-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const RemoteHostIdSchema = z.string().min(1).describe('id of the peer MC, e.g. "pc"');

async function peerFetch(hostId: string, pathname: string, init?: RequestInit) {
  const host = findHost(hostId);
  if (!host) throw new Error(`unknown host id: ${hostId}`);
  const url = host.url.replace(/\/+$/, '') + pathname;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${host.token}`,
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`peer ${hostId} ${pathname} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}

const listHostsTool = tool(
  'mc_remote_list_hosts',
  'List peer Mission Control instances configured for cross-machine chat. Returns each host\'s id, label, and url.',
  {},
  async () => {
    const hosts = listHosts().map(h => ({ id: h.id, label: h.label, url: h.url }));
    return {
      content: [{ type: 'text', text: hosts.length === 0
        ? 'No peer MC hosts configured. Edit ~/.config/mc-remote-hosts.json to add one.'
        : 'Configured peers:\n' + hosts.map(h => `  - ${h.id} (${h.label}): ${h.url}`).join('\n') }],
    };
  },
);

const listChatsTool = tool(
  'mc_remote_list_chats',
  'List active chat sessions on a peer Mission Control instance. Returns id, name, last-update for each.',
  { host: RemoteHostIdSchema },
  async ({ host }) => {
    const res = await peerFetch(host, '/api/chats');
    const data: any = await res.json();
    const chats = (Array.isArray(data) ? data : data?.chats || []).slice(0, 30);
    if (chats.length === 0) {
      return { content: [{ type: 'text', text: `No chats on ${host}.` }] };
    }
    const lines = chats.map((c: any) => {
      const updated = c.updatedAt ? new Date(c.updatedAt).toISOString() : '?';
      return `  - ${c.name || c.id} (${(c.id || '').slice(0, 8)}) — ${updated}`;
    });
    return { content: [{ type: 'text', text: `Chats on ${host}:\n${lines.join('\n')}` }] };
  },
);

const buildAskTool = (parentChatId?: string) => tool(
  'mc_remote_ask',
  'Send a message to a peer MC instance and get the assistant reply back. The peer\'s agent runs the message in its own workspace with its own files and tools, and returns the final text. Use this when you need the OTHER machine to do something or answer something only it can know.',
  {
    host: RemoteHostIdSchema,
    message: z.string().min(1).describe('the message to send to the peer agent'),
    chatId: z.string().optional().describe('optional — pass to continue an existing peer chat; omit to start a fresh one'),
    model: z.string().optional().describe('optional — override the peer\'s default model (e.g. "claude-haiku-4-5")'),
  },
  async ({ host, message, chatId, model }) => {
    // We negotiate for an SSE response so the peer's data keeps flowing
    // across the TCP connection. Even a 20-minute peer turn no longer trips
    // a router/NAT/proxy idle timeout because bytes arrive every few seconds
    // (keepalive frames every 15s minimum). The MCP tool itself still
    // returns a single final string to the chat agent — the streaming is
    // about transport robustness, not surfacing live deltas to the agent.
    const peerLabel = findHost(host)?.label || host;

    // Generate the requestId locally and persist outbound state BEFORE we
    // fire. This makes the call resumable: if this MC restarts before the
    // peer finishes, mc_remote_recover can find the requestId on disk and
    // fetch the eventual result from the peer's /result endpoint.
    const requestId = makeRequestId();
    writeOutbound({
      requestId, host, parentChatId, message,
      sentAt: Date.now(), status: 'in-flight',
    });

    // If we're being called from within a real chat turn, push a one-shot
    // status event into that chat's broadcast so the user sees the peer
    // call kick off in the chat UI without waiting for the final reply.
    if (parentChatId) {
      try {
        broadcast.emitEvent(parentChatId, {
          type: 'remote_progress',
          phase: 'start',
          host, peerLabel, requestId,
          messagePreview: message.slice(0, 120),
          ts: Date.now(),
        });
      } catch { /* broadcast failures must not block the tool call */ }
    }

    let res: Response;
    try {
      res = await peerFetch(host, '/api/remote-chat', {
        method: 'POST',
        headers: { 'Accept': 'text/event-stream' },
        body: JSON.stringify({ message, chatId, model, requestId }),
      });
    } catch (e: any) {
      // Network-level failure — peer unreachable, DNS, refused, etc.
      writeOutbound({
        requestId, host, parentChatId, message,
        sentAt: Date.now(), status: 'error',
        error: e?.message ?? String(e),
        completedAt: Date.now(),
      });
      if (parentChatId) {
        try {
          broadcast.emitEvent(parentChatId, {
            type: 'remote_progress', phase: 'error',
            host, peerLabel, requestId,
            error: e?.message ?? String(e), ts: Date.now(),
          });
        } catch { /* ignore */ }
      }
      throw e;
    }

    const contentType = res.headers.get('content-type') || '';
    const isSse = contentType.includes('text/event-stream');

    if (!isSse) {
      // Peer is an older build that ignores the Accept header and returned
      // JSON. Fall back to legacy single-shot parsing so this still works
      // during the rollout window when one machine has the new code and
      // the other doesn't.
      const data: any = await res.json();
      if (!data?.ok) {
        writeOutbound({
          requestId, host, parentChatId, message,
          sentAt: Date.now(), status: 'error',
          error: JSON.stringify(data).slice(0, 200),
          completedAt: Date.now(),
        });
        throw new Error(`peer ${host} returned: ${JSON.stringify(data).slice(0, 200)}`);
      }
      const reply = data.assistantText || '(no reply)';
      // Clean up outbound — call succeeded.
      deleteOutbound(requestId);
      if (parentChatId) {
        try {
          broadcast.emitEvent(parentChatId, {
            type: 'remote_progress', phase: 'done',
            host, peerLabel, requestId,
            chars: data.chars ?? reply.length,
            transport: 'json',
            ts: Date.now(),
          });
        } catch { /* ignore */ }
      }
      return {
        content: [
          {
            type: 'text',
            text: `[${peerLabel}] reply (chatId ${(data.chatId || '').slice(0, 8)}, ${data.chars} chars, legacy-json):\n\n${reply}`,
          },
        ],
      };
    }

    // SSE consumer. We don't surface intermediate events to the chat agent
    // (the MCP tool() return is single-shot), but we DO log a one-liner per
    // minute to pm2 logs so a human watching can confirm the peer is still
    // making progress on long turns.
    if (!res.body) throw new Error(`peer ${host} returned SSE without body`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let doneEvent: any = null;
    let errorMsg: string | null = null;
    let lastProgressLog = Date.now();
    let upstreamBytes = 0;
    let upstreamFrames = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        upstreamBytes += value.byteLength;
        buf += dec.decode(value, { stream: true });

        // SSE event parsing — events are `event: <name>\ndata: <json>\n\n`
        // or just `data: <json>\n\n` for default-named events. Comment lines
        // start with `:` and we skip them (they're keepalives).
        let blankLine: number;
        while ((blankLine = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, blankLine);
          buf = buf.slice(blankLine + 2);
          if (!block.trim()) continue;

          let eventName = 'message';
          let dataLine: string | null = null;
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue; // comment / keepalive
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLine = (dataLine ?? '') + line.slice(5).trim();
          }
          if (!dataLine) continue;
          upstreamFrames++;

          if (eventName === 'remote-done') {
            try { doneEvent = JSON.parse(dataLine); } catch { /* ignore */ }
            // We could break here, but we'll let the upstream close
            // naturally so the route can clean up its keepalive.
          } else if (eventName === 'remote-error') {
            try { const p = JSON.parse(dataLine); errorMsg = p?.message || 'peer error'; } catch { errorMsg = 'peer error (unparseable)'; }
          }
          // Other events (remote-start, raw upstream chat.completion.chunk,
          // status, heartbeat, subagent, usage, …) are just transport
          // signals — we count them for the progress log but don't surface
          // them to the agent.

          const now = Date.now();
          if (now - lastProgressLog > 60_000) {
            console.log('[mc_remote_ask] still streaming from %s: %d frames, %d bytes',
              peerLabel, upstreamFrames, upstreamBytes);
            lastProgressLog = now;
            // Also push a progress beat into the parent chat so the user
            // knows the peer is still working on a long call.
            if (parentChatId) {
              try {
                broadcast.emitEvent(parentChatId, {
                  type: 'remote_progress', phase: 'streaming',
                  host, peerLabel, requestId,
                  frames: upstreamFrames, bytes: upstreamBytes,
                  ts: now,
                });
              } catch { /* ignore */ }
            }
          }
        }
      }
    } catch (e: any) {
      writeOutbound({
        requestId, host, parentChatId, message,
        sentAt: Date.now(), status: 'error',
        error: e?.message ?? String(e),
        completedAt: Date.now(),
      });
      throw new Error(`peer ${host} stream error: ${e?.message ?? String(e)}`);
    }

    if (errorMsg) {
      writeOutbound({
        requestId, host, parentChatId, message,
        sentAt: Date.now(), status: 'error',
        error: errorMsg, completedAt: Date.now(),
      });
      if (parentChatId) {
        try {
          broadcast.emitEvent(parentChatId, {
            type: 'remote_progress', phase: 'error',
            host, peerLabel, requestId, error: errorMsg, ts: Date.now(),
          });
        } catch { /* ignore */ }
      }
      throw new Error(`peer ${host} reported: ${errorMsg}`);
    }
    if (!doneEvent) {
      // Stream ended without a remote-done event. Treat as truncated —
      // surface what we got with a warning so the agent can decide what
      // to do (retry, ask differently, give up). The outbound file is
      // KEPT so mc_remote_recover can try to fetch the eventual result
      // from the peer's /result endpoint — the peer may still finish.
      const err = `peer ${host} stream closed without remote-done (${upstreamFrames} frames, ${upstreamBytes} bytes received) — try mc_remote_recover requestId=${requestId}`;
      writeOutbound({
        requestId, host, parentChatId, message,
        sentAt: Date.now(), status: 'in-flight', // keep for recovery
        error: 'stream closed prematurely',
      });
      throw new Error(err);
    }

    // Success — delete the outbound record.
    deleteOutbound(requestId);
    if (parentChatId) {
      try {
        broadcast.emitEvent(parentChatId, {
          type: 'remote_progress', phase: 'done',
          host, peerLabel, requestId,
          chars: doneEvent.chars,
          frames: upstreamFrames, bytes: upstreamBytes,
          transport: 'sse', ts: Date.now(),
        });
      } catch { /* ignore */ }
    }

    const reply = doneEvent.assistantText || '(no reply)';
    return {
      content: [
        {
          type: 'text',
          text: `[${peerLabel}] reply (chatId ${(doneEvent.chatId || '').slice(0, 8)}, ${doneEvent.chars} chars, ${upstreamFrames} stream frames):\n\n${reply}`,
        },
      ],
    };
  },
);
const askTool = buildAskTool();

const readTool = tool(
  'mc_remote_read',
  'Read the last N messages of a chat on a peer MC instance — for sharing context across machines without re-asking.',
  {
    host: RemoteHostIdSchema,
    chatId: z.string().min(1).describe('the peer chat id'),
    lastN: z.number().int().min(1).max(50).default(10).describe('how many recent messages to fetch'),
  },
  async ({ host, chatId, lastN }) => {
    const res = await peerFetch(host, `/api/chats?id=${encodeURIComponent(chatId)}`);
    const data: any = await res.json();
    const chat = Array.isArray(data) ? data.find((c: any) => c.id === chatId) : data;
    const msgs = (chat?.messages || []).slice(-lastN);
    if (msgs.length === 0) {
      return { content: [{ type: 'text', text: `No messages in ${host}/${chatId.slice(0,8)}.` }] };
    }
    const lines = msgs.map((m: any) => {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${m.role}] ${text.slice(0, 600)}`;
    });
    return { content: [{ type: 'text', text: `Last ${msgs.length} from ${host}/${chatId.slice(0,8)}:\n\n${lines.join('\n\n')}` }] };
  },
);

const recoverTool = tool(
  'mc_remote_recover',
  'Recover the result of an in-flight peer call after a caller-side disconnect or MC restart. Call with no args to list all in-flight outbound calls on this machine; call with a requestId to fetch the peer\'s persisted result (whether in-progress or finished). Use when a previous mc_remote_ask was interrupted.',
  {
    requestId: z.string().optional().describe('the requestId from the interrupted call. Omit to list all in-flight outbound calls.'),
  },
  async ({ requestId }) => {
    if (!requestId) {
      const pending = listOutbound();
      if (pending.length === 0) {
        return { content: [{ type: 'text', text: 'No in-flight outbound peer calls on this machine.' }] };
      }
      const lines = pending.map(p => {
        const ageMin = Math.round((Date.now() - p.sentAt) / 60_000);
        const labelHost = findHost(p.host)?.label || p.host;
        return `  - ${p.requestId} → ${labelHost} (${p.status}, ${ageMin}m ago)\n      msg: ${p.message.slice(0, 100)}${p.message.length > 100 ? '…' : ''}${p.error ? `\n      err: ${p.error}` : ''}`;
      });
      return {
        content: [{
          type: 'text',
          text: `Outbound peer calls on disk:\n${lines.join('\n')}\n\nPass requestId to mc_remote_recover to fetch the peer's persisted result.`,
        }],
      };
    }

    // Fetch peer's persisted result by requestId.
    const local = listOutbound().find(p => p.requestId === requestId);
    if (!local) {
      return {
        content: [{
          type: 'text',
          text: `No outbound record for requestId=${requestId} on this machine. The call may have been cleaned up already, or the requestId is from a different machine.`,
        }],
      };
    }
    const peerLabel = findHost(local.host)?.label || local.host;
    let res: Response;
    try {
      res = await peerFetch(local.host, `/api/remote-chat/result?requestId=${encodeURIComponent(requestId)}`);
    } catch (e: any) {
      return {
        content: [{ type: 'text', text: `Failed to reach peer ${peerLabel}: ${e?.message ?? String(e)}` }],
      };
    }
    const data: any = await res.json();
    if (!data?.ok) {
      return { content: [{ type: 'text', text: `Peer ${peerLabel} response: ${JSON.stringify(data).slice(0, 400)}` }] };
    }

    // Update local outbound state to match.
    if (data.done) {
      writeOutbound({
        requestId, host: local.host,
        parentChatId: local.parentChatId,
        message: local.message,
        sentAt: local.sentAt,
        status: data.error ? 'error' : 'done',
        error: data.error,
        completedAt: data.completedAt,
      });
      if (!data.error) {
        // Successfully recovered the final result; remove outbound record.
        // We do this AFTER writing so a crash between read and write
        // doesn't lose state — better to leave a stale "done" file than
        // to silently drop the result.
        deleteOutbound(requestId);
      }
    }

    if (data.done && data.error) {
      return {
        content: [{
          type: 'text',
          text: `[${peerLabel}] requestId=${requestId} FAILED on peer: ${data.error}\n\nPartial assistantText (${data.chars} chars):\n${data.assistantText || '(none)'}`,
        }],
      };
    }
    if (data.done) {
      const reply = data.assistantText || '(no reply)';
      return {
        content: [{
          type: 'text',
          text: `[${peerLabel}] requestId=${requestId} DONE (${data.chars} chars, recovered from disk):\n\n${reply}`,
        }],
      };
    }
    return {
      content: [{
        type: 'text',
        text: `[${peerLabel}] requestId=${requestId} STILL IN PROGRESS — ${data.chars} chars so far (${data.framesSeen} frames, ${data.bytesSeen} bytes). Call mc_remote_recover again in a bit.\n\nPartial assistantText:\n${data.assistantText || '(none yet)'}`,
      }],
    };
  },
);

export const REMOTE_TOOL_NAMES = [
  'mcp__mc-remote__mc_remote_list_hosts',
  'mcp__mc-remote__mc_remote_list_chats',
  'mcp__mc-remote__mc_remote_ask',
  'mcp__mc-remote__mc_remote_read',
  'mcp__mc-remote__mc_remote_recover',
];

let cachedServer: ReturnType<typeof createSdkMcpServer> | null = null;

/**
 * Factory for the mc-remote MCP server.
 *
 * @param parentChatId  Optional. When supplied, the askTool will broadcast
 *                      progress events to this chat's listeners via the
 *                      chat-broadcast layer (event type `remote_progress`,
 *                      phases start | streaming | done | error). Allows the
 *                      chat UI to show live peer-call status without the
 *                      MCP tool needing to return multiple result blocks.
 *
 * Without a chatId we fall back to the module-cached server (legacy callers
 * that don't thread chat context through, like the listHosts probe).
 */
export function createRemoteMcpServer(parentChatId?: string) {
  if (!parentChatId) {
    if (cachedServer) return cachedServer;
    cachedServer = createSdkMcpServer({
      name: 'mc-remote',
      version: '1.0.0',
      tools: [listHostsTool, listChatsTool, askTool, readTool, recoverTool],
    });
    return cachedServer;
  }
  // Per-chat server so the closures inside askTool can capture parentChatId
  // for progress broadcasting. Light object; we don't cache these (the bridge
  // already LRU-caches MCP servers by sessionKey upstream).
  const askWithChat = buildAskTool(parentChatId);
  return createSdkMcpServer({
    name: 'mc-remote',
    version: '1.0.0',
    tools: [listHostsTool, listChatsTool, askWithChat, readTool, recoverTool],
  });
}
