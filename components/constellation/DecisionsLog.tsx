'use client';

import { useMemo } from 'react';
import { ROLE_GLYPHS, PHASE_ICONS } from './constants';
import type { TeamDecision, TeamPhase, AgentData } from '../teams/useTeamState';

interface DecisionsLogProps {
  decisions: TeamDecision[];
  phases: TeamPhase[];
  agents: AgentData[];
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(start: number | null, end: number | null): string {
  if (!start) return '—';
  const end_ = end ?? Date.now();
  const ms = end_ - start;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m${rs ? ` ${rs}s` : ''}`;
}

const DECISION_ICONS: Record<string, string> = {
  team_composition: '◆',
  phase_transition: '▸',
  task_assignment: '◎',
  rework_requested: '⟲',
  merge_decision: '⎇',
  team_created: '✦',
  architect_plan: '◆',
};

export function DecisionsLog({ decisions, phases, agents }: DecisionsLogProps) {
  const agentMap = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);
  const sortedPhases = useMemo(() => [...phases].sort((a, b) => a.ordering - b.ordering), [phases]);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Phase timeline */}
      {sortedPhases.length > 0 && (
        <section className="border-b border-terminal-border px-3 py-2">
          <h4 className="text-[10px] uppercase tracking-wider text-terminal-dim mb-2">
            Phase Timeline ({sortedPhases.filter(p => p.status === 'completed').length}/{sortedPhases.length})
          </h4>
          <div className="space-y-1.5">
            {sortedPhases.map(phase => {
              const roles: string[] = (() => {
                try { return JSON.parse(phase.roles_json || '[]'); } catch { return []; }
              })();
              const statusColor =
                phase.status === 'completed' ? 'text-terminal-green'
                : phase.status === 'active' ? 'text-terminal-amber'
                : phase.status === 'skipped' ? 'text-terminal-dim line-through'
                : 'text-terminal-dim';
              const borderColor =
                phase.status === 'completed' ? 'border-terminal-green/30'
                : phase.status === 'active' ? 'border-terminal-amber/50'
                : 'border-terminal-border';
              return (
                <div
                  key={phase.id}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded border ${borderColor} bg-terminal-surface/30`}
                >
                  <span className={`${statusColor} ${phase.status === 'active' ? 'animate-pulse' : ''}`}>
                    {PHASE_ICONS[phase.status] || '○'}
                  </span>
                  <span className="text-[10px] text-terminal-dim w-4">{phase.ordering + 1}.</span>
                  <div className="flex-1 min-w-0">
                    <div className={`text-[12px] font-medium ${statusColor}`}>{phase.name}</div>
                    {phase.description && (
                      <div className="text-[10px] text-terminal-dim truncate">{phase.description}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {roles.map(r => (
                      <span key={r} className="text-[10px] text-terminal-dim" title={r}>
                        {ROLE_GLYPHS[r] || '·'}
                      </span>
                    ))}
                  </div>
                  <span className="text-[10px] text-terminal-dim w-16 text-right flex-shrink-0">
                    {fmtDuration(phase.started_at, phase.completed_at)}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Decisions log */}
      <section className="px-3 py-2 flex-1">
        <h4 className="text-[10px] uppercase tracking-wider text-terminal-dim mb-2">
          Decisions ({decisions.length})
        </h4>
        {decisions.length === 0 && (
          <p className="text-terminal-dim text-center text-xs py-6">
            Architect decisions and phase transitions appear here
          </p>
        )}
        <div className="space-y-1.5">
          {decisions.map(d => {
            const agent = d.agent_id ? agentMap.get(d.agent_id) : null;
            const glyph = agent ? ROLE_GLYPHS[agent.role] || '?' : (DECISION_ICONS[d.decision_type] || '·');
            const details: Record<string, unknown> = (() => {
              try { return JSON.parse(d.details_json || '{}'); } catch { return {}; }
            })();

            return (
              <div
                key={d.id}
                className="p-2 rounded border border-terminal-border/50 bg-terminal-surface/40 text-[11px]"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-terminal-dim">{fmtTime(d.created_at)}</span>
                  <span className="text-terminal-cyan">{glyph} {agent?.role_handle || 'system'}</span>
                  <span className="text-[9px] uppercase text-terminal-amber border border-terminal-amber/30 px-1.5 py-0 rounded">
                    {d.decision_type.replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="mt-1 text-terminal-text whitespace-pre-wrap break-words">{d.summary}</div>
                {Object.keys(details).length > 0 && (
                  <pre className="mt-1 text-[10px] text-terminal-dim font-mono overflow-x-auto whitespace-pre-wrap">
                    {JSON.stringify(details, null, 2)}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
