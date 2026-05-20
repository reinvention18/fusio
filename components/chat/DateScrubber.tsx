/**
 * DateScrubber — left-margin mini-timeline for long chats.
 * Shows one tick per active day. Click a tick to jump Virtuoso to the first
 * message of that day. Silent for chats under ~100 messages.
 */
'use client';
import { memo, useMemo } from 'react';

export interface DateScrubberMessage {
  id: string;
  timestamp: Date | string;
}
export interface DateScrubberProps {
  messages: DateScrubberMessage[];
  onJump: (index: number) => void;
}

function dayKey(ts: Date | string): string {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function Impl(p: DateScrubberProps) {
  const ticks = useMemo(() => {
    const seen = new Map<string, { label: string; index: number; date: Date }>();
    for (let i = 0; i < p.messages.length; i++) {
      const m = p.messages[i];
      const d = typeof m.timestamp === 'string' ? new Date(m.timestamp) : m.timestamp;
      if (!(d instanceof Date) || isNaN(d.getTime())) continue;
      const key = dayKey(d);
      if (!seen.has(key)) {
        seen.set(key, {
          label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
          index: i,
          date: d,
        });
      }
    }
    return [...seen.values()];
  }, [p.messages]);

  if (p.messages.length < 100 || ticks.length < 3) return null;

  return (
    <div
      className="hidden md:flex"
      style={{
        position: 'absolute', left: 0, top: 8, bottom: 8, width: 40,
        flexDirection: 'column', alignItems: 'center', gap: 4,
        pointerEvents: 'none',
        zIndex: 10,
        opacity: 0.7,
        transition: 'opacity 120ms ease-out',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '0.7'; }}
    >
      <div
        className="no-scrollbar"
        style={{
          pointerEvents: 'auto',
          background: 'rgba(10, 10, 14, 0.85)',
          backdropFilter: 'blur(8px)',
          padding: '4px 4px',
          borderRadius: 8,
          border: '1px solid var(--line, rgba(255,255,255,0.08))',
          display: 'flex', flexDirection: 'column', gap: 2,
          maxHeight: '100%',
          overflowY: 'auto',
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        }}
      >
        {ticks.map((t, i) => (
          <button
            key={i}
            onClick={() => p.onJump(t.index)}
            data-fusio
            title={t.date.toLocaleString()}
            style={{
              padding: '2px 6px',
              fontFamily: 'var(--font-mono, ui-monospace)',
              fontSize: 9,
              letterSpacing: '0.08em',
              color: 'var(--mist, rgba(255,255,255,0.5))',
              background: 'transparent',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'all 120ms ease-out',
            }}
            onMouseEnter={e => {
              const el = e.currentTarget as HTMLElement;
              el.style.color = 'var(--cyan, #5EC4D9)';
              el.style.background = 'var(--ink-2, #131319)';
            }}
            onMouseLeave={e => {
              const el = e.currentTarget as HTMLElement;
              el.style.color = 'var(--mist, rgba(255,255,255,0.5))';
              el.style.background = 'transparent';
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export const DateScrubber = memo(Impl);
