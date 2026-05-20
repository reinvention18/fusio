'use client';

import { useRef, useEffect } from 'react';
import { ROLE_GLYPHS, STATUS_COLORS } from './constants';
import type { TeamEvent } from '../teams/useTeamState';

interface ActivityFeedProps {
  events: TeamEvent[];
  agents: Array<{ id: string; role: string; role_handle: string }>;
  maxEvents?: number;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getEventDisplay(event: TeamEvent, agentMap: Map<string, { role: string; handle: string }>) {
  const agent = event.agent_id ? agentMap.get(event.agent_id) : null;
  const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;

  const glyph = agent ? (ROLE_GLYPHS[agent.role] || '?') : '⚙';
  const handle = agent?.handle || 'system';

  let detail = '';
  switch (event.kind) {
    case 'task_transition':
      detail = `→ ${payload.to}${payload.summary ? `: ${payload.summary}` : ''}`;
      break;
    case 'tasks_proposed':
      detail = `proposed ${payload.count} tasks`;
      break;
    case 'agent_message':
      detail = `→ ${payload.to}: "${payload.body}"`;
      break;
    case 'rework_requested':
      detail = `⟲ rework requested (${payload.severity}): ${payload.findings?.slice(0, 80)}`;
      break;
    case 'rework_retest':
      detail = '⟲ auto re-test created';
      break;
    case 'codex_exec':
      detail = `codex: ${payload.prompt?.slice(0, 60)}`;
      break;
    case 'system':
      detail = payload.action || JSON.stringify(payload).slice(0, 80);
      break;
    default:
      detail = payload.summary || payload.action || payload.body || event.kind;
  }

  return { glyph, handle, detail };
}

export function ActivityFeed({ events, agents, maxEvents = 100 }: ActivityFeedProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const agentMap = new Map(agents.map(a => [a.id, { role: a.role, handle: a.role_handle }]));

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  const visible = events.slice(-maxEvents);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'var(--font-sans, system-ui)' }}>
      <h3
        style={{
          fontFamily: 'var(--font-mono, ui-monospace)',
          fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
          color: 'var(--mist, rgba(255,255,255,0.5))',
          margin: '0 0 8px',
          padding: '0 4px',
          fontWeight: 500,
        }}
      >
        Live activity
      </h3>
      <div
        style={{
          flex: 1, overflowY: 'auto',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: 11,
          display: 'flex', flexDirection: 'column', gap: 1,
        }}
      >
        {visible.length === 0 && (
          <p
            style={{
              textAlign: 'center', padding: '16px 0',
              color: 'var(--dim, rgba(255,255,255,0.32))',
              fontFamily: 'var(--font-sans, system-ui)',
              fontStyle: 'italic',
              margin: 0,
            }}
          >
            No activity yet
          </p>
        )}
        {visible.map(event => {
          const { glyph, handle, detail } = getEventDisplay(event, agentMap);
          const sevColor = event.severity === 'error' ? 'var(--red, #CC0C20)'
            : event.severity === 'warn' ? 'var(--amber, #E8A23B)'
            : 'var(--mist, rgba(255,255,255,0.5))';
          const dotColor = event.severity === 'error' ? 'var(--red, #CC0C20)'
            : event.severity === 'warn' ? 'var(--amber, #E8A23B)'
            : 'var(--dim, rgba(255,255,255,0.32))';

          return (
            <div
              key={event.id}
              style={{
                display: 'flex', gap: 6,
                padding: '2px 6px',
                borderRadius: 4,
                transition: 'background 120ms ease-out',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <span style={{ color: 'var(--dim, rgba(255,255,255,0.32))', flexShrink: 0, width: 64, letterSpacing: '0.04em' }}>
                {formatTime(event.created_at)}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  width: 6, height: 6,
                  borderRadius: '50%',
                  marginTop: 5,
                  background: dotColor,
                  boxShadow: event.severity === 'error' ? `0 0 6px ${dotColor}` : 'none',
                }}
              />
              <span style={{ color: 'var(--cyan, #5EC4D9)', flexShrink: 0 }}>
                {glyph} {handle}
              </span>
              <span
                style={{
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  color: event.kind === 'agent_message' ? 'var(--green, #4CC38A)' : sevColor,
                }}
              >
                {detail}
              </span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
