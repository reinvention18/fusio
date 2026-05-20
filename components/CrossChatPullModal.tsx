/**
 * CrossChatPullModal — pulls recent messages from a chat in another MC
 * instance / namespace and hands them back to the caller as a prepared
 * context block.
 *
 * Sources:
 *   • Server (mc namespace — chat 41 lives here)
 *   • Server (seo namespace)
 *   • PC peer (mc namespace)
 *   • PC peer (seo namespace)
 *   • Luke's Chat (this instance)
 *
 * UX flow:
 *   1. Pick a source. The chat list for that source loads via
 *      /api/cross-chat/list?source=...
 *   2. Optionally type to search — filters by chat name or preview text.
 *   3. Click a chat. A panel opens showing the last `limit` messages
 *      (slider 4-30, default 8).
 *   4. "Insert into chat" packages the messages as a markdown block and
 *      calls onInsert(text). The caller (ChatPanel) drops it into the
 *      composer so the user can edit + send.
 *   5. "Cancel" closes the modal without inserting anything.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';

interface SessionSummary {
  id: string;
  name?: string;
  message_count: number;
  preview?: string;
  updated_at?: string;
  workspace?: string;
}

interface PulledMessage {
  role: string;
  content: string;
  ts?: string;
}

const SOURCES = [
  { id: 'linux-mc',  label: 'Linux MC (chat 41)', desc: 'Prod Mission Control on this host' },
  { id: 'linux-seo', label: 'Linux SEO',          desc: 'Prod SEO chat namespace' },
  { id: 'pc-mc',     label: 'PC MC',              desc: 'Workstation peer over Tailscale' },
  { id: 'pc-seo',    label: 'PC SEO',             desc: 'PC SEO namespace' },
  { id: 'lukes',     label: "Luke's Chat",        desc: 'This instance — for cross-mission pulls' },
] as const;
type SourceId = typeof SOURCES[number]['id'];

interface CrossChatPullModalProps {
  open: boolean;
  onClose: () => void;
  /** Called with the formatted markdown block when the user clicks Insert. */
  onInsert: (block: string) => void;
}

