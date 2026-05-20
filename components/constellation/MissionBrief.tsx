/**
 * MissionBrief — top band of the constellation panel. Surfaces the team's
 * goal, current phase, task summary, and CTAs (deliverable + architect chat).
 * Re-skinned for the AI Fusio design.
 */
'use client';

import { Target, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';
import type { TeamPhase, TeamData } from '../teams/useTeamState';

interface MissionBriefProps {
  team: TeamData['team'] | undefined;
  phases: TeamPhase[];
  summary: TeamData['summary'] | undefined;
  deliverableReady: boolean;
  onJumpToDeliverable?: () => void;
  onJumpToArchitect?: () => void;
}

function findActivePhase(phases: TeamPhase[]): TeamPhase | null {
  return phases.find(p => p.status === 'active')
    || phases.find(p => p.status === 'pending')
    || null;
}

const eyebrow = (color = 'var(--mist, rgba(255,255,255,0.5))'): React.CSSProperties => ({
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 10,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color,
});

export function MissionBrief({
  team, phases, summary, deliverableReady, onJumpToDeliverable, onJumpToArchitect,
}: MissionBriefProps) {
  if (!team) return null;

  const active = findActivePhase(phases);
  const done = phases.filter(p => p.status === 'completed').length;
  const total = phases.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const isComplete = team.status === 'completed' || team.status === 'done';

  return (
    <div
      style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
        background: 'var(--void, #050507)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 16,
        flexWrap: 'wrap',
        fontFamily: 'var(--font-sans, system-ui)',
        color: 'var(--white, #fff)',
      }}
    >
      {/* Goal */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flex: 1, minWidth: 260 }}>
        <Target style={{ width: 14, height: 14, color: 'var(--cyan, #5EC4D9)', marginTop: 2, flexShrink: 0 }} />
        <div style={{ minWidth: 0 }}>
          <div style={eyebrow()}>Mission</div>
          <div
            style={{
              fontSize: 13,
              color: 'var(--white, #fff)',
              lineHeight: 1.45,
              marginTop: 2,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {team.goal || <span style={{ color: 'var(--mist, rgba(255,255,255,0.5))', fontStyle: 'italic' }}>(no goal set)</span>}
          </div>
        </div>
      </div>

      {/* Phase indicator */}
      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexShrink: 0 }}>
          {active?.status === 'active' ? (
            <Loader2 style={{ width: 14, height: 14, color: 'var(--amber, #E8A23B)', marginTop: 2, animation: 'spin 1s linear infinite' }} />
          ) : isComplete ? (
            <CheckCircle2 style={{ width: 14, height: 14, color: 'var(--green, #4CC38A)', marginTop: 2 }} />
          ) : (
            <AlertCircle style={{ width: 14, height: 14, color: 'var(--mist, rgba(255,255,255,0.5))', marginTop: 2 }} />
          )}
          <div>
            <div style={eyebrow()}>
              {isComplete ? 'Status' : 'Current phase'}
            </div>
            <div style={{ fontSize: 13, fontWeight: 500, marginTop: 2 }}>
              {isComplete ? (
                <span style={{ color: 'var(--green, #4CC38A)' }}>Mission complete</span>
              ) : active ? (
                <span style={{ color: active.status === 'active' ? 'var(--amber, #E8A23B)' : 'var(--mist, rgba(255,255,255,0.5))' }}>
                  {active.name}{active.status === 'active' ? ' · running' : ' · queued'}
                </span>
              ) : (
                <span style={{ color: 'var(--mist, rgba(255,255,255,0.5))' }}>—</span>
              )}
            </div>
            <div style={{ ...eyebrow('var(--dim, rgba(255,255,255,0.32))', ), fontSize: 9.5, marginTop: 4, letterSpacing: '0.1em' }}>
              {done}/{total} phase{total === 1 ? '' : 's'} done · {pct}%
            </div>
          </div>
        </div>
      )}

      {/* Tasks summary */}
      {summary && (
        <div style={{ flexShrink: 0 }}>
          <div style={eyebrow()}>Tasks</div>
          <div style={{ fontSize: 13, fontFamily: 'var(--font-mono, ui-monospace)', marginTop: 2 }}>
            <span style={{ color: 'var(--green, #4CC38A)' }}>{summary.done}</span>
            <span style={{ color: 'var(--mist, rgba(255,255,255,0.5))' }}>/</span>
            <span style={{ color: 'var(--white, #fff)' }}>{summary.total}</span>
            {summary.inProgress > 0 && (
              <span style={{ color: 'var(--amber, #E8A23B)', marginLeft: 6 }}>· {summary.inProgress} running</span>
            )}
            {summary.review > 0 && (
              <span style={{ color: 'var(--violet, #8B6FE8)', marginLeft: 6 }}>· {summary.review} in review</span>
            )}
          </div>
        </div>
      )}

      {/* CTAs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 'auto', flexWrap: 'wrap' }}>
        {deliverableReady && (
          <button
            onClick={onJumpToDeliverable}
            data-fusio
            className="card-btn primary"
            style={{
              fontSize: 11, padding: '6px 12px',
              background: 'var(--green, #4CC38A)',
              borderColor: 'var(--green, #4CC38A)',
              color: '#0a1612',
              whiteSpace: 'nowrap',
              boxShadow: '0 0 12px rgba(76, 195, 138, 0.3)',
              fontWeight: 600,
            }}
          >
            View deliverable →
          </button>
        )}
        <button
          onClick={onJumpToArchitect}
          data-fusio
          className="card-btn"
          style={{
            fontSize: 11, padding: '6px 12px',
            background: 'var(--ink-2, #131319)',
            color: 'var(--cyan, #5EC4D9)',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(94, 196, 217, 0.5)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--line, rgba(255,255,255,0.08))'; }}
        >
          💬 Talk to architect
        </button>
      </div>
    </div>
  );
}
