'use client';

import { useState, useEffect } from 'react';
import { AlertTriangle, RefreshCw, ExternalLink, ChevronDown, ChevronRight, Clock, Trash2 } from 'lucide-react';

interface ErrorEntry {
  id: string;
  type: 'vercel' | 'supabase' | 'client';
  message: string;
  source: string;
  timestamp: string;
  count: number;
  stack?: string;
  resolved?: boolean;
}

export default function ErrorTracker() {
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'vercel' | 'supabase' | 'client'>('all');

  const fetchErrors = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/errors');
      if (response.ok) {
        const data = await response.json();
        setErrors(data.errors || []);
      }
    } catch (e) {
      console.error('Failed to fetch errors:', e);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchErrors();
    const interval = setInterval(fetchErrors, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, []);

  const resolveError = async (id: string) => {
    try {
      await fetch(`/api/errors/${id}/resolve`, { method: 'POST' });
      setErrors(errors.map(e => e.id === id ? { ...e, resolved: true } : e));
    } catch (e) {
      console.error('Failed to resolve error:', e);
    }
  };

  const clearResolved = () => {
    setErrors(errors.filter(e => !e.resolved));
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return `${Math.floor(diffMins / 1440)}d ago`;
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'vercel':
        return 'bg-terminal-cyan/20 text-terminal-cyan border-terminal-cyan/50';
      case 'supabase':
        return 'bg-terminal-green/20 text-terminal-green border-terminal-green/50';
      case 'client':
        return 'bg-terminal-amber/20 text-terminal-amber border-terminal-amber/50';
      default:
        return 'bg-terminal-dim/20 text-terminal-dim border-terminal-dim/50';
    }
  };

  const filteredErrors = filter === 'all' 
    ? errors 
    : errors.filter(e => e.type === filter);

  const unresolvedCount = errors.filter(e => !e.resolved).length;

  return (
    <div
      style={{
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 12,
        padding: 16,
        fontFamily: 'var(--font-sans, system-ui)',
        color: 'var(--white, #fff)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 24, height: 24, borderRadius: 6,
              background: 'rgba(204, 12, 32, 0.12)',
              border: '1px solid rgba(204, 12, 32, 0.35)',
            }}
          >
            <AlertTriangle style={{ width: 12, height: 12, color: 'var(--red, #CC0C20)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Dev · Incidents
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 1 }}>
              Error tracker
            </div>
          </div>
          {unresolvedCount > 0 && (
            <span
              style={{
                marginLeft: 4,
                padding: '2px 8px',
                background: 'rgba(204, 12, 32, 0.18)',
                color: 'var(--red, #CC0C20)',
                border: '1px solid rgba(204, 12, 32, 0.4)',
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 10, letterSpacing: '0.12em',
                borderRadius: 99,
              }}
            >
              {unresolvedCount}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={clearResolved}
            data-fusio
            title="Clear resolved"
            style={{
              padding: 6, borderRadius: 5, background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--mist, rgba(255,255,255,0.5))',
              transition: 'all 120ms ease-out',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
          >
            <Trash2 style={{ width: 13, height: 13 }} />
          </button>
          <button
            onClick={fetchErrors}
            disabled={loading}
            data-fusio
            title="Refresh"
            style={{
              padding: 6, borderRadius: 5, background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--mist, rgba(255,255,255,0.5))',
              opacity: loading ? 0.5 : 1,
              transition: 'all 120ms ease-out',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(204, 12, 32, 0.12)'; (e.currentTarget as HTMLElement).style.color = 'var(--red, #CC0C20)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
          >
            <RefreshCw style={{ width: 13, height: 13, animation: loading ? 'spin 1s linear infinite' : undefined }} />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-3">
        {(['all', 'vercel', 'supabase', 'client'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-2 py-1 text-xs rounded transition ${
              filter === f
                ? 'bg-terminal-red/20 text-terminal-red border border-terminal-red/50'
                : 'text-terminal-dim border border-terminal-border hover:border-terminal-dim'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Error List */}
      <div className="space-y-2 max-h-[400px] overflow-y-auto">
        {filteredErrors.length > 0 ? (
          filteredErrors.map((error) => (
            <div 
              key={error.id} 
              className={`bg-terminal-bg rounded overflow-hidden ${
                error.resolved ? 'opacity-50' : ''
              }`}
            >
              <div 
                className="px-3 py-2 flex items-start gap-3 cursor-pointer hover:bg-terminal-surface/50"
                onClick={() => setExpandedError(expandedError === error.id ? null : error.id)}
              >
                <div className="flex-shrink-0 mt-0.5">
                  {expandedError === error.id ? (
                    <ChevronDown className="w-4 h-4 text-terminal-dim" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-terminal-dim" />
                  )}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`px-1.5 py-0.5 text-xs rounded border ${getTypeColor(error.type)}`}>
                      {error.type}
                    </span>
                    {error.count > 1 && (
                      <span className="text-terminal-dim text-xs">×{error.count}</span>
                    )}
                    <span className="text-terminal-dim text-xs flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatTime(error.timestamp)}
                    </span>
                  </div>
                  <div className="text-terminal-red text-sm truncate">{error.message}</div>
                  <div className="text-terminal-dim text-xs truncate">{error.source}</div>
                </div>

                {!error.resolved && (
                  <button
                    onClick={(e) => { e.stopPropagation(); resolveError(error.id); }}
                    className="px-2 py-1 text-xs text-terminal-green hover:bg-terminal-green/20 
                               rounded transition"
                  >
                    Resolve
                  </button>
                )}
              </div>

              {expandedError === error.id && error.stack && (
                <div className="px-3 pb-3 border-t border-terminal-border/30">
                  <pre className="mt-2 p-2 bg-terminal-surface rounded text-xs text-terminal-dim 
                                  font-mono overflow-x-auto max-h-40 overflow-y-auto">
                    {error.stack}
                  </pre>
                </div>
              )}
            </div>
          ))
        ) : (
          <div className="text-center py-8 text-terminal-dim text-sm">
            {loading ? (
              <div className="flex items-center justify-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin" />
                Loading errors...
              </div>
            ) : (
              <>
                <div className="text-2xl mb-2">🎉</div>
                No errors! Everything is running smoothly.
              </>
            )}
          </div>
        )}
      </div>

      {/* Quick Links */}
      <div className="mt-3 pt-3 border-t border-terminal-border flex gap-2 justify-center">
        <a
          href="https://vercel.com/<your-github-user>/fieldrepapp/logs"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 px-2 py-1 text-xs text-terminal-dim 
                     hover:text-terminal-cyan transition"
        >
          <ExternalLink className="w-3 h-3" />
          Vercel Logs
        </a>
        <a
          href="https://supabase.com/dashboard/project/nqzhoplyamubcbqjuvxh/logs/edge-logs"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 px-2 py-1 text-xs text-terminal-dim 
                     hover:text-terminal-green transition"
        >
          <ExternalLink className="w-3 h-3" />
          Supabase Logs
        </a>
      </div>
    </div>
  );
}
