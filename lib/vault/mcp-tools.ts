/**
 * vault/mcp-tools — MCP server exposing vault_search / vault_read / vault_write
 * so the agent can read and write Obsidian-compatible markdown directly.
 *
 * Obsidian syntax rules (wikilinks, frontmatter, callouts) are taught by the
 * kepano obsidian-skills SKILL.md files dropped into the workspace skills dir.
 * This server only enforces syntax on writes (frontmatter formatting).
 */

import 'server-only';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  isConfigured,
  listNotes,
  readNote,
  writeNote,
  searchVault,
} from './service';
import { getVaultSettings } from './config';
import { findHost } from '../remote/config';

// Cross-MC peer fetch helper — same pattern as mc-docs / mc-remote.
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

export function createVaultMcpServer() {
  const t = <S extends z.ZodRawShape>(
    name: string,
    desc: string,
    schema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
  ) => tool(name, desc, schema, handler as any);

  const tools = [
    t(
      'vault_search',
      "Full-text search across an Obsidian vault. Returns paths + line + preview. Use before vault_read to locate relevant notes. Pass `host` to search a peer's vault over the bridge.",
      {
        query: z.string().min(2),
        limit: z.number().int().min(1).max(100).default(20),
        host: z.string().optional().describe('peer host id (e.g. "pc"); omit to search local vault'),
      },
      async ({ query, limit, host }) => {
        if (host) {
          const params = new URLSearchParams({ q: query, limit: String(limit) });
          const res = await peerFetch(host, `/api/vault/search?${params.toString()}`);
          const data: any = await res.json();
          const hits = data.hits || [];
          if (hits.length === 0) return { content: [{ type: 'text' as const, text: `No vault notes on peer "${host}" match "${query}".` }] };
          const lines = hits.map((h: any) => `[${host}] ${h.path}:${h.line} — ${(h.preview || '').slice(0, 180)}`);
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        if (!isConfigured()) return { content: [{ type: 'text' as const, text: 'Local vault is not configured. Pass `host` to search a peer\'s vault.' }] };
        const hits = searchVault(query, { limit });
        if (hits.length === 0) return { content: [{ type: 'text' as const, text: `No local vault notes match "${query}".` }] };
        const lines = hits.map(h => `${h.path}:${h.line} — ${h.preview.slice(0, 180)}`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    ),
    t(
      'vault_list',
      'List notes in a vault, most-recently-modified first. Optional prefix filter. Pass `host` for peer\'s vault.',
      {
        prefix: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(50),
        host: z.string().optional(),
      },
      async ({ prefix, limit, host }) => {
        if (host) {
          const params = new URLSearchParams({ limit: String(limit) });
          if (prefix) params.set('prefix', prefix);
          const res = await peerFetch(host, `/api/vault/notes?${params.toString()}`);
          const data: any = await res.json();
          const notes = data.notes || [];
          if (notes.length === 0) return { content: [{ type: 'text' as const, text: `Peer "${host}" vault is empty.` }] };
          const lines = notes.map((n: any) => {
            const when = n.mtime ? new Date(n.mtime).toISOString().slice(0, 10) : '?';
            return `[${host}] ${when}  ${n.path}${(n.tags || []).length ? `  [${n.tags.join(', ')}]` : ''}`;
          });
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
        if (!isConfigured()) return { content: [{ type: 'text' as const, text: 'Local vault is not configured.' }] };
        const notes = listNotes({ prefix, limit });
        if (notes.length === 0) return { content: [{ type: 'text' as const, text: 'Local vault is empty.' }] };
        const lines = notes.map(n => {
          const when = new Date(n.mtime).toISOString().slice(0, 10);
          return `${when}  ${n.path}${n.tags.length ? `  [${n.tags.join(', ')}]` : ''}`;
        });
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    ),
    t(
      'vault_read',
      'Read a single note from a vault by path (relative to vault root, .md optional). Returns frontmatter + body. Pass `host` for peer.',
      {
        path: z.string().min(1),
        host: z.string().optional(),
      },
      async ({ path, host }) => {
        if (host) {
          const res = await peerFetch(host, `/api/vault/note?path=${encodeURIComponent(path)}`);
          const data: any = await res.json();
          const note = data.note;
          if (!note) return { content: [{ type: 'text' as const, text: `Note not found on peer "${host}": ${path}` }] };
          const fmStr = Object.keys(note.frontmatter || {}).length
            ? `\n---\n${Object.entries(note.frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n`
            : '';
          return { content: [{ type: 'text' as const, text: `[${host}] path: ${note.path}\n${fmStr}\n${note.body}` }] };
        }
        if (!isConfigured()) return { content: [{ type: 'text' as const, text: 'Local vault is not configured.' }] };
        try {
          const note = readNote(path);
          const fmStr = Object.keys(note.frontmatter).length
            ? `\n---\n${Object.entries(note.frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n`
            : '';
          return { content: [{ type: 'text' as const, text: `path: ${note.path}\n${fmStr}\n${note.body}` }] };
        } catch (e) {
          return { content: [{ type: 'text' as const, text: `Error reading "${path}": ${(e as Error).message}` }] };
        }
      },
    ),
    t(
      'vault_write',
      'Write a note to the vault (Obsidian-flavored markdown). Use wikilinks `[[Note Name]]` not markdown links for vault refs. Use the obsidian-markdown skill rules. Pass frontmatter separately; the tool serializes it.',
      {
        path: z.string().min(1).describe('Relative path in vault. Can be "folder/Subfolder/Note Name" (no .md needed). If no folder given, saved under "inbox/" (Karpathy wiki — captures land here for triage).'),
        content: z.string().min(1).describe('Markdown body (no frontmatter — pass that separately).'),
        frontmatter: z.record(z.string(), z.any()).optional(),
        overwrite: z.boolean().default(false).describe('When false (default), a timestamp suffix is appended if the path already exists.'),
      },
      async ({ path, content, frontmatter, overwrite }) => {
        if (!isConfigured()) return { content: [{ type: 'text' as const, text: 'Vault is not configured.' }] };
        try {
          const note = writeNote({ path, content, frontmatter, overwrite });
          return { content: [{ type: 'text' as const, text: `Wrote ${note.path} (${note.size} bytes)` }] };
        } catch (e) {
          return { content: [{ type: 'text' as const, text: `Error writing "${path}": ${(e as Error).message}` }] };
        }
      },
    ),
    t(
      'vault_status',
      'Return vault configuration status (path, enabled, note count). Pass `host` for peer.',
      { host: z.string().optional() },
      async ({ host }) => {
        if (host) {
          try {
            const res = await peerFetch(host, '/api/vault/config');
            const data: any = await res.json();
            const s = data.settings || {};
            const notesRes = await peerFetch(host, '/api/vault/notes?limit=5000').catch(() => null);
            const count = notesRes ? ((await notesRes.json()).notes || []).length : '?';
            return { content: [{ type: 'text' as const, text: `[${host}] path: ${s.path}\nenabled: ${s.enabled}\nexists: ${data.exists}\nnotes: ${count}` }] };
          } catch (e) {
            return { content: [{ type: 'text' as const, text: `Peer "${host}" vault status: ${(e as Error).message}` }] };
          }
        }
        const cfg = getVaultSettings();
        const configured = isConfigured();
        const count = configured ? listNotes({ limit: 5000 }).length : 0;
        return { content: [{ type: 'text' as const, text: `path: ${cfg.path}\nenabled: ${cfg.enabled}\nconfigured: ${configured}\nnotes: ${count}` }] };
      },
    ),
  ];

  return createSdkMcpServer({
    name: 'mc-vault',
    version: '1.0.0',
    tools,
  });
}

export const VAULT_TOOL_NAMES = [
  'mcp__mc-vault__vault_search',
  'mcp__mc-vault__vault_list',
  'mcp__mc-vault__vault_read',
  'mcp__mc-vault__vault_write',
  'mcp__mc-vault__vault_status',
];
