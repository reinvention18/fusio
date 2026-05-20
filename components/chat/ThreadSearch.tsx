/**
 * ThreadSearch — Cmd+F within the active chat. Filters visible messages,
 * reports hit indexes, lets the user jump forward/back with Enter/Shift+Enter.
 * Keeps DOM mounted — relies on parent's Virtuoso handle for navigation.
 */
'use client';
import { useEffect, useRef, useState } from 'react';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';

export interface ThreadSearchProps<M extends { id: string; content: string }> {
  messages: M[];
  onOpenChange?: (open: boolean) => void;
  onJump: (index: number) => void;
}

export function ThreadSearch<M extends { id: string; content: string }>(props: ThreadSearchProps<M>) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cmd/Ctrl+F opens; Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setOpen(true);
        setTimeout(() => inputRef.current?.focus(), 0);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => { props.onOpenChange?.(open); }, [open, props]);

  const hits: number[] = [];
  if (q.trim().length >= 2) {
    const needle = q.toLowerCase();
    for (let i = 0; i < props.messages.length; i++) {
      if ((props.messages[i].content || '').toLowerCase().includes(needle)) hits.push(i);
    }
  }

  const jump = (dir: 1 | -1) => {
    if (hits.length === 0) return;
    const next = (cursor + dir + hits.length) % hits.length;
    setCursor(next);
    props.onJump(hits[next]);
  };

  if (!open) return null;

  return (
    <div
      className="md:right-2 md:w-auto"
      style={{
        position: 'absolute',
        top: 8,
        left: 8,
        right: 8,
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        fontFamily: 'var(--font-sans, system-ui)',
      }}
    >
      <Search style={{ width: 13, height: 13, color: 'var(--mist, rgba(255,255,255,0.5))', flexShrink: 0 }} />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => { setQ(e.target.value); setCursor(0); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (hits.length > 0) {
              const next = e.shiftKey ? (cursor - 1 + hits.length) % hits.length : (cursor + 1) % hits.length;
              setCursor(next);
              props.onJump(hits[next]);
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        placeholder="Search thread…"
        className="flex-1 md:w-48 md:flex-none"
        data-fusio
        style={{
          background: 'transparent',
          fontSize: 12.5,
          color: 'var(--white, #fff)',
          border: 'none',
          outline: 'none',
          fontFamily: 'var(--font-sans, system-ui)',
          padding: '2px 0',
        }}
      />
      <span
        style={{
          fontFamily: 'var(--font-mono, ui-monospace)',
          fontSize: 10,
          letterSpacing: '0.08em',
          color: 'var(--mist, rgba(255,255,255,0.5))',
          whiteSpace: 'nowrap',
        }}
      >
        {hits.length === 0 ? (q ? '0' : '—') : `${cursor + 1}/${hits.length}`}
      </span>
      <button
        onClick={() => jump(-1)}
        disabled={hits.length === 0}
        data-fusio
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 24, height: 24, borderRadius: 5,
          background: 'transparent', color: 'var(--mist, rgba(255,255,255,0.5))', border: 'none',
          cursor: hits.length === 0 ? 'not-allowed' : 'pointer',
          opacity: hits.length === 0 ? 0.3 : 1,
          transition: 'background 120ms ease-out',
        }}
        onMouseEnter={e => { if (hits.length > 0) (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      >
        <ChevronUp style={{ width: 12, height: 12 }} />
      </button>
      <button
        onClick={() => jump(1)}
        disabled={hits.length === 0}
        data-fusio
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 24, height: 24, borderRadius: 5,
          background: 'transparent', color: 'var(--mist, rgba(255,255,255,0.5))', border: 'none',
          cursor: hits.length === 0 ? 'not-allowed' : 'pointer',
          opacity: hits.length === 0 ? 0.3 : 1,
          transition: 'background 120ms ease-out',
        }}
        onMouseEnter={e => { if (hits.length > 0) (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      >
        <ChevronDown style={{ width: 12, height: 12 }} />
      </button>
      <button
        onClick={() => setOpen(false)}
        data-fusio
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 24, height: 24, borderRadius: 5,
          background: 'transparent', color: 'var(--mist, rgba(255,255,255,0.5))', border: 'none',
          cursor: 'pointer',
          transition: 'all 120ms ease-out',
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLElement).style.background = 'rgba(204, 12, 32, 0.12)';
          (e.currentTarget as HTMLElement).style.color = 'var(--red, #CC0C20)';
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLElement).style.background = 'transparent';
          (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))';
        }}
      >
        <X style={{ width: 12, height: 12 }} />
      </button>
    </div>
  );
}
