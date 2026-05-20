'use client';

import { useMemo, useState } from 'react';
import type { TaskReview, TaskReviewFinding, TaskData } from '../teams/useTeamState';

interface CodexReviewsProps {
  reviews: TaskReview[];
  findings: TaskReviewFinding[];
  tasks: TaskData[];
}

const SEVERITY_META: Record<string, { color: string; badge: string; order: number }> = {
  critical: { color: 'text-terminal-red', badge: 'bg-terminal-red text-terminal-bg', order: 0 },
  high: { color: 'text-terminal-red', badge: 'bg-terminal-red/20 text-terminal-red border border-terminal-red/50', order: 1 },
  medium: { color: 'text-terminal-amber', badge: 'bg-terminal-amber/20 text-terminal-amber border border-terminal-amber/50', order: 2 },
  low: { color: 'text-terminal-cyan', badge: 'bg-terminal-cyan/20 text-terminal-cyan border border-terminal-cyan/50', order: 3 },
  info: { color: 'text-terminal-dim', badge: 'bg-terminal-surface text-terminal-dim border border-terminal-border', order: 4 },
};

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function CodexReviews({ reviews, findings, tasks }: CodexReviewsProps) {
  const [severityFilter, setSeverityFilter] = useState<'all' | 'critical' | 'high' | 'medium' | 'low' | 'info'>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const taskMap = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);

  const severityCounts = useMemo(() => {
    const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
    return counts;
  }, [findings]);

  const filtered = useMemo(() => {
    if (severityFilter === 'all') return findings;
    return findings.filter(f => f.severity === severityFilter);
  }, [findings, severityFilter]);

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (reviews.length === 0 && findings.length === 0) {
    return (
      <div
        style={{
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          height: '100%',
          padding: 32,
          color: 'var(--mist, rgba(255,255,255,0.5))',
          fontFamily: 'var(--font-sans, system-ui)',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
        <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))', marginBottom: 4 }}>
          Build · Reviews
        </div>
        <p style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, color: 'var(--white, #fff)', margin: 0 }}>
          No Codex reviews yet
        </p>
        <p style={{ fontSize: 12, marginTop: 8, maxWidth: 400, lineHeight: 1.5, color: 'var(--mist, rgba(255,255,255,0.5))' }}>
          Inspectors, security, and testers run{' '}
          <code style={{ color: 'var(--cyan, #5EC4D9)', fontFamily: 'var(--font-mono, ui-monospace)' }}>
            mc_codex_review
          </code>{' '}
          to get cross-model findings. They appear here with severity and recommendations.
        </p>
      </div>
    );
  }

  // Severity color helper for inline use
  const sevColor = (s: string) => {
    const meta = SEVERITY_META[s];
    if (!meta) return 'var(--mist, rgba(255,255,255,0.5))';
    if (meta.color.includes('red')) return 'var(--red, #CC0C20)';
    if (meta.color.includes('amber')) return 'var(--amber, #E8A23B)';
    if (meta.color.includes('cyan')) return 'var(--cyan, #5EC4D9)';
    return 'var(--mist, rgba(255,255,255,0.5))';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'var(--font-sans, system-ui)' }}>
      {/* Severity filter bar */}
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
          background: 'var(--ink-2, #131319)',
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
            color: 'var(--mist, rgba(255,255,255,0.5))',
          }}
        >
          Severity
        </span>
        {(['all', 'critical', 'high', 'medium', 'low', 'info'] as const).map(s => {
          const count = s === 'all' ? findings.length : (severityCounts[s] || 0);
          const active = severityFilter === s;
          const color = s === 'all' ? 'var(--white, #fff)' : sevColor(s);
          return (
            <button
              key={s}
              onClick={() => setSeverityFilter(s)}
              data-fusio
              style={{
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
                padding: '3px 9px',
                borderRadius: 5,
                background: active ? `color-mix(in srgb, ${color} 14%, transparent)` : 'transparent',
                color: active ? color : 'var(--mist, rgba(255,255,255,0.5))',
                border: `1px solid ${active ? `color-mix(in srgb, ${color} 35%, transparent)` : 'var(--line, rgba(255,255,255,0.08))'}`,
                cursor: 'pointer',
                transition: 'all 120ms ease-out',
              }}
            >
              {s} · {count}
            </button>
          );
        })}
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 10, letterSpacing: '0.12em',
            color: 'var(--mist, rgba(255,255,255,0.5))',
          }}
        >
          {reviews.length} review{reviews.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Findings */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1.5">
        {filtered.length === 0 && (
          <p className="text-terminal-dim text-center py-8 text-xs">No findings match this filter</p>
        )}
        {filtered.map(f => {
          const meta = SEVERITY_META[f.severity] || SEVERITY_META.info;
          const task = taskMap.get(f.task_id);
          const isOpen = expanded.has(f.id);

          return (
            <div
              key={f.id}
              className="rounded border border-terminal-border bg-terminal-surface/30 hover:border-terminal-dim overflow-hidden"
            >
              <button
                onClick={() => toggle(f.id)}
                className="w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-terminal-surface/50"
              >
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase flex-shrink-0 mt-0.5 ${meta.badge}`}>
                  {f.severity}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-terminal-text font-medium truncate">{f.title}</div>
                  <div className="flex items-center gap-2 text-[10px] text-terminal-dim mt-0.5 flex-wrap">
                    {f.file && (
                      <span className="font-mono text-terminal-cyan truncate max-w-[280px]">
                        {f.file}
                        {f.line_start ? `:${f.line_start}${f.line_end && f.line_end !== f.line_start ? `-${f.line_end}` : ''}` : ''}
                      </span>
                    )}
                    {task && <span className="truncate">· {task.title}</span>}
                    {f.confidence != null && <span>· conf {(f.confidence * 100).toFixed(0)}%</span>}
                    <span>· {fmtTime(f.created_at)}</span>
                    <span className={`ml-auto px-1.5 py-0 rounded text-[9px] uppercase border ${
                      f.status === 'open' ? 'text-terminal-amber border-terminal-amber/30'
                        : f.status === 'addressed' ? 'text-terminal-green border-terminal-green/30'
                        : 'text-terminal-dim border-terminal-border'
                    }`}>
                      {f.status}
                    </span>
                  </div>
                </div>
                <span className="text-terminal-dim flex-shrink-0 text-xs">{isOpen ? '▾' : '▸'}</span>
              </button>
              {isOpen && (
                <div className="px-3 pb-3 pt-0 border-t border-terminal-border/50 bg-terminal-bg/50">
                  {f.body && (
                    <div className="mt-2 text-[11px] text-terminal-text whitespace-pre-wrap leading-relaxed">
                      {f.body}
                    </div>
                  )}
                  {f.recommendation && (
                    <div className="mt-2 pt-2 border-t border-terminal-border/30">
                      <div className="text-[10px] uppercase tracking-wider text-terminal-dim mb-1">Recommendation</div>
                      <div className="text-[11px] text-terminal-green whitespace-pre-wrap leading-relaxed">
                        {f.recommendation}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
