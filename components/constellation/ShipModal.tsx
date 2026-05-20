'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Rocket, X, GitMerge, GitBranch, Loader2, CheckCircle2, XCircle,
  AlertTriangle, ExternalLink, Zap, Package, Database,
} from 'lucide-react';

type TargetKind = 'next' | 'rn-web' | 'eas-build' | 'eas-update' | 'supabase-db' | 'supabase-functions';

interface PlanTask {
  id: string;
  title: string;
  role_hint: string | null;
  status: string;
  branch_name: string | null;
  diff_numstat: string | null;
  result_summary: string | null;
}

interface DeployTarget {
  kind: TargetKind;
  label: string;
  command: string[];
  shouldRun: boolean;
  reason: string;
  metadata?: any;
}

interface ShipPlan {
  team_id: string;
  project_root: string;
  main_branch: string;
  shippable_tasks: PlanTask[];
  files_changed: string[];
  deploy_plan: {
    detected: any;
    targets: DeployTarget[];
  };
}

interface ShipStep {
  id: string;
  targetKind: TargetKind;
  label: string;
  command: string;
  status: 'queued' | 'running' | 'ok' | 'failed' | 'skipped';
  startedAt?: number;
  endedAt?: number;
  exitCode?: number;
  output: string[];
  error?: string;
  urls: string[];
}

interface ShipRun {
  id: string;
  teamId: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'ok' | 'failed' | 'partial';
  steps: ShipStep[];
}

const KIND_ICON: Record<TargetKind, React.ComponentType<{ className?: string }>> = {
  next: Package,
  'rn-web': Package,
  'eas-build': Package,
  'eas-update': Zap,
  'supabase-db': Database,
  'supabase-functions': Database,
};

interface ShipModalProps {
  teamId: string;
  open: boolean;
  onClose: () => void;
  onShipped?: () => void;
}

