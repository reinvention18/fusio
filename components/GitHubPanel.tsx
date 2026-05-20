'use client';

import { useState, useEffect, useCallback } from 'react';
import { GitBranch, GitPullRequest, AlertCircle, Folder, File, ChevronRight, RefreshCw, Search, ExternalLink, Lock, Globe, Star, Link2, X, Check } from 'lucide-react';

interface Repo {
  name: string;
  owner: { login: string };
  description: string | null;
  url: string;
  isPrivate: boolean;
  isFork: boolean;
  pushedAt: string;
  defaultBranchRef: { name: string } | null;
  primaryLanguage: { name: string } | null;
  stargazerCount: number;
}

interface GitHubPanelProps {
  onAttachRepo?: (repo: { name: string; fullName: string; url: string; defaultBranch: string }) => void;
}

export default function GitHubPanel({ onAttachRepo }: GitHubPanelProps) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState('');
  const [authHint, setAuthHint] = useState<string>('');
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [repoFiles, setRepoFiles] = useState<any[]>([]);
  const [filePath, setFilePath] = useState('');
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [prs, setPrs] = useState<any[]>([]);
  const [issues, setIssues] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'files' | 'prs' | 'issues'>('files');
  const [attached, setAttached] = useState<Set<string>>(new Set());

  // Check auth status
  useEffect(() => {
    fetch('/api/github?action=status')
      .then(r => r.json())
      .then(d => {
        setAuthenticated(d.authenticated);
        if (d.user) setUser(d.user);
        if (d.hint) setAuthHint(d.hint);
      })
      .catch(() => setAuthenticated(false));
  }, []);

  // Load repos
  const fetchRepos = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/github?action=repos&limit=50');
      const data = await res.json();
      setRepos(data.repos || []);
    } catch (err: any) {
      console.error('[GitHub] Failed to fetch repos:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authenticated) fetchRepos();
  }, [authenticated, fetchRepos]);

  // Load repo details
  const openRepo = async (fullName: string) => {
    setSelectedRepo(fullName);
    setFilePath('');
    setFileContent(null);
    setActiveTab('files');
    // Fetch files, PRs, issues in parallel
    const [filesRes, prsRes, issuesRes] = await Promise.all([
      fetch(`/api/github?action=files&repo=${encodeURIComponent(fullName)}`).then(r => r.json()),
      fetch(`/api/github?action=prs&repo=${encodeURIComponent(fullName)}`).then(r => r.json()),
      fetch(`/api/github?action=issues&repo=${encodeURIComponent(fullName)}`).then(r => r.json()),
    ]);
    setRepoFiles(filesRes.files || []);
    setPrs(prsRes.prs || []);
    setIssues(issuesRes.issues || []);
  };

  const navigateToPath = async (path: string) => {
    setFilePath(path);
    setFileContent(null);
    try {
      const res = await fetch(`/api/github?action=files&repo=${encodeURIComponent(selectedRepo!)}&path=${encodeURIComponent(path)}`);
      const data = await res.json();
      setRepoFiles(data.files || []);
    } catch {}
  };

  const openFile = async (path: string) => {
    try {
      const res = await fetch(`/api/github?action=content&repo=${encodeURIComponent(selectedRepo!)}&path=${encodeURIComponent(path)}`);
      const data = await res.json();
      setFileContent(data.content || '');
      setFilePath(path);
    } catch {}
  };

  const attachRepo = (repo: Repo) => {
    const fullName = `${repo.owner.login}/${repo.name}`;
    setAttached(prev => new Set([...prev, fullName]));
    onAttachRepo?.({
      name: repo.name,
      fullName,
      url: repo.url,
      defaultBranch: repo.defaultBranchRef?.name || 'main',
    });
  };

  const filteredRepos = repos.filter(r =>
    !search || r.name.toLowerCase().includes(search.toLowerCase()) ||
    r.description?.toLowerCase().includes(search.toLowerCase())
  );

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    const now = new Date();
    const diffH = Math.floor((now.getTime() - d.getTime()) / 3600000);
    if (diffH < 1) return 'just now';
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 30) return `${diffD}d ago`;
    return d.toLocaleDateString();
  };

  if (authenticated === null) {
    return (
      <div
        style={{
          padding: 16, textAlign: 'center',
          fontFamily: 'var(--font-mono, ui-monospace)',
          fontSize: 11,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--mist, rgba(255,255,255,0.5))',
        }}
      >
        Checking GitHub auth…
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div
        className="card"
        style={{
          margin: '0 auto',
          maxWidth: 640,
          padding: 24,
          textAlign: 'center',
          fontFamily: 'var(--font-sans, system-ui)',
          color: 'var(--white, #fff)',
        }}
      >
        <div
          style={{
            width: 48, height: 48,
            margin: '0 auto 12px',
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid var(--line, rgba(255,255,255,0.08))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <GitBranch style={{ width: 22, height: 22, color: 'var(--mist, rgba(255,255,255,0.5))' }} />
        </div>
        <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))', marginBottom: 4 }}>
          Build · Integrations
        </div>
        <h3 style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 18, fontWeight: 600, letterSpacing: '-0.015em', marginBottom: 8 }}>
          GitHub not connected
        </h3>
        {authHint ? (
          <p style={{ color: 'var(--amber, #E8A23B)', fontSize: 13, marginBottom: 14 }}>{authHint}</p>
        ) : (
          <p style={{ color: 'var(--mist, rgba(255,255,255,0.5))', fontSize: 13, marginBottom: 14 }}>
            Run this in your terminal to authenticate:
          </p>
        )}
        <code
          style={{
            display: 'inline-block',
            background: 'var(--ink, #0A0A0E)',
            border: '1px solid var(--line, rgba(255,255,255,0.08))',
            padding: '8px 14px',
            borderRadius: 6,
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 12.5,
            color: 'var(--green, #4CC38A)',
          }}
        >
          gh auth login -h github.com
        </code>
        <p style={{ color: 'var(--mist, rgba(255,255,255,0.5))', fontSize: 11.5, marginTop: 14, lineHeight: 1.55 }}>
          The <code style={{ color: 'var(--cyan, #5EC4D9)', fontFamily: 'var(--font-mono)' }}>gh</code> CLI is per-machine. If this
          is the PC and Linux works, you need to auth on the PC too — open a PowerShell window and run the command above. After
          authenticating, refresh this panel.
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 12,
        overflow: 'hidden',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-sans, system-ui)',
        color: 'var(--white, #fff)',
      }}
    >
      {/* Header */}
      <div style={{ padding: 14, borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 22, height: 22, borderRadius: 5,
                background: 'rgba(204, 12, 32, 0.12)',
                border: '1px solid rgba(204, 12, 32, 0.35)',
              }}
            >
              <GitBranch style={{ width: 11, height: 11, color: 'var(--red, #CC0C20)' }} />
            </span>
            <div>
              <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
                Build · GitHub
              </div>
              <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>
                @{user || 'github'}
              </div>
            </div>
          </div>
          <button
            onClick={fetchRepos}
            disabled={loading}
            data-fusio
            title="Refresh repos"
            style={{
              padding: 5, borderRadius: 5, background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--mist, rgba(255,255,255,0.5))',
              transition: 'all 120ms ease-out',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
          >
            <RefreshCw style={{ width: 13, height: 13, animation: loading ? 'spin 1s linear infinite' : undefined }} />
          </button>
        </div>
        {!selectedRepo && (
          <div style={{ position: 'relative' }}>
            <Search style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', width: 13, height: 13, color: 'var(--mist, rgba(255,255,255,0.5))' }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search repositories…"
              data-fusio
              style={{
                width: '100%',
                background: 'var(--ink-3, #1B1B23)',
                border: '1px solid var(--line, rgba(255,255,255,0.08))',
                borderRadius: 6,
                paddingLeft: 32, paddingRight: 10, paddingTop: 6, paddingBottom: 6,
                fontSize: 12, fontFamily: 'var(--font-sans, system-ui)',
                color: 'var(--white, #fff)',
                outline: 'none',
              }}
            />
          </div>
        )}
        {selectedRepo && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              onClick={() => { setSelectedRepo(null); setFileContent(null); }}
              data-fusio
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10.5, letterSpacing: '0.12em',
                color: 'var(--mist, rgba(255,255,255,0.5))',
                transition: 'color 120ms ease-out',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
            >
              ← REPOS
            </button>
            <span style={{ fontSize: 12, fontFamily: 'var(--font-mono, ui-monospace)', color: 'var(--white, #fff)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedRepo}
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['files', 'prs', 'issues'] as const).map(tab => {
                const active = activeTab === tab;
                return (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    data-fusio
                    style={{
                      padding: '3px 8px',
                      fontFamily: 'var(--font-mono, ui-monospace)',
                      fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
                      borderRadius: 5,
                      background: active ? 'rgba(204, 12, 32, 0.12)' : 'transparent',
                      color: active ? 'var(--red, #CC0C20)' : 'var(--mist, rgba(255,255,255,0.5))',
                      border: `1px solid ${active ? 'rgba(204, 12, 32, 0.4)' : 'transparent'}`,
                      cursor: 'pointer',
                      transition: 'all 120ms ease-out',
                    }}
                  >
                    {tab === 'prs' ? `PRs · ${prs.length}` : tab === 'issues' ? `Issues · ${issues.length}` : 'Files'}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Repo List */}
        {!selectedRepo && (
          <div className="divide-y divide-terminal-border/30">
            {filteredRepos.map(repo => {
              const fullName = `${repo.owner.login}/${repo.name}`;
              const isAttached = attached.has(fullName);
              return (
                <div key={fullName} className="p-2.5 hover:bg-terminal-bg transition">
                  <div className="flex items-start gap-2">
                    <button onClick={() => openRepo(fullName)} className="flex-1 text-left min-w-0">
                      <div className="flex items-center gap-1.5">
                        {repo.isPrivate ? <Lock className="w-3 h-3 text-terminal-amber flex-shrink-0" /> : <Globe className="w-3 h-3 text-terminal-dim flex-shrink-0" />}
                        <span className="text-sm text-terminal-cyan font-mono truncate">{repo.name}</span>
                        {repo.stargazerCount > 0 && <span className="text-xs text-terminal-dim flex items-center gap-0.5"><Star className="w-2.5 h-2.5" />{repo.stargazerCount}</span>}
                      </div>
                      {repo.description && <div className="text-xs text-terminal-dim mt-0.5 truncate">{repo.description}</div>}
                      <div className="flex items-center gap-2 mt-1 text-xs text-terminal-dim">
                        {repo.primaryLanguage && <span>{repo.primaryLanguage.name}</span>}
                        <span>{formatTime(repo.pushedAt)}</span>
                      </div>
                    </button>
                    <button
                      onClick={() => attachRepo(repo)}
                      className={`p-1.5 rounded text-xs transition flex-shrink-0 ${
                        isAttached
                          ? 'bg-terminal-green/20 text-terminal-green border border-terminal-green/30'
                          : 'text-terminal-dim hover:text-terminal-cyan border border-terminal-border hover:border-terminal-cyan/30'
                      }`}
                      title={isAttached ? 'Attached to chat' : 'Attach to current chat'}
                    >
                      {isAttached ? <Check className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* File Browser */}
        {selectedRepo && activeTab === 'files' && !fileContent && (
          <div>
            {filePath && (
              <button
                onClick={() => {
                  const parent = filePath.split('/').slice(0, -1).join('/');
                  parent ? navigateToPath(parent) : openRepo(selectedRepo);
                }}
                className="w-full text-left p-2 text-xs text-terminal-dim hover:text-terminal-text border-b border-terminal-border/30"
              >
                ← {filePath || '/'}
              </button>
            )}
            <div className="divide-y divide-terminal-border/30">
              {repoFiles.sort((a: any, b: any) => {
                if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
                return a.name.localeCompare(b.name);
              }).map((f: any) => (
                <button
                  key={f.path}
                  onClick={() => f.type === 'dir' ? navigateToPath(f.path) : openFile(f.path)}
                  className="w-full text-left p-2 flex items-center gap-2 hover:bg-terminal-bg transition text-sm"
                >
                  {f.type === 'dir' ? <Folder className="w-3.5 h-3.5 text-terminal-amber" /> : <File className="w-3.5 h-3.5 text-terminal-dim" />}
                  <span className="font-mono text-terminal-text truncate">{f.name}</span>
                  {f.type === 'dir' && <ChevronRight className="w-3 h-3 text-terminal-dim ml-auto" />}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* File Content */}
        {selectedRepo && fileContent !== null && (
          <div>
            <div className="p-2 border-b border-terminal-border flex items-center justify-between">
              <span className="text-xs font-mono text-terminal-cyan truncate">{filePath}</span>
              <button onClick={() => setFileContent(null)} className="text-terminal-dim hover:text-terminal-text"><X className="w-3.5 h-3.5" /></button>
            </div>
            <pre className="p-3 text-xs text-terminal-text font-mono whitespace-pre-wrap overflow-x-auto">{fileContent.slice(0, 10000)}{fileContent.length > 10000 ? '\n...[truncated]' : ''}</pre>
          </div>
        )}

        {/* PRs */}
        {selectedRepo && activeTab === 'prs' && (
          <div className="divide-y divide-terminal-border/30">
            {prs.length === 0 && <div className="p-4 text-center text-terminal-dim text-sm">No open PRs</div>}
            {prs.map((pr: any) => (
              <div key={pr.number} className="p-2.5">
                <div className="flex items-center gap-2">
                  <GitPullRequest className={`w-3.5 h-3.5 flex-shrink-0 ${pr.isDraft ? 'text-terminal-dim' : 'text-terminal-green'}`} />
                  <span className="text-sm text-terminal-text flex-1 truncate">{pr.title}</span>
                  <span className="text-xs text-terminal-dim">#{pr.number}</span>
                </div>
                <div className="text-xs text-terminal-dim mt-1 flex items-center gap-2 ml-5">
                  <span>{pr.headRefName}</span>
                  <span>by {pr.author?.login}</span>
                  <span>{formatTime(pr.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Issues */}
        {selectedRepo && activeTab === 'issues' && (
          <div className="divide-y divide-terminal-border/30">
            {issues.length === 0 && <div className="p-4 text-center text-terminal-dim text-sm">No open issues</div>}
            {issues.map((issue: any) => (
              <div key={issue.number} className="p-2.5">
                <div className="flex items-center gap-2">
                  <AlertCircle className={`w-3.5 h-3.5 flex-shrink-0 ${issue.state === 'OPEN' ? 'text-terminal-green' : 'text-terminal-dim'}`} />
                  <span className="text-sm text-terminal-text flex-1 truncate">{issue.title}</span>
                  <span className="text-xs text-terminal-dim">#{issue.number}</span>
                </div>
                <div className="text-xs text-terminal-dim mt-1 ml-5 flex items-center gap-2">
                  {issue.labels?.map((l: any) => (
                    <span key={l.name} className="px-1 py-0.5 rounded bg-terminal-purple/20 text-terminal-purple">{l.name}</span>
                  ))}
                  <span>{formatTime(issue.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
