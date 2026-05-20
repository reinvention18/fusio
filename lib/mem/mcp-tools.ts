/**
 * mem/mcp-tools — MCP server exposing the 3-layer progressive disclosure API
 * to the agent: mem_search, mem_timeline, mem_get, mem_save.
 *
 * Registered for the main chat session and every Constellation agent; the
 * agent's session id is bound in closure so queries default to its scope.
 */

import 'server-only';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  search,
  timeline,
  get as getObs,
  putObservation,
} from './api';

export interface MemMcpContext {
  /** The mem_session id the agent is bound to. Used as default scope. */
  sessionId: string;
  /** Human label for diagnostics/telemetry. */
  label?: string;
}

export function createMemMcpServer(ctx: MemMcpContext) {
  const t = <S extends z.ZodRawShape>(
    name: string,
    desc: string,
    schema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
  ) => tool(name, desc, schema, handler as any);

  const tools = [
    t(
      'mem_search',
      'Layer 1 of memory: search durable observations by keyword/semantic similarity across this session, its parent, and its siblings. Returns compact {id,title,type,score,excerpt,tags} rows. Use this first; then call mem_timeline or mem_get to drill in.',
      {
        query: z.string().min(2).describe('Free-text search query.'),
        type: z.enum(['decision','pattern','blocker','fact','skill','finding','summary']).optional(),
        limit: z.number().int().min(1).max(30).default(10),
        all_sessions: z.boolean().default(false).describe('When true, search across every session (not just this one and related).'),
      },
      async ({ query, type, limit, all_sessions }) => {
        const hits = await search({
          query,
          sessionId: all_sessions ? undefined : ctx.sessionId,
          type,
          limit,
        });
        if (hits.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No matching observations.' }] };
        }
        const lines = hits.map(h =>
          `#${h.id} [${h.type} ${h.score.toFixed(2)}] ${h.title} — ${h.excerpt.replace(/\s+/g, ' ').slice(0, 160)}`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    ),
    t(
      'mem_timeline',
      'Layer 2 of memory: return an ordered window of observation summaries around a specific observation id, or most-recent observations in this session scope.',
      {
        observation_id: z.number().int().optional(),
        limit: z.number().int().min(1).max(50).default(20),
        window_before: z.number().int().min(0).max(20).default(5),
        window_after: z.number().int().min(0).max(20).default(5),
      },
      async ({ observation_id, limit, window_before, window_after }) => {
        const entries = timeline({
          sessionId: observation_id != null ? undefined : ctx.sessionId,
          observationId: observation_id,
          limit,
          windowBefore: window_before,
          windowAfter: window_after,
        });
        if (entries.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No observations in timeline.' }] };
        }
        const lines = entries.map(e => {
          const when = new Date(e.createdAt).toISOString().slice(0, 19).replace('T', ' ');
          return `${when} #${e.id} [${e.type}] ${e.title} — ${e.summary}`;
        });
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    ),
    t(
      'mem_get',
      'Layer 3 of memory: fetch the full content of a single observation by id. Call after mem_search finds a promising hit.',
      { id: z.number().int() },
      async ({ id }) => {
        const obs = getObs(id);
        if (!obs) return { content: [{ type: 'text' as const, text: `No observation with id=${id}.` }] };
        const tags = (() => { try { return JSON.parse(obs.tags); } catch { return []; } })();
        const files = (() => { try { return JSON.parse(obs.files_involved); } catch { return []; } })();
        const body = [
          `id: ${obs.id}`,
          `session: ${obs.session_id}`,
          `type: ${obs.type}`,
          `created: ${new Date(obs.created_at).toISOString()}`,
          tags.length ? `tags: ${tags.join(', ')}` : '',
          files.length ? `files: ${files.join(', ')}` : '',
          '',
          `# ${obs.title}`,
          '',
          obs.content,
        ].filter(Boolean).join('\n');
        return { content: [{ type: 'text' as const, text: body }] };
      },
    ),
    t(
      'mem_save',
      'Write a durable observation you want future sessions to recall. Use sparingly — only for decisions, patterns, blockers, facts, or skills worth remembering.',
      {
        type: z.enum(['decision','pattern','blocker','fact','skill','finding','summary']),
        title: z.string().min(3).max(400),
        content: z.string().min(3).max(4000),
        tags: z.array(z.string()).optional(),
        files: z.array(z.string()).optional(),
      },
      async ({ type, title, content, tags, files }) => {
        const row = await putObservation({
          sessionId: ctx.sessionId,
          type,
          title,
          content,
          tags,
          filesInvolved: files,
        });
        return { content: [{ type: 'text' as const, text: `Saved observation #${row.id} [${row.type}] "${row.title}"` }] };
      },
    ),
  ];

  return createSdkMcpServer({
    name: 'mc-memory',
    version: '1.0.0',
    tools,
  });
}

export const MEM_TOOL_NAMES = [
  'mcp__mc-memory__mem_search',
  'mcp__mc-memory__mem_timeline',
  'mcp__mc-memory__mem_get',
  'mcp__mc-memory__mem_save',
];
