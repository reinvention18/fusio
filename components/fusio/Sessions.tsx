/**
 * Fusio sessions column — the chat list, styled via /fusio/mc.css's
 * `.sessions` class family. Replaces ChatPanel's internal sessions
 * sidebar so the layout matches the Fusio design exactly.
 *
 * Reads the chat list from /api/chats?lite=true and keeps it in sync via a
 * lightweight polling interval (the existing ChatPanel polls too — both
 * speak to the same /api/chats endpoint, so they stay consistent).
 *
 * Selecting a session writes the id to localStorage AND dispatches a
 * `mc-chat-select` window event that ChatPanel listens for, so the active
 * session switches without a remount.
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { I } from './Icons';

interface LiteSession {
  id: string;
  name: string;
  workspace?: string;
  pinned?: boolean;
  updatedAt?: string;
  // any other lite fields ChatPanel uses
}

interface FusioSessionsProps {
  /** Visible namespace prefix; chat tab = none, seo-chat = 'seo:', lukes-chat = 'mc-mis-' */
  namespace?: 'default' | 'seo' | 'missions';
  /** Optional title override */
  title?: string;
}

function relative(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts).getTime();
  if (!d || isNaN(d)) return '';
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString();
}

export function FusioSessions({ namespace = 'default', title = 'Conversations' }: FusioSessionsProps) {
  const [sessions, setSessions] = useState<LiteSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  // Initial load — read activeSessionId from localStorage (ChatPanel writes
  // it there too via use-chat-session hook).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const ns = namespace === 'seo' ? 'seo' : namespace === 'missions' ? 'missions' : 'mc';
    // Read both legacy dot-key and hyphen-key ChatPanel writes.
    const read = () =>
      localStorage.getItem(`${ns}-activeSessionId`) ||
      localStorage.getItem(`${ns}.activeSessionId`);
    setActiveId(read());
    const onStorage = () => setActiveId(read());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [namespace]);

  // Listen for cross-component session changes so the highlight tracks the
  // active chat even when other components flip it (e.g. ChatPanel's New
  // Chat button).
  useEffect(() => {
    const onSelect = (e: Event) => {
      const id = (e as CustomEvent).detail?.id;
      if (typeof id === 'string') setActiveId(id);
    };
    window.addEventListener('mc-chat-select', onSelect);
    return () => window.removeEventListener('mc-chat-select', onSelect);
  }, []);

  // Polling fetch — keep chat list current. /api/chats?lite=true is cheap.
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/chats?lite=true', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      const all: LiteSession[] = Array.isArray(j?.sessions) ? j.sessions : [];
      // Namespace filter — id prefix convention: seo chats start with "seo-",
      // missions chats start with "mc-mis-", regular chats are uuids.
      const filtered = all.filter(s => {
        if (namespace === 'seo') return s.id?.startsWith('seo-');
        if (namespace === 'missions') return s.id?.startsWith('mc-mis-');
        return !s.id?.startsWith('seo-') && !s.id?.startsWith('mc-mis-');
      });
      setSessions(filtered);
    } catch {
      /* network blip — try next tick */
    } finally {
      setLoading(false);
    }
  }, [namespace]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 8000);
    return () => clearInterval(iv);
  }, [load]);

  const select = (id: string) => {
    setActiveId(id);
    // Write to BOTH the legacy dot-key and the hyphen-key ChatPanel uses
    // so all consumers see the same active session.
    const ns = namespace === 'seo' ? 'seo'
             : namespace === 'missions' ? 'missions'
             : 'mc';
    try {
      localStorage.setItem(`${ns}.activeSessionId`, id);
      localStorage.setItem(`${ns}-activeSessionId`, id);
    } catch {}
    // Include the session name + workspace in the event payload so listeners
    // (FusioChatHeader, ChatPanel) can update their UI immediately without
    // refetching the chat list. Saves a flash of "New chat" while the
    // header's /api/chats fetch is in flight.
    const picked = sessions.find(s => s.id === id);
    window.dispatchEvent(new CustomEvent('mc-chat-select', {
      detail: { id, namespace, name: picked?.name, workspace: picked?.workspace },
    }));
  };

  const newChat = () => {
    window.dispatchEvent(new CustomEvent('mc-chat-new', { detail: { namespace } }));
    // Re-poll the sessions endpoint shortly after so the new chat
    // (created in ChatPanel's state) shows up in the list as soon as
    // it's persisted. Without this we wait up to 8s for the next tick.
    setTimeout(() => { load(); }, 500);
    setTimeout(() => { load(); }, 1500);
  };

  const filtered = q
    ? sessions.filter(s => (s.name || '').toLowerCase().includes(q.toLowerCase()))
    : sessions;

  // Pinned first, then by updatedAt desc — also the in-group sort.
  const ordered = [...filtered].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return tb - ta;
  });

  /* ===== Tree-by-project mode =====
     Persisted toggle. When on, sessions are grouped by their workspace
     into collapsible buckets sorted by most-recently-used. Each group
     header shows the workspace short-name + count and folds/unfolds. */
  const GROUP_KEY = `mc-sessions-grouped-${namespace}`;
  const COLLAPSE_KEY = `mc-sessions-collapsed-${namespace}`;
  const [grouped, setGrouped] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try { return localStorage.getItem(GROUP_KEY) !== '0'; } catch { return true; }
  });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {};
    try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}'); } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(GROUP_KEY, grouped ? '1' : '0'); } catch { /* ignore */ }
  }, [grouped, GROUP_KEY]);
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed)); } catch { /* ignore */ }
  }, [collapsed, COLLAPSE_KEY]);

  const toggleCollapsed = (ws: string) =>
    setCollapsed(prev => ({ ...prev, [ws]: !prev[ws] }));

  const wsLabel = (ws: string): string => {
    if (!ws || ws === '__none__') return '— no project —';
    const parts = ws.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] || ws;
  };

  // Build groups: map workspace -> sessions[]. Empty workspace bucketed
  // under "__none__" so the group still renders.
  const groups: Array<{ ws: string; sessions: typeof ordered }> = (() => {
    const buckets = new Map<string, typeof ordered>();
    for (const s of ordered) {
      const k = (s.workspace && s.workspace.trim()) || '__none__';
      const arr = buckets.get(k);
      if (arr) arr.push(s); else buckets.set(k, [s]);
    }
    // Sort groups by most-recent session inside each
    const out = Array.from(buckets.entries())
      .map(([ws, list]) => ({ ws, sessions: list }))
      .sort((a, b) => {
        const ta = a.sessions[0]?.updatedAt ? new Date(a.sessions[0].updatedAt).getTime() : 0;
        const tb = b.sessions[0]?.updatedAt ? new Date(b.sessions[0].updatedAt).getTime() : 0;
        return tb - ta;
      });
    return out;
  })();

  return (
    <aside className="sessions">
      <div className="sessions-head">
        <h3>{title}</h3>
        <div className="actions" style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={() => setGrouped(g => !g)}
            title={grouped ? 'Flat list' : 'Group by project'}
            aria-label={grouped ? 'Switch to flat list' : 'Group by project'}
            type="button"
            style={{
              minWidth: 32, minHeight: 32,
              padding: '4px 8px',
              borderRadius: 6,
              background: grouped ? 'var(--ink-3, #1B1B23)' : 'transparent',
              border: '1px solid ' + (grouped ? 'var(--cyan, rgba(94,196,217,0.4))' : 'var(--line)'),
              color: grouped ? 'var(--cyan, #5EC4D9)' : 'var(--mist)',
              fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            {grouped ? '⊟ Tree' : '≡ Flat'}
          </button>
          <button
            onClick={newChat}
            title="New chat"
            aria-label="New chat"
            type="button"
            style={{ minWidth: 36, minHeight: 36 }}
          >
            {I.plus}
          </button>
        </div>
      </div>
      <div className="sessions-search">
        <input
          type="text"
          placeholder="Search conversations…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
      </div>
      <div className="sessions-list">
        {loading && sessions.length === 0 && (
          <div style={{ padding: '14px 12px', color: 'var(--mist)', fontSize: 12 }}>Loading…</div>
        )}
        {!loading && ordered.length === 0 && (
          <div style={{ padding: '14px 12px', color: 'var(--mist)', fontSize: 12 }}>
            {q ? 'No matches' : 'No conversations yet'}
          </div>
        )}
        {/* Grouped (tree) mode: workspace header + nested rows. */}
        {grouped && groups.map(({ ws, sessions: rows }) => {
          const isCollapsed = !!collapsed[ws];
          return (
            <div key={ws} className="session-group">
              <button
                type="button"
                onClick={() => toggleCollapsed(ws)}
                className="session-group-head"
                style={{
                  width: '100%', textAlign: 'left',
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 10px',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: '1px solid var(--line, rgba(255,255,255,0.04))',
                  color: 'var(--mist)',
                  fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                }}
                title={ws === '__none__' ? 'Sessions with no project' : ws}
              >
                <span style={{
                  display: 'inline-block', width: 10, color: 'var(--dim)',
                  transition: 'transform 120ms ease-out',
                  transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                }}>▾</span>
                <span style={{
                  flex: 1, minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  color: ws === '__none__' ? 'var(--dim)' : 'var(--white)',
                }}>
                  {wsLabel(ws)}
                </span>
                <span style={{
                  color: 'var(--dim)', fontSize: 10,
                  background: 'var(--ink-2, #131319)',
                  padding: '1px 6px', borderRadius: 4,
                }}>
                  {rows.length}
                </span>
              </button>
              {!isCollapsed && rows.map(s => (
                <div
                  key={s.id}
                  className={'session-row ' + (activeId === s.id ? 'active' : '')}
                  onClick={() => select(s.id)}
                  role="button"
                  tabIndex={0}
                  style={{ paddingLeft: 22 }}  /* indent so tree feel is obvious */
                >
                  <div className="name-row">
                    {s.pinned && <span className="pin">📌</span>}
                    <span className="name">{s.name || 'Untitled'}</span>
                  </div>
                  <div className="meta">
                    <span className="time">{relative(s.updatedAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          );
        })}

        {/* Flat mode: original row-per-session, workspace shown inline. */}
        {!grouped && ordered.map(s => (
          <div
            key={s.id}
            className={'session-row ' + (activeId === s.id ? 'active' : '')}
            onClick={() => select(s.id)}
            role="button"
            tabIndex={0}
          >
            <div className="name-row">
              {s.pinned && <span className="pin">📌</span>}
              <span className="name">{s.name || 'Untitled'}</span>
            </div>
            <div className="meta">
              {s.workspace && (
                <span className="ws" title={s.workspace}>
                  {(s.workspace || '').split(/[/\\]/).pop()}
                </span>
              )}
              <span className="time">{relative(s.updatedAt)}</span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
