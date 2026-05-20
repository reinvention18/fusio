'use client';

import { useEffect, useMemo, useState } from 'react';
import { FileText, FileCheck, Plus, Trash2, RefreshCw, Search, Save, X, Wifi, GitBranch } from 'lucide-react';

type DocType = 'note' | 'plan';

interface DocSummary {
  id: string;
  type: DocType;
  title: string;
  updated: string;
  authorHost?: string;
  tags?: string[];
  bytes: number;
  /** synthesized client-side: which host this summary came from. local || peer id */
  _host?: string;
  _hostLabel?: string;
}

interface Doc extends DocSummary {
  content: string;
  created: string;
  chatOrigin?: string;
}

interface PeerHost { id: string; label: string; url: string; }

export default function DocsPanel() {
  const [peers, setPeers] = useState<PeerHost[]>([]);
  const [localLabel, setLocalLabel] = useState('local');
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | DocType>('all');
  const [hostFilter, setHostFilter] = useState<'all' | string>('all');
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeHost, setActiveHost] = useState<string | null>(null); // null=local, otherwise peer id
  const [activeDoc, setActiveDoc] = useState<Doc | null>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editType, setEditType] = useState<DocType>('plan');
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ at: number; pulled: number; error?: string } | null>(null);

  // Fetch peer list once
  useEffect(() => {
    fetch('/api/remote/hosts')
      .then(r => r.json())
      .then(d => setPeers(d.hosts || []))
      .catch(() => setPeers([]));
  }, []);

  // Refresh doc list (local + every peer in parallel)
  const refresh = async () => {
    setLoading(true);
    try {
      // Local
      const localRes = await fetch('/api/docs').then(r => r.json());
      setLocalLabel(localRes.host || 'local');
      const local: DocSummary[] = (localRes.docs || []).map((d: any) => ({
        ...d, _host: 'local', _hostLabel: localRes.host || 'local',
      }));

      // Peers — fetch through our own bridge tool surface (avoids CORS).
      // We expose a small server-side proxy at /api/remote/docs?host=<id>.
      // Until that exists, fall back to direct fetch which works on same-tailnet.
      const peerLists = await Promise.all(peers.map(async (p) => {
        try {
          const r = await fetch(`/api/remote/docs?host=${encodeURIComponent(p.id)}`);
          if (!r.ok) return [];
          const d = await r.json();
          return (d.docs || []).map((doc: any) => ({
            ...doc, _host: p.id, _hostLabel: p.label,
          }));
        } catch {
          return [];
        }
      }));
      const all = [...local, ...peerLists.flat()];
      all.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
      setDocs(all);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [peers.length]);

  // Force git pull on every machine in the tailnet (local + each peer in parallel),
  // then refresh the doc list. The button shows a spinner + last-pulled count.
  const syncNow = async () => {
    setSyncing(true);
    try {
      const tasks: Promise<{ host: string; pulled: number; error?: string }>[] = [];

      // Local sync via /api/vault/sync (force-pull + push pending)
      tasks.push(
        fetch('/api/vault/sync', { method: 'POST' })
          .then(r => r.json())
          .then(d => ({ host: 'local', pulled: d.pulled || 0, error: d.ok ? undefined : (d.error || 'failed') }))
          .catch(e => ({ host: 'local', pulled: 0, error: e.message })),
      );

      // Each peer via the proxy. We don't expose /api/remote/vault/sync yet — the
      // peer's own MC has its own pull loop, plus the agent can call mc_remote_ask
      // to force-sync there. For now we just rely on the peer's own loop. If the
      // user explicitly clicked Sync Now, that's a strong "I want fresh data RIGHT
      // NOW" signal — we hit each peer's /api/vault/sync via the same proxy path.
      for (const p of peers) {
        tasks.push(
          fetch(`/api/remote/vault-sync?host=${encodeURIComponent(p.id)}`, { method: 'POST' })
            .then(r => r.json())
            .then(d => ({ host: p.id, pulled: d.pulled || 0, error: d.ok ? undefined : (d.error || 'failed') }))
            .catch(e => ({ host: p.id, pulled: 0, error: e.message })),
        );
      }

      const results = await Promise.all(tasks);
      const totalPulled = results.reduce((s, r) => s + r.pulled, 0);
      const errs = results.filter(r => r.error).map(r => `${r.host}: ${r.error}`);
      setSyncStatus({ at: Date.now(), pulled: totalPulled, error: errs.length ? errs.join('; ') : undefined });
      await refresh();
    } finally {
      setSyncing(false);
    }
  };

  // Open a doc in viewer
  const openDoc = async (s: DocSummary) => {
    setActiveId(s.id);
    setActiveHost(s._host === 'local' ? null : (s._host || null));
    setActiveDoc(null);
    setEditing(false);
    const path = s._host === 'local' || !s._host
      ? `/api/docs/${encodeURIComponent(s.id)}`
      : `/api/remote/docs/${encodeURIComponent(s.id)}?host=${encodeURIComponent(s._host)}`;
    try {
      const r = await fetch(path);
      if (!r.ok) return;
      const d = await r.json();
      setActiveDoc({ ...d.doc, _host: s._host, _hostLabel: s._hostLabel });
      setEditTitle(d.doc.title);
      setEditType(d.doc.type);
      setEditContent(d.doc.content);
    } catch { /* ignore */ }
  };

  const startNew = (type: DocType) => {
    setActiveId(null);
    setActiveHost(null);
    setActiveDoc(null);
    setEditTitle('');
    setEditType(type);
    setEditContent('');
    setEditing(true);
  };

  const save = async () => {
    if (!editTitle.trim()) return;
    setSaving(true);
    try {
      // Writes are LOCAL ONLY. Peer writes go through the chat agent via mc_remote_ask.
      const url = activeId && activeHost === null ? `/api/docs/${encodeURIComponent(activeId)}` : '/api/docs';
      const method = activeId && activeHost === null ? 'PUT' : 'POST';
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: editType, title: editTitle, content: editContent }),
      });
      if (!r.ok) {
        alert('Save failed: ' + (await r.text()));
        return;
      }
      const data = await r.json();
      await refresh();
      setActiveId(data.doc.id);
      setActiveHost(null);
      setActiveDoc({ ...data.doc, _host: 'local', _hostLabel: localLabel });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!activeId || activeHost) return;
    if (!confirm(`Delete "${activeDoc?.title || activeId}"?`)) return;
    const r = await fetch(`/api/docs/${encodeURIComponent(activeId)}`, { method: 'DELETE' });
    if (r.ok) {
      setActiveId(null);
      setActiveDoc(null);
      await refresh();
    }
  };

  const filtered = useMemo(() => {
    let out = docs;
    if (filter !== 'all') out = out.filter(d => d.type === filter);
    if (hostFilter !== 'all') out = out.filter(d => d._host === hostFilter);
    if (query.trim()) {
      const q = query.toLowerCase();
      out = out.filter(d =>
        d.title.toLowerCase().includes(q) ||
        (d.tags || []).some(t => t.toLowerCase().includes(q)),
      );
    }
    return out;
  }, [docs, filter, hostFilter, query]);

  const byHost = useMemo(() => {
    const counts: Record<string, number> = { all: docs.length, local: 0 };
    for (const p of peers) counts[p.id] = 0;
    for (const d of docs) counts[d._host || 'local'] = (counts[d._host || 'local'] || 0) + 1;
    return counts;
  }, [docs, peers]);

  return (
    <div
      className="flex flex-col md:flex-row"
      style={{
        height: '100%',
        background: 'var(--ink, #0A0A0E)',
        fontFamily: 'var(--font-sans, system-ui)',
        color: 'var(--white, #fff)',
      }}
    >
      {/* Left: list */}
      <div
        className="md:w-[380px] flex-shrink-0 flex flex-col"
        style={{ borderRight: '1px solid var(--line, rgba(255,255,255,0.08))' }}
      >
        {/* List header */}
        <div
          style={{
            padding: 12,
            borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 22, height: 22, borderRadius: 5,
                background: 'rgba(94, 196, 217, 0.12)',
                border: '1px solid rgba(94, 196, 217, 0.35)',
              }}
            >
              <FileText style={{ width: 11, height: 11, color: 'var(--cyan, #5EC4D9)' }} />
            </span>
            <div>
              <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
                Knowledge · Library
              </div>
              <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>
                Docs
              </div>
            </div>
            <button
              onClick={syncNow}
              disabled={syncing}
              title="Force git pull on this machine and every peer, then refresh the list"
              data-fusio
              className="ml-auto"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '4px 10px',
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase',
                color: 'var(--cyan, #5EC4D9)',
                background: 'rgba(94, 196, 217, 0.1)',
                border: '1px solid rgba(94, 196, 217, 0.35)',
                borderRadius: 5,
                cursor: syncing ? 'not-allowed' : 'pointer',
                opacity: syncing ? 0.5 : 1,
                transition: 'filter 120ms ease-out',
              }}
              onMouseEnter={e => { if (!syncing) (e.currentTarget as HTMLElement).style.filter = 'brightness(1.15)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.filter = 'brightness(1)'; }}
            >
              <GitBranch style={{ width: 11, height: 11, animation: syncing ? 'spin 1s linear infinite' : undefined }} />
              <span>{syncing ? 'Syncing' : 'Sync now'}</span>
              {syncStatus && !syncing && (
                <span style={{ marginLeft: 3, color: syncStatus.error ? 'var(--red, #CC0C20)' : 'var(--mist, rgba(255,255,255,0.5))' }}>
                  {syncStatus.error ? '⚠' : `+${syncStatus.pulled}`}
                </span>
              )}
            </button>
            <button
              onClick={refresh}
              disabled={loading}
              title="Refresh list (no git fetch)"
              data-fusio
              style={{
                padding: 4, borderRadius: 5, background: 'transparent', border: 'none',
                color: 'var(--mist, rgba(255,255,255,0.5))',
                cursor: 'pointer', transition: 'background 120ms ease-out',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <RefreshCw style={{ width: 13, height: 13, animation: loading ? 'spin 1s linear infinite' : undefined }} />
            </button>
          </div>
          {syncStatus?.error && (
            <div className="text-[10px] text-terminal-red truncate" title={syncStatus.error}>
              ⚠ {syncStatus.error}
            </div>
          )}
          <div className="flex gap-1">
            <button onClick={() => startNew('plan')} className="flex-1 text-xs px-2 py-1 bg-terminal-cyan/15 border border-terminal-cyan/40 text-terminal-cyan rounded hover:bg-terminal-cyan/25">
              <Plus className="w-3 h-3 inline mr-1" />New Plan
            </button>
            <button onClick={() => startNew('note')} className="flex-1 text-xs px-2 py-1 bg-terminal-green/15 border border-terminal-green/40 text-terminal-green rounded hover:bg-terminal-green/25">
              <Plus className="w-3 h-3 inline mr-1" />New Note
            </button>
          </div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-2 text-terminal-dim" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search title/tag…"
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-terminal-bg border border-terminal-border/40 rounded text-terminal-text placeholder:text-terminal-dim focus:border-terminal-cyan focus:outline-none"
            />
          </div>
          <div className="flex gap-1 text-[10px]">
            {(['all', 'plan', 'note'] as const).map(t => (
              <button key={t} onClick={() => setFilter(t)}
                className={`px-2 py-0.5 rounded border ${filter === t ? 'bg-terminal-text/10 border-terminal-text/40 text-terminal-text' : 'border-terminal-border/40 text-terminal-dim'}`}>
                {t}
              </button>
            ))}
            <span className="mx-1 text-terminal-dim">|</span>
            <button onClick={() => setHostFilter('all')}
              className={`px-2 py-0.5 rounded border ${hostFilter === 'all' ? 'bg-terminal-text/10 border-terminal-text/40 text-terminal-text' : 'border-terminal-border/40 text-terminal-dim'}`}>
              all ({byHost.all})
            </button>
            <button onClick={() => setHostFilter('local')}
              className={`px-2 py-0.5 rounded border ${hostFilter === 'local' ? 'bg-terminal-cyan/20 border-terminal-cyan/40 text-terminal-cyan' : 'border-terminal-border/40 text-terminal-dim'}`}>
              {localLabel} ({byHost.local || 0})
            </button>
            {peers.map(p => (
              <button key={p.id} onClick={() => setHostFilter(p.id)}
                className={`px-2 py-0.5 rounded border ${hostFilter === p.id ? 'bg-terminal-cyan/20 border-terminal-cyan/40 text-terminal-cyan' : 'border-terminal-border/40 text-terminal-dim'}`}>
                {p.label} ({byHost[p.id] || 0})
              </button>
            ))}
          </div>
        </div>

        {/* List body */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 && !loading && (
            <div className="p-4 text-xs text-terminal-dim italic">No docs match.</div>
          )}
          {filtered.map(d => (
            <button
              key={`${d._host}:${d.id}`}
              onClick={() => openDoc(d)}
              className={`w-full text-left p-2.5 border-b border-terminal-border/30 hover:bg-terminal-border/20 ${
                activeId === d.id && activeHost === (d._host === 'local' ? null : d._host)
                  ? 'bg-terminal-cyan/10 border-l-2 border-l-terminal-cyan'
                  : ''
              }`}
            >
              <div className="flex items-center gap-2 mb-0.5">
                {d.type === 'plan' ? <FileCheck className="w-3 h-3 text-terminal-cyan" /> : <FileText className="w-3 h-3 text-terminal-green" />}
                <span className="text-xs text-terminal-text font-medium truncate">{d.title}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-terminal-dim">
                <span>{d.updated?.slice(0, 10)}</span>
                <span>·</span>
                <span className="font-mono">{d.id.slice(0, 24)}</span>
                {d._host && (
                  <span className={`ml-auto px-1.5 py-0.5 rounded ${d._host === 'local' ? 'bg-terminal-cyan/20 text-terminal-cyan' : 'bg-terminal-amber/20 text-terminal-amber'}`}>
                    {d._hostLabel}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right: viewer / editor */}
      <div className="flex-1 flex flex-col min-h-[400px] md:h-full">
        {!activeId && !editing && (
          <div className="flex-1 flex items-center justify-center text-terminal-dim text-sm p-8 text-center">
            <div>
              <FileText className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p>Select a doc on the left, or click <strong>+ New Plan</strong> / <strong>+ New Note</strong>.</p>
              <p className="mt-2 text-xs opacity-70">Plans and notes from every machine on your tailnet appear here. Local writes save here; chat agents on either machine can read both via <code>mc_docs_*</code> tools, or you can attach a doc to a chat from the composer.</p>
            </div>
          </div>
        )}

        {(activeDoc || editing) && (
          <>
            <div className="p-3 border-b border-terminal-border/40 flex items-center gap-2 flex-wrap">
              {editing ? (
                <>
                  <select value={editType} onChange={e => setEditType(e.target.value as DocType)}
                    className="text-xs bg-terminal-bg border border-terminal-border/40 rounded px-2 py-1 text-terminal-text">
                    <option value="plan">Plan</option>
                    <option value="note">Note</option>
                  </select>
                  <input
                    value={editTitle}
                    onChange={e => setEditTitle(e.target.value)}
                    placeholder="Title"
                    className="flex-1 text-sm bg-terminal-bg border border-terminal-border/40 rounded px-2 py-1 text-terminal-text"
                  />
                  <button onClick={save} disabled={saving || !editTitle.trim()}
                    className="px-3 py-1 text-xs bg-terminal-green/20 border border-terminal-green/40 text-terminal-green rounded hover:bg-terminal-green/30">
                    <Save className="w-3 h-3 inline mr-1" />{saving ? 'Saving…' : 'Save'}
                  </button>
                  {activeId && (
                    <button onClick={() => { setEditing(false); if (activeDoc) { setEditTitle(activeDoc.title); setEditContent(activeDoc.content); }}}
                      className="px-2 py-1 text-xs text-terminal-dim hover:text-terminal-text">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </>
              ) : activeDoc && (
                <>
                  {activeDoc.type === 'plan' ? <FileCheck className="w-4 h-4 text-terminal-cyan" /> : <FileText className="w-4 h-4 text-terminal-green" />}
                  <span className="font-bold text-terminal-text">{activeDoc.title}</span>
                  <span className="text-[10px] text-terminal-dim ml-2">{activeDoc.id}</span>
                  {activeDoc._host && activeDoc._host !== 'local' && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-terminal-amber/20 text-terminal-amber rounded flex items-center gap-1">
                      <Wifi className="w-3 h-3" />{activeDoc._hostLabel}
                    </span>
                  )}
                  <div className="ml-auto flex gap-1">
                    {(!activeDoc._host || activeDoc._host === 'local') && (
                      <button onClick={() => setEditing(true)}
                        className="px-2 py-1 text-xs text-terminal-dim hover:text-terminal-text border border-terminal-border/40 rounded">Edit</button>
                    )}
                    {(!activeDoc._host || activeDoc._host === 'local') && (
                      <button onClick={remove}
                        className="px-2 py-1 text-xs text-terminal-red hover:text-terminal-red border border-terminal-red/30 rounded">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="flex-1 overflow-auto">
              {editing ? (
                <textarea
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  placeholder="Markdown body…"
                  className="w-full h-full min-h-[400px] p-4 bg-terminal-bg text-terminal-text text-sm font-mono leading-relaxed resize-none focus:outline-none border-0"
                />
              ) : activeDoc && (
                <pre className="whitespace-pre-wrap p-4 text-sm text-terminal-text font-mono leading-relaxed">
                  {activeDoc.content}
                </pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
