'use client';

/**
 * PullLatestButton — chat-header dropdown that lets the user fast-forward
 * any (or all) managed repos with one click.
 *
 * Status (ahead/behind/dirty) is fetched on open. The button shows a small
 * red dot when ANY managed repo is behind origin so you can see drift at
 * a glance without opening the dropdown.
 */

import { useEffect, useRef, useState } from 'react';
import { GitBranch, RefreshCw, ChevronDown, AlertTriangle } from 'lucide-react';

interface RepoStatus {
  id: string;
  label: string;
  path?: string;
  exists: boolean;
  branch?: string;
  head?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  dirtyCount?: number;
}

interface PullResult {
  id: string;
  label: string;
  ok: boolean;
  before?: string;
  after?: string;
  changedFiles?: string[];
  error?: string;
  pullCount?: number;
}

const POLL_MS = 30_000;

export function PullLatestButton() {
  const [open, setOpen] = useState(false);
  const [repos, setRepos] = useState<RepoStatus[]>([]);
  const [pulling, setPulling] = useState<string | null>(null); // repoId | 'all'
  const [results, setResults] = useState<PullResult[]>([]);
  const [resultsAt, setResultsAt] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Click-outside
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const refresh = async () => {
    try {
      const r = await fetch('/api/git/status');
      if (!r.ok) return;
      const d = await r.json();
      setRepos(d.repos || []);
    } catch { /* ignore */ }
  };

  // Refresh on mount + on open + every 30s while open
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    if (!open) return;
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [open]);

  const anyBehind = repos.some(r => (r.behind || 0) > 0);
  const totalBehind = repos.reduce((s, r) => s + (r.behind || 0), 0);

  const pull = async (repoId: string) => {
    setPulling(repoId);
    setResults([]);
    try {
      const r = await fetch('/api/git/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: repoId }),
      });
      const d = await r.json();
      setResults(d.results || []);
      setResultsAt(Date.now());
      await refresh();
    } catch (e: any) {
      setResults([{ id: repoId, label: repoId, ok: false, error: e?.message || 'request failed' }]);
      setResultsAt(Date.now());
    } finally {
      setPulling(null);
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="Pull latest from git for managed repos"
        data-fusio
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '5px 10px',
          fontFamily: 'var(--font-mono, ui-monospace)',
          fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
          borderRadius: 5,
          background: anyBehind ? 'rgba(232, 162, 59, 0.12)' : 'var(--ink-3, #1B1B23)',
          color: anyBehind ? 'var(--amber, #E8A23B)' : 'var(--mist, rgba(255,255,255,0.5))',
          border: `1px solid ${anyBehind ? 'rgba(232, 162, 59, 0.4)' : 'var(--line, rgba(255,255,255,0.08))'}`,
          cursor: 'pointer',
          transition: 'all 120ms ease-out',
        }}
        onMouseEnter={e => { if (!anyBehind) (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
        onMouseLeave={e => { if (!anyBehind) (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
      >
        <GitBranch style={{ width: 11, height: 11, animation: pulling ? 'spin 1s linear infinite' : undefined }} />
        <span>Pull Latest</span>
        {anyBehind && (
          <span style={{ marginLeft: 4, fontWeight: 600 }}>
            {totalBehind} behind
          </span>
        )}
        <ChevronDown style={{ width: 11, height: 11 }} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            marginTop: 8,
            right: 0,
            zIndex: 1000,
            width: 440,
            background: 'var(--ink, #0A0A0E)',
            border: '1px solid var(--line, rgba(255,255,255,0.08))',
            borderRadius: 10,
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            overflow: 'hidden',
            fontFamily: 'var(--font-sans, system-ui)',
          }}
        >
          {/* Header row */}
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 12px',
              borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
              background: 'var(--ink-2, #131319)',
            }}
          >
            <div>
              <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
                Tools · Git
              </div>
              <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--white, #fff)' }}>
                Managed repositories
              </div>
            </div>
            <button
              onClick={() => pull('all')}
              disabled={!!pulling || repos.every(r => !r.exists)}
              data-fusio
              className="card-btn primary"
              title="Pull every repo (skips dirty trees)"
              style={{
                marginLeft: 'auto',
                fontSize: 10,
                padding: '4px 10px',
                background: 'var(--cyan, #5EC4D9)',
                borderColor: 'var(--cyan, #5EC4D9)',
                color: '#06181d',
                fontFamily: 'var(--font-mono, ui-monospace)',
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                opacity: (!!pulling || repos.every(r => !r.exists)) ? 0.5 : 1,
                cursor: (!!pulling || repos.every(r => !r.exists)) ? 'not-allowed' : 'pointer',
              }}
            >
              {pulling === 'all' ? 'Pulling…' : 'Pull all'}
            </button>
            <button
              onClick={refresh}
              data-fusio
              title="Refresh status"
              style={{
                padding: 4, borderRadius: 4, background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--mist, rgba(255,255,255,0.5))',
                transition: 'all 120ms ease-out',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
            >
              <RefreshCw style={{ width: 11, height: 11 }} />
            </button>
          </div>

          {/* Repo list */}
          <div className="max-h-[400px] overflow-y-auto">
            {repos.length === 0 && (
              <div className="p-4 text-xs text-terminal-dim italic text-center">
                No managed repos found. Edit <code>lib/git-pull/repos.ts</code> to add some.
              </div>
            )}
            {repos.map(r => {
              const behind = r.behind || 0;
              const ahead = r.ahead || 0;
              const status =
                !r.exists ? 'missing'
                : r.dirty ? 'dirty'
                : behind > 0 && ahead > 0 ? 'diverged'
                : behind > 0 ? 'behind'
                : ahead > 0 ? 'ahead'
                : 'clean';
              const statusColor = {
                missing: 'text-terminal-red',
                dirty: 'text-terminal-amber',
                diverged: 'text-terminal-amber',
                behind: 'text-terminal-cyan',
                ahead: 'text-terminal-green',
                clean: 'text-terminal-dim',
              }[status];

              return (
                <div key={r.id} className="px-3 py-2 border-b border-terminal-border/30 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-terminal-text">{r.label}</div>
                    <div className="text-[10px] text-terminal-dim font-mono truncate">
                      {r.exists
                        ? `${r.branch || '?'} @ ${r.head || '?'}`
                        : 'not found'}
                    </div>
                    <div className={`text-[10px] ${statusColor}`}>
                      {status === 'clean' && 'up-to-date'}
                      {status === 'behind' && `${behind} behind`}
                      {status === 'ahead' && `${ahead} ahead (push)`}
                      {status === 'diverged' && `${behind} behind, ${ahead} ahead`}
                      {status === 'dirty' && `${r.dirtyCount || 0} uncommitted`}
                      {status === 'missing' && 'missing'}
                    </div>
                  </div>
                  <button
                    onClick={() => pull(r.id)}
                    disabled={!!pulling || !r.exists || r.dirty || (behind === 0 && ahead === 0)}
                    title={
                      !r.exists ? 'Repo not found locally'
                      : r.dirty ? 'Working tree has uncommitted changes — commit or stash first'
                      : behind === 0 ? 'Already up-to-date'
                      : `Pull ${behind} commit(s) from origin/${r.branch}`
                    }
                    className="px-2 py-1 text-[10px] rounded border border-terminal-cyan/40 text-terminal-cyan hover:bg-terminal-cyan/15 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {pulling === r.id ? '…' : 'Pull'}
                  </button>
                </div>
              );
            })}
          </div>

          {/* Last pull results */}
          {results.length > 0 && (
            <div className="border-t border-terminal-border/40 bg-terminal-bg/40 p-2 max-h-[180px] overflow-y-auto">
              <div className="text-[10px] text-terminal-dim mb-1">
                Pull result · {resultsAt && new Date(resultsAt).toLocaleTimeString()}
              </div>
              {results.map((r, i) => (
                <div key={`${r.id}-${i}`} className="text-[11px] mb-1.5">
                  {r.ok ? (
                    <div>
                      <span className="text-terminal-green">✓</span>{' '}
                      <span className="text-terminal-text">{r.label}</span>{' '}
                      <span className="text-terminal-dim">
                        {(r.changedFiles?.length || 0) === 0
                          ? 'already up-to-date'
                          : `+${r.changedFiles!.length} file${r.changedFiles!.length === 1 ? '' : 's'}`}
                      </span>
                      {r.before && r.after && r.before !== r.after && (
                        <span className="text-terminal-dim ml-1 font-mono text-[10px]">
                          ({r.before.slice(0,7)} → {r.after.slice(0,7)})
                        </span>
                      )}
                      {r.changedFiles && r.changedFiles.length > 0 && (
                        <div className="ml-3 text-[10px] text-terminal-dim mt-0.5">
                          {r.changedFiles.slice(0, 5).map(f => (
                            <div key={f} className="truncate">{f}</div>
                          ))}
                          {r.changedFiles.length > 5 && <div>… {r.changedFiles.length - 5} more</div>}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-start gap-1">
                      <AlertTriangle className="w-3 h-3 text-terminal-red flex-shrink-0 mt-0.5" />
                      <div>
                        <span className="text-terminal-text font-medium">{r.label}:</span>{' '}
                        <span className="text-terminal-red">{r.error}</span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
