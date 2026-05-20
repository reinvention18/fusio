'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, FileCheck, Plus, X, ChevronDown, Wifi } from 'lucide-react';

type DocType = 'note' | 'plan';

interface DocSummary {
  id: string;
  type: DocType;
  title: string;
  updated: string;
  authorHost?: string;
  tags?: string[];
  bytes: number;
  _host: string;       // 'local' or peer id
  _hostLabel?: string;
}

export interface AttachedDocRef {
  /** 'local' or peer id */
  host: string;
  /** doc id */
  id: string;
  /** title for display only */
  title: string;
  type: DocType;
}

interface PeerHost { id: string; label: string; url: string; }

export interface DocAttachDropdownProps {
  attached: AttachedDocRef[];
  onAttach: (refs: AttachedDocRef[]) => void;
  /** the active chat's session key — passed down to mc_docs_write so newly created
   *  docs from this composer get tagged with their chatOrigin. */
  chatSessionKey?: string;
}

export function DocAttachDropdown(props: DocAttachDropdownProps) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [peers, setPeers] = useState<PeerHost[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
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

  // Load peers + docs when first opened (and refresh every open)
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    (async () => {
      try {
        const peersRes = await fetch('/api/remote/hosts').then(r => r.json()).catch(() => ({ hosts: [] }));
        const peerList: PeerHost[] = peersRes.hosts || [];
        setPeers(peerList);

        const localRes = await fetch('/api/docs').then(r => r.json()).catch(() => ({ docs: [] }));
        const localLabel = localRes.host || 'local';
        const local: DocSummary[] = (localRes.docs || []).map((d: any) => ({
          ...d, _host: 'local', _hostLabel: localLabel,
        }));

        const peerDocs = await Promise.all(peerList.map(async (p) => {
          try {
            const r = await fetch(`/api/remote/docs?host=${encodeURIComponent(p.id)}`);
            if (!r.ok) return [];
            const d = await r.json();
            return (d.docs || []).map((doc: any) => ({ ...doc, _host: p.id, _hostLabel: p.label }));
          } catch { return []; }
        }));

        const all = [...local, ...peerDocs.flat()];
        all.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
        setDocs(all);
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter(d =>
      d.title.toLowerCase().includes(q) ||
      d.id.toLowerCase().includes(q) ||
      (d.tags || []).some(t => t.toLowerCase().includes(q)),
    );
  }, [docs, filter]);

  const isAttached = (d: DocSummary) =>
    props.attached.some(a => a.host === d._host && a.id === d.id);

  const toggle = (d: DocSummary) => {
    if (isAttached(d)) {
      props.onAttach(props.attached.filter(a => !(a.host === d._host && a.id === d.id)));
    } else {
      props.onAttach([...props.attached, {
        host: d._host, id: d.id, title: d.title, type: d.type,
      }]);
    }
  };

  const cyanActive = props.attached.length > 0;
  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="Attach a plan or note to this chat"
        data-fusio
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '5px 10px',
          fontFamily: 'var(--font-mono, ui-monospace)',
          fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
          borderRadius: 5,
          background: cyanActive ? 'rgba(94, 196, 217, 0.12)' : 'var(--ink-3, #1B1B23)',
          color: cyanActive ? 'var(--cyan, #5EC4D9)' : 'var(--mist, rgba(255,255,255,0.5))',
          border: `1px solid ${cyanActive ? 'rgba(94, 196, 217, 0.4)' : 'var(--line, rgba(255,255,255,0.08))'}`,
          cursor: 'pointer',
          transition: 'all 120ms ease-out',
        }}
        onMouseEnter={e => { if (!cyanActive) (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
        onMouseLeave={e => { if (!cyanActive) (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
      >
        <FileText style={{ width: 11, height: 11 }} />
        <span>📋 {props.attached.length > 0 ? `Doc${props.attached.length === 1 ? '' : 's'} · ${props.attached.length}` : 'Attach doc'}</span>
        <ChevronDown style={{ width: 11, height: 11 }} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            marginBottom: 8,
            left: 0,
            zIndex: 1000,
            width: 420,
            maxHeight: 460,
            display: 'flex', flexDirection: 'column',
            background: 'var(--ink, #0A0A0E)',
            border: '1px solid var(--line, rgba(255,255,255,0.08))',
            borderRadius: 10,
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            overflow: 'hidden',
            fontFamily: 'var(--font-sans, system-ui)',
          }}
        >
          <div
            style={{
              padding: 10,
              borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
              background: 'var(--ink-2, #131319)',
            }}
          >
            <input
              autoFocus
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter plans & notes…"
              data-fusio
              style={{
                width: '100%',
                fontSize: 12.5,
                background: 'var(--ink-3, #1B1B23)',
                border: '1px solid var(--line, rgba(255,255,255,0.08))',
                borderRadius: 6,
                padding: '5px 10px',
                color: 'var(--white, #fff)',
                outline: 'none',
                fontFamily: 'var(--font-sans, system-ui)',
              }}
              onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(94, 196, 217, 0.5)'; }}
              onBlur={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--line, rgba(255,255,255,0.08))'; }}
            />
          </div>

          {props.attached.length > 0 && (
            <div
              style={{
                padding: '8px 10px',
                borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
                background: 'rgba(94, 196, 217, 0.04)',
              }}
            >
              <div
                style={{
                  fontFamily: 'var(--font-mono, ui-monospace)',
                  fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase',
                  color: 'var(--mist, rgba(255,255,255,0.5))',
                  marginBottom: 5,
                }}
              >
                Attached · {props.attached.length}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {props.attached.map(a => (
                  <div
                    key={`${a.host}:${a.id}`}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      padding: '2px 6px',
                      background: 'rgba(94, 196, 217, 0.12)',
                      border: '1px solid rgba(94, 196, 217, 0.4)',
                      borderRadius: 4,
                      fontSize: 10,
                      color: 'var(--cyan, #5EC4D9)',
                    }}
                  >
                    {a.type === 'plan' ? <FileCheck style={{ width: 10, height: 10 }} /> : <FileText style={{ width: 10, height: 10 }} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{a.title}</span>
                    <button
                      onClick={() => props.onAttach(props.attached.filter(x => !(x.host === a.host && x.id === a.id)))}
                      data-fusio
                      style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, display: 'inline-flex' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--red, #CC0C20)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'inherit'; }}
                    >
                      <X style={{ width: 10, height: 10 }} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading && (
              <div style={{ padding: 14, fontSize: 12, color: 'var(--mist, rgba(255,255,255,0.5))', fontStyle: 'italic' }}>
                Loading…
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div style={{ padding: 14, fontSize: 12, color: 'var(--dim, rgba(255,255,255,0.32))', fontStyle: 'italic' }}>
                No matching docs.
              </div>
            )}
            {filtered.map(d => {
              const a = isAttached(d);
              return (
                <button
                  key={`${d._host}:${d.id}`}
                  type="button"
                  onClick={() => toggle(d)}
                  data-fusio
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 12px',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    background: a ? 'rgba(94, 196, 217, 0.08)' : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    transition: 'background 120ms ease-out',
                    fontFamily: 'var(--font-sans, system-ui)',
                  }}
                  onMouseEnter={e => { if (!a) (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; }}
                  onMouseLeave={e => { if (!a) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {d.type === 'plan'
                      ? <FileCheck style={{ width: 12, height: 12, color: 'var(--cyan, #5EC4D9)' }} />
                      : <FileText style={{ width: 12, height: 12, color: 'var(--green, #4CC38A)' }} />}
                    <span style={{ fontSize: 11.5, color: 'var(--white, #fff)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {d.title}
                    </span>
                    {d._host !== 'local' && (
                      <span
                        style={{
                          fontFamily: 'var(--font-mono, ui-monospace)',
                          fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase',
                          padding: '1px 5px',
                          background: 'rgba(232, 162, 59, 0.14)',
                          color: 'var(--amber, #E8A23B)',
                          border: '1px solid rgba(232, 162, 59, 0.3)',
                          borderRadius: 3,
                          display: 'inline-flex', alignItems: 'center', gap: 3,
                        }}
                      >
                        <Wifi style={{ width: 8, height: 8 }} />
                        {d._hostLabel}
                      </span>
                    )}
                    {a && <Plus style={{ width: 12, height: 12, color: 'var(--cyan, #5EC4D9)', transform: 'rotate(45deg)' }} />}
                  </div>
                  <div style={{ fontSize: 9.5, color: 'var(--dim, rgba(255,255,255,0.32))', fontFamily: 'var(--font-mono, ui-monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2, letterSpacing: '0.04em' }}>
                    {d.id}
                  </div>
                </button>
              );
            })}
          </div>

          <div
            style={{
              padding: '6px 12px',
              borderTop: '1px solid var(--line, rgba(255,255,255,0.08))',
              background: 'var(--ink-2, #131319)',
              fontFamily: 'var(--font-mono, ui-monospace)',
              fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase',
              color: 'var(--dim, rgba(255,255,255,0.32))',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}
          >
            <span>{filtered.length} of {docs.length}</span>
            <span>peers · {peers.length}</span>
          </div>
        </div>
      )}
    </div>
  );
}
