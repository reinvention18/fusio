'use client';

/**
 * TopNavDropdown — click-to-open category menu for the top nav.
 * Keeps the 18 tabs navigable without a huge horizontal scroll bar.
 */

import { useEffect, useRef, useState } from 'react';

export interface NavItem {
  id: string;
  label: string;
}

interface Props<T extends string> {
  label: string;
  items: NavItem[];
  activeId: T;
  onSelect: (id: T) => void;
}

export function TopNavDropdown<T extends string>({ label, items, activeId, onSelect }: Props<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const activeInside = items.some(i => i.id === activeId);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        data-fusio
        style={{
          padding: '8px 16px',
          fontFamily: 'var(--font-mono, ui-monospace)',
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          background: activeInside ? 'rgba(204, 12, 32, 0.1)' : 'transparent',
          color: activeInside ? 'var(--red, #CC0C20)' : 'var(--mist, rgba(255,255,255,0.5))',
          border: 'none',
          borderBottom: `2px solid ${activeInside ? 'var(--red, #CC0C20)' : 'transparent'}`,
          whiteSpace: 'nowrap',
          cursor: 'pointer',
          transition: 'all 120ms ease-out',
        }}
        onMouseEnter={e => {
          if (!activeInside) {
            (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)';
            (e.currentTarget as HTMLElement).style.borderBottomColor = 'rgba(204, 12, 32, 0.3)';
          }
        }}
        onMouseLeave={e => {
          if (!activeInside) {
            (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))';
            (e.currentTarget as HTMLElement).style.borderBottomColor = 'transparent';
          }
        }}
      >
        {label} <span style={{ opacity: 0.6, marginLeft: 2 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            marginTop: 4,
            minWidth: 200,
            background: 'var(--ink, #0A0A0E)',
            border: '1px solid var(--line, rgba(255,255,255,0.08))',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            zIndex: 50,
            padding: '4px 0',
            fontFamily: 'var(--font-sans, system-ui)',
          }}
        >
          {items.map(it => {
            const isActive = activeId === it.id;
            return (
              <button
                key={it.id}
                onClick={() => { onSelect(it.id as T); setOpen(false); }}
                data-fusio
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 14px',
                  fontSize: 12.5,
                  whiteSpace: 'nowrap',
                  background: isActive ? 'rgba(204, 12, 32, 0.1)' : 'transparent',
                  color: isActive ? 'var(--red, #CC0C20)' : 'var(--white, #fff)',
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'background 120ms ease-out',
                }}
                onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; }}
                onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default TopNavDropdown;
