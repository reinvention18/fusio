/**
 * PhaseBar — progress bar + phase pipeline shown above the constellation
 * panel content. Re-skinned for the AI Fusio design.
 */
'use client';

import { PHASE_ICONS } from './constants';

interface Phase {
  id: string;
  name: string;
  status: string;
  ordering: number;
}

interface PhaseBarProps {
  phases: Phase[];
  teamStatus: string;
  onPhaseClick?: (phaseId: string) => void;
  activePhaseFilter?: string | null;
}

export function PhaseBar({ phases, teamStatus, onPhaseClick, activePhaseFilter }: PhaseBarProps) {
  if (phases.length === 0) return null;

  const completedCount = phases.filter(p => p.status === 'completed').length;
  const pct = phases.length > 0 ? Math.round((completedCount / phases.length) * 100) : 0;

  const statusColor = teamStatus === 'completed'
    ? 'var(--green, #4CC38A)'
    : teamStatus === 'running'
      ? 'var(--green, #4CC38A)'
      : 'var(--mist, rgba(255,255,255,0.5))';

  return (
    <div
      style={{
        borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
        paddingBottom: 12,
        marginBottom: 16,
        fontFamily: 'var(--font-sans, system-ui)',
      }}
    >
      {/* Progress bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
            color: 'var(--mist, rgba(255,255,255,0.5))',
          }}
        >
          Progress
        </span>
        <div
          style={{
            flex: 1,
            height: 4,
            background: 'var(--ink-3, #1B1B23)',
            borderRadius: 99,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              background: 'var(--green, #4CC38A)',
              width: `${pct}%`,
              borderRadius: 99,
              transition: 'width 500ms ease-out',
              boxShadow: '0 0 8px rgba(76, 195, 138, 0.4)',
            }}
          />
        </div>
        <span style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 11, letterSpacing: '0.04em', color: 'var(--white, #fff)' }}>
          {pct}%
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 9.5, letterSpacing: '0.16em', textTransform: 'uppercase',
            padding: '3px 9px',
            borderRadius: 5,
            background: teamStatus === 'completed' || teamStatus === 'running'
              ? 'rgba(76, 195, 138, 0.12)'
              : 'var(--ink-2, #131319)',
            color: statusColor,
            border: `1px solid ${teamStatus === 'completed' || teamStatus === 'running' ? 'rgba(76, 195, 138, 0.35)' : 'var(--line, rgba(255,255,255,0.08))'}`,
          }}
        >
          {teamStatus}
        </span>
      </div>

      {/* Phase pipeline */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        {phases.sort((a, b) => a.ordering - b.ordering).map((phase, i) => {
          const phaseColor = phase.status === 'completed'
            ? 'var(--green, #4CC38A)'
            : phase.status === 'active'
              ? 'var(--amber, #E8A23B)'
              : 'var(--mist, rgba(255,255,255,0.5))';
          const isActive = activePhaseFilter === phase.id;
          return (
            <div key={phase.id} style={{ display: 'flex', alignItems: 'center' }}>
              {i > 0 && (
                <span style={{ color: 'var(--dim, rgba(255,255,255,0.32))', margin: '0 4px', fontFamily: 'var(--font-mono, ui-monospace)' }}>
                  →
                </span>
              )}
              <button
                onClick={() => onPhaseClick?.(activePhaseFilter === phase.id ? '' : phase.id)}
                data-fusio
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '4px 10px',
                  borderRadius: 5,
                  fontSize: 11,
                  background: isActive ? `color-mix(in srgb, ${phaseColor} 14%, transparent)` : 'transparent',
                  border: `1px solid ${isActive ? `color-mix(in srgb, ${phaseColor} 40%, transparent)` : 'transparent'}`,
                  color: phaseColor,
                  cursor: 'pointer',
                  transition: 'all 120ms ease-out',
                  fontFamily: 'var(--font-sans, system-ui)',
                }}
                onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; }}
                onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <span style={{ animation: phase.status === 'active' ? 'fusio-pulse 1.6s ease-in-out infinite' : undefined }}>
                  {PHASE_ICONS[phase.status] || '○'}
                </span>
                <span>{phase.name}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
