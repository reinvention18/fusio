/**
 * PairModeChip — header control for switching the chat between Solo and the
 * three pair-mode protocols (Consult, Debate, Pair-Build).
 *
 * Mode is settable mid-conversation: each user message uses whichever mode is
 * active at send time. Switching does not interrupt an in-flight stream.
 */

'use client';

import React, { useState, useRef, useEffect } from 'react';

export type PairMode = 'solo' | 'consult' | 'debate' | 'pair-build' | 'autopilot';

interface ModeMeta {
  id: PairMode;
  label: string;
  glyph: string;
  blurb: string;
}

const MODES: ModeMeta[] = [
  { id: 'solo',       label: 'Solo',       glyph: '🐸',   blurb: 'Claude only. Default.' },
  { id: 'consult',    label: 'Consult',    glyph: '🐸·⚡', blurb: 'Claude drafts, Codex critiques, Claude finalizes.' },
  { id: 'debate',     label: 'Debate',     glyph: '🐸⇆⚡', blurb: 'Both produce positions, then synthesized into a Plan Card.' },
  { id: 'pair-build', label: 'Pair-Build', glyph: '🐸+⚡', blurb: 'Plan A + Plan B → synth → Plan Card → Claude codes → Codex reviews → patch.' },
  { id: 'autopilot',  label: 'Autopilot',  glyph: '🚦',    blurb: 'Phased plan executed end-to-end. Codex audits each phase and pushes Claude through gaps. Stops only for questions only you can answer.' },
];

interface Props {
  mode: PairMode;
  onChange: (m: PairMode) => void;
  disabled?: boolean;
  /** Compact look for mobile/limited space. */
  compact?: boolean;
}

export default function PairModeChip({ mode, onChange, disabled, compact }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const current = MODES.find(m => m.id === mode) || MODES[0];
  const isPair = mode !== 'solo';

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        title={current.blurb}
        data-fusio
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 10px',
          fontFamily: 'var(--font-mono, ui-monospace)',
          fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
          borderRadius: 99,
          background: isPair ? 'rgba(232, 162, 59, 0.12)' : 'var(--ink-3, #1B1B23)',
          color: isPair ? 'var(--amber, #E8A23B)' : 'var(--fog, rgba(255,255,255,0.78))',
          border: `1px solid ${isPair ? 'rgba(232, 162, 59, 0.45)' : 'var(--line, rgba(255,255,255,0.08))'}`,
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
          transition: 'all 120ms ease-out',
        }}
        onMouseEnter={e => {
          if (disabled) return;
          (e.currentTarget as HTMLElement).style.filter = 'brightness(1.12)';
        }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.filter = 'brightness(1)'; }}
      >
        <span style={{ fontSize: 13, lineHeight: 1 }}>{current.glyph}</span>
        {!compact && <span>{current.label}</span>}
        <span style={{ opacity: 0.6, fontSize: 9 }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            marginTop: 6,
            zIndex: 50,
            width: 288,
            background: 'var(--ink, #0A0A0E)',
            border: '1px solid var(--line, rgba(255,255,255,0.08))',
            borderRadius: 12,
            boxShadow: '0 12px 32px rgba(0,0,0,0.6)',
            padding: 6,
            fontFamily: 'var(--font-sans, system-ui)',
          }}
        >
          {MODES.map(m => {
            const isCurrent = m.id === mode;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => { onChange(m.id); setOpen(false); }}
                data-fusio
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  background: isCurrent ? 'rgba(232, 162, 59, 0.12)' : 'transparent',
                  border: `1px solid ${isCurrent ? 'rgba(232, 162, 59, 0.4)' : 'transparent'}`,
                  cursor: 'pointer',
                  transition: 'background 120ms ease-out',
                }}
                onMouseEnter={e => { if (!isCurrent) (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; }}
                onMouseLeave={e => { if (!isCurrent) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <span style={{ fontSize: 16, lineHeight: 1, marginTop: 2, width: 48, flexShrink: 0 }}>{m.glyph}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--white, #fff)' }}>
                    {m.label}
                  </span>
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--mist, rgba(255,255,255,0.5))', marginTop: 2, lineHeight: 1.45 }}>
                    {m.blurb}
                  </span>
                </span>
                {isCurrent && (
                  <span style={{ color: 'var(--amber, #E8A23B)', fontSize: 12, marginTop: 4 }}>✓</span>
                )}
              </button>
            );
          })}
          <div
            style={{
              borderTop: '1px solid var(--line, rgba(255,255,255,0.08))',
              marginTop: 6,
              paddingTop: 6,
              padding: '6px 10px 4px',
              fontFamily: 'var(--font-mono, ui-monospace)',
              fontSize: 9.5,
              letterSpacing: '0.08em',
              color: 'var(--dim, rgba(255,255,255,0.32))',
              lineHeight: 1.45,
            }}
          >
            Switch any time · mode applies to your next message · Codex reviews/proposes, Claude writes the code.
          </div>
        </div>
      )}
    </div>
  );
}
