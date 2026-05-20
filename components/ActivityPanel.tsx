/**
 * ActivityPanel — live feed of file edits across all peer machines. Polls
 * /api/edits/recent locally + /api/remote/edits for each peer; lets the user
 * filter by host / op / window and select an edit to see its diff preview.
 *
 * Re-skinned for the AI Fusio design language: mono uppercase filter pills,
 * accent-tinted active states, ink-2 surfaces, eyebrow + display title in
 * the detail pane.
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { FileEdit, RefreshCw, Wifi, Filter } from 'lucide-react';

interface EditEntry {
  ts: number;
  host: string;
  sessionKey?: string;
  chatId?: string;
  agent: string;
  op: string;
  file: string;
  linesAdded?: number;
  linesRemoved?: number;
  summary: string;
  preview?: string;
}

interface PeerHost { id: string; label: string; url: string; }

const REFRESH_MS = 5_000;

const FONT_MONO    = 'var(--font-mono, ui-monospace, monospace)';
const FONT_SANS    = 'var(--font-sans, system-ui)';
const FONT_DISPLAY = 'var(--font-display, "Space Grotesk")';

const eyebrow = (color = 'var(--mist, rgba(255,255,255,0.5))', size = 10): CSSProperties => ({
  fontFamily: FONT_MONO,
  fontSize: size,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color,
});

function fmtTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff/1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff/60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff/3_600_000)}h ago`;
  return new Date(ts).toLocaleString();
}

function basename(p: string): string {
  return p.split('/').pop() || p;
}

function dirname(p: string): string {
  const parts = p.split('/');
  parts.pop();
  return parts.join('/');
}

function opColor(op: string): string {
  if (op === 'Write')        return 'var(--green, #4CC38A)';
  if (op === 'Edit')         return 'var(--cyan, #5EC4D9)';
  if (op === 'MultiEdit')    return 'var(--amber, #E8A23B)';
  if (op === 'NotebookEdit') return 'var(--violet, #8B6FE8)';
  return 'var(--mist, rgba(255,255,255,0.5))';
}

// Filter pill — small mono uppercase button used in the filter rows
function FilterPill({
  active, onClick, children, accent = 'var(--white, #fff)',
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  accent?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-fusio
      style={{
        ...eyebrow(active ? accent : 'var(--mist, rgba(255,255,255,0.5))', 9.5),
        padding: '3px 8px',
        borderRadius: 5,
        background: active ? `color-mix(in srgb, ${accent} 14%, transparent)` : 'transparent',
        border: `1px solid ${active ? `color-mix(in srgb, ${accent} 35%, transparent)` : 'var(--line, rgba(255,255,255,0.08))'}`,
        cursor: 'pointer',
        transition: 'all 120ms ease-out',
      }}
    >
      {children}
    </button>
  );
}

export default function ActivityPanel() {
  const [peers, setPeers] = useState<PeerHost[]>([]);
  const [edits, setEdits] = useState<EditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [hostFilter, setHostFilter] = useState<'all' | string>('all');
  const [opFilter, setOpFilter] = useState<'all' | 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit'>('all');
  const [windowMin, setWindowMin] = useState(120);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [localLabel, setLocalLabel] = useState('local');
  const [selected, setSelected] = useState<EditEntry | null>(null);

  useEffect(() => {
    fetch('/api/remote/hosts')
      .then(r => r.json())
      .then(d => setPeers(d.hosts || []))
      .catch(() => setPeers([]));
  }, []);

  const refresh = async () => {
    setLoading(true);
    try {
      const since = Date.now() - windowMin * 60_000;
      const params = new URLSearchParams({ since: String(since), limit: '200' });
      const localRes = await fetch(`/api/edits/recent?${params.toString()}`).then(r => r.json()).catch(() => ({ edits: [] }));
      setLocalLabel(localRes.host || 'local');
      const localEdits: EditEntry[] = localRes.edits || [];

      const peerEdits = await Promise.all(peers.map(async (p) => {
        try {
          const r = await fetch(`/api/remote/edits?host=${encodeURIComponent(p.id)}&since=${since}&limit=200`);
          if (!r.ok) return [];
          const d = await r.json();
          return d.edits || [];
        } catch { return []; }
      }));

      const all = [...localEdits, ...peerEdits.flat()];
      all.sort((a, b) => b.ts - a.ts);
      setEdits(all);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [peers.length, windowMin]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [autoRefresh, peers.length, windowMin]);

  const filtered = useMemo(() => {
    let out = edits;
    if (hostFilter !== 'all') out = out.filter(e => e.host === hostFilter);
    if (opFilter !== 'all') out = out.filter(e => e.op === opFilter);
    return out;
  }, [edits, hostFilter, opFilter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of edits) c[e.host] = (c[e.host] || 0) + 1;
    return c;
  }, [edits]);

  const allHosts = [localLabel, ...peers.map(p => p.label)];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        height: '100%',
        background: 'var(--ink, #0A0A0E)',
        fontFamily: FONT_SANS,
        color: 'var(--white, #fff)',
      }}
      className="flex-col md:flex-row"
    >
      {/* LEFT — list */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid var(--line, rgba(255,255,255,0.08))',
        }}
        className="md:w-[480px]"
      >
        {/* Filter head */}
        <div style={{ padding: 12, borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 22, height: 22, borderRadius: 5,
                background: 'rgba(94, 196, 217, 0.12)',
                border: '1px solid rgba(94, 196, 217, 0.35)',
              }}
            >
              <FileEdit style={{ width: 11, height: 11, color: 'var(--cyan, #5EC4D9)' }} />
            </span>
            <div>
              <div style={eyebrow()}>Monitor · Edits</div>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>Activity</div>
            </div>
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              title="Refresh"
              data-fusio
              style={{
                marginLeft: 'auto', padding: 4, borderRadius: 5,
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--mist, rgba(255,255,255,0.5))',
                transition: 'background 120ms ease-out',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <RefreshCw style={{ width: 13, height: 13, animation: loading ? 'spin 1s linear infinite' : undefined }} />
            </button>
          </div>

          {/* Host filter row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Filter style={{ width: 11, height: 11, color: 'var(--mist, rgba(255,255,255,0.5))' }} />
            <span style={eyebrow('var(--dim, rgba(255,255,255,0.32))', 9.5)}>Host</span>
            <FilterPill active={hostFilter === 'all'} onClick={() => setHostFilter('all')}>
              All · {edits.length}
            </FilterPill>
            {allHosts.map(h => (
              <FilterPill key={h} active={hostFilter === h} onClick={() => setHostFilter(h)} accent="var(--cyan, #5EC4D9)">
                {h} · {counts[h] || 0}
              </FilterPill>
            ))}
          </div>

          {/* Op + window row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={eyebrow('var(--dim, rgba(255,255,255,0.32))', 9.5)}>Op</span>
            {(['all', 'Edit', 'Write', 'MultiEdit'] as const).map(o => (
              <FilterPill key={o} active={opFilter === o} onClick={() => setOpFilter(o)}>
                {o}
              </FilterPill>
            ))}
            <span style={{ ...eyebrow('var(--dim, rgba(255,255,255,0.32))', 9.5), marginLeft: 8 }}>Window</span>
            {[30, 120, 720, 1440].map(m => (
              <FilterPill key={m} active={windowMin === m} onClick={() => setWindowMin(m)}>
                {m < 60 ? `${m}m` : `${m/60}h`}
              </FilterPill>
            ))}
            <label
              style={{
                marginLeft: 'auto',
                display: 'flex', alignItems: 'center', gap: 5,
                cursor: 'pointer',
                ...eyebrow('var(--mist, rgba(255,255,255,0.5))', 9.5),
              }}
            >
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={e => setAutoRefresh(e.target.checked)}
                style={{ width: 11, height: 11, accentColor: 'var(--red, #CC0C20)' }}
              />
              Live
            </label>
          </div>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filtered.length === 0 && !loading && (
            <div style={{ padding: 16, fontSize: 11.5, color: 'var(--mist, rgba(255,255,255,0.5))', fontStyle: 'italic' }}>
              No edits in this window.
            </div>
          )}
          {filtered.map((e, i) => {
            const isPeer = e.host !== localLabel;
            const isSelected = selected?.ts === e.ts && selected?.file === e.file;
            return (
              <button
                key={`${e.ts}-${e.file}-${i}`}
                type="button"
                onClick={() => setSelected(e)}
                style={{
                  width: '100%', textAlign: 'left',
                  padding: '10px 12px',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  background: isSelected ? 'rgba(94, 196, 217, 0.1)' : 'transparent',
                  borderLeft: isSelected ? '2px solid var(--cyan, #5EC4D9)' : '2px solid transparent',
                  cursor: 'pointer',
                  transition: 'background 120ms ease-out',
                  fontFamily: FONT_SANS,
                }}
                onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; }}
                onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <span style={{ ...eyebrow(opColor(e.op), 9.5) }}>{e.op}</span>
                  <span
                    style={{
                      fontSize: 12.5, fontWeight: 600, color: 'var(--white, #fff)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                    }}
                  >
                    {basename(e.file)}
                  </span>
                  {(e.linesAdded || e.linesRemoved) ? (
                    <span style={{ ...eyebrow('var(--mist, rgba(255,255,255,0.5))', 9), letterSpacing: '0.04em' }}>
                      <span style={{ color: 'var(--green, #4CC38A)' }}>+{e.linesAdded || 0}</span>
                      <span style={{ margin: '0 4px' }}>/</span>
                      <span style={{ color: 'var(--red, #CC0C20)' }}>-{e.linesRemoved || 0}</span>
                    </span>
                  ) : null}
                </div>
                <div
                  style={{
                    ...eyebrow('var(--mist, rgba(255,255,255,0.5))', 9.5),
                    letterSpacing: '0.04em',
                    textTransform: 'none',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {dirname(e.file) || '(root)'}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, marginTop: 3 }}>
                  <span
                    style={{
                      ...eyebrow(isPeer ? 'var(--amber, #E8A23B)' : 'var(--cyan, #5EC4D9)', 9),
                      padding: '1px 6px',
                      background: isPeer ? 'rgba(232, 162, 59, 0.12)' : 'rgba(94, 196, 217, 0.12)',
                      borderRadius: 4,
                      display: 'inline-flex', alignItems: 'center', gap: 3,
                    }}
                  >
                    {isPeer && <Wifi style={{ width: 9, height: 9 }} />}
                    {e.host}
                  </span>
                  <span style={{ color: 'var(--mist, rgba(255,255,255,0.5))', fontFamily: FONT_MONO }}>{fmtTime(e.ts)}</span>
                  <span style={{ color: 'var(--dim, rgba(255,255,255,0.32))', marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.agent}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* RIGHT — detail */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 400 }}>
        {!selected ? (
          <div
            style={{
              flex: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 32, textAlign: 'center',
              color: 'var(--mist, rgba(255,255,255,0.5))',
            }}
          >
            <div>
              <FileEdit style={{ width: 32, height: 32, margin: '0 auto 8px', display: 'block', opacity: 0.4 }} />
              <p style={{ fontSize: 13, margin: 0 }}>Select an edit to see what changed.</p>
              <p style={{ ...eyebrow('var(--dim, rgba(255,255,255,0.32))', 9.5), marginTop: 8 }}>
                Live · refreshes every {REFRESH_MS/1000}s
              </p>
            </div>
          </div>
        ) : (
          <>
            <div
              style={{
                padding: 12,
                borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
                display: 'flex', alignItems: 'center', gap: 8,
              }}
            >
              <span style={eyebrow(opColor(selected.op), 10)}>{selected.op}</span>
              <span
                style={{
                  fontSize: 13, fontWeight: 600, color: 'var(--white, #fff)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                }}
              >
                {selected.file}
              </span>
              <span style={{ ...eyebrow('var(--mist, rgba(255,255,255,0.5))', 9.5), letterSpacing: '0.04em' }}>
                {new Date(selected.ts).toLocaleString()}
              </span>
            </div>
            <div
              style={{
                padding: 12,
                borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
                fontSize: 11,
              }}
            >
              <div>
                <span style={eyebrow('var(--dim, rgba(255,255,255,0.32))', 9.5)}>Host</span>{' '}
                <span style={{ fontFamily: FONT_MONO, color: 'var(--white, #fff)' }}>{selected.host}</span>
              </div>
              <div>
                <span style={eyebrow('var(--dim, rgba(255,255,255,0.32))', 9.5)}>Agent</span>{' '}
                <span style={{ fontFamily: FONT_MONO, color: 'var(--white, #fff)' }}>{selected.agent}</span>
              </div>
              {(selected.linesAdded || selected.linesRemoved) ? (
                <div style={{ gridColumn: 'span 2' }}>
                  <span style={eyebrow('var(--dim, rgba(255,255,255,0.32))', 9.5)}>Lines</span>{' '}
                  <span style={{ color: 'var(--green, #4CC38A)', fontFamily: FONT_MONO }}>+{selected.linesAdded || 0}</span>
                  <span style={{ color: 'var(--mist, rgba(255,255,255,0.5))' }}> / </span>
                  <span style={{ color: 'var(--red, #CC0C20)', fontFamily: FONT_MONO }}>-{selected.linesRemoved || 0}</span>
                </div>
              ) : null}
              {selected.chatId && (
                <div style={{ gridColumn: 'span 2' }}>
                  <span style={eyebrow('var(--dim, rgba(255,255,255,0.32))', 9.5)}>Chat</span>{' '}
                  <span style={{ fontFamily: FONT_MONO, color: 'var(--mist, rgba(255,255,255,0.5))' }}>
                    {selected.chatId.slice(0, 8)}
                  </span>
                </div>
              )}
            </div>
            <div style={{ padding: 12, borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))' }}>
              <div style={{ ...eyebrow(), marginBottom: 4 }}>Summary</div>
              <div style={{ fontSize: 13, color: 'var(--white, #fff)', lineHeight: 1.5 }}>{selected.summary}</div>
            </div>
            {selected.preview && (
              <div style={{ flex: 1, overflowY: 'auto' }}>
                <div style={{ ...eyebrow(), padding: '12px 12px 4px' }}>Preview</div>
                <pre
                  style={{
                    padding: '0 12px 12px',
                    fontFamily: FONT_MONO,
                    fontSize: 11.5,
                    color: 'var(--white, #fff)',
                    whiteSpace: 'pre-wrap',
                    lineHeight: 1.55,
                  }}
                >
                  {selected.preview}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
