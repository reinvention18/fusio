'use client';

import { useMemo, useState } from 'react';
import { ROLE_GLYPHS } from './constants';
import type { TeamMessage, AgentData } from '../teams/useTeamState';

interface MessageLogProps {
  messages: TeamMessage[];
  agents: AgentData[];
}

const TYPE_COLORS: Record<string, string> = {
  direct: 'text-terminal-cyan',
  broadcast: 'text-terminal-green',
  halt: 'text-terminal-red',
  note: 'text-terminal-dim',
  chat_report: 'text-terminal-amber',
};

const PRIORITY_COLORS: Record<string, string> = {
  now: 'text-terminal-red bg-terminal-red/10 border-terminal-red/30',
  next: 'text-terminal-amber bg-terminal-amber/10 border-terminal-amber/30',
  later: 'text-terminal-dim bg-terminal-surface border-terminal-border',
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function describeAgent(id: string | null, agents: AgentData[]): { glyph: string; label: string; role: string } {
  if (!id) return { glyph: '✦', label: 'commander', role: 'commander' };
  const a = agents.find(x => x.id === id);
  if (!a) return { glyph: '?', label: 'unknown', role: '' };
  return { glyph: ROLE_GLYPHS[a.role] || '·', label: a.role_handle, role: a.role };
}

export function MessageLog({ messages, agents }: MessageLogProps) {
  const [filter, setFilter] = useState<'all' | 'direct' | 'broadcast' | 'chat_report'>('all');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let xs = messages;
    if (filter !== 'all') xs = xs.filter(m => m.type === filter);
    if (selectedAgentId) {
      xs = xs.filter(m => m.from_agent_id === selectedAgentId || m.to_agent_id === selectedAgentId);
    }
    return [...xs].sort((a, b) => a.created_at - b.created_at);
  }, [messages, filter, selectedAgentId]);

  const stats = useMemo(() => {
    const byType: Record<string, number> = {};
    for (const m of messages) byType[m.type] = (byType[m.type] || 0) + 1;
    return byType;
  }, [messages]);

  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
          background: 'var(--ink-2, #131319)',
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
          fontFamily: 'var(--font-sans, system-ui)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
            color: 'var(--mist, rgba(255,255,255,0.5))',
          }}
        >
          Filter
        </span>
        {(['all', 'direct', 'broadcast', 'chat_report'] as const).map(f => {
          const active = filter === f;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              data-fusio
              style={{
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
                padding: '3px 9px',
                borderRadius: 5,
                background: active ? 'rgba(204, 12, 32, 0.12)' : 'transparent',
                color: active ? 'var(--red, #CC0C20)' : 'var(--mist, rgba(255,255,255,0.5))',
                border: `1px solid ${active ? 'rgba(204, 12, 32, 0.4)' : 'var(--line, rgba(255,255,255,0.08))'}`,
                cursor: 'pointer',
                transition: 'all 120ms ease-out',
              }}
            >
              {f === 'all' ? `all · ${messages.length}` : `${f.replace('_', ' ')} · ${stats[f] || 0}`}
            </button>
          );
        })}
        {selectedAgentId && (
          <button
            onClick={() => setSelectedAgentId(null)}
            data-fusio
            style={{
              marginLeft: 'auto',
              fontFamily: 'var(--font-mono, ui-monospace)',
              fontSize: 10, letterSpacing: '0.12em',
              color: 'var(--amber, #E8A23B)',
              background: 'transparent', border: 'none', cursor: 'pointer',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--amber, #E8A23B)'; }}
          >
            clear agent filter ✕
          </button>
        )}
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-2 py-2 font-mono text-[11px] space-y-2">
        {filtered.length === 0 && (
          <p className="text-terminal-dim text-center py-8">
            {messages.length === 0 ? 'No messages yet' : 'No messages match the filter'}
          </p>
        )}
        {filtered.map(msg => {
          const from = describeAgent(msg.from_agent_id, agents);
          const to = msg.to_agent_id ? describeAgent(msg.to_agent_id, agents) : null;
          const typeClass = TYPE_COLORS[msg.type] || 'text-terminal-dim';
          const prioClass = PRIORITY_COLORS[msg.priority] || PRIORITY_COLORS.later;
          const isBroadcast = msg.type === 'broadcast' || msg.to_agent_id === null;

          return (
            <div
              key={msg.id}
              className="p-2 rounded border border-terminal-border/50 bg-terminal-surface/40 hover:border-terminal-border"
            >
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-terminal-dim">{fmtTime(msg.created_at)}</span>
                <button
                  onClick={() => msg.from_agent_id && setSelectedAgentId(msg.from_agent_id)}
                  className="text-terminal-cyan hover:underline"
                >
                  {from.glyph} {from.label}
                </button>
                <span className="text-terminal-dim">→</span>
                {isBroadcast ? (
                  <span className="text-terminal-green">◆ broadcast</span>
                ) : (
                  <button
                    onClick={() => to && msg.to_agent_id && setSelectedAgentId(msg.to_agent_id)}
                    className="text-terminal-green hover:underline"
                  >
                    {to?.glyph} {to?.label}
                  </button>
                )}
                <span className={`px-1.5 py-0 rounded text-[9px] uppercase ${typeClass} border border-current/30`}>
                  {msg.type}
                </span>
                <span className={`px-1.5 py-0 rounded text-[9px] uppercase border ${prioClass}`}>
                  {msg.priority}
                </span>
                {msg.delivered_at && (
                  <span className="text-[9px] text-terminal-dim ml-auto">
                    delivered {fmtTime(msg.delivered_at)}
                  </span>
                )}
              </div>
              <div className="text-terminal-text whitespace-pre-wrap break-words leading-relaxed">
                {msg.body}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
