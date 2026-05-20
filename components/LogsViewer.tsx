/**
 * LogsViewer — append-only log stream with level filter + pause/clear.
 *
 * Re-skinned for the AI Fusio design language: eyebrow + display title,
 * level-colored mono entries, Ink-2 surface, hover-revealed icon-buttons.
 */
'use client';
import { generateId } from '../lib/generateId';

import { useState, useEffect, useRef } from 'react';
import { ScrollText, Trash2, Pause, Play } from 'lucide-react';

interface LogEntry {
  id: string;
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
}

const FONT_MONO    = 'var(--font-mono, ui-monospace, monospace)';
const FONT_SANS    = 'var(--font-sans, system-ui)';
const FONT_DISPLAY = 'var(--font-display, "Space Grotesk")';

export default function LogsViewer() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mockLogs: LogEntry[] = [
      { id: '1', timestamp: new Date(Date.now() - 60000), level: 'info',  message: 'Gateway started on port 18789', source: 'gateway' },
      { id: '2', timestamp: new Date(Date.now() - 45000), level: 'info',  message: 'WebSocket connection established', source: 'ws' },
      { id: '3', timestamp: new Date(Date.now() - 30000), level: 'debug', message: 'Heartbeat sent', source: 'agent' },
      { id: '4', timestamp: new Date(Date.now() - 15000), level: 'info',  message: 'Session main active', source: 'session' },
    ];
    setLogs(mockLogs);

    const interval = setInterval(() => {
      if (!paused) {
        const newLog: LogEntry = {
          id: generateId(),
          timestamp: new Date(),
          level: Math.random() > 0.9 ? 'warn' : 'info',
          message: ['Heartbeat OK', 'Processing request', 'Task queued', 'Cache hit', 'Memory check passed'][Math.floor(Math.random() * 5)],
          source: ['agent', 'gateway', 'session', 'cron'][Math.floor(Math.random() * 4)],
        };
        setLogs(prev => [...prev.slice(-100), newLog]);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [paused]);

  useEffect(() => {
    if (logRef.current && !paused) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, paused]);

  const clearLogs = () => setLogs([]);
  const filteredLogs = logs.filter(l => filter === 'all' || l.level === filter);

  const getLevelColor = (level: LogEntry['level']) => {
    switch (level) {
      case 'error': return 'var(--red, #CC0C20)';
      case 'warn':  return 'var(--amber, #E8A23B)';
      case 'debug': return 'var(--dim, rgba(255,255,255,0.32))';
      default:      return 'var(--cyan, #5EC4D9)';
    }
  };

  const formatTime = (date: Date) => date.toLocaleTimeString('en-US', { hour12: false });

  return (
    <div
      style={{
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 12,
        padding: 14,
        height: '100%',
        display: 'flex', flexDirection: 'column',
        fontFamily: FONT_SANS,
        color: 'var(--white, #fff)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 22, borderRadius: 5,
              background: 'rgba(94, 196, 217, 0.12)',
              border: '1px solid rgba(94, 196, 217, 0.35)',
            }}
          >
            <ScrollText style={{ width: 11, height: 11, color: 'var(--cyan, #5EC4D9)' }} />
          </span>
          <div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Monitor · Stream
            </div>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>
              Logs
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <select
            value={filter}
            onChange={e => setFilter(e.target.value as any)}
            data-fusio
            style={{
              background: 'var(--ink-3, #1B1B23)',
              border: '1px solid var(--line, rgba(255,255,255,0.08))',
              borderRadius: 6,
              padding: '3px 8px',
              color: 'var(--white, #fff)',
              fontSize: 11,
              fontFamily: FONT_MONO,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              outline: 'none',
            }}
          >
            <option value="all">All</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          <button
            onClick={() => setPaused(!paused)}
            data-fusio
            title={paused ? 'Resume' : 'Pause'}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 26, height: 26, borderRadius: 5,
              background: paused ? 'rgba(76, 195, 138, 0.14)' : 'rgba(232, 162, 59, 0.14)',
              color: paused ? 'var(--green, #4CC38A)' : 'var(--amber, #E8A23B)',
              border: `1px solid ${paused ? 'rgba(76, 195, 138, 0.35)' : 'rgba(232, 162, 59, 0.35)'}`,
              cursor: 'pointer',
              transition: 'all 120ms ease-out',
            }}
          >
            {paused ? <Play style={{ width: 11, height: 11 }} /> : <Pause style={{ width: 11, height: 11 }} />}
          </button>
          <button
            onClick={clearLogs}
            data-fusio
            title="Clear logs"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 26, height: 26, borderRadius: 5,
              background: 'transparent', color: 'var(--mist, rgba(255,255,255,0.5))', border: 'none',
              cursor: 'pointer',
              transition: 'all 120ms ease-out',
            }}
            onMouseEnter={e => {
              const el = e.currentTarget as HTMLElement;
              el.style.background = 'rgba(204, 12, 32, 0.14)';
              el.style.color = 'var(--red, #CC0C20)';
            }}
            onMouseLeave={e => {
              const el = e.currentTarget as HTMLElement;
              el.style.background = 'transparent';
              el.style.color = 'var(--mist, rgba(255,255,255,0.5))';
            }}
          >
            <Trash2 style={{ width: 11, height: 11 }} />
          </button>
        </div>
      </div>

      {/* Log stream */}
      <div
        ref={logRef}
        style={{
          flex: 1,
          background: 'var(--void, #050507)',
          border: '1px solid var(--line, rgba(255,255,255,0.08))',
          borderRadius: 8,
          padding: 10,
          overflowY: 'auto',
          fontFamily: FONT_MONO,
          fontSize: 11.5,
          lineHeight: 1.55,
        }}
      >
        {filteredLogs.map(log => (
          <div key={log.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span style={{ flexShrink: 0, color: 'var(--dim, rgba(255,255,255,0.32))' }}>{formatTime(log.timestamp)}</span>
            <span style={{ flexShrink: 0, width: 56, color: getLevelColor(log.level), letterSpacing: '0.08em' }}>
              [{log.level.toUpperCase()}]
            </span>
            {log.source && <span style={{ flexShrink: 0, color: 'var(--mist, rgba(255,255,255,0.5))' }}>{log.source}:</span>}
            <span style={{ color: 'var(--white, #fff)' }}>{log.message}</span>
          </div>
        ))}
        {filteredLogs.length === 0 && (
          <div style={{ textAlign: 'center', padding: '16px 0', fontStyle: 'italic', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
            No logs
          </div>
        )}
      </div>
    </div>
  );
}
