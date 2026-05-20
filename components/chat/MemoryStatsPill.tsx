'use client';

import { useState, useEffect, useRef } from 'react';

interface MemoryStats {
  turnCount: number;
  episodeCount: number;
  lastIndexedTurn: number;
  lastError: string | null;
  jsonlBytes: number | null;
  dbBytes: number;
  disabled: boolean;
}

interface MemorySearchResult {
  mode: string;
  query: string;
  totalTokens: number;
  turns: Array<{
    turnIndex: number;
    tsStart: number;
    source: string;
    excerpt: string;
    score: number;
    tokens: number;
  }>;
  episodes: Array<{
    startTurn: number;
    endTurn: number;
    title: string;
    summary: string;
    score: number;
  }>;
}

const pillButtonStyle: React.CSSProperties = {
  padding: '5px 10px',
  fontSize: 11,
  borderRadius: 4,
  border: '1px solid #475569',
  background: '#1e293b',
  color: '#cbd5e1',
  cursor: 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
};

function ReindexItem({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 8px',
        background: 'transparent',
        border: 'none',
        color: '#e5e7eb',
        cursor: 'pointer',
        fontSize: 11,
        borderRadius: 4,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = '#334155')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <div style={{ fontWeight: 600 }}>{label}</div>
      <div style={{ color: '#94a3b8', fontSize: 10 }}>{hint}</div>
    </button>
  );
}

