/**
 * mc-docs MCP server — list/read/write/search shared notes & plans.
 *
 * Tools accept an optional `host` param. When omitted, ops run on the local
 * machine. When set to a peer id (e.g. "pc"), the tool calls the peer's
 * /api/docs endpoint over the Tailscale bridge using the bearer token from
 * ~/.config/mc-remote-hosts.json.
 *
 * Writes are LOCAL ONLY by design — to write to a peer's docs, the agent uses
 * mc_remote_ask to instruct the peer's agent (which then calls mc_docs_write
 * locally over there). Keeps the failure modes simple.
 */

import 'server-only';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { listDocs, readDoc, writeDoc, searchDocs, type DocType } from './service';
import { findHost, loadRemoteConfig } from '../remote/config';

const TypeSchema = z.enum(['note', 'plan']).describe('"note" for free-form, "plan" for structured');
const HostSchema = z.string().min(1).optional().describe('peer host id (e.g. "pc"); omit to query local machine');

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

const listTool = tool(
  'mc_docs_list',
  'List shared notes & plans. Pass `host` to query a peer machine; omit for local. Filter by `type` ("note" | "plan").',
  {
    host: HostSchema,
    type: TypeSchema.optional(),
    limit: z.number().int().min(1).max(200).default(50).describe('max results'),
  },
  async ({ host, type, limit }) => {
    let summaries;
    if (host) {
      const params = new URLSearchParams();
      if (type) params.set('type', type);
      if (limit) params.set('limit', String(limit));
      const res = await peerFetch(host, `/api/docs?${params.toString()}`);
      const data: any = await res.json();
      summaries = data.docs || [];
    } else {
      summaries = listDocs({ type: type as DocType | undefined, limit });
    }
    if (!summaries.length) {
      return { content: [{ type: 'text', text: `No ${type || 'docs'} on ${host || 'local machine'}.` }] };
    }
    const where = host ? `peer "${host}"` : 'local';
    const lines = summaries.map((d: any) =>
      `  - [${d.type}] ${d.id}  "${d.title}"  (${d.updated?.slice(0, 10)})${d.authorHost ? ` · by ${d.authorHost}` : ''}`,
    );
    return { content: [{ type: 'text', text: `${summaries.length} doc(s) on ${where}:\n${lines.join('\n')}` }] };
  },
);

const readToolDef = tool(
  'mc_docs_read',
  'Read the full body of a note or plan. Pass `host` for peer docs.',
  {
    id: z.string().min(1),
    host: HostSchema,
  },
  async ({ id, host }) => {
    let doc;
    if (host) {
      const res = await peerFetch(host, `/api/docs/${encodeURIComponent(id)}`);
      const data: any = await res.json();
      doc = data.doc;
    } else {
      doc = readDoc(id);
    }
    if (!doc) return { content: [{ type: 'text', text: `Doc not found: ${host || 'local'}/${id}` }] };
    return {
      content: [{ type: 'text', text:
        `# ${doc.title}\n` +
        `_type: ${doc.type} · updated: ${doc.updated} · author: ${doc.authorHost || '?'}` +
        `${doc.tags?.length ? ' · tags: ' + doc.tags.join(', ') : ''}_\n\n` +
        doc.content,
      }],
    };
  },
);

const writeToolDef = tool(
  'mc_docs_write',
  'Create or update a note or plan on the LOCAL machine. To write to a peer, use mc_remote_ask to instruct the peer agent. Returns the canonical id which can be shared with the user for later reference.',
  {
    type: TypeSchema,
    title: z.string().min(1).max(200),
    content: z.string().describe('full markdown body'),
    id: z.string().optional().describe('omit to create; pass an existing id to update'),
    tags: z.array(z.string()).optional(),
    chatOrigin: z.string().optional().describe('sessionKey of the chat producing this doc'),
  },
  async ({ type, title, content, id, tags, chatOrigin }) => {
    const cfg = loadRemoteConfig();
    const doc = writeDoc({
      type,
      title,
      content,
      id,
      tags,
      chatOrigin,
      authorHost: cfg?.myLabel || 'local',
    });
    return {
      content: [{ type: 'text', text: `✓ Saved ${doc.type} "${doc.title}" → id: ${doc.id} (${cfg?.myLabel || 'local'})` }],
    };
  },
);

const searchToolDef = tool(
  'mc_docs_search',
  'Search notes & plans by title, tag, or body content. Pass `host` for peer docs.',
  {
    query: z.string().min(1),
    host: HostSchema,
    type: TypeSchema.optional(),
    limit: z.number().int().min(1).max(50).default(15),
  },
  async ({ query, host, type, limit }) => {
    let summaries;
    if (host) {
      // Peer doesn't expose a search endpoint, so fetch list + filter client-side
      const params = new URLSearchParams();
      if (type) params.set('type', type);
      const res = await peerFetch(host, `/api/docs?${params.toString()}`);
      const data: any = await res.json();
      const q = query.toLowerCase();
      summaries = (data.docs || [])
        .filter((d: any) => d.title.toLowerCase().includes(q) || (d.tags || []).some((t: string) => t.toLowerCase().includes(q)))
        .slice(0, limit);
    } else {
      summaries = searchDocs(query, { type: type as DocType | undefined, limit });
    }
    if (!summaries.length) {
      return { content: [{ type: 'text', text: `No matches for "${query}" on ${host || 'local'}.` }] };
    }
    const lines = summaries.map((d: any) =>
      `  - [${d.type}] ${d.id}  "${d.title}"${d.authorHost ? ` · ${d.authorHost}` : ''}`);
    return { content: [{ type: 'text', text: `${summaries.length} match(es) for "${query}" on ${host || 'local'}:\n${lines.join('\n')}` }] };
  },
);

export const DOCS_TOOL_NAMES = [
  'mcp__mc-docs__mc_docs_list',
  'mcp__mc-docs__mc_docs_read',
  'mcp__mc-docs__mc_docs_write',
  'mcp__mc-docs__mc_docs_search',
];

let cachedServer: ReturnType<typeof createSdkMcpServer> | null = null;
export function createDocsMcpServer() {
  if (cachedServer) return cachedServer;
  cachedServer = createSdkMcpServer({
    name: 'mc-docs',
    version: '1.0.0',
    tools: [listTool, readToolDef, writeToolDef, searchToolDef],
  });
  return cachedServer;
}
