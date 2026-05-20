/**
 * TeamRoster — sidebar list of agents on the active team with status dots.
 * Re-skinned for the AI Fusio design.
 */
'use client';

import { ROLE_GLYPHS, STATUS_COLORS, STATUS_DOTS } from './constants';
import type { AgentData } from '../teams/useTeamState';

interface TeamRosterProps {
  agents: AgentData[];
  selectedAgentId?: string | null;
  onSelectAgent?: (agentId: string) => void;
}

export function TeamRoster({ agents, selectedAgentId, onSelectAgent }: TeamRosterProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'var(--font-sans, system-ui)' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 8, padding: '0 4px',
        }}
      >
        <h3
          style={{
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
            color: 'var(--mist, rgba(255,255,255,0.5))',
            margin: 0, fontWeight: 500,
          }}
        >
          Team roster
        </h3>
        <span
          style={{
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 10, letterSpacing: '0.12em',
            color: 'var(--dim, rgba(255,255,255,0.32))',
          }}
        >
          {agents.length} agent{agents.length === 1 ? '' : 's'}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {agents.map(agent => {
          const isSelected = selectedAgentId === agent.id;
          return (
            <button
              key={agent.id}
              onClick={() => onSelectAgent?.(agent.id)}
              data-fusio
              style={{
                width: '100%',
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px',
                borderRadius: 6,
                fontSize: 12,
                background: isSelected ? 'rgba(204, 12, 32, 0.1)' : 'transparent',
                border: `1px solid ${isSelected ? 'rgba(204, 12, 32, 0.4)' : 'transparent'}`,
                color: 'var(--white, #fff)',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 120ms ease-out',
                fontFamily: 'var(--font-sans, system-ui)',
              }}
              onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; }}
              onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <span
                className={STATUS_DOTS[agent.status] || 'bg-terminal-dim'}
                style={{
                  width: 7, height: 7,
                  borderRadius: '50%',
                  flexShrink: 0,
                  animation: agent.status === 'working' ? 'fusio-pulse 1.6s ease-in-out infinite' : undefined,
                }}
              />
              <span style={{ flexShrink: 0, width: 14, textAlign: 'center', color: 'var(--cyan, #5EC4D9)' }}>
                {ROLE_GLYPHS[agent.role] || '?'}
              </span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>
                {agent.role_handle}
              </span>
              <span
                className={STATUS_COLORS[agent.status] || 'text-terminal-dim'}
                style={{
                  fontFamily: 'var(--font-mono, ui-monospace)',
                  fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase',
                }}
              >
                {agent.status}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