export function ShipModal({ teamId, open, onClose, onShipped }: ShipModalProps) {
  const [plan, setPlan] = useState<ShipPlan | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // UI toggles
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [targetRun, setTargetRun] = useState<Map<TargetKind, boolean>>(new Map());
  const [squash, setSquash] = useState(false);
  const [skipDeploy, setSkipDeploy] = useState(false);

  // Run state
  const [shipping, setShipping] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<ShipRun | null>(null);
  const [mergeReport, setMergeReport] = useState<{
    approved: number; merged_ok: number; merged_failed: number; details: any[];
  } | null>(null);

  // Load plan when opened
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingPlan(true);
    setErr(null);
    fetch(`/api/teams/${teamId}/ship/plan`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        if (d.error) { setErr(d.error); return; }
        setPlan(d);
        setSelectedTaskIds(new Set(d.shippable_tasks.map((t: PlanTask) => t.id)));
        const tr = new Map<TargetKind, boolean>();
        for (const t of d.deploy_plan.targets as DeployTarget[]) tr.set(t.kind, t.shouldRun);
        setTargetRun(tr);
      })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoadingPlan(false); });
    return () => { cancelled = true; };
  }, [open, teamId]);

  // Poll ship run status once shipping starts
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch(`/api/teams/${teamId}/ship/status?run_id=${runId}`);
        const d = await r.json();
        if (cancelled) return;
        setRun(d.run || null);
        if (d.run && d.run.status !== 'running') {
          // Done — final poll to pick up last output
          setTimeout(() => poll(), 1500);
          return;
        }
      } catch { /* ignore */ }
    };
    const interval = setInterval(poll, 1500);
    poll();
    return () => { cancelled = true; clearInterval(interval); };
  }, [runId, teamId]);

  const toggleTask = useCallback((id: string) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleTarget = useCallback((kind: TargetKind) => {
    setTargetRun(prev => {
      const next = new Map(prev);
      next.set(kind, !next.get(kind));
      return next;
    });
  }, []);

  const executeShip = useCallback(async () => {
    if (!plan || selectedTaskIds.size === 0) return;
    setShipping(true);
    setErr(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/ship`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_ids: Array.from(selectedTaskIds),
          approve: true,
          merge: true,
          squash,
          skip_deploy: skipDeploy,
          deploy_targets: plan.deploy_plan.targets.map(t => ({
            kind: t.kind,
            run: targetRun.get(t.kind) ?? false,
          })),
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Ship failed');
      setMergeReport({
        approved: d.approved_count,
        merged_ok: d.merged_ok,
        merged_failed: d.merged_failed,
        details: d.merge_results,
      });
      if (d.ship_run_id) setRunId(d.ship_run_id);
      else onShipped?.();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setShipping(false);
    }
  }, [plan, selectedTaskIds, targetRun, teamId, squash, skipDeploy, onShipped]);

  const selectedFilesCount = useMemo(() => {
    if (!plan) return 0;
    const set = new Set<string>();
    for (const t of plan.shippable_tasks) {
      if (!selectedTaskIds.has(t.id)) continue;
      // reconstruct files — not exposed per-task; use aggregate as upper bound
    }
    // We don't have per-task files client-side; show aggregate.
    return plan.files_changed.length;
  }, [plan, selectedTaskIds]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 90,
        display: 'flex', justifyContent: 'center',
        background: 'rgba(0,0,0,0.72)',
        backdropFilter: 'blur(3px)',
      }}
      className="items-stretch md:items-center md:p-4"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full md:max-w-4xl md:max-h-[92vh] h-full md:h-auto md:rounded-xl"
        style={{
          display: 'flex', flexDirection: 'column',
          background: 'var(--ink, #0A0A0E)',
          border: '1px solid var(--line, rgba(255,255,255,0.08))',
          boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
          overflow: 'hidden',
          fontFamily: 'var(--font-sans, system-ui)',
          color: 'var(--white, #fff)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '12px 20px',
            borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
            background: 'var(--ink-2, #131319)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 24, height: 24, borderRadius: 6,
                background: 'rgba(76, 195, 138, 0.12)',
                border: '1px solid rgba(76, 195, 138, 0.35)',
              }}
            >
              <Rocket style={{ width: 12, height: 12, color: 'var(--green, #4CC38A)' }} />
            </span>
            <div>
              <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
                Build · Ship
              </div>
              <h2 style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 15, fontWeight: 600, letterSpacing: '-0.015em', margin: 0, color: 'var(--white, #fff)' }}>
                Ship deliverable
              </h2>
            </div>
          </div>
          <button
            onClick={onClose}
            data-fusio
            style={{
              padding: 4, borderRadius: 5, background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--mist, rgba(255,255,255,0.5))',
              transition: 'all 120ms ease-out',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--red, #CC0C20)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
          >
            <X style={{ width: 18, height: 18 }} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loadingPlan && (
            <div className="flex items-center gap-2 text-terminal-dim text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Building deploy plan…
            </div>
          )}
          {err && (
            <div className="rounded border border-terminal-red/30 bg-terminal-red/10 text-terminal-red p-3 text-sm">
              {err}
            </div>
          )}

          {plan && !run && !mergeReport && (
            <>
              {/* Tasks to ship */}
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-bold text-terminal-text flex items-center gap-2">
                    <GitMerge className="w-4 h-4 text-terminal-cyan" />
                    Tasks to ship ({selectedTaskIds.size}/{plan.shippable_tasks.length})
                  </h3>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setSelectedTaskIds(new Set(plan.shippable_tasks.map(t => t.id)))}
                      className="text-[10px] text-terminal-dim hover:text-terminal-text"
                    >all</button>
                    <span className="text-terminal-dim">·</span>
                    <button
                      onClick={() => setSelectedTaskIds(new Set())}
                      className="text-[10px] text-terminal-dim hover:text-terminal-text"
                    >none</button>
                  </div>
                </div>
                <div className="space-y-1 max-h-48 overflow-y-auto border border-terminal-border rounded">
                  {plan.shippable_tasks.map(t => (
                    <label key={t.id} className="flex items-start gap-2 px-2 py-1.5 hover:bg-terminal-surface/50 cursor-pointer border-b border-terminal-border/50 last:border-0">
                      <input
                        type="checkbox"
                        checked={selectedTaskIds.has(t.id)}
                        onChange={() => toggleTask(t.id)}
                        className="mt-0.5 accent-terminal-green"
                      />
                      <div className="flex-1 min-w-0 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="text-terminal-text font-medium truncate">{t.title}</span>
                          <span className="text-[10px] text-terminal-dim">[{t.role_hint || '-'}]</span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-terminal-dim mt-0.5">
                          <span className={
                            t.status === 'approved' ? 'text-terminal-green' :
                            t.status === 'ready_for_review' ? 'text-terminal-purple' : ''
                          }>{t.status}</span>
                          {t.diff_numstat && <span className="text-terminal-green">{t.diff_numstat}</span>}
                          {t.branch_name && <span className="font-mono text-terminal-cyan truncate max-w-[240px]">{t.branch_name}</span>}
                        </div>
                      </div>
                    </label>
                  ))}
                  {plan.shippable_tasks.length === 0 && (
                    <p className="text-xs text-terminal-dim p-4 text-center">No tasks ready to ship</p>
                  )}
                </div>
              </section>

              {/* Merge options */}
              <section className="space-y-2">
                <h3 className="text-sm font-bold text-terminal-text flex items-center gap-2">
                  <GitBranch className="w-4 h-4 text-terminal-cyan" />
                  Merge into <span className="font-mono text-terminal-green">{plan.main_branch}</span>
                </h3>
                <label className="flex items-center gap-2 text-xs text-terminal-dim cursor-pointer">
                  <input type="checkbox" checked={squash} onChange={e => setSquash(e.target.checked)} className="accent-terminal-cyan" />
                  Squash-merge (one commit per task, cleaner history)
                </label>
              </section>

              {/* Deploy plan */}
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-bold text-terminal-text flex items-center gap-2">
                    <Rocket className="w-4 h-4 text-terminal-cyan" />
                    Deploy targets ({plan.deploy_plan.targets.length})
                  </h3>
                  <label className="flex items-center gap-2 text-xs text-terminal-dim cursor-pointer">
                    <input type="checkbox" checked={skipDeploy} onChange={e => setSkipDeploy(e.target.checked)} className="accent-terminal-amber" />
                    Skip deploy (merge only)
                  </label>
                </div>
                {plan.deploy_plan.targets.length === 0 && (
                  <div className="text-xs text-terminal-dim p-3 border border-terminal-border rounded bg-terminal-surface/30">
                    No deploy targets detected in <span className="font-mono">{plan.project_root}</span>.
                    <br />
                    (Looking for: next.config, dist/.vercel, eas.json, supabase/migrations, supabase/functions)
                  </div>
                )}
                <div className="space-y-1.5">
                  {plan.deploy_plan.targets.map(t => {
                    const Icon = KIND_ICON[t.kind];
                    const on = targetRun.get(t.kind) ?? false;
                    return (
                      <label
                        key={t.kind}
                        className={`flex items-start gap-2 p-2 rounded border cursor-pointer transition-colors ${
                          skipDeploy ? 'opacity-40 pointer-events-none' :
                          on ? 'border-terminal-cyan/50 bg-terminal-cyan/5' :
                          'border-terminal-border hover:bg-terminal-surface/50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleTarget(t.kind)}
                          disabled={skipDeploy}
                          className="mt-1 accent-terminal-cyan"
                        />
                        <Icon className="w-4 h-4 mt-0.5 flex-shrink-0 text-terminal-cyan" />
                        <div className="flex-1 min-w-0 text-xs">
                          <div className="font-medium text-terminal-text">{t.label}</div>
                          <div className="text-[10px] text-terminal-dim mt-0.5">{t.reason}</div>
                          <div className="font-mono text-[10px] text-terminal-green mt-0.5 truncate">
                            $ {t.command.join(' ')}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </section>
            </>
          )}

          {mergeReport && (
            <section className="space-y-2">
              <h3 className="text-sm font-bold text-terminal-text flex items-center gap-2">
                <GitMerge className="w-4 h-4 text-terminal-cyan" />
                Merge result
              </h3>
              <div className="flex gap-3 text-xs">
                <span className="text-terminal-green">{mergeReport.merged_ok} merged</span>
                {mergeReport.merged_failed > 0 && <span className="text-terminal-red">{mergeReport.merged_failed} failed</span>}
                <span className="text-terminal-dim">{mergeReport.approved} approved</span>
              </div>
              <div className="space-y-1 max-h-36 overflow-y-auto border border-terminal-border rounded p-2 text-xs">
                {mergeReport.details.map((r: any, i: number) => (
                  <div key={i} className="flex items-start gap-2">
                    {r.ok
                      ? <CheckCircle2 className="w-3 h-3 text-terminal-green mt-0.5 flex-shrink-0" />
                      : <XCircle className="w-3 h-3 text-terminal-red mt-0.5 flex-shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-terminal-text truncate">{r.title}</div>
                      {r.ok ? (
                        <div className="text-[10px] text-terminal-green">+{r.lines_added} -{r.lines_removed}</div>
                      ) : (
                        <div className="text-[10px] text-terminal-red">{r.error}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {run && (
            <section className="space-y-2">
              <h3 className="text-sm font-bold text-terminal-text flex items-center gap-2">
                <Rocket className="w-4 h-4 text-terminal-cyan" />
                Deploy run
                <span className={`text-[10px] px-2 py-0.5 rounded uppercase tracking-wider border ${
                  run.status === 'ok' ? 'text-terminal-green border-terminal-green/40' :
                  run.status === 'failed' ? 'text-terminal-red border-terminal-red/40' :
                  run.status === 'partial' ? 'text-terminal-amber border-terminal-amber/40' :
                  'text-terminal-cyan border-terminal-cyan/40 animate-pulse'
                }`}>{run.status}</span>
              </h3>
              <div className="space-y-2">
                {run.steps.map(s => {
                  const Icon = KIND_ICON[s.targetKind] || Rocket;
                  return (
                    <div key={s.id} className="rounded border border-terminal-border">
                      <div className="px-3 py-2 flex items-center gap-2 border-b border-terminal-border/50 bg-terminal-surface/30">
                        <Icon className="w-4 h-4 text-terminal-cyan flex-shrink-0" />
                        <span className="text-xs font-medium text-terminal-text flex-1 truncate">{s.label}</span>
                        {s.status === 'running' && <Loader2 className="w-3 h-3 text-terminal-amber animate-spin" />}
                        {s.status === 'ok' && <CheckCircle2 className="w-3 h-3 text-terminal-green" />}
                        {s.status === 'failed' && <XCircle className="w-3 h-3 text-terminal-red" />}
                        {s.status === 'skipped' && <span className="text-[10px] text-terminal-dim">skipped</span>}
                        {s.status === 'queued' && <span className="text-[10px] text-terminal-dim">queued</span>}
                        {s.startedAt && s.endedAt && (
                          <span className="text-[10px] text-terminal-dim">
                            {((s.endedAt - s.startedAt) / 1000).toFixed(1)}s
                          </span>
                        )}
                      </div>
                      {s.urls.length > 0 && (
                        <div className="px-3 py-1 text-[10px] text-terminal-cyan border-b border-terminal-border/30 bg-terminal-bg/50 space-y-0.5">
                          {s.urls.slice(0, 4).map(u => (
                            <a key={u} href={u} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:underline truncate">
                              <ExternalLink className="w-2.5 h-2.5" /> {u}
                            </a>
                          ))}
                        </div>
                      )}
                      {(s.status === 'running' || s.status === 'ok' || s.status === 'failed') && s.output.length > 0 && (
                        <details className="group">
                          <summary className="px-3 py-1 text-[10px] text-terminal-dim cursor-pointer hover:text-terminal-text">
                            {s.output.length} line{s.output.length === 1 ? '' : 's'} of output
                          </summary>
                          <pre className="bg-terminal-bg text-[10px] text-terminal-dim font-mono p-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
                            {s.output.slice(-200).join('\n')}
                          </pre>
                        </details>
                      )}
                      {s.error && (
                        <div className="px-3 py-1 text-[10px] text-terminal-red bg-terminal-red/5 border-t border-terminal-red/20">
                          {s.error}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-terminal-border bg-terminal-surface/40">
          <div className="text-[11px] text-terminal-dim">
            {plan && !mergeReport && (
              <>
                {selectedTaskIds.size} task{selectedTaskIds.size === 1 ? '' : 's'} ·
                {' '}{selectedFilesCount} file{selectedFilesCount === 1 ? '' : 's'} ·
                {' '}{skipDeploy ? 'no deploy' : `${Array.from(targetRun.values()).filter(Boolean).length} target${Array.from(targetRun.values()).filter(Boolean).length === 1 ? '' : 's'}`}
              </>
            )}
            {mergeReport && run && run.status !== 'running' && (
              <>Ship complete. Merged {mergeReport.merged_ok}, deploy {run.status}.</>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded border border-terminal-border text-terminal-dim hover:text-terminal-text"
            >Close</button>
            {!mergeReport && (
              <button
                onClick={executeShip}
                disabled={shipping || !plan || selectedTaskIds.size === 0}
                className="px-4 py-1.5 text-xs rounded bg-terminal-green/20 border border-terminal-green/40 text-terminal-green hover:bg-terminal-green/30 disabled:opacity-50 font-bold flex items-center gap-1"
              >
                {shipping ? <Loader2 className="w-3 h-3 animate-spin" /> : <Rocket className="w-3 h-3" />}
                Ship {selectedTaskIds.size} task{selectedTaskIds.size === 1 ? '' : 's'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