export function MemoryStatsPill({ chatId }: { chatId?: string }) {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [reindexMenu, setReindexMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState<MemorySearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [expandedTurn, setExpandedTurn] = useState<number | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    if (!chatId) return;
    try {
      const res = await fetch(`/api/memory/stats?chatId=${encodeURIComponent(chatId)}`);
      if (res.ok) setStats(await res.json());
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!chatId) {
      setStats(null);
      setOpen(false);
      setSearchResult(null);
      setSearchQuery('');
      return;
    }
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // Click-outside handler for the popover
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
        setReindexMenu(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!chatId) return null;

  const reindex = async (mode: 'incremental' | 'full' | 'embeddings' | 'episodes') => {
    if (!chatId) return;
    setLoading(true);
    setReindexMenu(false);
    try {
      await fetch('/api/memory/reindex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, mode }),
      });
      await refresh();
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  const toggleDisabled = async () => {
    if (!chatId) return;
    setLoading(true);
    try {
      await fetch('/api/memory/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId,
          action: stats?.disabled ? 'enable' : 'disable',
        }),
      });
      await refresh();
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  const runSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!chatId || !searchQuery.trim()) return;
    setSearching(true);
    setSearchResult(null);
    setExpandedTurn(null);
    try {
      const res = await fetch('/api/memory/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, query: searchQuery, k: 10 }),
      });
      if (res.ok) setSearchResult(await res.json());
    } catch {
      /* ignore */
    } finally {
      setSearching(false);
    }
  };

  const hasError = !!stats?.lastError;
  const isDisabled = !!stats?.disabled;
  const turnCount = stats?.turnCount ?? 0;
  const episodeCount = stats?.episodeCount ?? 0;

  // Pill colors — Fusio palette
  const borderColor = isDisabled
    ? 'var(--line, rgba(255,255,255,0.08))'
    : hasError
      ? 'rgba(204, 12, 32, 0.4)'
      : 'var(--line, rgba(255,255,255,0.08))';
  const bgColor = isDisabled
    ? 'var(--ink-2, #131319)'
    : hasError
      ? 'rgba(204, 12, 32, 0.1)'
      : 'var(--ink-3, #1B1B23)';
  const textColor = isDisabled
    ? 'var(--dim, rgba(255,255,255,0.32))'
    : hasError
      ? 'var(--red, #CC0C20)'
      : 'var(--mist, rgba(255,255,255,0.5))';

  const tooltip = stats
    ? `Memory ${isDisabled ? '(disabled)' : ''}: ${turnCount} turns, ${episodeCount} episodes\n` +
      `Last indexed turn: ${stats.lastIndexedTurn}\n` +
      `JSONL: ${stats.jsonlBytes != null ? (stats.jsonlBytes / 1024 / 1024).toFixed(1) + ' MB' : 'n/a'}\n` +
      `DB rows: ${(stats.dbBytes / 1024).toFixed(1)} KB\n` +
      (stats.lastError ? `\n⚠ ${stats.lastError}` : 'OK') +
      `\n\nClick to open menu`
    : 'Memory loading…';

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        title={tooltip}
        onClick={() => {
          setOpen((o) => !o);
          setReindexMenu(false);
        }}
        disabled={loading}
        data-fusio
        style={{
          padding: '4px 10px',
          fontSize: 10,
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          letterSpacing: '0.08em',
          borderRadius: 5,
          border: '1px solid ' + borderColor,
          background: bgColor,
          color: textColor,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          transition: 'all 120ms ease-out',
        }}
      >
        🧠{isDisabled ? '⊘' : ''} {loading ? '…' : `${turnCount}t`}
        {episodeCount > 0 ? ` · ${episodeCount}ep` : ''}
        {hasError ? ' ⚠' : ''}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 1000,
            width: 380,
            background: 'var(--ink, #0A0A0E)',
            border: '1px solid var(--line, rgba(255,255,255,0.08))',
            borderRadius: 10,
            padding: 14,
            color: 'var(--white, #fff)',
            fontSize: 12,
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            fontFamily: 'var(--font-sans, system-ui)',
          }}
        >
          {/* Header row */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div>
              <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
                Knowledge · Memory
              </div>
              <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--white, #fff)', marginTop: 1 }}>
                Chat memory {isDisabled && <span style={{ color: 'var(--mist, rgba(255,255,255,0.5))', fontWeight: 400, fontSize: 11 }}>· disabled</span>}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              data-fusio
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--mist, rgba(255,255,255,0.5))',
                cursor: 'pointer',
                fontSize: 18,
                padding: 0,
                lineHeight: 1,
                transition: 'color 120ms ease-out',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--red, #CC0C20)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
            >
              ×
            </button>
          </div>

          {/* Stats */}
          <div
            style={{
              background: 'var(--ink-2, #131319)',
              border: '1px solid var(--line, rgba(255,255,255,0.08))',
              borderRadius: 8,
              padding: 10,
              marginBottom: 12,
              fontFamily: 'var(--font-mono, ui-monospace)',
              fontSize: 11,
              lineHeight: 1.6,
              color: 'var(--fog, rgba(255,255,255,0.78))',
            }}
          >
            <div>
              Turns: <b style={{ color: 'var(--white, #fff)' }}>{turnCount}</b>
              {' · '}
              Episodes: <b style={{ color: 'var(--white, #fff)' }}>{episodeCount}</b>
            </div>
            <div>Last indexed: turn {stats?.lastIndexedTurn ?? '?'}</div>
            <div>
              JSONL: {stats?.jsonlBytes != null ? (stats.jsonlBytes / 1024 / 1024).toFixed(1) + ' MB' : 'n/a'}
              {' · '}
              DB: {stats ? (stats.dbBytes / 1024).toFixed(1) + ' KB' : 'n/a'}
            </div>
            {hasError && (
              <div style={{ color: 'var(--red, #CC0C20)', marginTop: 4 }}>⚠ {stats?.lastError}</div>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setReindexMenu((m) => !m)}
                disabled={loading}
                style={pillButtonStyle}
              >
                ↻ Reindex ▾
              </button>
              {reindexMenu && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 4px)',
                    left: 0,
                    background: '#1e293b',
                    border: '1px solid #475569',
                    borderRadius: 6,
                    padding: 4,
                    zIndex: 1001,
                    minWidth: 180,
                  }}
                >
                  <ReindexItem label="Incremental" hint="catch up new turns" onClick={() => reindex('incremental')} />
                  <ReindexItem label="Full rebuild" hint="wipe + reindex all" onClick={() => reindex('full')} />
                  <ReindexItem label="Embeddings only" hint="re-embed all turns" onClick={() => reindex('embeddings')} />
                  <ReindexItem label="Episodes only" hint="rebuild summaries" onClick={() => reindex('episodes')} />
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setSearchOpen((s) => !s);
                if (searchOpen) {
                  setSearchResult(null);
                  setSearchQuery('');
                }
              }}
              style={pillButtonStyle}
            >
              🔍 Search
            </button>
            <button
              type="button"
              onClick={toggleDisabled}
              disabled={loading}
              style={{
                ...pillButtonStyle,
                background: isDisabled ? '#065f46' : '#1e293b',
                color: isDisabled ? '#a7f3d0' : '#cbd5e1',
              }}
            >
              {isDisabled ? '✓ Enable' : '⊘ Disable'}
            </button>
          </div>

          {/* Search panel */}
          {searchOpen && (
            <div style={{ borderTop: '1px solid #334155', paddingTop: 10 }}>
              <form onSubmit={runSearch} style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search past turns…"
                  autoFocus
                  style={{
                    flex: 1,
                    padding: '6px 8px',
                    fontSize: 12,
                    background: '#0b1220',
                    border: '1px solid #334155',
                    borderRadius: 4,
                    color: '#f1f5f9',
                    outline: 'none',
                  }}
                />
                <button type="submit" disabled={searching || !searchQuery.trim()} style={pillButtonStyle}>
                  {searching ? '…' : 'Go'}
                </button>
              </form>
              {searchResult && (
                <div style={{ marginTop: 8, maxHeight: 320, overflowY: 'auto' }}>
                  <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 6 }}>
                    {searchResult.mode} · {searchResult.turns.length} turns · {searchResult.episodes.length} episodes · {searchResult.totalTokens} tokens
                  </div>
                  {searchResult.turns.length === 0 && searchResult.episodes.length === 0 && (
                    <div style={{ color: '#64748b', fontStyle: 'italic', fontSize: 11 }}>No matches.</div>
                  )}
                  {searchResult.episodes.map((ep) => (
                    <div
                      key={'ep-' + ep.startTurn}
                      style={{
                        background: '#0b1220',
                        border: '1px solid #1e3a8a',
                        borderRadius: 4,
                        padding: 6,
                        marginBottom: 6,
                        fontSize: 11,
                      }}
                    >
                      <div style={{ color: '#93c5fd', fontWeight: 600 }}>📚 {ep.title}</div>
                      <div style={{ color: '#cbd5e1', marginTop: 2 }}>{ep.summary}</div>
                      <div style={{ color: '#64748b', fontSize: 10, marginTop: 2 }}>
                        turns {ep.startTurn}–{ep.endTurn} · score {ep.score.toFixed(3)}
                      </div>
                    </div>
                  ))}
                  {searchResult.turns.map((t) => {
                    const expanded = expandedTurn === t.turnIndex;
                    return (
                      <div
                        key={t.turnIndex}
                        style={{
                          background: '#0b1220',
                          border: '1px solid #1e293b',
                          borderRadius: 4,
                          padding: 6,
                          marginBottom: 6,
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                        onClick={() => setExpandedTurn(expanded ? null : t.turnIndex)}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: 10 }}>
                          <span>turn {t.turnIndex} · {new Date(t.tsStart).toLocaleString()}</span>
                          <span>score {t.score.toFixed(3)}</span>
                        </div>
                        <div
                          style={{
                            color: '#e5e7eb',
                            marginTop: 2,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            maxHeight: expanded ? 'none' : 60,
                            overflow: 'hidden',
                          }}
                        >
                          {expanded ? t.excerpt : t.excerpt.slice(0, 250) + (t.excerpt.length > 250 ? '…' : '')}
                        </div>
                        {!expanded && t.excerpt.length > 250 && (
                          <div style={{ color: '#64748b', fontSize: 10, marginTop: 2 }}>click to expand</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
