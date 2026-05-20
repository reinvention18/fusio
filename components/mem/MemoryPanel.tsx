'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, Brain, Loader2, RefreshCw, Save, Clock, Zap } from 'lucide-react';

type ObservationType = 'decision' | 'pattern' | 'blocker' | 'fact' | 'skill' | 'finding' | 'summary';

interface TimelineEntry {
  id: number;
  sessionId: string;
  type: ObservationType;
  title: string;
  summary: string;
  createdAt: number;
}

interface SearchHit {
  id: number;
  sessionId: string;
  type: ObservationType;
  title: string;
  excerpt: string;
  tags: string[];
  score: number;
  createdAt: number;
}

interface MemoryPanelProps {
  /** Resolve mode: pass any of these, panel will create/ensure the session. */
  chatSessionKey?: string;       // mc-XXXX-… key; resolves to mem chat session
  teamId?: string;               // team ID; resolves to team_meta session
  memSessionId?: string;         // already-resolved mem session id
  title?: string;                // panel header
}

const TYPE_COLORS: Record<ObservationType, string> = {
  decision: 'text-terminal-cyan border-terminal-cyan/40 bg-terminal-cyan/10',
  pattern: 'text-terminal-purple border-terminal-purple/40 bg-terminal-purple/10',
  blocker: 'text-terminal-red border-terminal-red/40 bg-terminal-red/10',
  fact: 'text-terminal-text border-terminal-border bg-terminal-surface',
  skill: 'text-terminal-green border-terminal-green/40 bg-terminal-green/10',
  finding: 'text-terminal-amber border-terminal-amber/40 bg-terminal-amber/10',
  summary: 'text-terminal-dim border-terminal-border bg-terminal-bg',
};

