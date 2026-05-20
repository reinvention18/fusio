/**
 * mc-edits MCP server — agents query recent file edits across machines.
 *
 * Tools:
 *   mc_edits_recent({host?, file?, sinceMinutes?, limit?})
 *     - omit host:  local edits
 *     - host:"pc":  peer's edits over the bridge
 *     - omit both:  local + every peer, merged + sorted newest first
 */

import 'server-only';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { listRecentEdits, type EditLogEntry } from '../edit-log';
import { findHost, listHosts, loadRemoteConfig } from '../remote/config';

async function peerEdits(hostId: string, since?: number, file?: string, limit = 50): Promise<EditLogEntry[]> {
  const host = findHost(hostId);
  if (!host) throw new Error(`unknown host id: ${hostId}`);
  const params = new URLSearchParams();
  if (since) params.set('since', String(since));
  if (file) params.set('file', file);
  if (limit) params.set('limit', String(limit));
  const url = host.url.replace(/\/+$/, '') + '/api/edits/recent?' + params.toString();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${host.token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`peer ${hostId} → ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json() as any;
  return data.edits || [];
}

function fmt(e: EditLogEntry): string {
  const when = new Date(e.ts).toISOString().slice(11, 19);
  const stats = (e.linesAdded || e.linesRemoved)
    ? ` (+${e.linesAdded || 0}/-${e.linesRemoved || 0})`
    : '';
  return `[${e.host} ${when}] ${e.op} ${e.file}${stats} - ${e.summary}`;
}

const recentTool = tool(
  'mc_edits_recent',
  "Show recent file edits across machines. Lets you see what the peer agent (or your earlier self) just touched, so you can read updated files BEFORE editing them and avoid stomping on fresh changes.\n\nUsage:\n  - Omit `host` and pass nothing: returns LOCAL + every PEER, merged newest-first.\n  - Pass `host: \"pc\"`: only that peer's edits.\n  - Pass `file`: only edits to that exact file path.\n  - Pass `sinceMinutes`: only edits in the last N minutes.\n\nReturns each edit's host, time, op, file, +/- lines, and a 1-sentence summary.",
  {
    host: z.string().optional().describe("peer host id (e.g. 'pc'), 'local' for local-only, or omit for ALL machines merged"),
    file: z.string().optional().describe('only return edits to this exact path'),
    sinceMinutes: z.number().int().min(1).max(2880).default(30).describe('how far back to look (default 30 min)'),
    limit: z.number().int().min(1).max(200).default(50),
  },
  async ({ host, file, sinceMinutes, limit }) => {
    const since = Date.now() - sinceMinutes * 60_000;
    let edits: EditLogEntry[] = [];

    if (host === 'local') {
      edits = listRecentEdits({ since, file, limit });
    } else if (host) {
      edits = await peerEdits(host, since, file, limit);
    } else {
      // Merge local + every peer
      const local = listRecentEdits({ since, file, limit });
      const peerLists = await Promise.all(
        listHosts().map(h => peerEdits(h.id, since, file, limit).catch(() => [] as EditLogEntry[])),
      );
      edits = [...local, ...peerLists.flat()];
      edits.sort((a, b) => b.ts - a.ts);
      edits = edits.slice(0, limit);
    }

    if (edits.length === 0) {
      return { content: [{ type: 'text' as const, text: `No edits in the last ${sinceMinutes} minutes${file ? ` to ${file}` : ''}.` }] };
    }
    const lines = edits.map(fmt);
    const myLabel = loadRemoteConfig()?.myLabel || 'local';
    const header = host === 'local'
      ? `${edits.length} local edit(s) on ${myLabel} (last ${sinceMinutes}min):`
      : host
      ? `${edits.length} edit(s) on peer ${host} (last ${sinceMinutes}min):`
      : `${edits.length} edit(s) across all machines (last ${sinceMinutes}min):`;
    return { content: [{ type: 'text' as const, text: header + '\n' + lines.join('\n') }] };
  },
);

export const EDITS_TOOL_NAMES = ['mcp__mc-edits__mc_edits_recent'];

let cachedServer: ReturnType<typeof createSdkMcpServer> | null = null;
export function createEditsMcpServer() {
  if (cachedServer) return cachedServer;
  cachedServer = createSdkMcpServer({
    name: 'mc-edits',
    version: '1.0.0',
    tools: [recentTool],
  });
  return cachedServer;
}
