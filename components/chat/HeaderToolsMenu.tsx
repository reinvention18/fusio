/**
 * HeaderToolsMenu — consolidates the chat-header action surface into a
 * single rich dropdown. Each item can render a badge, sub-label, or a
 * fully custom body (e.g. embedded select, segmented control).
 *
 * Parent keeps state/handlers; this component is a pure view shell with
 * click-outside + Escape to close.
 */
'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface ToolMenuItem {
  id: string;
  label: string;
  /** One-click action. Ignored when `render` is provided. */
  onClick?: () => void;
  /** Custom full-row renderer (e.g. inline select). Takes priority over the default layout. */
  render?: () => React.ReactNode;
  /** Small description shown beneath the label. */
  subLabel?: string;
  /** Content rendered right-aligned next to the label (badge, count, chevron). */
  rightSlot?: React.ReactNode;
  /** Leading icon (w-4 h-4). */
  icon?: React.ReactNode;
  /** Indicator dot color (e.g. 'bg-terminal-green'). */
  dotColor?: string;
  /** Muted style. */
  disabled?: boolean;
  /** Red hover (for destructive actions). */
  danger?: boolean;
  /** Don't close the menu on click. Useful for items that spawn an overlay
   *  the user still needs the menu visible for, or that are toggles. */
  keepOpen?: boolean;
}
export interface ToolMenuSection {
  title: string;
  items: ToolMenuItem[];
}

export interface HeaderToolsMenuProps {
  sections: ToolMenuSection[];
  label?: string;
  className?: string;
  /** Accessible width class; default w-72 (18rem). */
  widthClass?: string;
}

function Impl({ sections, label = 'Tools', className = '', widthClass = 'w-72' }: HeaderToolsMenuProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!anchor.current) return;
      if (!anchor.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const renderItem = (item: ToolMenuItem) => {
    if (item.render) {
      // Custom row (e.g. inline select) — still rendered as a .tp-item
      // wrapper so spacing/borders match neighbors, but with raw content.
      return (
        <div key={item.id} className="tp-item" style={{ display: 'block', padding: '8px 16px' }}>
          {item.render()}
        </div>
      );
    }

    // Map our optional `danger` flag to the design's modifier classes so
    // the icon + hover get red-tinted automatically via /fusio/mc.css.
    // Other tones could be wired similarly if items grow tone props.
    const cls = ['tp-item', item.danger ? 'red' : ''].filter(Boolean).join(' ');

    return (
      <button
        key={item.id}
        disabled={item.disabled}
        onClick={() => {
          if (!item.keepOpen) setOpen(false);
          item.onClick?.();
        }}
        className={cls}
        data-fusio
        style={{
          width: '100%',
          textAlign: 'left',
          border: 'none',
          opacity: item.disabled ? 0.4 : 1,
          cursor: item.disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {item.icon && (
          <div className="ic">{item.icon}</div>
        )}
        {!item.icon && item.dotColor && (
          <span
            className={item.dotColor}
            style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, marginRight: 8 }}
          />
        )}
        <div className="info">
          <div className="name">{item.label}</div>
          {item.subLabel && <div className="desc">{item.subLabel}</div>}
        </div>
        {item.rightSlot && <div className="val">{item.rightSlot}</div>}
      </button>
    );
  };

  return (
    <div ref={anchor} className={`relative ${className}`}>
      <button
        onClick={() => setOpen(v => !v)}
        data-fusio
        title="More actions"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '5px 12px',
          fontFamily: 'var(--font-mono, ui-monospace)',
          fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
          borderRadius: 5,
          background: open ? 'rgba(94, 196, 217, 0.14)' : 'var(--ink-3, #1B1B23)',
          color: open ? 'var(--cyan, #5EC4D9)' : 'var(--mist, rgba(255,255,255,0.5))',
          border: `1px solid ${open ? 'rgba(94, 196, 217, 0.4)' : 'var(--line, rgba(255,255,255,0.08))'}`,
          cursor: 'pointer',
          transition: 'all 120ms ease-out',
        }}
        onMouseEnter={e => {
          if (!open) {
            (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)';
            (e.currentTarget as HTMLElement).style.borderColor = 'rgba(94, 196, 217, 0.3)';
          }
        }}
        onMouseLeave={e => {
          if (!open) {
            (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))';
            (e.currentTarget as HTMLElement).style.borderColor = 'var(--line, rgba(255,255,255,0.08))';
          }
        }}
      >
        <span>{label}</span>
        <ChevronDown style={{ width: 11, height: 11, transition: 'transform 120ms ease-out', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }} />
      </button>
      {open && (
        <div
          className={`tools-panel ${widthClass}`}
          style={{
            // Override the design's absolute top/right (which assumes
            // page-level positioning) with anchor-relative placement so
            // this dropdown sits below the trigger button.
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            maxHeight: '80vh',
            zIndex: 50,
          }}
        >
          <div className="tp-scroll" style={{ maxHeight: '78vh' }}>
            {sections.map(section => (
              <div className="tp-section" key={section.title}>
                <div className="tp-title">{section.title}</div>
                {section.items.map(renderItem)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export const HeaderToolsMenu = memo(Impl);
