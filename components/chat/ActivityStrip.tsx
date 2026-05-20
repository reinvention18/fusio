/**
 * ActivityStrip — live tool/sub-agent chatter rendered under the streaming
 * bubble. Pulls from the bridge's heartbeat SSE events (setActivityMap) so
 * the user always knows what the agent is doing, even when it's silent
 * between tool calls.
 */
'use client';
import { memo } from 'react';
import { Loader2, Users } from 'lucide-react';

export interface ActivityStripProps {
  status: string;
  elapsedSec: number;
  toolsUsed?: number;
  subagentsRunning?: number;
  subagentsDone?: number;
  silentSec?: number;
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function ActivityStripImpl(p: ActivityStripProps) {
  const parts: string[] = [];
  if (p.toolsUsed && p.toolsUsed > 0) parts.push(`${p.toolsUsed} tool${p.toolsUsed === 1 ? '' : 's'}`);
  if (p.subagentsDone && p.subagentsDone > 0) parts.push(`${p.subagentsDone} subagent${p.subagentsDone === 1 ? '' : 's'} done`);

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '5px 10px',
        background: 'var(--ink-2, #131319)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 6,
        fontFamily: 'var(--font-sans, system-ui)',
        fontSize: 11.5,
        color: 'var(--mist, rgba(255,255,255,0.5))',
      }}
    >
      <Loader2 style={{ width: 11, height: 11, color: 'var(--green, #4CC38A)', animation: 'spin 1s linear infinite', flexShrink: 0 }} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fog, rgba(255,255,255,0.78))' }}>
        {p.status}
      </span>
      {p.subagentsRunning && p.subagentsRunning > 0 ? (
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            color: 'var(--cyan, #5EC4D9)',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 10,
            letterSpacing: '0.08em',
          }}
        >
          <Users style={{ width: 11, height: 11 }} />
          {p.subagentsRunning}
        </span>
      ) : null}
      <span
        style={{
          color: 'var(--green, #4CC38A)',
          fontFamily: 'var(--font-mono, ui-monospace)',
          fontSize: 10.5,
          letterSpacing: '0.04em',
          whiteSpace: 'nowrap',
          opacity: 0.85,
        }}
      >
        {fmtDuration(p.elapsedSec)}
      </span>
      {parts.length > 0 && (
        <span
          className="hidden md:inline"
          style={{
            color: 'var(--dim, rgba(255,255,255,0.32))',
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 10,
            letterSpacing: '0.08em',
            whiteSpace: 'nowrap',
          }}
        >
          · {parts.join(' · ')}
        </span>
      )}
    </div>
  );
}

export const ActivityStrip = memo(ActivityStripImpl);
