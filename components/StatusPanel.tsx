/**
 * StatusPanel — system status card with uptime / bandwidth / heartbeat /
 * recent activity. Lives in the Dashboard grid.
 *
 * Re-skinned for the AI Fusio design: tokens come from /fusio/mc.css,
 * accent pip with green-pulse for live state, mono uppercase eyebrows on
 * every stat sub-card.
 */
'use client';

import { useEffect, useState } from 'react';
import { Activity, Clock, Zap, GitCommit, Terminal } from 'lucide-react';

interface StatusPanelProps {
  connected: boolean;
}

const FONT_MONO    = 'var(--font-mono, ui-monospace, monospace)';
const FONT_SANS    = 'var(--font-sans, system-ui)';
const FONT_DISPLAY = 'var(--font-display, "Space Grotesk")';

const eyebrow = (color = 'var(--mist, rgba(255,255,255,0.5))', size = 10): React.CSSProperties => ({
  fontFamily: FONT_MONO,
  fontSize: size,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color,
});

export default function StatusPanel({ connected }: StatusPanelProps) {
  const [status, setStatus] = useState<'idle' | 'working' | 'error'>('idle');
  const [currentTask] = useState<string | null>(null);
  const [lastHeartbeat, setLastHeartbeat] = useState<Date | null>(null);
  const [nextHeartbeat, setNextHeartbeat] = useState<Date | null>(null);
  const [bandwidth, setBandwidth] = useState(0);
  const [recentCommits] = useState<string[]>([]);
  const [uptime, setUptime] = useState('0:00:00');

  useEffect(() => {
    const interval = setInterval(() => {
      setLastHeartbeat(new Date());
      setNextHeartbeat(new Date(Date.now() + 60000));
      setBandwidth(Math.floor(Math.random() * 30));
    }, 5000);

    const startTime = Date.now();
    const uptimeInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const hours = Math.floor(elapsed / 3600);
      const mins = Math.floor((elapsed % 3600) / 60);
      const secs = elapsed % 60;
      setUptime(`${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`);
    }, 1000);

    return () => {
      clearInterval(interval);
      clearInterval(uptimeInterval);
    };
  }, []);

  const statusColor = !connected ? 'var(--red, #CC0C20)' :
    status === 'working' ? 'var(--amber, #E8A23B)' :
    status === 'error' ? 'var(--red, #CC0C20)' :
    'var(--green, #4CC38A)';

  const statusText = !connected ? 'Disconnected' :
    status === 'working' ? 'Processing' :
    status === 'error' ? 'Error' : 'Standby';

  return (
    <div
      style={{
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 12,
        padding: 16,
        fontFamily: FONT_SANS,
        color: 'var(--white, #fff)',
      }}
    >
      {/* Head */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, borderRadius: 5,
            background: 'rgba(76, 195, 138, 0.12)',
            border: '1px solid rgba(76, 195, 138, 0.35)',
          }}
        >
          <Terminal style={{ width: 11, height: 11, color: 'var(--green, #4CC38A)' }} />
        </span>
        <div>
          <div style={eyebrow()}>Monitor · Runtime</div>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 1 }}>
            System status
          </div>
        </div>
      </div>

      {/* Main status */}
      <div style={{ marginBottom: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <span
            style={{
              width: 10, height: 10, borderRadius: '50%',
              background: statusColor,
              boxShadow: `0 0 12px ${statusColor}`,
              animation: connected ? 'fusio-pulse 1.8s ease-in-out infinite' : undefined,
            }}
          />
          <span style={{ fontFamily: FONT_DISPLAY, fontSize: 20, fontWeight: 600, letterSpacing: '-0.015em', color: statusColor }}>
            {statusText}
          </span>
        </div>
        {currentTask && (
          <div style={{ ...eyebrow('var(--mist, rgba(255,255,255,0.5))', 11), letterSpacing: '0.04em', textTransform: 'none', paddingLeft: 20 }}>
            → {currentTask}
          </div>
        )}
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        {/* Uptime */}
        <div style={{ background: 'var(--ink-2, #131319)', borderRadius: 8, padding: 12, border: '1px solid var(--line, rgba(255,255,255,0.08))' }}>
          <div style={{ ...eyebrow(), display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
            <Clock style={{ width: 10, height: 10 }} />
            Uptime
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 16, color: 'var(--cyan, #5EC4D9)', letterSpacing: '0.04em' }}>
            {uptime}
          </div>
        </div>

        {/* Bandwidth */}
        <div style={{ background: 'var(--ink-2, #131319)', borderRadius: 8, padding: 12, border: '1px solid var(--line, rgba(255,255,255,0.08))' }}>
          <div style={{ ...eyebrow(), display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
            <Zap style={{ width: 10, height: 10 }} />
            Bandwidth
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 16, color: 'var(--amber, #E8A23B)', letterSpacing: '0.04em' }}>
            {bandwidth}%
          </div>
          <div style={{ marginTop: 6, height: 3, background: 'var(--ink-3, #1B1B23)', borderRadius: 99, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                background: 'var(--amber, #E8A23B)',
                width: `${bandwidth}%`,
                transition: 'width 500ms ease-out',
                boxShadow: '0 0 8px rgba(232, 162, 59, 0.4)',
              }}
            />
          </div>
        </div>
      </div>

      {/* Heartbeat */}
      <div
        style={{
          background: 'var(--ink-2, #131319)',
          borderRadius: 8,
          padding: 12,
          marginBottom: 12,
          border: '1px solid var(--line, rgba(255,255,255,0.08))',
        }}
      >
        <div style={{ ...eyebrow(), display: 'flex', alignItems: 'center', gap: 5, marginBottom: 8 }}>
          <Activity style={{ width: 10, height: 10 }} />
          Heartbeat
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
          <div>
            <span style={eyebrow('var(--dim, rgba(255,255,255,0.32))', 9.5)}>Last </span>
            <span style={{ fontFamily: FONT_MONO, color: 'var(--white, #fff)' }}>
              {lastHeartbeat ? lastHeartbeat.toLocaleTimeString() : '--:--:--'}
            </span>
          </div>
          <div>
            <span style={eyebrow('var(--dim, rgba(255,255,255,0.32))', 9.5)}>Next </span>
            <span style={{ fontFamily: FONT_MONO, color: 'var(--green, #4CC38A)' }}>
              {nextHeartbeat ? nextHeartbeat.toLocaleTimeString() : '--:--:--'}
            </span>
          </div>
        </div>
      </div>

      {/* Recent activity */}
      <div
        style={{
          background: 'var(--ink-2, #131319)',
          borderRadius: 8,
          padding: 12,
          border: '1px solid var(--line, rgba(255,255,255,0.08))',
        }}
      >
        <div style={{ ...eyebrow(), display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
          <GitCommit style={{ width: 10, height: 10 }} />
          Recent activity
        </div>
        {recentCommits.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5 }}>
            {recentCommits.slice(0, 3).map((commit, i) => (
              <div
                key={i}
                style={{
                  color: 'var(--white, #fff)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontFamily: FONT_MONO,
                }}
              >
                → {commit}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ ...eyebrow('var(--dim, rgba(255,255,255,0.32))', 10), fontStyle: 'italic', textTransform: 'none', letterSpacing: '0.04em' }}>
            No recent activity
          </div>
        )}
      </div>
    </div>
  );
}
