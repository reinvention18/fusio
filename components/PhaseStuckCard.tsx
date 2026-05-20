/**
 * PhaseStuckCard — rendered when an Autopilot phase exhausted its rework cap.
 * Surfaces three options to the user:
 *   1. Retry the phase with a bumped cap (resume from same attempt count)
 *   2. Skip ahead to the next phase (treat the current as accepted)
 *   3. Edit/fix manually outside the chat, then continue from next phase
 *
 * Markup uses the AI Fusio design's `.card.phase-stuck` class from
 * /fusio/mc.css. Functionality (bump-and-retry, skip, locked state) is
 * unchanged.
 */

'use client';

import React from 'react';

interface Props {
  phaseIndex: number;
  phaseName: string;
  totalPhases: number;
  attemptsUsed: number;
  reworkCap: number;
  lastConcerns: string[];
  /** Bump cap by this many and retry this phase. Resumes audit history. */
  onRetryWithBumpedCap: (additionalAttempts: number) => void;
  /** Skip this phase as if accepted, advance to next phase. */
  onSkipToNextPhase: () => void;
  /** Once an action has been taken, lock the card. */
  locked?: boolean;
  lockedLabel?: string;
}

export default function PhaseStuckCard({
  phaseIndex, phaseName, totalPhases, attemptsUsed, reworkCap, lastConcerns,
  onRetryWithBumpedCap, onSkipToNextPhase, locked, lockedLabel,
}: Props) {
  const [bump, setBump] = React.useState(3);
  const isLastPhase = phaseIndex >= totalPhases;

  return (
    <div className="card phase-stuck">
      {/* Head — uppercase eyebrow with pulsing red pip, phase counter, attempt usage */}
      <div className="card-head" style={{ justifyContent: 'space-between' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <span className="pip" />
          <span>Phase stuck · exceeded rework cap</span>
        </span>
        <span style={{ display: 'inline-flex', gap: 10, fontFamily: 'var(--font-mono)', fontSize: 10 }}>
          <span style={{ color: 'var(--mist, rgba(255,255,255,0.5))' }}>
            Phase {String(phaseIndex).padStart(2, '0')}/{String(totalPhases).padStart(2, '0')}
          </span>
          <span style={{ color: 'var(--mist, rgba(255,255,255,0.5))' }}>
            {attemptsUsed} of {reworkCap} used
          </span>
        </span>
      </div>

      {/* Title = phase name */}
      <div className="card-title">{phaseName}</div>

      {/* Body — explanation of what happened */}
      <div className="card-body">
        Codex kept finding real issues. Claude made progress on each attempt but the cap of {reworkCap} was reached before the phase passed audit.
      </div>

      {/* Last concerns Codex flagged — sub-section */}
      {lastConcerns.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--red, #CC0C20)',
              marginBottom: 6,
            }}
          >
            Last concerns Codex flagged
          </div>
          <ul style={{ margin: 0, padding: '0 0 0 18px', listStyle: 'disc', color: 'var(--fog, rgba(255,255,255,0.78))', fontSize: 13.5, lineHeight: 1.55 }}>
            {lastConcerns.slice(0, 6).map((c, i) => (
              <li key={i} style={{ marginBottom: 3 }}>{c}</li>
            ))}
            {lastConcerns.length > 6 && (
              <li style={{ color: 'var(--dim, rgba(255,255,255,0.32))', fontStyle: 'italic' }}>
                …and {lastConcerns.length - 6} more
              </li>
            )}
          </ul>
        </div>
      )}

      {/* Actions */}
      {locked ? (
        <div style={{ marginTop: 14, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green, #4CC38A)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>✓</span>
          <span>{lockedLabel || 'Action taken — autopilot continuing.'}</span>
        </div>
      ) : (
        <>
          {/* Retry row: bump input + retry button */}
          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--mist, rgba(255,255,255,0.5))',
              }}
            >
              Bump cap by
            </label>
            <input
              type="number"
              min={1}
              max={20}
              value={bump}
              onChange={e => setBump(Math.max(1, Math.min(20, parseInt(e.target.value || '3', 10))))}
              style={{
                width: 64,
                background: 'var(--ink-3, #1B1B23)',
                border: '1px solid var(--line, rgba(255,255,255,0.08))',
                borderRadius: 6,
                padding: '6px 10px',
                color: 'var(--white, #FFFFFF)',
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={() => onRetryWithBumpedCap(bump)}
              className="card-btn primary"
            >
              ↻ Retry phase · {attemptsUsed + bump} total attempts
            </button>
          </div>

          {/* Skip / accept row */}
          <div className="card-actions">
            <button
              type="button"
              onClick={onSkipToNextPhase}
              className="card-btn"
            >
              {isLastPhase ? 'Accept phase & end mission' : `Skip to Phase ${String(phaseIndex + 1).padStart(2, '0')}`}
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--mist, rgba(255,255,255,0.5))', marginTop: 4 }}>
            {isLastPhase
              ? 'Marks this final phase as accepted (with whatever criteria are disputed) and ends the mission.'
              : 'Marks this phase as accepted; resume from the next phase.'}
          </div>

          {/* When-to-use hint */}
          <div
            style={{
              marginTop: 12,
              paddingTop: 10,
              borderTop: '1px solid var(--line, rgba(255,255,255,0.08))',
              fontSize: 11,
              color: 'var(--mist, rgba(255,255,255,0.5))',
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fog, rgba(255,255,255,0.78))', marginBottom: 4 }}>
              When to use which
            </div>
            <ul style={{ margin: 0, padding: '0 0 0 18px', listStyle: 'disc' }}>
              <li><strong style={{ color: 'var(--white, #FFFFFF)' }}>Retry</strong> — if the cap was just too tight and Claude was making real progress.</li>
              <li><strong style={{ color: 'var(--white, #FFFFFF)' }}>{isLastPhase ? 'Accept' : 'Skip'}</strong> — if Codex is demanding something literally impossible (math error, contradictory criteria) and Claude has marked it as disputed.</li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
