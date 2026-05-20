'use client';

import { useState } from 'react';
import { FileText, GitBranch, CheckCircle2, Loader2, Sparkles, Send, ShieldCheck, AlertCircle, XCircle, Play, Rocket } from 'lucide-react';
import { ROLE_GLYPHS } from './constants';
import { askArchitect, useFinalAudit, type DeliverableData } from '../teams/useTeamState';
import { ShipModal } from './ShipModal';

interface DeliverableProps {
  teamId: string;
  teamStatus: string;
  data: DeliverableData | null;
  onRefresh?: () => void;
  onJumpToArchitect?: () => void;
}

function fmtTime(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
}

export function Deliverable({ teamId, teamStatus, data, onRefresh, onJumpToArchitect }: DeliverableProps) {
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionText, setRevisionText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sentOk, setSentOk] = useState(false);
  const { audit, loading: auditLoading, runNow: runAudit } = useFinalAudit(teamId);
  const [shipOpen, setShipOpen] = useState(false);

  const submitRevision = async () => {
    const body = revisionText.trim();
    if (!body || submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      await askArchitect(teamId, body, { resume: true, kind: 'revision' });
      setRevisionOpen(false);
      setRevisionText('');
      setSentOk(true);
      setTimeout(() => setSentOk(false), 4000);
      onRefresh?.();
    } catch (e: any) {
      setErr(e.message || 'Failed to send revision');
    } finally {
      setSubmitting(false);
    }
  };

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-terminal-dim p-8">
        <Loader2 className="w-6 h-6 animate-spin mb-2" />
        <p className="text-sm">Loading deliverable...</p>
      </div>
    );
  }

  const { is_complete, scratchpad_section, scribe_report, tasks_summary, files_changed, totals, goal } = data;
  const hasAnything = Boolean(scratchpad_section || scribe_report || tasks_summary.length > 0);
  const isTerminal = ['done', 'completed', 'paused', 'error', 'cancelled'].includes(teamStatus);

  return (
    <div className="h-full overflow-y-auto">
      {/* Banner */}
      <div
        style={{
          padding: '14px 18px',
          borderBottom: `1px solid ${is_complete ? 'rgba(76, 195, 138, 0.3)' : 'var(--line, rgba(255,255,255,0.08))'}`,
          background: is_complete ? 'rgba(76, 195, 138, 0.05)' : 'var(--ink-2, #131319)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flexShrink: 0, marginTop: 4 }}>
            {is_complete
              ? <CheckCircle2 style={{ width: 18, height: 18, color: 'var(--green, #4CC38A)' }} />
              : teamStatus === 'running' || teamStatus === 'planning'
                ? <Loader2 style={{ width: 18, height: 18, color: 'var(--amber, #E8A23B)', animation: 'spin 1s linear infinite' }} />
                : <FileText style={{ width: 18, height: 18, color: 'var(--mist, rgba(255,255,255,0.5))' }} />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
                {is_complete ? 'Complete · shipped' : 'In progress'}
              </div>
            </div>
            <h3 style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.015em', marginTop: 2, marginBottom: 0, color: is_complete ? 'var(--green, #4CC38A)' : 'var(--white, #fff)' }}>
              {is_complete ? 'Mission complete' : 'Deliverable — work in progress'}
            </h3>
            <div style={{ display: 'flex', gap: 12, marginTop: 4, fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              <span><span style={{ color: 'var(--white, #fff)' }}>{totals.done}</span>/{totals.total} tasks</span>
              {totals.in_progress > 0 && <span style={{ color: 'var(--amber, #E8A23B)' }}>{totals.in_progress} in progress</span>}
              {totals.pending > 0 && <span>{totals.pending} pending</span>}
            </div>
            {goal && (
              <p style={{ fontSize: 12, color: 'var(--fog, rgba(255,255,255,0.78))', marginTop: 8, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                <span style={{ ...({ fontFamily: 'var(--font-mono, ui-monospace)' as any }), fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))', marginRight: 6 }}>Mission</span>
                {goal}
              </p>
            )}
          </div>
          <div style={{ flexShrink: 0, display: 'flex', gap: 6 }}>
            {onJumpToArchitect && (
              <button
                onClick={onJumpToArchitect}
                data-fusio
                className="card-btn"
                style={{ fontSize: 11, padding: '6px 12px' }}
              >
                Talk to architect
              </button>
            )}
            {(is_complete || isTerminal) && (
              <button
                onClick={() => setRevisionOpen(v => !v)}
                data-fusio
                className="card-btn"
                style={{
                  fontSize: 11, padding: '6px 12px',
                  background: 'rgba(232, 162, 59, 0.12)',
                  color: 'var(--amber, #E8A23B)',
                  borderColor: 'rgba(232, 162, 59, 0.4)',
                  fontWeight: 600,
                }}
              >
                <Sparkles style={{ width: 11, height: 11, display: 'inline-block', marginRight: 4 }} /> Request revision
              </button>
            )}
            {(totals.in_progress + totals.pending) === 0 && totals.total > 0 && (
              <button
                onClick={() => setShipOpen(true)}
                title="Approve + merge + deploy"
                data-fusio
                className="card-btn primary"
                style={{
                  fontSize: 11, padding: '6px 12px',
                  background: 'var(--green, #4CC38A)',
                  borderColor: 'var(--green, #4CC38A)',
                  color: '#0a1612',
                  fontWeight: 600,
                  boxShadow: '0 0 14px rgba(76, 195, 138, 0.35)',
                }}
              >
                <Rocket style={{ width: 11, height: 11, display: 'inline-block', marginRight: 4 }} /> Ship deliverable
              </button>
            )}
          </div>
        </div>

        {sentOk && (
          <div className="mt-2 text-xs text-terminal-green bg-terminal-green/10 border border-terminal-green/30 rounded px-2 py-1">
            ✓ Revision sent. The architect is being re-triggered.
          </div>
        )}

        {revisionOpen && (
          <div className="mt-3 bg-terminal-bg rounded border border-terminal-amber/40 p-3 space-y-2">
            <div className="text-xs text-terminal-amber font-bold">Request a revision</div>
            <p className="text-[11px] text-terminal-dim leading-relaxed">
              This message goes directly to the architect. They'll spawn new tasks or revise existing work
              to address what you write here. The team will automatically re-open if it's in a terminal state.
            </p>
            <textarea
              value={revisionText}
              onChange={e => setRevisionText(e.target.value)}
              rows={4}
              placeholder="e.g. 'The security audit missed the recipient-share-token flow — have security re-check token rotation.' or 'Also cover the mobile side, not just web.'"
              className="w-full bg-terminal-surface border border-terminal-border rounded p-2 text-sm text-terminal-text resize-none focus:border-terminal-amber/50 focus:outline-none"
            />
            {err && <div className="text-xs text-terminal-red">{err}</div>}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setRevisionOpen(false); setRevisionText(''); setErr(null); }}
                className="px-3 py-1.5 text-xs rounded border border-terminal-border text-terminal-dim hover:text-terminal-text transition"
              >
                Cancel
              </button>
              <button
                onClick={submitRevision}
                disabled={!revisionText.trim() || submitting}
                className="px-3 py-1.5 text-xs rounded bg-terminal-amber/20 border border-terminal-amber/40 text-terminal-amber hover:bg-terminal-amber/30 transition font-bold disabled:opacity-50"
              >
                {submitting ? <Loader2 className="w-3 h-3 inline animate-spin" /> : <Send className="w-3 h-3 inline mr-1" />}
                Send Revision & Reopen Team
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="px-4 py-3 space-y-4">
        {/* Codex cross-model audit — independent second opinion */}
        {(audit || is_complete) && (
          <section className={`rounded border p-3 ${
            audit?.verdict === 'addressed' ? 'border-terminal-green/40 bg-terminal-green/5'
              : audit?.verdict === 'missed' ? 'border-terminal-red/40 bg-terminal-red/5'
              : 'border-terminal-amber/40 bg-terminal-amber/5'
          }`}>
            <div className="flex items-start gap-2 mb-2">
              {audit?.verdict === 'addressed' ? <ShieldCheck className="w-4 h-4 text-terminal-green mt-0.5" />
                : audit?.verdict === 'missed' ? <XCircle className="w-4 h-4 text-terminal-red mt-0.5" />
                : <AlertCircle className="w-4 h-4 text-terminal-amber mt-0.5" />}
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="text-sm font-bold">Codex Cross-Model Audit</h4>
                  {audit && (
                    <>
                      <span className={`text-[10px] px-1.5 rounded uppercase tracking-wider border ${
                        audit.verdict === 'addressed' ? 'text-terminal-green border-terminal-green/40'
                          : audit.verdict === 'missed' ? 'text-terminal-red border-terminal-red/40'
                          : 'text-terminal-amber border-terminal-amber/40'
                      }`}>{audit.verdict}</span>
                      <span className="text-[11px] text-terminal-dim">
                        quality {audit.quality_score}/10 · {(audit.duration_ms / 1000).toFixed(1)}s
                      </span>
                    </>
                  )}
                </div>
                <p className="text-[11px] text-terminal-dim mt-0.5">
                  Independent GPT evaluation of the team's work against your original prompt.
                </p>
              </div>
              <button
                onClick={() => runAudit().catch(e => setErr(e.message))}
                disabled={auditLoading}
                className="px-2 py-1 text-xs rounded border border-terminal-cyan/40 text-terminal-cyan hover:bg-terminal-cyan/10 disabled:opacity-50 flex items-center gap-1"
              >
                {auditLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                {audit ? 'Re-run' : 'Run now'}
              </button>
            </div>

            {auditLoading && !audit && (
              <p className="text-xs text-terminal-dim">Running audit (1–3 min — Codex is reading the deliverable)…</p>
            )}

            {audit && (
              <>
                <p className="text-[12px] text-terminal-text leading-relaxed whitespace-pre-wrap">
                  {audit.summary}
                </p>

                {audit.coverage.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[10px] uppercase tracking-wider text-terminal-dim mb-1">Coverage</div>
                    <ul className="space-y-1">
                      {audit.coverage.map((c, i) => (
                        <li key={i} className="flex items-start gap-2 text-[11px]">
                          <span className={`flex-shrink-0 w-3 text-center ${
                            c.status === 'addressed' ? 'text-terminal-green'
                              : c.status === 'missed' ? 'text-terminal-red'
                              : 'text-terminal-amber'
                          }`}>{c.status === 'addressed' ? '✓' : c.status === 'missed' ? '✗' : '~'}</span>
                          <div className="flex-1">
                            <span className="text-terminal-text">{c.requirement}</span>
                            {c.evidence && (
                              <span className="text-terminal-dim"> — <span className="font-mono">{c.evidence}</span></span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {audit.missing_work.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[10px] uppercase tracking-wider text-terminal-red mb-1">Missing work</div>
                    <ul className="text-[11px] text-terminal-text space-y-0.5">
                      {audit.missing_work.map((m, i) => <li key={i}>• {m}</li>)}
                    </ul>
                  </div>
                )}

                {audit.unrelated_work.length > 0 && (
                  <details className="mt-3">
                    <summary className="text-[10px] uppercase tracking-wider text-terminal-dim cursor-pointer">
                      Unrelated work ({audit.unrelated_work.length})
                    </summary>
                    <ul className="text-[11px] text-terminal-dim space-y-0.5 mt-1">
                      {audit.unrelated_work.map((m, i) => <li key={i}>• {m}</li>)}
                    </ul>
                  </details>
                )}
              </>
            )}

            {!audit && !auditLoading && is_complete && (
              <p className="text-[11px] text-terminal-dim italic">
                No audit yet. Click "Run now" to have GPT independently evaluate what this team delivered against your prompt.
              </p>
            )}
          </section>
        )}

        {!hasAnything && (
          <div className="text-center py-10 text-terminal-dim">
            <FileText className="w-10 h-10 mx-auto opacity-30 mb-2" />
            <p className="text-sm">The scribe hasn't written the final deliverable yet.</p>
            <p className="text-xs mt-1">This will populate when the scribe completes their task.</p>
          </div>
        )}

        {/* Scratchpad Final Deliverable section (primary) */}
        {scratchpad_section && (
          <section className="rounded border border-terminal-green/30 bg-terminal-green/5 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-terminal-green" />
              <h4 className="text-sm font-bold text-terminal-green">Final Deliverable (from scribe)</h4>
            </div>
            <pre className="whitespace-pre-wrap text-[12px] leading-relaxed text-terminal-text font-mono">
              {scratchpad_section}
            </pre>
          </section>
        )}

        {/* Scribe task summary (if scratchpad empty but scribe ran) */}
        {!scratchpad_section && scribe_report && (
          <section className="rounded border border-terminal-border bg-terminal-surface/30 p-3">
            <div className="flex items-center gap-2 mb-1">
              <span>{ROLE_GLYPHS.scribe}</span>
              <h4 className="text-sm font-bold text-terminal-text">{scribe_report.title}</h4>
              <span className="text-[10px] text-terminal-dim">{fmtTime(scribe_report.completed_at)}</span>
            </div>
            {scribe_report.summary ? (
              <pre className="whitespace-pre-wrap text-[12px] leading-relaxed text-terminal-dim font-mono">
                {scribe_report.summary}
              </pre>
            ) : (
              <p className="text-xs text-terminal-dim italic">Scribe didn't produce a summary.</p>
            )}
          </section>
        )}

        {/* Files changed */}
        {files_changed.length > 0 && (
          <section className="rounded border border-terminal-border bg-terminal-surface/30 p-3">
            <div className="flex items-center gap-2 mb-2">
              <GitBranch className="w-3.5 h-3.5 text-terminal-cyan" />
              <h4 className="text-xs uppercase tracking-wider text-terminal-dim">
                Files Changed ({files_changed.length})
              </h4>
            </div>
            <ul className="text-[11px] font-mono text-terminal-cyan space-y-0.5 max-h-48 overflow-y-auto">
              {files_changed.map(f => (
                <li key={f} className="truncate" title={f}>{f}</li>
              ))}
            </ul>
          </section>
        )}

        {/* Completed tasks breakdown */}
        {tasks_summary.length > 0 && (
          <section className="rounded border border-terminal-border bg-terminal-surface/30 p-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs uppercase tracking-wider text-terminal-dim">
                Completed Tasks ({tasks_summary.length})
              </h4>
            </div>
            <div className="space-y-2">
              {tasks_summary.map(t => (
                <details key={t.id} className="rounded bg-terminal-bg border border-terminal-border">
                  <summary className="px-2 py-1.5 cursor-pointer flex items-center gap-2 text-xs hover:bg-terminal-surface/50">
                    <span>{ROLE_GLYPHS[t.role_hint || ''] || '·'}</span>
                    <span className="text-terminal-text flex-1 truncate">{t.title}</span>
                    {t.diff_numstat && <span className="text-terminal-green text-[10px]">{t.diff_numstat}</span>}
                    <span className="text-terminal-dim text-[10px]">{fmtTime(t.completed_at)}</span>
                  </summary>
                  {t.summary && (
                    <div className="px-3 py-2 border-t border-terminal-border text-[11px] text-terminal-dim font-mono whitespace-pre-wrap leading-relaxed">
                      {t.summary}
                    </div>
                  )}
                </details>
              ))}
            </div>
          </section>
        )}
      </div>

      <ShipModal
        teamId={teamId}
        open={shipOpen}
        onClose={() => setShipOpen(false)}
        onShipped={() => onRefresh?.()}
      />
    </div>
  );
}
