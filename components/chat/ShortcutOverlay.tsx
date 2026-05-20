/**
 * ShortcutOverlay — triggered by `?`. Two columns: keyboard shortcuts and
 * slash commands. Escape or click-outside closes. Re-skinned for AI Fusio.
 */
'use client';
import { useEffect } from 'react';
import { X, Keyboard, Slash } from 'lucide-react';

export interface ShortcutOverlayProps {
  open: boolean;
  onClose: () => void;
}

const shortcuts: Array<{ keys: string; hint: string }> = [
  { keys: 'Enter', hint: 'send message' },
  { keys: '⇧ Enter', hint: 'newline' },
  { keys: '⌘/Ctrl + F', hint: 'search this thread' },
  { keys: '?', hint: 'this overlay' },
  { keys: 'Esc', hint: 'close overlay / cancel edit' },
];

const slashCommands: Array<{ cmd: string; hint: string }> = [
  { cmd: '/opus', hint: 'one turn: Opus 4.7 (200K ctx)' },
  { cmd: '/opus1m', hint: 'one turn: Opus 4.7 · 1M context' },
  { cmd: '/sonnet', hint: 'one turn: Sonnet 4.6' },
  { cmd: '/haiku', hint: 'one turn: Haiku 4.5' },
  { cmd: '/quick', hint: 'lean mode: Haiku + no long-term recall' },
  { cmd: '/work', hint: 'default mode' },
  { cmd: '/constellation', hint: 'constellation team mode' },
];

const eyebrow: React.CSSProperties = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 10,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--mist, rgba(255,255,255,0.5))',
};

export function ShortcutOverlay({ open, onClose }: ShortcutOverlayProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.72)',
        backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 560,
          background: 'var(--ink, #0A0A0E)',
          border: '1px solid var(--line, rgba(255,255,255,0.08))',
          borderRadius: 12,
          boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
          fontFamily: 'var(--font-sans, system-ui)',
          color: 'var(--white, #fff)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 18px',
            borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
            background: 'var(--ink-2, #131319)',
          }}
        >
          <div>
            <div style={eyebrow}>Help · Reference</div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 15, fontWeight: 600, letterSpacing: '-0.015em', marginTop: 1 }}>
              Shortcuts
            </div>
          </div>
          <button
            onClick={onClose}
            data-fusio
            style={{
              padding: 5, borderRadius: 5,
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--mist, rgba(255,255,255,0.5))',
              transition: 'all 120ms ease-out',
            }}
            onMouseEnter={e => {
              const el = e.currentTarget as HTMLElement;
              el.style.background = 'rgba(204, 12, 32, 0.12)';
              el.style.color = 'var(--red, #CC0C20)';
            }}
            onMouseLeave={e => {
              const el = e.currentTarget as HTMLElement;
              el.style.background = 'transparent';
              el.style.color = 'var(--mist, rgba(255,255,255,0.5))';
            }}
          >
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>

        <div
          className="grid grid-cols-1 md:grid-cols-2"
          style={{ gap: 0 }}
        >
          <div
            style={{
              padding: 18,
              borderRight: '1px solid var(--line, rgba(255,255,255,0.08))',
            }}
          >
            <div style={{ ...eyebrow, display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
              <Keyboard style={{ width: 11, height: 11, color: 'var(--cyan, #5EC4D9)' }} />
              Keyboard
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {shortcuts.map(s => (
                <li key={s.keys} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <kbd
                    style={{
                      padding: '2px 7px',
                      fontSize: 10.5,
                      background: 'var(--ink-3, #1B1B23)',
                      border: '1px solid var(--line, rgba(255,255,255,0.08))',
                      borderRadius: 4,
                      fontFamily: 'var(--font-mono, ui-monospace)',
                      color: 'var(--white, #fff)',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {s.keys}
                  </kbd>
                  <span style={{ color: 'var(--mist, rgba(255,255,255,0.5))', fontSize: 12.5, textAlign: 'right' }}>
                    {s.hint}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div style={{ padding: 18 }}>
            <div style={{ ...eyebrow, display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
              <Slash style={{ width: 11, height: 11, color: 'var(--red, #CC0C20)' }} />
              Slash commands
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {slashCommands.map(s => (
                <li key={s.cmd} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <code
                    style={{
                      padding: '2px 7px',
                      fontSize: 10.5,
                      background: 'var(--ink-3, #1B1B23)',
                      border: '1px solid var(--line, rgba(255,255,255,0.08))',
                      borderRadius: 4,
                      fontFamily: 'var(--font-mono, ui-monospace)',
                      color: 'var(--cyan, #5EC4D9)',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {s.cmd}
                  </code>
                  <span style={{ color: 'var(--mist, rgba(255,255,255,0.5))', fontSize: 12.5, textAlign: 'right' }}>
                    {s.hint}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div
          style={{
            padding: '8px 18px',
            borderTop: '1px solid var(--line, rgba(255,255,255,0.08))',
            background: 'var(--ink-2, #131319)',
            ...eyebrow,
            color: 'var(--dim, rgba(255,255,255,0.32))',
            letterSpacing: '0.08em',
          }}
        >
          Swipe-left on a message · Branch &nbsp;·&nbsp; Swipe-right · Copy
        </div>
      </div>
    </div>
  );
}
