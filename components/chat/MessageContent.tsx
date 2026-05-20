'use client';

import { useState, useEffect } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';

const DISPLAY_LIMIT = 20000; // 20k chars before offering collapse

export function MessageContent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(true);
  const isLong = content.length > DISPLAY_LIMIT;

  // For very long content, start collapsed
  useEffect(() => {
    if (content.length > 50000) {
      setExpanded(false);
    }
  }, [content.length]);

  if (!isLong) {
    return <div className="whitespace-pre-wrap text-[17px] md:text-sm leading-relaxed md:leading-normal">{content}</div>;
  }

  return (
    <div>
      <div className="whitespace-pre-wrap text-[17px] md:text-sm leading-relaxed md:leading-normal">
        {expanded ? content : content.slice(0, DISPLAY_LIMIT)}
        {!expanded && (
          <span style={{ color: 'var(--mist, rgba(255,255,255,0.5))', fontStyle: 'italic' }}>
            {'\n\n'}… [{(content.length - DISPLAY_LIMIT).toLocaleString()} more characters]
          </span>
        )}
      </div>
      <button
        onClick={() => setExpanded(!expanded)}
        data-fusio
        style={{
          marginTop: 8,
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '4px 10px',
          fontFamily: 'var(--font-mono, ui-monospace)',
          fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
          background: 'rgba(94, 196, 217, 0.1)',
          border: '1px solid rgba(94, 196, 217, 0.35)',
          borderRadius: 5,
          color: 'var(--cyan, #5EC4D9)',
          cursor: 'pointer',
          transition: 'filter 120ms ease-out',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.filter = 'brightness(1.15)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.filter = 'brightness(1)'; }}
      >
        {expanded ? (
          <>
            <Minimize2 style={{ width: 11, height: 11 }} />
            Collapse · {content.length.toLocaleString()} chars
          </>
        ) : (
          <>
            <Maximize2 style={{ width: 11, height: 11 }} />
            Expand · {content.length.toLocaleString()} chars
          </>
        )}
      </button>
    </div>
  );
}
