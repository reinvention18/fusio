/**
 * MissionsDashboard — Phase 5 of the missions architecture.
 *
 * Luke: "Your standard chat interface doesn't work for something that lasts
 * many days." This component is the PM-style dashboard that complements the
 * chat: a list of running/paused/completed missions with progress bars,
 * current phase, last activity, and per-mission abort/resume controls.
 *
 * Mounted in the Luke's Chat tab as a collapsible header above the chat.
 * The chat itself remains the primary surface for talking to the orchestrator;
 * the dashboard is for "where are my long-running missions right now?"
 *
 * Data flow:
 *   • Polls GET /api/missions every 5s (cheap — disk read of state files).
 *   • For the selected mission, opens an SSE connection to
 *     /api/missions/<id>/events to get live phase + audit events.
 *   • Abort/Resume buttons fire POST /api/missions/<id>/{abort,resume}.
 *
 * Why polling for the list vs SSE: the list shape is stable and small;
 * SSE-per-mission is reserved for the live event stream. Polling at 5s is
 * imperceptible and avoids per-mission persistent connections.
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

interface MissionListItem {
  id: string;
  goal: string;
  status:
    | 'draft'
    | 'approved'
    | 'running'
    | 'paused-question'
    | 'paused-stuck'
    | 'paused-checkpoint'
    | 'completed'
    | 'cancelled';
  created_at: string;
  last_activity_at: string;
  current_phase_index: number;
  total_phases: number;
  /** Phase 11: parent + child relationships. Listing endpoint copies these
   *  through from the mission state so the dashboard can render the tree
   *  without an extra round-trip per mission. */
  parent_mission_id?: string;
  child_mission_ids?: string[];
}

interface MissionEventFrame {
  type: string;
  seq?: number;
  [k: string]: unknown;
}

interface MissionsDashboardProps {
  /** When true, renders compact single-row entries (used in the Luke's Chat
   *  header). When false, renders the full multi-section dashboard. */
  compact?: boolean;
}

interface RolePreset {
  id: string;
  label: string;
  description: string;
  config: {
    orchestrator: { provider: string; model: string };
    worker: { provider: string; model: string };
    scrutiny: { provider: string; model: string };
    user_testing: { provider: string; model: string };
  };
}

interface CheckpointInfo { n: number; label?: string; path: string }

