/**
 * CodexQuestionCard — rendered inline when an Autopilot run pauses on a Codex
 * question. The user types one answer, hits Send, and the orchestrator
 * resumes from the same phase.
 *
 * Markup uses the AI Fusio `.card.approval` design class from
 * /fusio/mc.css (amber accent for pause/awaiting-input semantics).
 */

'use client';

import React from 'react';

interface Props {
  phaseIndex: number;
  question: string;
  auditSummary?: string;
  onAnswer: (answer: string) => void;
  /** Once answered, lock the card visually. */
  locked?: boolean;
}

export default function CodexQuestionCard({ phaseIndex, question, auditSummary, onAnswer, locked }: Props) {
  const [val, setVal] = React.useState('');
  const submit = () => {
    if (locked || !val.trim()) return;
    onAnswer(val.trim());
  };

  return (
    <div className="card approval">
      <div className="card-head" style={{ justifyContent: 'space-between' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <span className="pip" />
          <span>Autopilot paused · Codex needs your input</span>
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--mist, rgba(255,255,255,0.5))' }}>
          Phase {String(phaseIndex).padStart(2, '0')}
        </span>
      </div>

      <div style={{ marginTop: 4 }}>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--amber, #E8A23B)',
            marginBottom: 6,
          }}
        >
          Question
        </div>
        <div className="card-body" style={{ whiteSpace: 'pre-wrap' }}>{question}</div>
      </div>

      {auditSummary && (
        <div
          style={{
            marginTop: 10,
            fontSize: 12,
            color: 'var(--mist, rgba(255,255,255,0.5))',
            fontStyle: 'italic',
          }}
        >
          {auditSummary}
        </div>
      )}

      {locked ? (
        <div style={{ marginTop: 12, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green, #4CC38A)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>✓</span><span>Answered — autopilot resumed.</span>
        </div>
      ) : (
        <>
          <textarea
            value={val}
            onChange={e => setVal(e.target.value)}
            placeholder="Your answer — autopilot will resume from this phase…"
            rows={3}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
            style={{
              marginTop: 12,
              width: '100%',
              background: 'var(--ink-3, #1B1B23)',
              border: '1px solid var(--line, rgba(255,255,255,0.08))',
              borderRadius: 8,
              padding: '10px 12px',
              color: 'var(--white, #fff)',
              fontFamily: 'var(--font-sans)',
              fontSize: 13,
              outline: 'none',
              resize: 'vertical',
            }}
          />
          <div className="card-actions">
            <button
              type="button"
              disabled={!val.trim()}
              onClick={submit}
              className="card-btn primary"
              style={{
                opacity: val.trim() ? 1 : 0.4,
                background: 'var(--amber, #E8A23B)',
                borderColor: 'var(--amber, #E8A23B)',
                color: '#1a1410',
              }}
            >
              Answer · resume autopilot
            </button>
            <span style={{ alignSelf: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              ⌘/Ctrl + Enter
            </span>
          </div>
        </>
      )}
    </div>
  );
}