function fmtTime(ts: number): string {
  const now = Date.now();
  const age = now - ts;
  if (age < 60_000) return 'just now';
  if (age < 3600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86400_000) return `${Math.floor(age / 3600_000)}h ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function MemoryPanel({ chatSessionKey, teamId, memSessionId, title }: MemoryPanelProps) {
  const [sessionId, setSessionId] = useState<string | null>(memSessionId ?? null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [typeFilter, setTypeFilter] = useState<ObservationType | 'all'>('all');
  const [compressing, setCompressing] = useState(false);
  const [compressMsg, setCompressMsg] = useState<string | null>(null);

  // Resolve / ensure a session
  useEffect(() => {
    if (memSessionId) {
      setSessionId(memSessionId);
      return;
    }
    if (!chatSessionKey && !teamId) return;
    let cancelled = false;
    (async () => {
      try {
        const body = chatSessionKey
          ? { kind: 'chat', chat_id: chatSessionKey }
          : { kind: 'team_meta', team_id: teamId };
        const res = await fetch('/api/mem/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await res.json();
        if (cancelled) return;
        if (d?.session?.id) setSessionId(d.session.id);
        else setError(d?.error || 'Could not resolve memory session');
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [chatSessionKey, teamId, memSessionId]);

  // Load timeline
  const loadTimeline = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/mem/timeline?session_id=${sessionId}&limit=40`);
      const d = await res.json();
      setTimeline(d.entries || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    loadTimeline();
    const interval = setInterval(loadTimeline, 8000);
    return () => clearInterval(interval);
  }, [sessionId, loadTimeline]);

  // Search
  const doSearch = useCallback(async () => {
    const q = query.trim();
    if (!q || q.length < 2 || !sessionId) { setHits([]); return; }
    setSearching(true);
    try {
      const res = await fetch(`/api/mem/search?q=${encodeURIComponent(q)}&session_id=${sessionId}&limit=15`);
      const d = await res.json();
      setHits(d.hits || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSearching(false);
    }
  }, [query, sessionId]);

  // Manual compression trigger
  const doCompress = useCallback(async () => {
    if (compressing) return;
    setCompressing(true);
    setCompressMsg('Compressing…');
    try {
      const res = await fetch('/api/mem/tick', { method: 'POST' });
      const d = await res.json();
      const n = d?.observationsWritten ?? 0;
      const s = d?.sessionsProcessed ?? 0;
      setCompressMsg(`✓ ${n} new observation${n === 1 ? '' : 's'} from ${s} session${s === 1 ? '' : 's'}`);
      await loadTimeline();
      setTimeout(() => setCompressMsg(null), 4000);
    } catch (e: any) {
      setCompressMsg(`✗ ${e.message}`);
    } finally {
      setCompressing(false);
    }
  }, [compressing, loadTimeline]);

  // Stats
  const stats = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of timeline) counts[e.type] = (counts[e.type] || 0) + 1;
    return counts;
  }, [timeline]);

  const visibleTimeline = useMemo(() => {
    return typeFilter === 'all' ? timeline : timeline.filter(e => e.type === typeFilter);
  }, [timeline, typeFilter]);

  const toggleExpand = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'var(--font-sans, system-ui)' }}>
      {/* Header */}
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
          background: 'var(--ink, #0A0A0E)',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, borderRadius: 5,
            background: 'rgba(139, 111, 232, 0.12)',
            border: '1px solid rgba(139, 111, 232, 0.35)',
          }}
        >
          <Brain style={{ width: 11, height: 11, color: 'var(--violet, #8B6FE8)' }} />
        </span>
        <div>
          <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
            Knowledge · Observations
          </div>
          <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 1, color: 'var(--white, #fff)' }}>
            {title || 'Memory'}
          </div>
        </div>
        {sessionId && (
          <span style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.04em', color: 'var(--dim, rgba(255,255,255,0.32))' }}>
            session · {sessionId.slice(0, 8)}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
          {timeline.length} obs
        </span>
        <button
          onClick={doCompress}
          disabled={compressing}
          data-fusio
          title="Distill pending queue into observations now"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '3px 10px',
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
            borderRadius: 5,
            background: 'rgba(94, 196, 217, 0.1)',
            color: 'var(--cyan, #5EC4D9)',
            border: '1px solid rgba(94, 196, 217, 0.35)',
            cursor: 'pointer',
            opacity: compressing ? 0.5 : 1,
            transition: 'filter 120ms ease-out',
          }}
        >
          {compressing
            ? <Loader2 style={{ width: 10, height: 10, animation: 'spin 1s linear infinite' }} />
            : <Zap style={{ width: 10, height: 10 }} />}
          Compress
        </button>
        <button
          onClick={loadTimeline}
          disabled={loading}
          data-fusio
          title="Refresh"
          style={{
            padding: 4, borderRadius: 4, background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--mist, rgba(255,255,255,0.5))',
            transition: 'color 120ms ease-out',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
        >
          {loading
            ? <Loader2 style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} />
            : <RefreshCw style={{ width: 12, height: 12 }} />}
        </button>
      </div>
      {compressMsg && (
        <div className="px-3 py-1 text-[10px] text-terminal-cyan bg-terminal-cyan/10 border-b border-terminal-cyan/20">
          {compressMsg}
        </div>
      )}

      {/* Search + filter */}
      <div className="px-3 py-2 border-b border-terminal-border bg-terminal-bg/40 space-y-2">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-terminal-dim absolute left-2 top-2" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') doSearch(); }}
            placeholder="Search observations (⏎)…"
            className="w-full pl-7 pr-20 py-1.5 text-xs bg-terminal-surface border border-terminal-border rounded focus:border-terminal-cyan/50 focus:outline-none text-terminal-text"
          />
          <button
            onClick={doSearch}
            disabled={query.trim().length < 2 || searching}
            className="absolute right-1 top-1 px-2 py-0.5 text-[10px] rounded bg-terminal-cyan/20 text-terminal-cyan border border-terminal-cyan/40 hover:bg-terminal-cyan/30 disabled:opacity-40"
          >
            {searching ? '…' : 'Search'}
          </button>
        </div>

        {/* Type filter chips */}
        <div className="flex items-center gap-1 flex-wrap">
          <button
            onClick={() => setTypeFilter('all')}
            className={`text-[10px] px-1.5 py-0.5 rounded border ${
              typeFilter === 'all'
                ? 'border-terminal-green text-terminal-green bg-terminal-green/10'
                : 'border-terminal-border text-terminal-dim hover:text-terminal-text'
            }`}
          >
            all ({timeline.length})
          </button>
          {(['decision', 'finding', 'blocker', 'fact', 'skill', 'pattern', 'summary'] as ObservationType[]).map(t => {
            const n = stats[t] || 0;
            if (n === 0 && typeFilter !== t) return null;
            const active = typeFilter === t;
            return (
              <button
                key={t}
                onClick={() => setTypeFilter(active ? 'all' : t)}
                className={`text-[10px] px-1.5 py-0.5 rounded border uppercase tracking-wider ${
                  active
                    ? TYPE_COLORS[t]
                    : 'border-terminal-border text-terminal-dim hover:text-terminal-text'
                }`}
              >
                {t} {n > 0 ? `(${n})` : ''}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {error && (
          <div className="text-xs text-terminal-red bg-terminal-red/10 border border-terminal-red/30 rounded p-2">
            {error}
          </div>
        )}

        {/* Search hits (when active) */}
        {hits.length > 0 && (
          <section>
            <div className="text-[10px] uppercase tracking-wider text-terminal-dim mb-1.5 flex items-center gap-1">
              <Search className="w-3 h-3" />
              Search results ({hits.length})
              <button
                onClick={() => { setHits([]); setQuery(''); }}
                className="ml-auto text-terminal-amber hover:text-terminal-text normal-case"
              >
                clear ✕
              </button>
            </div>
            <div className="space-y-1.5">
              {hits.map(h => (
                <ObservationCard
                  key={`hit-${h.id}`}
                  id={h.id}
                  type={h.type}
                  title={h.title}
                  body={h.excerpt}
                  createdAt={h.createdAt}
                  score={h.score}
                  tags={h.tags}
                  isOpen={expanded.has(h.id)}
                  onToggle={() => toggleExpand(h.id)}
                />
              ))}
            </div>
          </section>
        )}

        {/* Timeline */}
        {hits.length === 0 && (
          <section>
            <div className="text-[10px] uppercase tracking-wider text-terminal-dim mb-1.5 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Recent
            </div>
            {visibleTimeline.length === 0 && !loading && (
              <div className="text-center py-8 text-terminal-dim text-xs space-y-1">
                <div className="text-2xl opacity-50">🧠</div>
                <p>No observations yet.</p>
                <p className="text-[10px]">Observations are compressed from chat/agent activity every ~30s.</p>
              </div>
            )}
            <div className="space-y-1.5">
              {visibleTimeline.map(e => (
                <ObservationCard
                  key={e.id}
                  id={e.id}
                  type={e.type}
                  title={e.title}
                  body={e.summary}
                  createdAt={e.createdAt}
                  isOpen={expanded.has(e.id)}
                  onToggle={() => toggleExpand(e.id)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

interface CardProps {
  id: number;
  type: ObservationType;
  title: string;
  body: string;
  createdAt: number;
  score?: number;
  tags?: string[];
  isOpen: boolean;
  onToggle: () => void;
}

function ObservationCard({ id, type, title, body, createdAt, score, tags, isOpen, onToggle }: CardProps) {
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);

  const expand = async () => {
    onToggle();
    if (!fullContent && !loadingFull) {
      setLoadingFull(true);
      try {
        const res = await fetch(`/api/mem/observations?id=${id}`);
        const d = await res.json();
        if (d?.content) setFullContent(d.content);
      } catch { /* ignore */ }
      setLoadingFull(false);
    }
  };

  return (
    <div className={`rounded border text-xs ${TYPE_COLORS[type]}`}>
      <button onClick={expand} className="w-full text-left px-2 py-1.5 hover:bg-black/20 rounded-t">
        <div className="flex items-start gap-2">
          <span className="text-[9px] uppercase tracking-wider font-bold flex-shrink-0 opacity-70 mt-0.5">
            {type}
          </span>
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate">{title}</div>
            {!isOpen && body && (
              <div className="text-[11px] opacity-70 line-clamp-2 leading-snug mt-0.5">{body}</div>
            )}
          </div>
          <div className="flex-shrink-0 flex items-center gap-1 opacity-60 text-[10px]">
            {score !== undefined && <span>{(score * 100).toFixed(0)}%</span>}
            <span>{fmtTime(createdAt)}</span>
            <span>{isOpen ? '▾' : '▸'}</span>
          </div>
        </div>
      </button>
      {isOpen && (
        <div className="px-2 pb-2 pt-1 border-t border-current/20 text-[11px] whitespace-pre-wrap leading-relaxed">
          {loadingFull ? (
            <span className="opacity-60">Loading…</span>
          ) : (
            fullContent || body
          )}
          {tags && tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-current/10">
              {tags.map(t => (
                <span key={t} className="text-[9px] px-1.5 rounded bg-black/20 opacity-70">{t}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
