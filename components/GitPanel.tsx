'use client';

import { useState, useEffect } from 'react';
import { GitBranch, GitCommit, RefreshCw, Send, AlertCircle, CheckCircle, Loader2 } from 'lucide-react';

interface GitStatus {
  branch: string;
  isDirty: boolean;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  recentCommits: Array<{
    hash: string;
    message: string;
    author: string;
    date: string;
  }>;
}

export default function GitPanel() {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchStatus = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/git/status');
      if (response.ok) {
        const data = await response.json();
        setStatus(data);
        setError(null);
      } else {
        setError('Failed to fetch git status');
      }
    } catch (e) {
      setError('Network error');
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleCommit = async () => {
    if (!commitMessage.trim()) return;
    
    setCommitting(true);
    setError(null);
    setSuccess(null);
    
    try {
      const response = await fetch('/api/git/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMessage })
      });
      
      if (response.ok) {
        setCommitMessage('');
        setSuccess('Committed successfully');
        fetchStatus();
      } else {
        const data = await response.json();
        setError(data.error || 'Commit failed');
      }
    } catch (e) {
      setError('Network error');
    }
    setCommitting(false);
  };

  const handlePush = async () => {
    setPushing(true);
    setError(null);
    setSuccess(null);
    
    try {
      const response = await fetch('/api/git/push', { method: 'POST' });
      
      if (response.ok) {
        setSuccess('Pushed successfully');
        fetchStatus();
      } else {
        const data = await response.json();
        setError(data.error || 'Push failed');
      }
    } catch (e) {
      setError('Network error');
    }
    setPushing(false);
  };

  const handleSwitchBranch = async (branch: string) => {
    try {
      const response = await fetch('/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch })
      });
      
      if (response.ok) {
        setSuccess(`Switched to ${branch}`);
        fetchStatus();
      } else {
        const data = await response.json();
        setError(data.error || 'Switch failed');
      }
    } catch (e) {
      setError('Network error');
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return `${Math.floor(diffMins / 1440)}d ago`;
  };

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
              background: 'rgba(139, 111, 232, 0.12)',
              border: '1px solid rgba(139, 111, 232, 0.35)',
            }}
          >
            <GitBranch style={{ width: 12, height: 12, color: 'var(--violet, #8B6FE8)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Dev · Source
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 1 }}>
              Git status
            </div>
          </div>
        </div>
        <button
          onClick={fetchStatus}
          disabled={loading}
          data-fusio
          title="Refresh"
          style={{
            padding: 6, borderRadius: 5, background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--mist, rgba(255,255,255,0.5))',
            opacity: loading ? 0.5 : 1,
            transition: 'all 120ms ease-out',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(139, 111, 232, 0.12)'; (e.currentTarget as HTMLElement).style.color = 'var(--violet, #8B6FE8)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
        >
          <RefreshCw style={{ width: 14, height: 14, animation: loading ? 'spin 1s linear infinite' : undefined }} />
        </button>
      </div>

      {/* Error/Success Messages */}
      {error && (
        <div className="mb-3 p-2 bg-terminal-red/20 border border-terminal-red/50 rounded text-terminal-red text-xs flex items-center gap-2">
          <AlertCircle className="w-3 h-3" />
          {error}
        </div>
      )}
      {success && (
        <div className="mb-3 p-2 bg-terminal-green/20 border border-terminal-green/50 rounded text-terminal-green text-xs flex items-center gap-2">
          <CheckCircle className="w-3 h-3" />
          {success}
        </div>
      )}

      {status ? (
        <>
          {/* Branch Status */}
          <div className="bg-terminal-bg rounded p-3 mb-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <GitBranch className="w-4 h-4 text-terminal-cyan" />
                <span className="text-terminal-cyan font-mono font-bold">{status.branch}</span>
                {status.isDirty && (
                  <span className="text-terminal-amber text-xs">(modified)</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {status.ahead > 0 && (
                  <span className="text-terminal-green text-xs">↑{status.ahead}</span>
                )}
                {status.behind > 0 && (
                  <span className="text-terminal-red text-xs">↓{status.behind}</span>
                )}
              </div>
            </div>

            {/* Quick Branch Switch */}
            <div className="flex gap-2 mt-2">
              {['main', 'staging'].map(branch => (
                <button
                  key={branch}
                  onClick={() => handleSwitchBranch(branch)}
                  disabled={status.branch === branch}
                  className={`px-2 py-1 text-xs rounded transition ${
                    status.branch === branch
                      ? 'bg-terminal-purple/30 text-terminal-purple border border-terminal-purple/50'
                      : 'bg-terminal-surface text-terminal-dim hover:text-terminal-text border border-terminal-border'
                  }`}
                >
                  {branch}
                </button>
              ))}
            </div>
          </div>

          {/* Working Tree Status */}
          {(status.staged > 0 || status.unstaged > 0 || status.untracked > 0) && (
            <div className="bg-terminal-bg rounded p-3 mb-3">
              <div className="text-terminal-dim text-xs mb-2">Working Tree</div>
              <div className="flex gap-4 text-xs">
                {status.staged > 0 && (
                  <span className="text-terminal-green">+{status.staged} staged</span>
                )}
                {status.unstaged > 0 && (
                  <span className="text-terminal-amber">~{status.unstaged} modified</span>
                )}
                {status.untracked > 0 && (
                  <span className="text-terminal-dim">?{status.untracked} untracked</span>
                )}
              </div>
            </div>
          )}

          {/* Quick Commit */}
          <div className="bg-terminal-bg rounded p-3 mb-3">
            <div className="text-terminal-dim text-xs mb-2">Quick Commit</div>
            <div className="flex gap-2">
              <input
                type="text"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCommit()}
                placeholder="feat: add new feature"
                className="flex-1 bg-terminal-surface border border-terminal-border rounded px-2 py-1.5 
                           text-terminal-text text-sm focus:border-terminal-purple outline-none font-mono"
              />
              <button
                onClick={handleCommit}
                disabled={committing || !commitMessage.trim()}
                className="px-3 py-1.5 bg-terminal-purple/20 text-terminal-purple border 
                           border-terminal-purple/50 rounded hover:bg-terminal-purple/30 transition
                           disabled:opacity-50 text-sm"
              >
                {committing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
            {status.ahead > 0 && (
              <button
                onClick={handlePush}
                disabled={pushing}
                className="w-full mt-2 px-3 py-1.5 bg-terminal-green/20 text-terminal-green border 
                           border-terminal-green/50 rounded hover:bg-terminal-green/30 transition
                           disabled:opacity-50 text-sm flex items-center justify-center gap-2"
              >
                {pushing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>Push {status.ahead} commit{status.ahead > 1 ? 's' : ''}</>
                )}
              </button>
            )}
          </div>

          {/* Recent Commits */}
          <div className="bg-terminal-bg rounded p-3">
            <div className="flex items-center gap-2 text-terminal-dim text-xs mb-2">
              <GitCommit className="w-3 h-3" />
              Recent Commits
            </div>
            <div className="space-y-2">
              {status.recentCommits.slice(0, 5).map((commit, i) => (
                <div key={commit.hash} className="text-xs">
                  <div className="flex items-start gap-2">
                    <span className="text-terminal-purple font-mono">{commit.hash.slice(0, 7)}</span>
                    <span className="text-terminal-text flex-1 truncate">{commit.message}</span>
                  </div>
                  <div className="text-terminal-dim ml-[4.5rem]">
                    {commit.author} • {formatDate(commit.date)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : loading ? (
        <div className="flex items-center justify-center py-8 text-terminal-dim">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : (
        <div className="text-center py-8 text-terminal-dim text-sm">
          Unable to load git status
        </div>
      )}
    </div>
  );
}
