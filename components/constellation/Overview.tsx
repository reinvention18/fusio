'use client';

import { useCallback, useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { ActivityFeed } from './ActivityFeed';
import type { TeamEvent, AgentData } from '../teams/useTeamState';

interface OverviewProps {
  teamId: string;
  events: TeamEvent[];
  agents: AgentData[];
}

export function Overview({ teamId, events, agents }: OverviewProps) {
  const [content, setContent] = useState('');
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/teams/${teamId}/scratchpad`);
        if (!res.ok) return;
        const d = await res.json();
        if (cancelled) return;
        if (!dirty) {
          setContent(d.content || '');
          setVersion(d.version || 0);
        }
      } catch { /* ignore */ }
    };
    load();
    const interval = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [teamId, dirty]);

  const save = useCallback(async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/teams/${teamId}/scratchpad`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, expected_version: version, updated_by: 'commander' }),
      });
      const d = await res.json();
      if (d.version) setVersion(d.version);
      setDirty(false);
    } catch { /* ignore */ } finally {
      setSaving(false);
    }
  }, [teamId, content, version, dirty]);

  return (
    <div className="h-full flex flex-col md:flex-row min-h-0">
      {/* Activity feed — top on mobile, left on desktop */}
      <div className="md:w-80 border-b md:border-b-0 md:border-r border-terminal-border p-3 md:flex-shrink-0 min-h-0 flex flex-col h-[40%] md:h-auto">
        <ActivityFeed events={events} agents={agents} maxEvents={120} />
      </div>

      {/* Scratchpad — bottom on mobile, right on desktop */}
      <div className="flex-1 flex flex-col min-h-0 p-3" style={{ fontFamily: 'var(--font-sans, system-ui)' }}>
        <div className="flex items-center justify-between mb-2 gap-2">
          <div className="min-w-0">
            <h3
              style={{
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 10,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--mist, rgba(255,255,255,0.5))',
                margin: 0,
              }}
            >
              Shared scratchpad
            </h3>
            <p
              className="hidden md:block"
              style={{
                fontSize: 11,
                color: 'var(--dim, rgba(255,255,255,0.32))',
                marginTop: 2,
                lineHeight: 1.45,
              }}
            >
              Read by all agents — the ADR, findings, and deliverable live here.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span
              style={{
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 10,
                letterSpacing: '0.12em',
                color: dirty ? 'var(--amber, #E8A23B)' : 'var(--mist, rgba(255,255,255,0.5))',
              }}
            >
              v{version}{dirty ? ' · unsaved' : ''}
            </span>
            <button
              onClick={save}
              disabled={!dirty || saving}
              data-fusio
              className="card-btn primary"
              style={{
                background: 'var(--green, #4CC38A)',
                borderColor: 'var(--green, #4CC38A)',
                color: '#0a1612',
                fontSize: 11,
                padding: '6px 12px',
                display: 'inline-flex', alignItems: 'center', gap: 4,
                opacity: (!dirty || saving) ? 0.4 : 1,
                cursor: (!dirty || saving) ? 'not-allowed' : 'pointer',
                fontWeight: 600,
              }}
            >
              <Save style={{ width: 11, height: 11 }} />
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        <textarea
          value={content}
          onChange={e => { setContent(e.target.value); setDirty(true); }}
          onKeyDown={e => {
            if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
          data-fusio
          style={{
            flex: 1, width: '100%',
            background: 'var(--ink-2, #131319)',
            border: '1px solid var(--line, rgba(255,255,255,0.08))',
            borderRadius: 8,
            padding: 14,
            fontSize: 12.5,
            color: 'var(--white, #fff)',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            resize: 'none',
            outline: 'none',
            lineHeight: 1.55,
          }}
          onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(94, 196, 217, 0.4)'; }}
          onBlur={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--line, rgba(255,255,255,0.08))'; }}
          placeholder="# Mission scratchpad

The architect writes the ADR here. Scouts write findings. Scribe writes ## Final Deliverable.

You can edit this too — add notes, paste links, annotate. All agents read this at every turn."
        />
      </div>
    </div>
  );
}