export default function MissionsDashboard({ compact = false }: MissionsDashboardProps) {
  const [missions, setMissions] = useState<MissionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [presets, setPresets] = useState<RolePreset[]>([]);
  const [activePresetId, setActivePresetId] = useState<string>(() => {
    if (typeof window === 'undefined') return 'frontier-mixed';
    return localStorage.getItem('mc-mission-preset') || 'frontier-mixed';
  });

  // Load role presets once at mount — they're static within a deployment.
  useEffect(() => {
    fetch('/api/missions/role-config', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data: { presets?: RolePreset[] }) => {
        if (Array.isArray(data?.presets)) setPresets(data.presets);
      })
      .catch(() => { /* settings panel just won't render presets */ });
  }, []);

  // Poll list every 5s. Each render of the dashboard owns one interval.
  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const r = await fetch('/api/missions', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!cancelled) {
          setMissions(Array.isArray(data?.missions) ? data.missions : []);
          setError(null);
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(String(err?.message || err));
          setLoading(false);
        }
      }
    };
    fetchOnce();
    const i = setInterval(fetchOnce, 5_000);
    return () => { cancelled = true; clearInterval(i); };
  }, []);

  // Phase 11: build a parent→children tree so child missions render indented
  // under their parents. Missions without a parent root the tree; orphans
  // (parent_id named but parent missing) appear at the top level too.
  const tree = useMemo(() => {
    const byId = new Map(missions.map(m => [m.id, m]));
    const roots: MissionListItem[] = [];
    const childrenOf = new Map<string, MissionListItem[]>();
    for (const m of missions) {
      if (m.parent_mission_id && byId.has(m.parent_mission_id)) {
        const arr = childrenOf.get(m.parent_mission_id) || [];
        arr.push(m);
        childrenOf.set(m.parent_mission_id, arr);
      } else {
        roots.push(m);
      }
    }
    return { roots, childrenOf };
  }, [missions]);

  const grouped = useMemo(() => {
    const active: MissionListItem[] = [];
    const paused: MissionListItem[] = [];
    const done: MissionListItem[] = [];
    // Group by status using ROOTS only — children render via the tree
    // expansion under their parent in MissionRow. This keeps the column
    // counts accurate ("3 running" means 3 root missions) and avoids
    // double-counting child missions.
    for (const m of tree.roots) {
      if (m.status === 'running') active.push(m);
      else if (m.status === 'completed' || m.status === 'cancelled') done.push(m);
      else paused.push(m);
    }
    return { active, paused, done };
  }, [tree]);

  // Compact mode: just one summary line per active mission, no detail panel.
  if (compact) {
    return (
      <div className="text-xs text-terminal-text px-3 py-2 border-b border-terminal-border bg-terminal-bg/40 flex flex-wrap items-center gap-3">
        <span className="font-semibold text-terminal-text">🛰️ Missions:</span>
        {loading && <span className="text-terminal-dim">loading…</span>}
        {error && <span className="text-terminal-red">err: {error}</span>}
        {!loading && !error && missions.length === 0 && (
          <span className="text-terminal-dim">none yet — POST /api/missions to start one</span>
        )}
        {grouped.active.map(m => (
          <span key={m.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-terminal-green/40 border border-terminal-green/50">
            <span className="w-1.5 h-1.5 rounded-full bg-terminal-green animate-pulse" />
            <span className="font-medium">{m.goal.slice(0, 40)}</span>
            <span className="text-terminal-green">P{m.current_phase_index}/{m.total_phases}</span>
          </span>
        ))}
        {grouped.paused.map(m => (
          <span key={m.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-terminal-amber/40 border border-terminal-amber/50">
            <span className="w-1.5 h-1.5 rounded-full bg-terminal-amber" />
            <span className="font-medium">{m.goal.slice(0, 40)}</span>
            <span className="text-terminal-amber">{statusLabel(m.status)}</span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="bg-terminal-bg/80 border border-terminal-border rounded-lg overflow-hidden">
      <div className="w-full flex items-center justify-between px-4 py-2 text-sm bg-terminal-surface/60">
        <button
          onClick={() => setCollapsed(c => !c)}
          className="flex items-center gap-2 text-left hover:opacity-90"
        >
          <span className="font-semibold text-terminal-text">🛰️ Mission Dashboard</span>
          <span className="text-terminal-dim font-normal">
            {grouped.active.length} running · {grouped.paused.length} paused · {grouped.done.length} done
          </span>
        </button>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowCreate(s => !s)}
            className={`text-xs px-2 py-1 rounded border ${showCreate ? 'border-terminal-green bg-terminal-green/30 text-terminal-green' : 'border-terminal-green/50 text-terminal-green hover:bg-terminal-green/20'}`}
            title="Create a new mission"
          >
            + New
          </button>
          <button
            onClick={() => setShowSettings(s => !s)}
            className={`text-xs px-2 py-1 rounded border ${showSettings ? 'border-terminal-dim bg-terminal-elevated text-terminal-text' : 'border-terminal-border text-terminal-dim hover:text-terminal-text'}`}
            title="Per-role model preset"
          >
            ⚙ Settings
          </button>
          <button
            onClick={() => setCollapsed(c => !c)}
            className="text-terminal-dim hover:text-terminal-text"
          >
            {collapsed ? '▸' : '▾'}
          </button>
        </div>
      </div>

      {!collapsed && showCreate && (
        <CreateMissionPanel
          presets={presets}
          activePresetId={activePresetId}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            setSelectedId(id);
          }}
        />
      )}

      {!collapsed && showSettings && (
        <SettingsPanel
          presets={presets}
          activeId={activePresetId}
          onPick={(id) => {
            setActivePresetId(id);
            try { localStorage.setItem('mc-mission-preset', id); } catch { /* private mode etc. */ }
          }}
        />
      )}

      {!collapsed && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 p-3">
          <div className="space-y-2">
            <SectionHeader label="🟢 Running" count={grouped.active.length} tint="emerald" />
            {grouped.active.length === 0 && <EmptyHint text="No active missions." />}
            {grouped.active.map(m => (
              <MissionTreeRow key={m.id} m={m} childrenOf={tree.childrenOf} selectedId={selectedId} onSelect={setSelectedId} depth={0} />
            ))}
          </div>
          <div className="space-y-2">
            <SectionHeader label="⏸ Paused" count={grouped.paused.length} tint="amber" />
            {grouped.paused.length === 0 && <EmptyHint text="No paused missions." />}
            {grouped.paused.map(m => (
              <MissionTreeRow key={m.id} m={m} childrenOf={tree.childrenOf} selectedId={selectedId} onSelect={setSelectedId} depth={0} />
            ))}
          </div>
          <div className="space-y-2">
            <SectionHeader label="🏁 Recent" count={grouped.done.length} tint="zinc" />
            {grouped.done.length === 0 && <EmptyHint text="No completed missions." />}
            {grouped.done.slice(0, 5).map(m => (
              <MissionTreeRow key={m.id} m={m} childrenOf={tree.childrenOf} selectedId={selectedId} onSelect={setSelectedId} depth={0} />
            ))}
          </div>
        </div>
      )}

      {!collapsed && selectedId && (
        <div className="border-t border-terminal-border">
          <MissionDetail
            missionId={selectedId}
            onClose={() => setSelectedId(null)}
            onActed={() => { /* no-op — list polling will pick up status changes */ }}
          />
        </div>
      )}
    </div>
  );
}

function SectionHeader({ label, count, tint }: { label: string; count: number; tint: 'emerald' | 'amber' | 'zinc' }) {
  const tintClass =
    tint === 'emerald' ? 'text-terminal-green' :
    tint === 'amber' ? 'text-terminal-amber' :
    'text-terminal-dim';
  return (
    <div className={`text-xs font-semibold uppercase tracking-wide ${tintClass} flex items-center justify-between`}>
      <span>{label}</span>
      <span className="text-terminal-border font-normal">{count}</span>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div className="text-xs text-terminal-border italic px-2 py-3">{text}</div>;
}

function MissionTreeRow({
  m, childrenOf, selectedId, onSelect, depth,
}: {
  m: MissionListItem;
  childrenOf: Map<string, MissionListItem[]>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  depth: number;
}) {
  const kids = childrenOf.get(m.id) || [];
  return (
    <div style={{ paddingLeft: depth ? depth * 12 : 0 }}>
      {depth > 0 && (
        <div className="text-[10px] text-terminal-border -mb-1">└─ child</div>
      )}
      <MissionRow m={m} selected={selectedId === m.id} onSelect={onSelect} />
      {kids.length > 0 && (
        <div className="mt-1 space-y-1 border-l border-terminal-border/60 pl-2 ml-1">
          {kids.map(k => (
            <MissionTreeRow key={k.id} m={k} childrenOf={childrenOf} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function MissionRow({ m, selected, onSelect }: { m: MissionListItem; selected: boolean; onSelect: (id: string | null) => void }) {
  const pct = m.total_phases > 0 ? Math.round(((m.current_phase_index - 1) / m.total_phases) * 100) : 0;
  const ageMs = Date.now() - new Date(m.last_activity_at).getTime();
  return (
    <button
      onClick={() => onSelect(selected ? null : m.id)}
      className={`w-full text-left rounded-md px-2 py-1.5 transition-colors border ${selected ? 'bg-terminal-elevated border-terminal-border' : 'bg-terminal-surface/40 border-terminal-border hover:bg-terminal-surface'}`}
    >
      <div className="text-sm text-terminal-text truncate">{m.goal}</div>
      <div className="mt-1 h-1 rounded-full bg-terminal-elevated overflow-hidden">
        <div
          className={`h-full ${m.status === 'running' ? 'bg-terminal-green' : m.status === 'completed' ? 'bg-terminal-dim' : 'bg-terminal-amber'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-terminal-dim">
        <span>{statusLabel(m.status)} · P{m.current_phase_index}/{m.total_phases}</span>
        <span>{relativeTime(ageMs)}</span>
      </div>
    </button>
  );
}

function MissionDetail({ missionId, onClose, onActed }: { missionId: string; onClose: () => void; onActed: () => void }) {
  const [events, setEvents] = useState<MissionEventFrame[]>([]);
  const [busy, setBusy] = useState<'abort' | 'resume' | 'rewind' | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const sseRef = useRef<EventSource | null>(null);

  // Load checkpoints when the panel mounts AND every time the SSE pushes
  // a new phase.complete event (a fresh checkpoint just landed). Cheap
  // because it's a single GET and the manifest is tiny.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      fetch(`/api/missions/${encodeURIComponent(missionId)}/checkpoints`, { cache: 'no-store' })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then((data: { checkpoints: CheckpointInfo[] }) => {
          if (!cancelled && Array.isArray(data?.checkpoints)) setCheckpoints(data.checkpoints);
        })
        .catch(() => { /* checkpoints panel just won't render */ });
    };
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [missionId]);

  useEffect(() => {
    setEvents([]);
    const es = new EventSource(`/api/missions/${encodeURIComponent(missionId)}/events`);
    sseRef.current = es;
    es.onmessage = (msg) => {
      try {
        const obj = JSON.parse(msg.data) as MissionEventFrame;
        setEvents(prev => {
          // Cap at the most recent 200 events to keep the DOM cheap. The
          // SSE replay sends us everything at first, then live events; we
          // only need the tail for the timeline.
          const next = [...prev, obj];
          return next.length > 200 ? next.slice(next.length - 200) : next;
        });
      } catch { /* ignore non-JSON heartbeats */ }
    };
    es.onerror = () => {
      // Browser will auto-reconnect; nothing to do. Surface in UI by leaving
      // the existing events visible (the next reconnect replays from start).
    };
    return () => { es.close(); sseRef.current = null; };
  }, [missionId]);

  const phaseEvents = events.filter(e => typeof e.type === 'string' && (e.type === 'mission-phase' || e.type.startsWith('phase.')));
  const currentText = events.filter(e => e.type === 'chunk').slice(-3).map(e => String((e as any).text || '')).join('');
  const lastQuestion = [...events].reverse().find(e => e.type === 'mission-question');
  const coverage = [...events].reverse().find(e => e.type === 'mission-coverage') as any;
  // Phase 10: aggregate the per-turn `mission-usage` SSE frames into a
  // running total so the dashboard shows tokens + cost without an extra
  // API call. The accumulator on the server side persists the same data
  // to MissionState.tokens_used; this is the live UI projection.
  const usageTotal = useMemo(() => {
    let input = 0, output = 0, cacheRead = 0, cacheCreation = 0, cost = 0;
    for (const e of events) {
      if (e.type !== 'mission-usage') continue;
      const u = (e as any).usage || {};
      input += Number(u.input_tokens || 0);
      output += Number(u.output_tokens || 0);
      cacheRead += Number(u.cache_read_input_tokens || 0);
      cacheCreation += Number(u.cache_creation_input_tokens || 0);
      cost += Number((e as any).cost || 0);
    }
    return { input, output, cacheRead, cacheCreation, cost };
  }, [events]);
  const lastDecision = [...events].reverse().find(e => e.type === 'orchestrator-decision') as any;
  const lastFanout = [...events].reverse().find(e => e.type === 'scrutiny-fanout') as any;

  const fireAction = async (kind: 'abort' | 'resume') => {
    setBusy(kind);
    try {
      const r = await fetch(`/api/missions/${encodeURIComponent(missionId)}/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onActed();
    } catch (err: any) {
      // Surface inline — no toast system in this scope.
      // eslint-disable-next-line no-alert
      alert(`${kind} failed: ${err?.message || err}`);
    } finally {
      setBusy(null);
    }
  };

  const fireRewind = async (n: number) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Rewind mission state to checkpoint ${n}? The mission will be abort-ed first if running, and your current state file will be replaced.`)) return;
    setBusy('rewind');
    try {
      // Abort first if running. The endpoint refuses rewinds while attached.
      await fetch(`/api/missions/${encodeURIComponent(missionId)}/abort`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'pre-rewind' }),
      }).catch(() => undefined);
      const r = await fetch(`/api/missions/${encodeURIComponent(missionId)}/rewind`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checkpoint: n }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      setShowCheckpoints(false);
      onActed();
    } catch (err: any) {
      // eslint-disable-next-line no-alert
      alert(`Rewind to checkpoint ${n} failed: ${err?.message || err}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-3 grid grid-cols-1 md:grid-cols-3 gap-3">
      <div className="md:col-span-2 space-y-3">
        <div className="flex items-center justify-between">
          <h3
            style={{
              fontFamily: 'var(--font-display, "Space Grotesk")',
              fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em',
              color: 'var(--white, #fff)',
              margin: 0,
            }}
          >
            Mission ·{' '}
            <span
              style={{
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 12,
                color: 'var(--mist, rgba(255,255,255,0.5))',
                fontWeight: 400,
                letterSpacing: '0.04em',
              }}
            >
              {missionId.slice(0, 8)}…
            </span>
          </h3>
          <div className="flex items-center gap-2">
            {checkpoints.length > 0 && (
              <button
                onClick={() => setShowCheckpoints(s => !s)}
                disabled={busy !== null}
                data-fusio
                title="Phase 10: rewind to a milestone checkpoint"
                style={{
                  fontFamily: 'var(--font-mono, ui-monospace)',
                  fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase',
                  padding: '4px 10px', borderRadius: 5,
                  background: showCheckpoints ? 'var(--ink-2, #131319)' : 'transparent',
                  color: 'var(--fog, rgba(255,255,255,0.78))',
                  border: `1px solid ${showCheckpoints ? 'rgba(255,255,255,0.18)' : 'var(--line, rgba(255,255,255,0.08))'}`,
                  opacity: busy !== null ? 0.5 : 1,
                  cursor: 'pointer',
                  transition: 'all 120ms ease-out',
                }}
              >
                ⏮ {checkpoints.length} ckpt
              </button>
            )}
            <button
              onClick={() => fireAction('abort')}
              disabled={busy !== null}
              data-fusio
              style={{
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase',
                padding: '4px 10px', borderRadius: 5,
                background: 'rgba(204, 12, 32, 0.12)',
                color: 'var(--red, #CC0C20)',
                border: '1px solid rgba(204, 12, 32, 0.4)',
                opacity: busy !== null ? 0.5 : 1,
                cursor: 'pointer',
                transition: 'filter 120ms ease-out',
              }}
              onMouseEnter={e => { if (busy === null) (e.currentTarget as HTMLElement).style.filter = 'brightness(1.15)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.filter = 'brightness(1)'; }}
            >
              {busy === 'abort' ? 'Aborting…' : 'Abort'}
            </button>
            <button
              onClick={() => fireAction('resume')}
              disabled={busy !== null}
              data-fusio
              style={{
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase',
                padding: '4px 10px', borderRadius: 5,
                background: 'rgba(76, 195, 138, 0.12)',
                color: 'var(--green, #4CC38A)',
                border: '1px solid rgba(76, 195, 138, 0.4)',
                opacity: busy !== null ? 0.5 : 1,
                cursor: 'pointer',
                transition: 'filter 120ms ease-out',
              }}
              onMouseEnter={e => { if (busy === null) (e.currentTarget as HTMLElement).style.filter = 'brightness(1.15)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.filter = 'brightness(1)'; }}
            >
              {busy === 'resume' ? 'Resuming…' : 'Resume'}
            </button>
            <button
              onClick={onClose}
              data-fusio
              style={{
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase',
                color: 'var(--mist, rgba(255,255,255,0.5))',
                background: 'transparent', border: 'none', cursor: 'pointer',
                padding: '4px 8px',
                transition: 'color 120ms ease-out',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
            >
              Close
            </button>
          </div>
        </div>

        {showCheckpoints && (
          <div className="text-xs bg-terminal-bg border border-terminal-border rounded p-2 space-y-1">
            <div className="text-terminal-dim uppercase tracking-wide mb-1">Checkpoints (most recent first)</div>
            {[...checkpoints].reverse().map(c => (
              <div key={c.n} className="flex items-center justify-between gap-2 group">
                <div className="text-terminal-text truncate">
                  <span className="font-mono text-terminal-dim">#{c.n}</span>
                  <span className="ml-2">{c.label || '(unlabeled)'}</span>
                </div>
                <button
                  onClick={() => fireRewind(c.n)}
                  disabled={busy !== null}
                  className="text-[11px] px-1.5 py-0.5 rounded border border-terminal-amber/50 bg-terminal-amber/20 text-terminal-amber hover:bg-terminal-amber/40 disabled:opacity-50"
                >
                  {busy === 'rewind' ? '…' : 'Rewind'}
                </button>
              </div>
            ))}
          </div>
        )}

        {coverage && (
          <div className="text-xs text-terminal-dim">
            Contract progress: <span className="font-mono text-terminal-text">{coverage.covered}/{coverage.total}</span> assertions verified
          </div>
        )}

        {(usageTotal.input > 0 || usageTotal.output > 0) && (
          <div className="text-xs text-terminal-dim flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span>
              Tokens: <span className="font-mono text-terminal-text">{fmtKtok(usageTotal.input)} in</span>
              {' · '}
              <span className="font-mono text-terminal-text">{fmtKtok(usageTotal.output)} out</span>
              {usageTotal.cacheRead > 0 && (
                <>{' · '}<span className="font-mono text-terminal-green" title="cache hits">{fmtKtok(usageTotal.cacheRead)} cache-read</span></>
              )}
              {usageTotal.cacheCreation > 0 && (
                <>{' · '}<span className="font-mono text-terminal-amber" title="cache misses (created)">{fmtKtok(usageTotal.cacheCreation)} cache-write</span></>
              )}
            </span>
            {usageTotal.cost > 0 && (
              <span>Cost: <span className="font-mono text-terminal-text">${usageTotal.cost.toFixed(3)}</span></span>
            )}
          </div>
        )}

        {lastFanout && (
          <div className="text-xs text-cyan-300/80">
            Scrutiny fan-out: <span className="font-mono text-cyan-200">{lastFanout.count}</span> parallel reviewers (Phase 6)
          </div>
        )}

        {lastDecision && (
          <div className="text-xs bg-terminal-bg border border-terminal-border rounded px-2 py-1.5">
            <div className="text-terminal-dim mb-0.5">Last orchestrator decision (Phase 7)</div>
            <div className="text-terminal-text">
              <span className="font-mono text-terminal-dim">[P{lastDecision.phase}/a{lastDecision.attempt}]</span>{' '}
              <span className="font-semibold">{String(lastDecision.decision)}</span>{' — '}{String(lastDecision.reasoning).slice(0, 200)}
            </div>
            {lastDecision.next_action && (
              <div className="text-terminal-dim italic">→ {String(lastDecision.next_action).slice(0, 200)}</div>
            )}
          </div>
        )}

        {lastQuestion && (
          <div className="text-xs bg-terminal-amber/20 border border-terminal-amber/40 rounded px-2 py-1.5">
            <div className="text-terminal-amber font-semibold mb-0.5">⏸️ Awaiting your answer (Phase {(lastQuestion as any).index})</div>
            <div className="text-terminal-text">{(lastQuestion as any).question}</div>
          </div>
        )}

        <div>
          <div className="text-xs uppercase text-terminal-dim mb-1">Phase timeline</div>
          {phaseEvents.length === 0 && <div className="text-xs text-terminal-border italic">No phase events yet.</div>}
          <ul className="space-y-1 text-xs">
            {phaseEvents.slice(-15).map((e, idx) => (
              <li key={`${e.seq}-${idx}`} className="flex items-center gap-2">
                <span className="font-mono text-terminal-dim w-16 truncate">{(e as any).status || (e.type || '').replace('phase.', '')}</span>
                <span className="text-terminal-text truncate">{(e as any).name || `Phase ${(e as any).index}`}</span>
                {(e as any).attempts && <span className="text-terminal-dim">· {(e as any).attempts} attempt(s)</span>}
                {(e as any).attempt && !(e as any).attempts && <span className="text-terminal-dim">· attempt {(e as any).attempt}</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div>
        <div className="text-xs uppercase text-terminal-dim mb-1">Current activity</div>
        <div className="text-xs text-terminal-text max-h-48 overflow-auto bg-terminal-bg border border-terminal-border rounded p-2 whitespace-pre-wrap font-mono">
          {currentText || <span className="text-terminal-border italic">Idle…</span>}
        </div>
      </div>
    </div>
  );
}

function CreateMissionPanel({
  presets, activePresetId, onClose, onCreated,
}: {
  presets: RolePreset[];
  activePresetId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [mode, setMode] = useState<'goal' | 'full-force' | 'json'>('goal');
  const [goalText, setGoalText] = useState('');
  const [cwd, setCwd] = useState(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem('mc-mission-cwd') || '';
  });
  const [targetUrl, setTargetUrl] = useState('');
  const [jsonBody, setJsonBody] = useState('');
  const [authoring, setAuthoring] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Full Force negotiation streaming state. Captured from the SSE stream
  // /api/missions/negotiate emits as Opus and Codex go back and forth.
  const [negotiating, setNegotiating] = useState(false);
  const [negotiationLog, setNegotiationLog] = useState<string>('');
  const [negotiationRounds, setNegotiationRounds] = useState<Array<{ round: number; opus_accepted: boolean; codex_accepted: boolean; converged: boolean }>>([]);

  const activePreset = presets.find(p => p.id === activePresetId);

  // Mode 'full-force': run an Opus<->Codex negotiation that produces an
  // agreed Mission JSON, plus mark workflow_mode = 'full-force' on the
  // result so the runner knows to do the end-of-mission audit.
  const negotiateFullForce = async () => {
    const source = goalText.trim();
    if (!source || !cwd.trim()) return;
    setNegotiating(true);
    setNegotiationLog('');
    setNegotiationRounds([]);
    setError(null);
    try {
      const resp = await fetch('/api/missions/negotiate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source,
          cwd: cwd.trim(),
          target_url: targetUrl.trim() || undefined,
          preset_id: activePresetId,
        }),
      });
      if (!resp.body) throw new Error('no response body');
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let carry = '';
      let finalMission: any = null;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        carry += dec.decode(value, { stream: true });
        let idx;
        while ((idx = carry.indexOf('\n\n')) >= 0) {
          const frame = carry.slice(0, idx);
          carry = carry.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const ev = JSON.parse(payload);
              if (ev.type === 'agent-text' && typeof ev.text === 'string') {
                setNegotiationLog(prev => prev + ev.text);
              } else if (ev.type === 'status' && typeof ev.status === 'string') {
                setNegotiationLog(prev => prev + `\n_[${ev.status}]_\n`);
              } else if (ev.type === 'negotiation-round') {
                setNegotiationRounds(prev => [...prev, {
                  round: ev.round,
                  opus_accepted: !!ev.opus_accepted,
                  codex_accepted: !!ev.codex_accepted,
                  converged: !!ev.converged,
                }]);
              } else if (ev.type === 'negotiation-final') {
                finalMission = ev.mission;
                if (finalMission) {
                  // Stamp workflow_mode so the runner knows to do final audit.
                  finalMission.workflow_mode = 'full-force';
                  // Apply preset roles if missing.
                  if (!finalMission.roles && activePreset) finalMission.roles = activePreset.config;
                  setJsonBody(JSON.stringify(finalMission, null, 2));
                  setMode('json');
                } else {
                  setError(`Negotiation finished without a parseable Mission JSON (reason: ${ev.reason}). Review the rounds and either retry or paste a JSON manually.`);
                }
              } else if (ev.type === 'negotiation-error') {
                setError(`Negotiation error: ${ev.message}`);
              }
            } catch { /* skip non-JSON heartbeats */ }
          }
        }
      }
      if (!finalMission && !error) {
        setError('Negotiation stream ended without a final Mission. Try again or use Goal mode.');
      }
    } catch (err: any) {
      setError(`Negotiate failed: ${err?.message || err}`);
    } finally {
      setNegotiating(false);
    }
  };

  // Mode 'goal': call the orchestrator surface to author a contract from the
  // goal sentence + cwd. Returns a Mission JSON the user can review before
  // POSTing /api/missions.
  const authorFromGoal = async () => {
    setAuthoring(true);
    setError(null);
    try {
      const r = await fetch('/api/missions/author', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: goalText.trim(), cwd: cwd.trim(), target_url: targetUrl.trim() || undefined, preset_id: activePresetId }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const data = await r.json();
      if (!data?.mission) throw new Error('orchestrator returned no mission');
      // Pretty-print so the user can review/tweak before POSTing.
      setJsonBody(JSON.stringify(data.mission, null, 2));
      setMode('json');
    } catch (err: any) {
      setError(`Author failed: ${err?.message || err}`);
    } finally {
      setAuthoring(false);
    }
  };

  const submitMission = async () => {
    setSubmitting(true);
    setError(null);
    try {
      let mission: any;
      try { mission = JSON.parse(jsonBody); }
      catch (e: any) { throw new Error(`Mission JSON is invalid: ${e?.message || e}`); }
      // Apply the user's preset if mission.roles isn't already explicit
      if (!mission.roles && activePreset) mission.roles = activePreset.config;
      // Persist cwd choice for next time
      if (cwd) try { localStorage.setItem('mc-mission-cwd', cwd); } catch { /* private mode */ }
      const r = await fetch('/api/missions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mission, auto_start: true }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const data = await r.json();
      if (!data?.mission_id) throw new Error('server did not return a mission id');
      onCreated(data.mission_id);
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="px-4 py-3 border-b border-terminal-border bg-terminal-bg space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-terminal-dim">Create new mission</div>
        <div className="flex gap-2">
          <button
            onClick={() => setMode('goal')}
            className={`text-xs px-2 py-0.5 rounded ${mode === 'goal' ? 'bg-terminal-elevated text-terminal-text' : 'text-terminal-dim hover:text-terminal-text'}`}
          >Goal mode</button>
          <button
            onClick={() => setMode('full-force')}
            className={`text-xs px-2 py-0.5 rounded ${mode === 'full-force' ? 'bg-terminal-amber/40 text-terminal-text border border-terminal-amber/50' : 'text-terminal-dim hover:text-terminal-text'}`}
            title="Opus + Codex negotiate the plan, then run with end-of-mission audit"
          >🔥 Full Force</button>
          <button
            onClick={() => setMode('json')}
            className={`text-xs px-2 py-0.5 rounded ${mode === 'json' ? 'bg-terminal-elevated text-terminal-text' : 'text-terminal-dim hover:text-terminal-text'}`}
          >Raw JSON</button>
          <button onClick={onClose} className="text-xs text-terminal-dim hover:text-terminal-text">Close</button>
        </div>
      </div>

      {mode === 'goal' && (
        <div className="space-y-2">
          <label className="block">
            <div className="text-[11px] uppercase text-terminal-dim mb-1">Goal (one sentence)</div>
            <textarea
              value={goalText}
              onChange={(e) => setGoalText(e.target.value)}
              rows={2}
              placeholder="e.g. Add a /api/health endpoint that returns {ok:true} and is covered by a Vitest test"
              className="w-full bg-terminal-surface border border-terminal-border rounded p-2 text-sm text-terminal-text placeholder:text-terminal-border focus:outline-none focus:border-terminal-green"
            />
          </label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <label className="block">
              <div className="text-[11px] uppercase text-terminal-dim mb-1">Working directory (cwd)</div>
              <input
                type="text"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="~/some-project"
                className="w-full bg-terminal-surface border border-terminal-border rounded p-2 text-sm text-terminal-text font-mono placeholder:text-terminal-border focus:outline-none focus:border-terminal-green"
              />
            </label>
            <label className="block">
              <div className="text-[11px] uppercase text-terminal-dim mb-1">target_url (optional)</div>
              <input
                type="text"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="http://localhost:3005 (for behavioral assertions)"
                className="w-full bg-terminal-surface border border-terminal-border rounded p-2 text-sm text-terminal-text font-mono placeholder:text-terminal-border focus:outline-none focus:border-terminal-green"
              />
            </label>
          </div>
          {activePreset && (
            <div className="text-[11px] text-terminal-dim">
              Using preset <span className="text-terminal-text">{activePreset.label}</span> (worker:{' '}
              <span className="font-mono text-terminal-text">{activePreset.config.worker.model}</span>, scrutiny:{' '}
              <span className="font-mono text-terminal-text">{activePreset.config.scrutiny.provider}/{activePreset.config.scrutiny.model}</span>)
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={authorFromGoal}
              disabled={authoring || !goalText.trim() || !cwd.trim()}
              className="text-xs px-3 py-1.5 rounded border border-terminal-green bg-terminal-green/30 text-terminal-text hover:bg-terminal-green/50 disabled:opacity-50"
            >
              {authoring ? 'Authoring contract…' : '🧭 Have orchestrator author the contract'}
            </button>
            <button
              onClick={() => { setJsonBody(scaffoldMissionJson(goalText.trim(), cwd.trim(), targetUrl.trim(), activePreset?.config)); setMode('json'); }}
              disabled={!goalText.trim() || !cwd.trim()}
              className="text-xs px-3 py-1.5 rounded border border-terminal-border text-terminal-text hover:bg-terminal-surface disabled:opacity-50"
              title="Skip the orchestrator and edit the JSON yourself"
            >
              ⚙ Scaffold JSON manually
            </button>
          </div>
        </div>
      )}

      {mode === 'full-force' && (
        <div className="space-y-2">
          <div className="text-xs text-terminal-amber bg-terminal-amber/40 border border-terminal-amber/50 rounded px-2 py-1.5">
            <div className="font-semibold">🔥 Full Force workflow</div>
            <div className="text-terminal-amber/80">
              Opus (Anthropic) and Codex (OpenAI) read your source material and negotiate
              a plan back-and-forth until they both ACCEPT. Then the mission runs with
              per-phase pair workers AND a final Codex audit at the end. Cost: ~$2-4 per
              mission depending on scope.
            </div>
          </div>
          <label className="block">
            <div className="text-[11px] uppercase text-terminal-dim mb-1">Source material — chat content, plan, prompt, prose goal</div>
            <textarea
              value={goalText}
              onChange={(e) => setGoalText(e.target.value)}
              rows={6}
              placeholder="Paste a chat thread, an existing plan doc, a prose goal, or any free-form description of what you want built. Both agents will analyze it before drafting plans."
              className="w-full bg-terminal-surface border border-terminal-border rounded p-2 text-sm text-terminal-text placeholder:text-terminal-border focus:outline-none focus:border-terminal-amber"
              disabled={negotiating}
            />
          </label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <label className="block">
              <div className="text-[11px] uppercase text-terminal-dim mb-1">Working directory (cwd)</div>
              <input
                type="text"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="~/some-project"
                className="w-full bg-terminal-surface border border-terminal-border rounded p-2 text-sm text-terminal-text font-mono placeholder:text-terminal-border focus:outline-none focus:border-terminal-amber"
                disabled={negotiating}
              />
            </label>
            <label className="block">
              <div className="text-[11px] uppercase text-terminal-dim mb-1">target_url (optional, for behavioral)</div>
              <input
                type="text"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="http://localhost:3005"
                className="w-full bg-terminal-surface border border-terminal-border rounded p-2 text-sm text-terminal-text font-mono placeholder:text-terminal-border focus:outline-none focus:border-terminal-amber"
                disabled={negotiating}
              />
            </label>
          </div>
          <button
            onClick={negotiateFullForce}
            disabled={negotiating || !goalText.trim() || !cwd.trim()}
            className="text-xs px-3 py-1.5 rounded border border-terminal-amber bg-terminal-amber/40 text-terminal-text hover:bg-terminal-amber/60 disabled:opacity-50"
          >
            {negotiating ? '🤝 Negotiating…' : '🤝 Start plan negotiation'}
          </button>

          {(negotiationLog || negotiationRounds.length > 0) && (
            <div className="mt-3 space-y-2">
              {negotiationRounds.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {negotiationRounds.map(r => (
                    <span key={r.round} className={`text-[11px] px-2 py-0.5 rounded border ${r.converged ? 'border-terminal-green bg-terminal-green/30 text-terminal-green' : 'border-terminal-border text-terminal-dim'}`}>
                      R{r.round}: O={r.opus_accepted ? '✓' : '·'} C={r.codex_accepted ? '✓' : '·'}{r.converged ? ' converged' : ''}
                    </span>
                  ))}
                </div>
              )}
              <div className="text-xs text-terminal-text max-h-72 overflow-y-auto bg-terminal-bg border border-terminal-border rounded p-2 whitespace-pre-wrap font-mono">
                {negotiationLog || '(waiting for first round…)'}
              </div>
            </div>
          )}
        </div>
      )}

      {mode === 'json' && (
        <div className="space-y-2">
          <div className="text-[11px] text-terminal-dim">
            Edit if needed, then submit. The mission will start running immediately.
          </div>
          <textarea
            value={jsonBody}
            onChange={(e) => setJsonBody(e.target.value)}
            rows={16}
            placeholder='{"id":"…","goal":"…","phases":[…],"contract":{"assertions":[…]}, …}'
            className="w-full bg-terminal-surface border border-terminal-border rounded p-2 text-xs text-terminal-text font-mono placeholder:text-terminal-border focus:outline-none focus:border-terminal-green"
            spellCheck={false}
          />
          <div className="flex gap-2 items-center">
            <button
              onClick={submitMission}
              disabled={submitting || !jsonBody.trim()}
              className="text-xs px-3 py-1.5 rounded border border-terminal-green bg-terminal-green/40 text-terminal-text hover:bg-terminal-green/60 disabled:opacity-50"
            >
              {submitting ? 'Starting…' : '🚀 Start mission'}
            </button>
            <button
              onClick={() => setMode('goal')}
              className="text-xs px-3 py-1.5 rounded border border-terminal-border text-terminal-text hover:bg-terminal-surface"
            >
              ← Back to goal
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="text-xs text-terminal-red bg-terminal-red/40 border border-terminal-red rounded px-2 py-1.5 whitespace-pre-wrap">
          {error}
        </div>
      )}
    </div>
  );
}

/** Bare-bones mission JSON scaffold — gives the user something to edit when
 *  they don't want to call the orchestrator. Single trivial phase, no
 *  assertions. The user is expected to add real phases + assertions before
 *  hitting Start. */
function scaffoldMissionJson(
  goal: string,
  cwd: string,
  targetUrl: string,
  roles: { orchestrator?: { provider: string; model: string }; worker?: { provider: string; model: string }; scrutiny?: { provider: string; model: string }; user_testing?: { provider: string; model: string } } | undefined,
): string {
  const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `mission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const mission: Record<string, unknown> = {
    id,
    goal: goal || 'TODO: state the goal in one sentence',
    phases: [
      {
        index: 1,
        name: 'TODO: short phase title',
        spec: 'TODO: what this phase delivers (free-form markdown)',
        assertion_ids: ['A001'],
        origin: 'plan',
      },
    ],
    contract: {
      assertions: [
        {
          id: 'A001',
          statement: 'TODO: a verifiable, plain-language assertion',
          type: 'static',
          severity: 'high',
        },
      ],
    },
    cwd: cwd || '/path/to/project',
    status: 'approved',
    created_at: now,
    last_activity_at: now,
  };
  if (roles) mission.roles = roles;
  if (targetUrl) mission.target_url = targetUrl;
  return JSON.stringify(mission, null, 2);
}

function SettingsPanel({ presets, activeId, onPick }: { presets: RolePreset[]; activeId: string; onPick: (id: string) => void }) {
  if (presets.length === 0) {
    return (
      <div className="px-4 py-3 border-b border-terminal-border text-xs text-terminal-dim italic">
        Loading role presets…
      </div>
    );
  }
  return (
    <div className="px-4 py-3 border-b border-terminal-border bg-terminal-surface/40 space-y-2">
      <div className="text-xs uppercase tracking-wide text-terminal-dim">Per-role model preset (Phase 9)</div>
      <p className="text-xs text-terminal-dim max-w-prose">
        Stored locally; new missions started from this client pick up the preset
        unless their <code className="text-terminal-text">mission.roles</code> override it.
        Phase 9's mix-providers guard surfaces a warning at mission start if
        scrutiny ends up on the same provider as the worker.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {presets.map(p => (
          <button
            key={p.id}
            onClick={() => onPick(p.id)}
            className={`text-left rounded-md p-2 border transition-colors ${activeId === p.id ? 'border-terminal-green bg-terminal-green/20' : 'border-terminal-border bg-terminal-surface/30 hover:bg-terminal-surface'}`}
          >
            <div className="text-sm font-semibold text-terminal-text flex items-center gap-2">
              {p.label}
              {activeId === p.id && <span className="text-terminal-green text-xs">●</span>}
            </div>
            <div className="text-xs text-terminal-dim mb-1">{p.description}</div>
            <div className="text-[11px] text-terminal-dim font-mono space-y-0.5">
              <div>orch: <span className="text-terminal-text">{p.config.orchestrator.model}</span></div>
              <div>work: <span className="text-terminal-text">{p.config.worker.model}</span></div>
              <div>scrut: <span className="text-terminal-text">{p.config.scrutiny.provider}/{p.config.scrutiny.model}</span></div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function statusLabel(s: MissionListItem['status']): string {
  switch (s) {
    case 'running': return 'running';
    case 'paused-question': return 'awaiting answer';
    case 'paused-stuck': return 'stuck';
    case 'paused-checkpoint': return 'paused';
    case 'completed': return 'completed';
    case 'cancelled': return 'cancelled';
    case 'approved': return 'approved';
    case 'draft': return 'draft';
    default: return s;
  }
}

function fmtKtok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function relativeTime(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
