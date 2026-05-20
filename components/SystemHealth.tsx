/**
 * SystemHealth — compact CPU/Memory/Disk/Network/Uptime card for the
 * Dashboard. Re-skinned for the AI Fusio design.
 */
'use client';

import { useState, useEffect } from 'react';
import { Activity, HardDrive, Cpu, MemoryStick, Wifi } from 'lucide-react';

interface HealthData {
  cpu: number;
  memory: number;
  disk: number;
  network: 'online' | 'offline' | 'degraded';
  uptime: number;
}

const FONT_MONO    = 'var(--font-mono, ui-monospace, monospace)';
const FONT_SANS    = 'var(--font-sans, system-ui)';
const FONT_DISPLAY = 'var(--font-display, "Space Grotesk")';

const eyebrow = (color = 'var(--mist, rgba(255,255,255,0.5))', size = 10): React.CSSProperties => ({
  fontFamily: FONT_MONO,
  fontSize: size,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color,
});

export default function SystemHealth() {
  const [health, setHealth] = useState<HealthData>({
    cpu: 0, memory: 0, disk: 0, network: 'online', uptime: 0,
  });

  useEffect(() => {
    const updateHealth = () => {
      setHealth({
        cpu: Math.floor(Math.random() * 30) + 10,
        memory: Math.floor(Math.random() * 20) + 45,
        disk: 68,
        network: 'online',
        uptime: Date.now() - 86400000 * 3,
      });
    };
    updateHealth();
    const interval = setInterval(updateHealth, 5000);
    return () => clearInterval(interval);
  }, []);

  const getBarColor = (value: number) => {
    if (value < 50) return 'var(--green, #4CC38A)';
    if (value < 80) return 'var(--amber, #E8A23B)';
    return 'var(--red, #CC0C20)';
  };
  const getBarGlow = (value: number) => {
    if (value < 50) return 'rgba(76, 195, 138, 0.4)';
    if (value < 80) return 'rgba(232, 162, 59, 0.4)';
    return 'rgba(204, 12, 32, 0.4)';
  };

  const formatUptime = (start: number) => {
    const diff = Date.now() - start;
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    if (days > 0) return `${days}d ${hours}h`;
    return `${hours}h`;
  };

  // Single stat row
  const StatRow = ({ icon, label, value }: {
    icon: React.ReactNode; label: string; value: number;
  }) => (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
        <div style={{ ...eyebrow(), display: 'flex', alignItems: 'center', gap: 5 }}>
          {icon}
          {label}
        </div>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: 'var(--white, #fff)', letterSpacing: '0.04em' }}>{value}%</span>
      </div>
      <div style={{ height: 3, background: 'var(--ink-3, #1B1B23)', borderRadius: 99, overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            background: getBarColor(value),
            width: `${value}%`,
            transition: 'width 500ms ease-out',
            boxShadow: `0 0 6px ${getBarGlow(value)}`,
          }}
        />
      </div>
    </div>
  );

  return (
    <div
      style={{
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 12,
        padding: 14,
        fontFamily: FONT_SANS,
        color: 'var(--white, #fff)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, borderRadius: 5,
            background: 'rgba(76, 195, 138, 0.12)',
            border: '1px solid rgba(76, 195, 138, 0.35)',
          }}
        >
          <Activity style={{ width: 11, height: 11, color: 'var(--green, #4CC38A)' }} />
        </span>
        <div>
          <div style={eyebrow()}>Monitor · System</div>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 1 }}>
            Health
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <StatRow icon={<Cpu style={{ width: 10, height: 10 }} />} label="CPU" value={health.cpu} />
        <StatRow icon={<MemoryStick style={{ width: 10, height: 10 }} />} label="Memory" value={health.memory} />
        <StatRow icon={<HardDrive style={{ width: 10, height: 10 }} />} label="Disk" value={health.disk} />

        {/* Network + uptime */}
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            paddingTop: 8,
            borderTop: '1px solid var(--line, rgba(255,255,255,0.08))',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Wifi
              style={{
                width: 11, height: 11,
                color: health.network === 'online' ? 'var(--green, #4CC38A)' : 'var(--red, #CC0C20)',
              }}
            />
            <span style={{ ...eyebrow(health.network === 'online' ? 'var(--green, #4CC38A)' : 'var(--red, #CC0C20)', 9.5) }}>
              {health.network}
            </span>
          </div>
          <div style={{ ...eyebrow('var(--mist, rgba(255,255,255,0.5))', 9.5) }}>
            Uptime · <span style={{ color: 'var(--cyan, #5EC4D9)' }}>{formatUptime(health.uptime)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
