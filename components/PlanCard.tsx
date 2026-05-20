/**
 * PlanCard — synthesized pair plan rendered inline in chat. Shows what Claude
 * and Codex agreed/disagreed on and gives the user a hard gate before any
 * code is written.
 *
 * For Pair-Build mode: clicking Approve re-sends a follow-up POST to
 * /api/chat/pair with mode='pair-build-execute' and the approved plan.
 * Claude then writes the diff and Codex reviews it.
 *
 * Markup uses the AI Fusio design's `.card.plan` / `.card.autopilot`
 * classes from /fusio/mc.css so styling is pixel-faithful to the design.
 */

'use client';

import React from 'react';

export interface PlanCardPhase {
  index: number;
  name: string;
  spec: string;
  exit_criteria: string[];
  expected_files?: string[];
}

export interface PlanCardData {
  goal: string;
  approach: string;
  claude_points: string[];
  codex_points: string[];
  resolution: string;
  open_questions: string[];
  signed_off: { claude: boolean; codex: boolean };
  protocol: 'consult' | 'debate' | 'pair-build' | 'autopilot';
  /** Phased plan — when present, Approve runs autopilot end-to-end. */
  phases?: PlanCardPhase[];
  rework_cap?: number;
}

interface Props {
  card: PlanCardData;
  /** Whether to show the Approve button (pair-build OR autopilot with phases). */
  approvable?: boolean;
  onApprove?: () => void;
  onSendBack?: (note: string) => void;
  /** Once approved/sent-back, lock the card. */
  locked?: boolean;
  lockedLabel?: string;
}

// Sub-section used for Claude points / Codex points / Open Questions.
function Section({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--mist, rgba(255,255,255,0.5))',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <ul style={{ margin: 0, padding: '0 0 0 18px', listStyle: 'disc', color: 'var(--fog, rgba(255,255,255,0.78))', fontSize: 13.5, lineHeight: 1.55 }}>
        {items.map((it, i) => <li key={i} style={{ marginBottom: 3 }}>{it}</li>)}
      </ul>
    </div>
  );
}

export default function PlanCard({ card, approvable, onApprove, onSendBack, locked, lockedLabel }: Props) {
  const [feedback, setFeedback] = React.useState('');
  const [showFeedback, setShowFeedback] = React.useState(false);

  // Autopilot phases get the .autopilot card variant; everything else uses .plan.
  const variant = card.phases && card.phases.length > 0 ? 'autopilot' : 'plan';
  const headLabel = variant === 'autopilot' ? 'Autopilot plan' : 'Pair plan';

  return (
    <div className={`card ${variant}`}>
      {/* Card head — uppercase eyebrow with sign-off chips */}
      <div className="card-head" style={{ justifyContent: 'space-between' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <span className="pip" />
          <span>{headLabel} · {card.protocol}</span>
        </span>
        <span style={{ display: 'inline-flex', gap: 12, fontFamily: 'var(--font-mono)', fontSize: 10 }}>
          <span style={{ color: card.signed_off.claude ? 'var(--green, #4CC38A)' : 'var(--dim, rgba(255,255,255,0.32))' }}>
            Claude · {card.signed_off.claude ? 'signed' : 'pending'}
          </span>
          <span style={{ color: card.signed_off.codex ? 'var(--amber, #E8A23B)' : 'var(--dim, rgba(255,255,255,0.32))' }}>
            Codex · {card.signed_off.codex ? 'signed' : 'pending'}
          </span>
        </span>
      </div>

      {/* Title = goal */}
      {card.goal && <div className="card-title">{card.goal}</div>}

      {/* Body = approach */}
      {card.approach && (
        <div className="card-body" style={{ whiteSpace: 'pre-wrap' }}>
          {card.approach}
        </div>
      )}

      <Section label="Claude points" items={card.claude_points} />
      <Section label="Codex points" items={card.codex_points} />

      {card.resolution && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--mist, rgba(255,255,255,0.5))',
              marginBottom: 6,
            }}
          >
            Resolution
          </div>
          <div className="card-body" style={{ whiteSpace: 'pre-wrap' }}>
            {card.resolution}
          </div>
        </div>
      )}

      <Section label="Open questions" items={card.open_questions} />

      {/* Phases (autopilot) — design's .card-steps + .step pattern */}
      {card.phases && card.phases.length > 0 && (
        <>
          <div style={{
            marginTop: 14,
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--mist, rgba(255,255,255,0.5))',
            marginBottom: 6,
          }}>
            {card.phases.length} phase{card.phases.length === 1 ? '' : 's'}{card.rework_cap ? ` · rework cap ${card.rework_cap}` : ''}
          </div>
          <div className="card-steps">
            {card.phases.map(p => (
              <div className="step" key={p.index}>
                <span className="num">{String(p.index).padStart(2, '0')}</span>
                <span className="text">{p.name}{p.spec ? <span style={{ color: 'var(--mist, rgba(255,255,255,0.5))' }}>{' — '}{p.spec}</span> : null}</span>
                {p.expected_files && p.expected_files.length > 0 && (
                  <span className="tag" title={p.expected_files.join(', ')}>{p.expected_files.length} file{p.expected_files.length === 1 ? '' : 's'}</span>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Actions row */}
      {locked ? (
        <div style={{ marginTop: 14, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green, #4CC38A)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>✓</span>
          <span>{lockedLabel || 'Plan locked'}</span>
        </div>
      ) : approvable ? (
        <>
          <div className="card-actions">
            <button
              type="button"
              onClick={() => onApprove?.()}
              className="card-btn primary"
            >
              {variant === 'autopilot'
                ? `Approve · run autopilot (${card.phases!.length} phase${card.phases!.length === 1 ? '' : 's'})`
                : 'Approve & build'}
            </button>
            <button
              type="button"
              onClick={() => setShowFeedback(s => !s)}
              className="card-btn"
            >
              Send back
            </button>
          </div>

          {showFeedback && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <textarea
                value={feedback}
                onChange={e => setFeedback(e.target.value)}
                placeholder="What should they reconsider?"
                rows={2}
                style={{
                  width: '100%',
                  background: 'var(--ink-3, #1B1B23)',
                  border: '1px solid var(--line, rgba(255,255,255,0.08))',
                  borderRadius: 8,
                  padding: '10px 12px',
                  color: 'var(--white, #FFFFFF)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  outline: 'none',
                  resize: 'vertical',
                }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  disabled={!feedback.trim()}
                  onClick={() => { onSendBack?.(feedback.trim()); setShowFeedback(false); setFeedback(''); }}
                  className="card-btn primary"
                  style={{ opacity: feedback.trim() ? 1 : 0.4 }}
                >
                  Send revision
                </button>
                <button
                  type="button"
                  onClick={() => { setShowFeedback(false); setFeedback(''); }}
                  className="card-btn"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
