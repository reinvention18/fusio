/**
 * MentionDropdown — pop-out list when the user types '@' in the composer.
 * Lists agents on the active team. Re-skinned for the AI Fusio design.
 */
'use client';

import { useState, useEffect } from 'react';

const MENTION_GLYPHS: Record<string, string> = {
  commander: '✦', architect: '◆', builder: '●', inspector: '◎',
  sentinel: '▲', scout: '◇', scribe: '✎', navigator: '◈',
};

export function MentionDropdown({
  teamId, filter, onSelect,
}: {
  teamId: string;
  filter: string;
  onSelect: (handle: string) => void;
}) {
  const [agents, setAgents] = useState<Array<{ role_handle: string; role: string; status: string }>>([]);
  useEffect(() => {
    fetch(`/api/teams/${teamId}`)
      .then(r => r.json())
      .then(d => setAgents((d.agents || []).map((a: any) => ({
        role_handle: a.role_handle, role: a.role, status: a.status,
      }))))
      .catch(() => {});
  }, [teamId]);

  const filtered = agents.filter(a => !filter || a.role_handle.toLowerCase().includes(filter));
  if (filtered.length === 0) return null;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: 4,
        width: 240,
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 10,
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        zIndex: 50,
        overflow: 'hidden',
        fontFamily: 'var(--font-sans, system-ui)',
      }}
    >
      <div
        style={{
          padding: '6px 12px',
          fontFamily: 'var(--font-mono, ui-monospace)',
          fontSize: 9.5,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--mist, rgba(255,255,255,0.5))',
          borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
        }}
      >
        Mention an agent
      </div>
      {filtered.map(a => (
        <button
          key={a.role_handle}
          onClick={() => onSelect(a.role_handle)}
          data-fusio
          style={{
            width: '100%',
            textAlign: 'left',
            padding: '7px 12px',
            fontSize: 12,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            color: 'var(--white, #fff)',
            transition: 'background 120ms ease-out',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(204, 12, 32, 0.08)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        >
          <span style={{ color: 'var(--cyan, #5EC4D9)', width: 14, textAlign: 'center' }}>
            {MENTION_GLYPHS[a.role] || '●'}
          </span>
          <span style={{ fontWeight: 600 }}>@{a.role_handle}</span>
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: 'var(--font-mono, ui-monospace)',
              fontSize: 9.5,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--mist, rgba(255,255,255,0.5))',
            }}
          >
            {a.status}
          </span>
        </button>
      ))}
    </div>
  );
}
