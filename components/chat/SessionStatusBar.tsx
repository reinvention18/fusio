/**
 * SessionStatusBar — dense one-line summary of chat state above the composer.
 * Model · mode · token meter · running subagents · connection.
 */
'use client';
import { memo } from 'react';
import { Bot, Cpu, Users, Wifi, WifiOff, Zap } from 'lucide-react';

export interface SessionStatusProps {
  model: string;          // 'default' | 'opus' | 'sonnet' | 'haiku' | ...
  mode: 'quick' | 'work' | 'constellation';
  tokenUsage: { used: number; max: number; outputTokens?: number } | null;
  subagentsRunning: number;
  subagentsDone: number;
  isLoading: boolean;
  connection: 'live' | 'throttled' | 'stale' | 'offline';
  onClickTokens?: () => void;
}

function prettyModel(id: string): string {
  if (!id || id === 'default') return 'auto';
  if (id === 'claude-opus-4-7[1m]' || id === 'opus1m') return 'opus 4.7 · 1M';
  if (id === 'claude-opus-4-7' || id === 'opus' || id === 'opus47') return 'opus 4.7';
  if (id === 'claude-sonnet-4-6' || id === 'sonnet') return 'sonnet 4.6';
  if (id === 'claude-haiku-4-5' || id === 'haiku') return 'haiku 4.5';
  return id;
}

function StatusBarImpl(p: SessionStatusProps) {
  const usedPct = p.tokenUsage
    ? Math.min(100, Math.round((p.tokenUsage.used / p.tokenUsage.max) * 100))
    : 0;
  const tokenColor = usedPct > 85
    ? 'var(--red, #CC0C20)'
    : usedPct > 60
      ? 'var(--amber, #E8A23B)'
      : 'var(--green, #4CC38A)';
  const connTone =
    p.connection === 'live' ? 'var(--green, #4CC38A)' :
    p.connection === 'throttled' ? 'var(--amber, #E8A23B)' :
    p.connection === 'stale' ? 'var(--mist, rgba(255,255,255,0.5))' :
    'var(--red, #CC0C20)';
  const modeColor = p.mode === 'quick'
    ? 'var(--cyan, #5EC4D9)'
    : p.mode === 'constellation'
      ? 'var(--amber, #E8A23B)'
      : 'var(--white, #fff)';

  const cell: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: 10,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: 'var(--mist, rgba(255,255,255,0.5))',
  };

  return (
    <div
      style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center',
        columnGap: 14, rowGap: 4,
        padding: '4px 4px',
        fontFamily: 'var(--font-sans, system-ui)',
      }}
    >
      {/* Model */}
      <span style={cell}>
        <Cpu style={{ width: 10, height: 10 }} />
        <span style={{ color: 'var(--white, #fff)' }}>{prettyModel(p.model)}</span>
      </span>
      {/* Mode */}
      <span style={cell}>
        <Zap style={{ width: 10, height: 10 }} />
        <span style={{ color: modeColor }}>{p.mode}</span>
      </span>
      {/* Token meter — compact */}
      {p.tokenUsage && (
        <button
          onClick={p.onClickTokens}
          data-fusio
          title={`${p.tokenUsage.used.toLocaleString()} / ${p.tokenUsage.max.toLocaleString()} tokens`}
          style={{
            ...cell,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            gap: 6,
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
        >
          <span
            className="w-12 md:w-14"
            style={{
              height: 3,
              background: 'var(--ink-3, #1B1B23)',
              borderRadius: 99,
              overflow: 'hidden',
              display: 'inline-block',
            }}
          >
            <span
              style={{
                display: 'block',
                height: '100%',
                background: tokenColor,
                width: `${usedPct}%`,
                borderRadius: 99,
                boxShadow: usedPct > 60 ? `0 0 6px ${tokenColor}` : 'none',
                transition: 'width 500ms ease-out',
              }}
            />
          </span>
          <span style={{ color: tokenColor }}>{usedPct}%</span>
        </button>
      )}
      {/* Subagents */}
      {(p.subagentsRunning > 0 || p.subagentsDone > 0) && (
        <span style={cell}>
          <Users style={{ width: 10, height: 10 }} />
          {p.subagentsRunning > 0 ? (
            <span style={{ color: 'var(--cyan, #5EC4D9)' }}>
              {p.subagentsRunning}<span className="hidden sm:inline"> running</span>
            </span>
          ) : (
            <span>{p.subagentsDone}<span className="hidden sm:inline"> done</span></span>
          )}
        </span>
      )}
      {/* Connection — icon-only on narrow */}
      <span
        style={{ ...cell, marginLeft: 'auto', color: connTone }}
        title={`connection: ${p.connection}`}
      >
        {p.connection === 'offline' ? <WifiOff style={{ width: 10, height: 10 }} /> : <Wifi style={{ width: 10, height: 10 }} />}
        <span className="hidden md:inline">{p.connection}</span>
      </span>
      {p.isLoading && (
        <span style={{ ...cell, color: 'var(--green, #4CC38A)' }}>
          <Bot style={{ width: 10, height: 10, animation: 'fusio-pulse 1.4s ease-in-out infinite' }} />
          <span className="hidden md:inline">working</span>
        </span>
      )}
    </div>
  );
}

export const SessionStatusBar = memo(StatusBarImpl);
