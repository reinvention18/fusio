/**
 * Fusio right rail — design's 340 px tabbed sidebar for Tasks / Notepad /
 * Agents. Uses `.right-rail` / `.rail-head` / `.rail-body` / `.task` styles
 * from /fusio/mc.css.
 *
 * - Tasks tab: list of active sub-agent runs from /api/subagents
 * - Notepad tab: embeds the existing <SharedNotepad/> (already realtime)
 * - Agents tab: catalog from /api/agents or matched-personas info
 */

'use client';

import { useEffect, useState } from 'react';
import { I } from './Icons';
import { SharedNotepad } from '../SharedNotepad';

type RailMode = 'tasks' | 'notepad' | 'agents' | 'skills';

interface RightRailProps {
  open?: boolean;
  initialMode?: RailMode;
  onClose?: () => void;
}

interface SubAgent {
  id?: string;
  name?: string;
  status?: 'running' | 'done' | 'queued' | 'idle' | 'error';
  startedAt?: string | number;
  endedAt?: string | number;
  agent?: string;
  task?: string;
  progress?: number;
  events?: Array<{ ts: string; agent?: string; text?: string }>;
}

function relTime(ts?: string | number): string {
  if (!ts) return '';
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime();
  if (!t || isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(t).toLocaleDateString();
}

function TasksList() {
  const [tasks, setTasks] = useState<SubAgent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/subagents', { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (!alive) return;
        const list: SubAgent[] = Array.isArray(j) ? j : (j?.subagents || j?.agents || []);
        setTasks(list);
      } catch { /* network blip */ }
      finally { setLoading(false); }
    };
    load();
    const iv = setInterval(load, 4000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  if (loading && tasks.length === 0) {
    return <div style={{ color: 'var(--mist)', fontSize: 12 }}>Loading tasks…</div>;
  }
  if (tasks.length === 0) {
    return <div style={{ color: 'var(--mist)', fontSize: 12 }}>No active tasks.</div>;
  }

  return (
    <>
      {tasks.map((tk, i) => {
        // Map our status onto the design's CSS modifier classes so the
        // pulsing green/cyan/amber/red dots work via /fusio/mc.css.
        const designStatus =
          tk.status === 'running' ? 'running' :
          tk.status === 'done'    ? 'done'    :
          tk.status === 'queued'  ? 'queued'  :
          tk.status === 'error'   ? 'failed'  :
          'queued';
        const hasProgress = typeof tk.progress === 'number';
        return (
          <div className="task" key={tk.id || i}>
            <div className="task-head">
              <span className={`status ${designStatus}`}>{designStatus}</span>
              <span className="time">{relTime(tk.startedAt) || '—'}</span>
            </div>
            <div className="task-title">
              {tk.name || tk.task || tk.agent || tk.id || 'Untitled task'}
            </div>
            {hasProgress && (
              <div className="task-prog">
                <i style={{ width: `${Math.max(0, Math.min(100, tk.progress || 0))}%` }} />
              </div>
            )}
            {tk.events && tk.events.length > 0 && (
              <div className="task-events">
                {tk.events.slice(-3).map((e, idx) => (
                  <div className="ev" key={idx}>
                    <span className="ts">{e.ts}</span>
                    {e.agent && <span className="agent">{e.agent}:</span>}
                    <span>{e.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * Notepad pane — uses the design's `.notepad-area` + `.notepad-status`
 * classes for the status strip + textarea chrome. Hosts the existing
 * SharedNotepad so the realtime peer-sync still works.
 *
 * The status strip surfaces SharedNotepad's saved/version/byline data
 * via the same custom events it already dispatches.
 */
function NotepadEmbed() {
  return (
    <div className="notepad-area">
      <SharedNotepad padId="default" />
    </div>
  );
}

function AgentsList() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/agents', { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (alive) setData(j);
      } catch { /* skip */ }
    };
    load();
    const iv = setInterval(load, 8000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  if (!data) return <div style={{ color: 'var(--mist)', fontSize: 12 }}>Loading agents…</div>;
  const list = Array.isArray(data) ? data : data?.agents || [];
  if (list.length === 0) return <div style={{ color: 'var(--mist)', fontSize: 12 }}>No agents to display.</div>;
  return (
    <>
      {list.slice(0, 50).map((a: any, i: number) => (
        <div className="task" key={a.id || a.name || i}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ color: 'var(--white)', fontSize: 13, fontWeight: 500 }}>
              {a.name || a.id || 'unnamed'}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--mist)', letterSpacing: '0.16em', textTransform: 'uppercase' }}>
              {a.status || a.state || 'idle'}
            </span>
          </div>
          {a.description && (
            <div style={{ color: 'var(--fog)', fontSize: 12, marginTop: 2 }}>
              {String(a.description).slice(0, 140)}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/**
 * Skills pane — catalog of installed skills the user can tap to inject
 * into the active chat (stacks on top of any already-active skills).
 * Each skill fires `mc-chat-inject-skill` with `{ skillName }`; ChatPanel
 * appends a system message that surfaces the skill marker so the existing
 * activeSkills tracker picks it up and downstream model calls receive
 * the skill context.
 */
interface SkillItem {
  name: string;
  description?: string;
  enabled?: boolean;
  category?: string;
  path?: string;
}

function SkillsList() {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [injected, setInjected] = useState<Record<string, number>>({});

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/skills?action=list', { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (!alive) return;
        const list: SkillItem[] = Array.isArray(j?.skills) ? j.skills : [];
        // Only enabled skills are injectable — disabled ones would be a
        // dead-end click.
        setSkills(list.filter(s => s.enabled !== false));
      } catch { /* ignore */ }
      finally { if (alive) setLoading(false); }
    };
    load();
    return () => { alive = false; };
  }, []);

  const inject = (skill: SkillItem) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('mc-chat-inject-skill', {
      detail: { name: skill.name, description: skill.description, path: skill.path },
    }));
    // Visual flash so the user knows it landed.
    setInjected(prev => ({ ...prev, [skill.name]: Date.now() }));
    setTimeout(() => {
      setInjected(prev => {
        const next = { ...prev };
        delete next[skill.name];
        return next;
      });
    }, 1500);
  };

  const q = filter.trim().toLowerCase();
  const filtered = q
    ? skills.filter(s =>
        (s.name || '').toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q)
      )
    : skills;

  if (loading) {
    return <div style={{ color: 'var(--mist)', fontSize: 12 }}>Loading skills…</div>;
  }
  if (skills.length === 0) {
    return <div style={{ color: 'var(--mist)', fontSize: 12 }}>No skills installed.</div>;
  }

  return (
    <>
      <div style={{ position: 'sticky', top: 0, paddingBottom: 8, background: 'var(--ink, #0A0A0E)', zIndex: 1 }}>
        <input
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder={`Search ${skills.length} skills…`}
          style={{
            width: '100%',
            padding: '7px 10px',
            background: 'var(--ink-2, #131319)',
            border: '1px solid var(--line, rgba(255,255,255,0.08))',
            borderRadius: 8,
            color: 'var(--white, #fff)',
            fontSize: 13,
            outline: 'none',
          }}
        />
        <div style={{
          marginTop: 6,
          fontFamily: 'var(--font-mono, ui-monospace)',
          fontSize: 9.5,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--dim, rgba(255,255,255,0.4))',
        }}>
          {filtered.length} of {skills.length} · tap to inject into chat
        </div>
      </div>
      {filtered.slice(0, 200).map((s) => {
        const isInjected = !!injected[s.name];
        return (
          <button
            key={s.name}
            type="button"
            onClick={() => inject(s)}
            className="task"
            style={{
              width: '100%',
              textAlign: 'left',
              cursor: 'pointer',
              border: '1px solid',
              borderColor: isInjected ? 'var(--green, #4CC38A)' : 'var(--line, rgba(255,255,255,0.08))',
              background: isInjected ? 'rgba(76, 195, 138, 0.08)' : undefined,
              transition: 'border-color 180ms ease-out, background 180ms ease-out',
            }}
            title={`Inject "${s.name}" into the active chat`}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
              <span style={{ color: 'var(--white)', fontSize: 13, fontWeight: 500, lineHeight: 1.25, flex: 1, minWidth: 0 }}>
                {s.name}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9.5,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: isInjected ? 'var(--green)' : 'var(--mist)',
                  flexShrink: 0,
                }}
              >
                {isInjected ? '✓ injected' : (s.category || 'skill')}
              </span>
            </div>
            {s.description && (
              <div style={{ color: 'var(--fog)', fontSize: 11.5, lineHeight: 1.45 }}>
                {String(s.description).slice(0, 180)}
                {String(s.description).length > 180 ? '…' : ''}
              </div>
            )}
          </button>
        );
      })}
    </>
  );
}

export function FusioRightRail({ open = true, initialMode = 'tasks', onClose }: RightRailProps) {
  const [mode, setMode] = useState<RailMode>(initialMode);

  return (
    <aside className={`right-rail ${open ? 'open' : ''}`}>
      <div className="rail-head">
        <div className="tabs">
          <button className={mode === 'tasks' ? 'active' : ''} onClick={() => setMode('tasks')}>Tasks</button>
          <button className={mode === 'notepad' ? 'active' : ''} onClick={() => setMode('notepad')}>Notepad</button>
          <button className={mode === 'skills' ? 'active' : ''} onClick={() => setMode('skills')}>Skills</button>
          <button className={mode === 'agents' ? 'active' : ''} onClick={() => setMode('agents')}>Agents</button>
        </div>
        <button
          type="button"
          style={{
            color: 'var(--mist)', width: 28, height: 28, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: 'none', cursor: onClose ? 'pointer' : 'default',
            opacity: onClose ? 1 : 0.4,
          }}
          onClick={onClose}
          title={onClose ? 'Close right rail' : 'Always-on right rail'}
          disabled={!onClose}
        >
          {I.close}
        </button>
      </div>
      {mode === 'tasks'   && <div className="rail-body"><TasksList /></div>}
      {mode === 'notepad' && <NotepadEmbed />}
      {mode === 'skills'  && <div className="rail-body"><SkillsList /></div>}
      {mode === 'agents'  && <div className="rail-body"><AgentsList /></div>}
    </aside>
  );
}