export default function CrossChatPullModal({ open, onClose, onInsert }: CrossChatPullModalProps) {
  const [source, setSource] = useState<SourceId>('linux-mc');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [limit, setLimit] = useState(8);
  const [messages, setMessages] = useState<PulledMessage[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgError, setMsgError] = useState<string | null>(null);

  // Reload chat list whenever the source changes (or the modal opens).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    setSessions([]);
    setSelectedId(null);
    setMessages([]);
    fetch(`/api/cross-chat/list?source=${encodeURIComponent(source)}`, { cache: 'no-store' })
      .then(r => r.json().then(data => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok || data?.error) {
          setListError(`${data?.error || 'unknown'}${data?.hint ? ` — ${data.hint}` : ''}`);
        } else {
          setSessions(Array.isArray(data?.sessions) ? data.sessions : []);
        }
      })
      .catch(err => { if (!cancelled) setListError(String(err?.message || err)); })
      .finally(() => { if (!cancelled) setListLoading(false); });
    return () => { cancelled = true; };
  }, [open, source]);

  // Pull messages whenever a chat is selected (or `limit` changes).
  useEffect(() => {
    if (!open || !selectedId) { setMessages([]); return; }
    let cancelled = false;
    setMsgLoading(true);
    setMsgError(null);
    fetch(`/api/cross-chat/messages?source=${encodeURIComponent(source)}&id=${encodeURIComponent(selectedId)}&limit=${limit}`, { cache: 'no-store' })
      .then(r => r.json().then(data => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok || data?.error) {
          setMsgError(`${data?.error || 'unknown'}${data?.hint ? ` — ${data.hint}` : ''}`);
        } else {
          setMessages(Array.isArray(data?.messages) ? data.messages : []);
        }
      })
      .catch(err => { if (!cancelled) setMsgError(String(err?.message || err)); })
      .finally(() => { if (!cancelled) setMsgLoading(false); });
    return () => { cancelled = true; };
  }, [open, source, selectedId, limit]);

  const filteredSessions = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return sessions;
    return sessions.filter(s =>
      (s.name || '').toLowerCase().includes(f) ||
      (s.preview || '').toLowerCase().includes(f) ||
      (s.id || '').toLowerCase().includes(f),
    );
  }, [sessions, filter]);

  const selectedSession = sessions.find(s => s.id === selectedId);

  const formatBlock = () => {
    const sourceLabel = SOURCES.find(s => s.id === source)?.label || source;
    const lines: string[] = [];
    lines.push(`📎 **Context pulled from ${sourceLabel} → ${selectedSession?.name || selectedId} (last ${messages.length} of ${selectedSession?.message_count ?? '?'} messages)**`);
    lines.push('');
    for (const m of messages) {
      const tag = m.role === 'assistant' ? '🤖' : m.role === 'user' ? '👤' : `[${m.role}]`;
      // Trim each message to keep the inserted block manageable. Users can
      // pull more selectively with the limit slider if they want full text.
      const body = m.content.length > 1500 ? m.content.slice(0, 1500) + '\n…[truncated]' : m.content;
      lines.push(`${tag} ${m.ts ? `(${m.ts}) ` : ''}${body}`);
      lines.push('');
    }
    lines.push('---');
    lines.push('_(Question continues here)_');
    return lines.join('\n');
  };

  if (!open) return null;

  // Tokens
  const INK   = 'var(--ink, #0A0A0E)';
  const INK_2 = 'var(--ink-2, #131319)';
  const INK_3 = 'var(--ink-3, #1B1B23)';
  const LINE  = 'var(--line, rgba(255,255,255,0.08))';
  const WHITE = 'var(--white, #FFFFFF)';
  const FOG   = 'var(--fog, rgba(255,255,255,0.78))';
  const MIST  = 'var(--mist, rgba(255,255,255,0.5))';
  const DIM   = 'var(--dim, rgba(255,255,255,0.32))';
  const RED   = 'var(--red, #CC0C20)';
  const GREEN = 'var(--green, #4CC38A)';
  const FONT_MONO = 'var(--font-mono, ui-monospace, monospace)';
  const FONT_SANS = 'var(--font-sans, system-ui)';
  const FONT_DISPLAY = 'var(--font-display, "Space Grotesk")';

  const eyebrow = (color = MIST, size = 10): React.CSSProperties => ({
    fontFamily: FONT_MONO,
    fontSize: size,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color,
  });

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.72)',
        backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="card"
        style={{
          margin: 0,
          width: '100%',
          maxWidth: 768,
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          overflow: 'hidden',
          fontFamily: FONT_SANS,
        }}
      >
        {/* Head */}
        <div
          style={{
            padding: '14px 18px',
            borderBottom: `1px solid ${LINE}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={eyebrow()}>Tools · Cross-chat · Pull</div>
            <h2 style={{ fontFamily: FONT_DISPLAY, fontSize: 16, fontWeight: 600, letterSpacing: '-0.015em', color: WHITE, marginTop: 2 }}>
              📎 Pull chat context
            </h2>
            <p style={{ fontSize: 11, color: MIST, marginTop: 4 }}>
              Bring recent messages from another chat into this one.
            </p>
          </div>
          <button
            onClick={onClose}
            data-fusio
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: MIST,
              ...eyebrow(MIST),
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = WHITE; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = MIST; }}
          >
            Close
          </button>
        </div>

        {/* Source tabs */}
        <div
          style={{
            padding: '12px 18px',
            borderBottom: `1px solid ${LINE}`,
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6,
          }}
        >
          {SOURCES.map(s => {
            const active = source === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setSource(s.id)}
                title={s.desc}
                data-fusio
                style={{
                  ...eyebrow(active ? GREEN : MIST, 10),
                  padding: '4px 10px',
                  borderRadius: 5,
                  background: active ? 'rgba(76, 195, 138, 0.14)' : 'transparent',
                  border: `1px solid ${active ? 'rgba(76, 195, 138, 0.4)' : LINE}`,
                  cursor: 'pointer',
                  transition: 'all 120ms ease-out',
                }}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        {/* Filter */}
        <div style={{ padding: '10px 18px', borderBottom: `1px solid ${LINE}` }}>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search chat name, preview, id…"
            data-fusio
            style={{
              width: '100%',
              background: INK_3, border: `1px solid ${LINE}`,
              borderRadius: 6, padding: '7px 10px',
              fontSize: 13, color: WHITE, fontFamily: FONT_SANS,
              outline: 'none',
            }}
          />
        </div>

        {/* Split — list / preview */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            overflow: 'hidden',
            flex: 1, minHeight: 0,
          }}
        >
          {/* Chat list */}
          <div style={{ borderRight: `1px solid ${LINE}`, overflowY: 'auto' }}>
            {listLoading && (
              <div style={{ padding: '14px', fontSize: 13, color: FOG, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 10, height: 10, borderRadius: '50%',
                      background: GREEN, opacity: 0.5,
                      animation: 'fusio-pulse 1.6s ease-in-out infinite',
                    }}
                  />
                  Loading chat list…
                </div>
                <div style={{ ...eyebrow(DIM, 9.5), letterSpacing: '0.04em', textTransform: 'none' }}>
                  The upstream MC index can be ~20 MB and take 5–15s. Cached for 30s after first load.
                </div>
              </div>
            )}
            {listError && (
              <div style={{ padding: 14, fontSize: 11.5, color: RED, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div>Source error: {listError}</div>
                {listError.includes('timeout') && (
                  <div style={{ color: MIST }}>
                    The upstream MC took too long. Try the same source again — the second hit is cached.
                  </div>
                )}
              </div>
            )}
            {!listLoading && !listError && filteredSessions.length === 0 && (
              <div style={{ padding: 14, fontSize: 12.5, color: DIM, fontStyle: 'italic' }}>
                {sessions.length === 0 ? 'No chats in this source.' : 'No chats match your filter.'}
              </div>
            )}
            {filteredSessions.map(s => {
              const isSelected = selectedId === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  data-fusio
                  style={{
                    width: '100%', textAlign: 'left',
                    padding: '10px 14px',
                    borderBottom: '1px solid rgba(255,255,255,0.03)',
                    background: isSelected ? 'rgba(76, 195, 138, 0.1)' : 'transparent',
                    borderLeft: isSelected ? `2px solid ${GREEN}` : '2px solid transparent',
                    cursor: 'pointer',
                    transition: 'background 120ms ease-out',
                    border: 'none',
                    fontFamily: FONT_SANS,
                  }}
                  onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = INK_2; }}
                  onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <div style={{ fontSize: 13, color: WHITE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.name || s.id}
                  </div>
                  <div style={{ fontSize: 11, color: MIST, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.preview || '(no preview)'}
                  </div>
                  <div style={{ ...eyebrow(DIM, 9.5), marginTop: 3, letterSpacing: '0.04em' }}>
                    {s.message_count} msg{s.message_count === 1 ? '' : 's'}
                    {s.updated_at && ` · ${new Date(s.updated_at).toLocaleString()}`}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Preview pane */}
          <div style={{ overflowY: 'auto' }}>
            {!selectedId && (
              <div style={{ padding: 14, fontSize: 12.5, color: DIM, fontStyle: 'italic' }}>
                Pick a chat to preview its recent messages.
              </div>
            )}
            {selectedId && (
              <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: MIST }}>
                  <span>Pull last</span>
                  <input
                    type="number"
                    min={1} max={50}
                    value={limit}
                    onChange={(e) => setLimit(Math.min(50, Math.max(1, parseInt(e.target.value, 10) || 8)))}
                    data-fusio
                    style={{
                      width: 56,
                      background: INK_3, border: `1px solid ${LINE}`,
                      borderRadius: 5, padding: '3px 6px',
                      textAlign: 'center', color: WHITE,
                      fontFamily: FONT_MONO,
                    }}
                  />
                  <span>messages</span>
                </div>
                {msgLoading && <div style={{ fontSize: 11.5, color: MIST }}>Loading messages…</div>}
                {msgError && <div style={{ fontSize: 11.5, color: RED }}>Error: {msgError}</div>}
                {!msgLoading && messages.map((m, i) => (
                  <div
                    key={i}
                    style={{
                      border: `1px solid ${LINE}`,
                      borderRadius: 8,
                      padding: 10,
                      background: INK_2,
                    }}
                  >
                    <div style={{ ...eyebrow(DIM, 9.5), marginBottom: 4, letterSpacing: '0.14em' }}>
                      {m.role}{m.ts && ` · ${new Date(m.ts).toLocaleString()}`}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: WHITE,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        maxHeight: 128,
                        overflowY: 'auto',
                        lineHeight: 1.5,
                      }}
                    >
                      {m.content}
                    </div>
                  </div>
                ))}
                {!msgLoading && messages.length === 0 && !msgError && (
                  <div style={{ fontSize: 11.5, color: DIM, fontStyle: 'italic' }}>(No messages returned.)</div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Foot */}
        <div
          style={{
            padding: '14px 18px',
            borderTop: `1px solid ${LINE}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 10, flexWrap: 'wrap',
          }}
        >
          <div style={{ ...eyebrow(MIST, 10), letterSpacing: '0.04em', textTransform: 'none' }}>
            {selectedSession
              ? `Selected · ${selectedSession.name || selectedSession.id} · ${messages.length}/${limit}`
              : 'No chat selected.'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={onClose}
              className="card-btn"
              data-fusio
              style={{ fontSize: 11.5, padding: '6px 14px' }}
            >
              Cancel
            </button>
            <button
              onClick={() => { onInsert(formatBlock()); onClose(); }}
              disabled={!selectedId || messages.length === 0 || msgLoading}
              className="card-btn primary"
              data-fusio
              style={{
                fontSize: 11.5, padding: '6px 14px',
                background: GREEN, borderColor: GREEN, color: '#0a1612',
                opacity: (!selectedId || messages.length === 0 || msgLoading) ? 0.5 : 1,
                cursor: (!selectedId || messages.length === 0 || msgLoading) ? 'not-allowed' : 'pointer',
              }}
            >
              📎 Insert into chat
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
