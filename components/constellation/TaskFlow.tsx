/**
 * TaskFlow — kanban-style swimlane of constellation tasks, grouped by status
 * column (TASK_FLOW_COLUMNS). Re-skinned for the AI Fusio design.
 */
'use client';

import { ROLE_GLYPHS, TASK_FLOW_COLUMNS } from './constants';
import type { TaskData } from '../teams/useTeamState';

interface TaskFlowProps {
  tasks: TaskData[];
  phaseFilter?: string | null;
  onTaskClick?: (taskId: string) => void;
}

/** Map the legacy Tailwind border-top color class to a Fusio accent var. */
function columnAccent(colorClass: string): string {
  if (colorClass.includes('green')) return 'var(--green, #4CC38A)';
  if (colorClass.includes('amber')) return 'var(--amber, #E8A23B)';
  if (colorClass.includes('red'))   return 'var(--red, #CC0C20)';
  if (colorClass.includes('cyan'))  return 'var(--cyan, #5EC4D9)';
  if (colorClass.includes('purple'))return 'var(--violet, #8B6FE8)';
  return 'var(--mist, rgba(255,255,255,0.5))';
}

export function TaskFlow({ tasks, phaseFilter, onTaskClick }: TaskFlowProps) {
  const filtered = phaseFilter
    ? tasks.filter(t => t.phase === phaseFilter)
    : tasks;

  return (
    <div
      className="scrollbar-hide"
      style={{
        display: 'flex', gap: 8,
        overflowX: 'auto', paddingBottom: 8,
        fontFamily: 'var(--font-sans, system-ui)',
      }}
    >
      {TASK_FLOW_COLUMNS.map(col => {
        const colTasks = filtered.filter(t => (col.statuses as readonly string[]).includes(t.status));
        const accent = columnAccent(col.color);
        return (
          <div
            key={col.key}
            className="flex-shrink-0 w-56 md:w-44"
            style={{ borderTop: `2px solid ${accent}` }}
          >
            <div
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 10px',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono, ui-monospace)',
                  fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
                  color: 'var(--mist, rgba(255,255,255,0.5))',
                }}
              >
                {col.label}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono, ui-monospace)',
                  fontSize: 10, fontWeight: 600,
                  color: colTasks.length > 0 ? accent : 'var(--dim, rgba(255,255,255,0.32))',
                  letterSpacing: '0.04em',
                }}
              >
                {colTasks.length}
              </span>
            </div>
            <div
              style={{
                display: 'flex', flexDirection: 'column', gap: 4,
                padding: '0 4px',
                maxHeight: 192,
                overflowY: 'auto',
              }}
            >
              {colTasks.map(task => (
                <button
                  key={task.id}
                  onClick={() => onTaskClick?.(task.id)}
                  data-fusio
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: 8,
                    borderRadius: 6,
                    background: 'var(--ink-2, #131319)',
                    border: '1px solid var(--line, rgba(255,255,255,0.08))',
                    cursor: 'pointer',
                    transition: 'border-color 120ms ease-out',
                    fontFamily: 'var(--font-sans, system-ui)',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = `color-mix(in srgb, ${accent} 35%, transparent)`; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--line, rgba(255,255,255,0.08))'; }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, color: 'var(--cyan, #5EC4D9)', flexShrink: 0, width: 12, textAlign: 'center' }}>
                      {ROLE_GLYPHS[task.role_hint || ''] || '·'}
                    </span>
                    <span
                      style={{
                        fontSize: 11.5,
                        color: 'var(--white, #fff)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        flex: 1,
                      }}
                    >
                      {task.title}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    {task.rework_count > 0 && (
                      <span
                        style={{
                          fontFamily: 'var(--font-mono, ui-monospace)',
                          fontSize: 9, letterSpacing: '0.04em',
                          color: 'var(--amber, #E8A23B)',
                        }}
                      >
                        ↻ rework {task.rework_count}
                      </span>
                    )}
                    {task.diff_numstat && (
                      <span
                        style={{
                          fontFamily: 'var(--font-mono, ui-monospace)',
                          fontSize: 9, letterSpacing: '0.04em',
                          color: 'var(--green, #4CC38A)',
                        }}
                      >
                        {task.diff_numstat}
                      </span>
                    )}
                  </div>
                </button>
              ))}
              {colTasks.length === 0 && (
                <p
                  style={{
                    fontFamily: 'var(--font-mono, ui-monospace)',
                    fontSize: 10, letterSpacing: '0.12em',
                    color: 'var(--dim, rgba(255,255,255,0.32))',
                    textAlign: 'center',
                    padding: '8px 0',
                    margin: 0,
                  }}
                >
                  —
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
