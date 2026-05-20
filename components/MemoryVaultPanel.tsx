'use client';

/**
 * MemoryVaultPanel — drop-in UI for browsing the mem/api observations for a
 * chat session and configuring the Obsidian vault. Designed to be mounted
 * inside ChatPanel's existing tools drawer OR on a standalone settings page.
 *
 * Headless API contract: the integration works without this UI — agents can
 * already use mem_* and vault_* via MCP. This panel is for human inspection.
 */

import { useCallback, useEffect, useState } from 'react';

interface MemSession {
  id: string;
  kind: string;
  chat_id: string | null;
  team_id: string | null;
  agent_id: string | null;
  title: string;
  summary: string;
  created_at: number;
  updated_at: number;
}

interface Observation {
  id: number;
  type: string;
  title: string;
  excerpt: string;
  tags: string[];
  score: number;
  createdAt: number;
}

interface VaultCfg {
  path: string;
  enabled: boolean;
  autoIndex: boolean;
  createIfMissing: boolean;
}

interface Props {
  chatId?: string;
  compact?: boolean;
}

export function MemoryVaultPanel({ chatId, compact }: Props) {
  const [tab, setTab] = useState<'memory' | 'vault'>('memory');
  const [session, setSession] = useState<MemSession | null>(null);
  const [obs, setObs] = useState<Observation[]>([]);
  const [query, setQuery] = useState('');
  const [vaultCfg, setVaultCfg] = useState<VaultCfg | null>(null);
  const [vaultPathDraft, setVaultPathDraft] = useState('');
  const [vaultHits, setVaultHits] = useState<Array<{ path: string; title: string; line: number; preview: string }>>([]);
  const [vaultNoteCount, setVaultNoteCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // Resolve / create the mem session for this chat
  const ensureSession = useCallback(async () => {
    if (!chatId) return null;
    const resp = await fetch('/api/mem/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'chat', chat_id: chatId }),
    });
    const data = await resp.json();
    if (data?.session) setSession(data.session);
    return data?.session as MemSession | null;
  }, [chatId]);

  const loadObservations = useCallback(async (q = '') => {
    const s = session ?? await ensureSession();
    if (!s) return;
    setLoading(true);
    try {
      if (q.trim().length >= 2) {
        const res = await fetch(`/api/mem/search?q=${encodeURIComponent(q)}&session_id=${encodeURIComponent(s.id)}&limit=25`);
        const data = await res.json();
        setObs(data?.hits ?? []);
      } else {
        const res = await fetch(`/api/mem/timeline?session_id=${encodeURIComponent(s.id)}&limit=25`);
        const data = await res.json();
        setObs((data?.entries ?? []).map((e: any) => ({
          id: e.id, type: e.type, title: e.title,
          excerpt: e.summary, tags: [], score: 0, createdAt: e.createdAt,
        })));
      }
    } finally {
      setLoading(false);
    }
  }, [session, ensureSession]);

  const loadVault = useCallback(async () => {
    const [cfgRes, notesRes] = await Promise.all([
      fetch('/api/vault/config').then(r => r.json()).catch(() => null),
      fetch('/api/vault/notes?limit=1').then(r => r.json()).catch(() => null),
    ]);
    if (cfgRes?.settings) {
      setVaultCfg(cfgRes.settings);
      setVaultPathDraft(cfgRes.settings.path ?? '');
    }
    setVaultNoteCount(Array.isArray(notesRes?.notes) ? notesRes.notes.length : null);
  }, []);

  useEffect(() => { if (tab === 'memory') loadObservations(); }, [tab, chatId, loadObservations]);
  useEffect(() => { if (tab === 'vault') loadVault(); }, [tab, loadVault]);

  const saveVaultCfg = async () => {
    const res = await fetch('/api/vault/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: vaultPathDraft, enabled: true }),
    });
    const data = await res.json();
    if (data?.settings) setVaultCfg(data.settings);
  };

  const searchVault = async (q: string) => {
    if (!q.trim()) return;
    const res = await fetch(`/api/vault/search?q=${encodeURIComponent(q)}&limit=20`);
    const data = await res.json();
    setVaultHits(data?.hits ?? []);
  };

  // Fusio tokens
  const INK   = 'var(--ink, #0A0A0E)';
  const INK_2 = 'var(--ink-2, #131319)';
  const INK_3 = 'var(--ink-3, #1B1B23)';
  const LINE  = 'var(--line, rgba(255,255,255,0.08))';
  const WHITE = 'var(--white, #FFFFFF)';
  const FOG   = 'var(--fog, rgba(255,255,255,0.78))';
  const MIST  = 'var(--mist, rgba(255,255,255,0.5))';
  const DIM   = 'var(--dim, rgba(255,255,255,0.32))';
  const RED   = 'var(--red, #CC0C20)';
  const VIOLET = 'var(--violet, #8B6FE8)';
  const CYAN  = 'var(--cyan, #5EC4D9)';
  const FONT_MONO = 'var(--font-mono, ui-monospace, monospace)';
  const FONT_SANS = 'var(--font-sans, system-ui)';

  const eyebrow = (color = MIST, size = 10): React.CSSProperties => ({
    fontFamily: FONT_MONO,
    fontSize: size,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color,
  });

  const fieldInput: React.CSSProperties = {
    flex: 1,
    background: INK_3,
    border: `1px solid ${LINE}`,
    borderRadius: 6,
    padding: '6px 12px',
    color: WHITE,
    fontFamily: FONT_SANS,
    fontSize: 13,
    outline: 'none',
  };

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column',
        fontFamily: FONT_SANS,
        fontSize: compact ? 13 : 14,
        color: WHITE,
        background: INK,
      }}
    >
      {/* Tab strip */}
      <div
        style={{
          display: 'flex',
          gap: 6,
          borderBottom: `1px solid ${LINE}`,
          padding: '8px 12px',
          alignItems: 'center',
        }}
      >
        {(['memory', 'vault'] as const).map(t => {
          const active = tab === t;
          const accent = t === 'memory' ? VIOLET : CYAN;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              data-fusio
              style={{
                ...eyebrow(active ? accent : MIST, 10),
                padding: '4px 12px',
                borderRadius: 5,
                background: active ? `color-mix(in srgb, ${accent} 14%, transparent)` : 'transparent',
                border: `1px solid ${active ? `color-mix(in srgb, ${accent} 35%, transparent)` : 'transparent'}`,
                cursor: 'pointer',
                transition: 'all 120ms ease-out',
              }}
            >
              {t}
            </button>
          );
        })}
        {tab === 'memory' && (
          <span style={{ ...eyebrow(DIM, 9.5), marginLeft: 'auto' }}>
            {session ? `Session · ${session.id.slice(0, 8)}` : 'No session'}
          </span>
        )}
        {tab === 'vault' && (
          <span style={{ ...eyebrow(DIM, 9.5), marginLeft: 'auto' }}>
            {vaultCfg?.enabled ? (vaultNoteCount != null ? `~${vaultNoteCount}+ notes` : 'Enabled') : 'Disabled'}
          </span>
        )}
      </div>

      {/* Memory tab */}
      {tab === 'memory' && (
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') loadObservations(query); }}
              placeholder="Search observations…"
              data-fusio
              style={fieldInput}
            />
            <button
              type="button"
              onClick={() => loadObservations(query)}
              className="card-btn primary"
              data-fusio
              style={{
                background: VIOLET, borderColor: VIOLET, color: '#fff',
                padding: '6px 14px', fontSize: 11.5,
              }}
            >
              Search
            </button>
          </div>
          {loading && <div style={{ ...eyebrow(MIST, 9.5) }}>Loading…</div>}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '60vh', overflowY: 'auto' }}>
            {obs.map(o => (
              <li
                key={o.id}
                style={{
                  border: `1px solid ${LINE}`,
                  borderRadius: 8,
                  padding: 10,
                  background: INK_2,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={eyebrow(VIOLET, 9.5)}>{o.type}</span>
                  <span style={{ ...eyebrow(DIM, 9.5), letterSpacing: '0.05em' }}>#{o.id}</span>
                  <span style={{ ...eyebrow(DIM, 9.5), marginLeft: 'auto', letterSpacing: '0.04em' }}>
                    {new Date(o.createdAt).toLocaleString()}
                  </span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: WHITE, marginTop: 4 }}>{o.title}</div>
                <div style={{ fontSize: 11.5, color: FOG, marginTop: 4, lineHeight: 1.5 }}>{o.excerpt}</div>
                {o.tags?.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                    {o.tags.map(t => (
                      <span
                        key={t}
                        style={{
                          ...eyebrow(FOG, 9),
                          padding: '1px 6px',
                          background: INK_3,
                          border: `1px solid ${LINE}`,
                          borderRadius: 4,
                          letterSpacing: '0.1em',
                        }}
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
            {!loading && obs.length === 0 && (
              <li style={{ ...eyebrow(MIST, 9.5), fontStyle: 'italic' }}>
                No observations yet. They accumulate as the agent uses tools.
              </li>
            )}
          </ul>
        </div>
      )}

      {/* Vault tab */}
      {tab === 'vault' && (
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={eyebrow(MIST, 10)}>Vault path</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={vaultPathDraft}
                onChange={e => setVaultPathDraft(e.target.value)}
                placeholder="/home/user/Documents/MyVault"
                data-fusio
                style={fieldInput}
              />
              <button
                type="button"
                onClick={saveVaultCfg}
                className="card-btn primary"
                data-fusio
                style={{
                  background: CYAN, borderColor: CYAN, color: '#06181d',
                  padding: '6px 14px', fontSize: 11.5,
                }}
              >
                Save
              </button>
            </div>
            <div style={{ ...eyebrow(DIM, 9.5), letterSpacing: '0.04em', textTransform: 'none' }}>
              Precedence: VAULT_PATH env &gt; this setting &gt; default (~/Documents/MissionControl-Vault).
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={eyebrow(MIST, 10)}>Search vault</label>
            <VaultSearch onSearch={searchVault} hits={vaultHits} />
          </div>
        </div>
      )}
    </div>
  );
}

function VaultSearch({ onSearch, hits }: { onSearch: (q: string) => void; hits: any[] }) {
  const [q, setQ] = useState('');
  const INK_2 = 'var(--ink-2, #131319)';
  const INK_3 = 'var(--ink-3, #1B1B23)';
  const LINE  = 'var(--line, rgba(255,255,255,0.08))';
  const WHITE = 'var(--white, #FFFFFF)';
  const FOG   = 'var(--fog, rgba(255,255,255,0.78))';
  const MIST  = 'var(--mist, rgba(255,255,255,0.5))';
  const CYAN  = 'var(--cyan, #5EC4D9)';
  const FONT_MONO = 'var(--font-mono, ui-monospace, monospace)';
  const FONT_SANS = 'var(--font-sans, system-ui)';
  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSearch(q); }}
          data-fusio
          placeholder="Search vault notes…"
          style={{
            flex: 1,
            background: INK_3, border: `1px solid ${LINE}`,
            borderRadius: 6, padding: '6px 12px',
            color: WHITE, fontSize: 13, fontFamily: FONT_SANS,
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={() => onSearch(q)}
          className="card-btn"
          data-fusio
          style={{ padding: '6px 14px', fontSize: 11.5 }}
        >
          Find
        </button>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '50vh', overflowY: 'auto' }}>
        {hits.map((h, i) => (
          <li
            key={i}
            style={{
              border: `1px solid ${LINE}`,
              borderRadius: 6,
              padding: 8,
              background: INK_2,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: WHITE }}>{h.title}</div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: MIST, marginTop: 2, letterSpacing: '0.04em' }}>
              {h.path}:{h.line}
            </div>
            <div style={{ fontSize: 11.5, color: FOG, marginTop: 4, lineHeight: 1.5 }}>{h.preview}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default MemoryVaultPanel;
