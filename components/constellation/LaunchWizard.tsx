'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Star, XCircle, Plus, Trash2, ChevronLeft, ChevronRight, Zap } from 'lucide-react';
import { ROLE_GLYPHS, PHASE_ICONS } from './constants';
import { createTeam, startTeam, addTask } from '../teams/useTeamState';
import { estimateRoster, formatEstimate } from '../../lib/teams/estimate-client';

export interface WizardChatContext {
  sessionKey?: string;
  workspace?: string;
  contextSnapshot?: string;
  keyFacts?: Array<{ category: string; label: string; value: string }>;
  environment?: { name: string; saasUrl: string; appUrl: string; branch: string; supabaseRef: string };
  githubRepo?: { name: string; fullName: string; url: string; defaultBranch: string };
  recentMessages?: Array<{ role: string; content: string }>;
  goal?: string;
}

interface PresetPhase {
  name: string;
  roles: string[];
  description?: string;
}

interface Preset {
  id: string;
  name: string;
  description: string;
  roles: Array<{ role: string; handle: string; model: string }>;
  phases?: PresetPhase[];
  default_settings?: Record<string, any>;
}

interface LaunchWizardProps {
  onClose: () => void;
  onCreated: (teamId: string) => void;
  parentChatContext?: WizardChatContext;
}

interface ChatSummary {
  id: string;
  name: string;
  sessionKey: string;
  workspace?: string;
  contextSnapshot?: string;
  keyFacts?: any[];
  githubRepo?: any;
  messages?: Array<{ role: string; content: string; timestamp?: string }>;
}

const MODEL_OPTIONS = ['opus', 'sonnet', 'haiku'] as const;

const ROLE_LABEL: Record<string, string> = {
  commander: 'Commander', architect: 'Architect', builder: 'Builder', inspector: 'Inspector',
  sentinel: 'Sentinel', scout: 'Scout', scribe: 'Scribe', navigator: 'Navigator',
  security: 'Security', dba: 'DBA', tester: 'Tester', perfanalyst: 'Perf Analyst',
  uxreviewer: 'UX Reviewer', deployer: 'Deployer', apidesigner: 'API Designer', refactorer: 'Refactorer',
};

type Step = 1 | 2 | 3;

export function LaunchWizard({ onClose, onCreated, parentChatContext }: LaunchWizardProps) {
  const [step, setStep] = useState<Step>(1);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>('feature');
  const [name, setName] = useState('');
  const [goal, setGoal] = useState(parentChatContext?.goal || '');
  const [projectId, setProjectId] = useState(parentChatContext?.workspace || '');
  const [planFirst, setPlanFirst] = useState(false);
  const [requirePlanApproval, setRequirePlanApproval] = useState<boolean | null>(null); // null = use preset default
  const [tasks, setTasks] = useState<Array<{ title: string; description: string; role_hint?: string }>>([]);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [roster, setRoster] = useState<Array<{ role: string; handle: string; model: string }>>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Chat linking
  const [availableChats, setAvailableChats] = useState<ChatSummary[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(
    parentChatContext?.sessionKey ? '__parent__' : null,
  );
  const [resolvedContext, setResolvedContext] = useState<WizardChatContext | undefined>(parentChatContext);

  useEffect(() => {
    fetch('/team-presets.json')
      .then(r => (r.ok ? r.json() : []))
      .then((data: Preset[]) => setPresets(Array.isArray(data) ? data : []))
      .catch(() => setPresets([]));
  }, []);

  useEffect(() => {
    fetch('/api/chats')
      .then(r => r.json())
      .then(data => {
        const chats: ChatSummary[] = (data.sessions || [])
          .filter((s: any) => (s.messages?.length > 0 || s.workspace) && s.sessionKey)
          .slice(0, 20)
          .map((s: any) => ({
            id: s.id,
            name: s.name || `Chat ${s.id.slice(0, 6)}`,
            sessionKey: s.sessionKey,
            workspace: s.workspace,
            contextSnapshot: s.contextSnapshot,
            keyFacts: s.keyFacts,
            githubRepo: s.githubRepo,
            messages: (s.messages || []).slice(-10).map((m: any) => ({
              role: m.role,
              content: typeof m.content === 'string' ? m.content.slice(0, 500) : '',
              timestamp: m.timestamp,
            })),
          }));
        setAvailableChats(chats);
      })
      .catch(() => { /* ignore */ });
  }, []);

  useEffect(() => {
    if (selectedChatId === '__parent__' && parentChatContext) {
      setResolvedContext(parentChatContext);
      if (parentChatContext.workspace) setProjectId(parentChatContext.workspace);
      if (parentChatContext.goal) setGoal(parentChatContext.goal);
      return;
    }
    if (!selectedChatId || selectedChatId === '__none__') {
      setResolvedContext(undefined);
      return;
    }
    const chat = availableChats.find(c => c.id === selectedChatId);
    if (chat) {
      const ctx: WizardChatContext = {
        sessionKey: chat.sessionKey,
        workspace: chat.workspace,
        contextSnapshot: chat.contextSnapshot,
        keyFacts: chat.keyFacts,
        githubRepo: chat.githubRepo,
        recentMessages: chat.messages,
      };
      setResolvedContext(ctx);
      if (chat.workspace) setProjectId(chat.workspace);
    }
  }, [selectedChatId, availableChats, parentChatContext]);

  useEffect(() => {
    if (!parentChatContext?.workspace && !selectedChatId) {
      try {
        const stored = localStorage.getItem('mc_workspace');
        if (stored) {
          const parsed = JSON.parse(stored);
          setProjectId(parsed.path || parsed.workspace || '');
        }
      } catch { /* ignore */ }
    }
  }, [parentChatContext, selectedChatId]);

  const preset = useMemo(
    () => presets.find(p => p.id === selectedPresetId),
    [presets, selectedPresetId],
  );

  // When preset changes, reset roster to preset's default roles
  useEffect(() => {
    if (!preset) return;
    setRoster(preset.roles.map(r => ({ ...r })));
    setPlanFirst(preset.default_settings?.plan_first === true);
    // Reset approval override so the preset's default re-applies when switching
    setRequirePlanApproval(null);
  }, [preset]);

  const addRosterAgent = useCallback((role: string) => {
    setRoster(prev => {
      const existing = prev.filter(r => r.role === role).length;
      const handle = existing === 0 ? role : `${role}-${existing + 1}`;
      const model = role === 'architect' ? 'opus' : role === 'sentinel' || role === 'navigator' || role === 'deployer' ? 'haiku' : 'sonnet';
      return [...prev, { role, handle, model }];
    });
  }, []);

  const removeRosterAgent = useCallback((index: number) => {
    setRoster(prev => prev.filter((_, i) => i !== index));
  }, []);

  const updateRosterAgent = useCallback((index: number, patch: Partial<{ role: string; handle: string; model: string }>) => {
    setRoster(prev => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }, []);

  const canProceed1 = Boolean(selectedPresetId);
  const canProceed2 = Boolean(projectId.trim());

  const deploy = async () => {
    if (!projectId.trim()) {
      setError('Project path is required');
      setStep(2);
      return;
    }
    if (roster.length === 0) {
      setError('Roster cannot be empty');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const result = await createTeam({
        name: name.trim() || `${preset?.name || 'Custom'} ${new Date().toLocaleTimeString()}`,
        preset: selectedPresetId,
        goal: goal.trim() || undefined,
        project_id: projectId.trim(),
        parent_chat_key: resolvedContext?.sessionKey || parentChatContext?.sessionKey || undefined,
        roles: roster,
        tasks: tasks.length > 0 ? tasks : undefined,
        settings: {
          plan_first: planFirst,
          // Only override the preset default when the user explicitly toggled
          ...(requirePlanApproval !== null ? { require_plan_approval: requirePlanApproval } : {}),
        },
        chat_context: resolvedContext
          ? {
              workspace: resolvedContext.workspace || projectId.trim(),
              contextSnapshot: resolvedContext.contextSnapshot,
              keyFacts: resolvedContext.keyFacts,
              environment: resolvedContext.environment,
              githubRepo: resolvedContext.githubRepo,
              recentMessages: resolvedContext.recentMessages,
            }
          : undefined,
      });
      if (tasks.length === 0 && goal.trim()) {
        const hasArchitect = roster.some(r => r.role === 'architect');
        const hasBuilder = roster.some(r => r.role === 'builder');
        const roleHint = planFirst && hasArchitect ? 'architect' : hasBuilder ? 'builder' : undefined;
        await addTask(result.team.id, {
          title: goal.trim().slice(0, 80),
          description: goal.trim(),
          role_hint: roleHint,
        });
      }
      await startTeam(result.team.id);
      onCreated(result.team.id);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to deploy');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', justifyContent: 'center',
        background: 'rgba(0,0,0,0.72)',
        backdropFilter: 'blur(3px)',
      }}
      className="items-stretch md:items-center md:p-4"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full md:max-w-4xl md:max-h-[92vh] h-full md:h-auto md:rounded-xl"
        style={{
          display: 'flex', flexDirection: 'column',
          background: 'var(--ink, #0A0A0E)',
          border: '1px solid var(--line, rgba(255,255,255,0.08))',
          boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
          overflow: 'hidden',
          fontFamily: 'var(--font-sans, system-ui)',
          color: 'var(--white, #fff)',
        }}
      >
        {/* Header + step indicator */}
        <div
          style={{
            padding: '12px 20px',
            borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
            background: 'var(--ink-2, #131319)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 24, height: 24, borderRadius: 6,
                background: 'rgba(204, 12, 32, 0.12)',
                border: '1px solid rgba(204, 12, 32, 0.35)',
              }}
            >
              <Star style={{ width: 12, height: 12, color: 'var(--red, #CC0C20)' }} />
            </span>
            <div>
              <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
                Build · Constellation
              </div>
              <h2 style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 15, fontWeight: 600, letterSpacing: '-0.015em', margin: 0, color: 'var(--white, #fff)' }}>
                Deploy constellation
              </h2>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            {([1, 2, 3] as Step[]).map(s => (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div
                  style={{
                    width: 24, height: 24,
                    borderRadius: '50%',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'var(--font-mono, ui-monospace)',
                    fontSize: 10,
                    fontWeight: 600,
                    border: `1px solid ${step === s ? 'var(--red, #CC0C20)' : step > s ? 'rgba(204, 12, 32, 0.5)' : 'var(--line, rgba(255,255,255,0.08))'}`,
                    background: step === s ? 'rgba(204, 12, 32, 0.18)' : step > s ? 'rgba(204, 12, 32, 0.08)' : 'transparent',
                    color: step >= s ? 'var(--red, #CC0C20)' : 'var(--mist, rgba(255,255,255,0.5))',
                    boxShadow: step === s ? '0 0 12px rgba(204, 12, 32, 0.4)' : 'none',
                  }}
                >
                  {step > s ? '✓' : s}
                </div>
                {s < 3 && (
                  <span
                    style={{
                      width: 28,
                      height: 1,
                      background: step > s ? 'rgba(204, 12, 32, 0.5)' : 'var(--line, rgba(255,255,255,0.08))',
                    }}
                  />
                )}
              </div>
            ))}
          </div>
          <button
            onClick={onClose}
            data-fusio
            style={{
              padding: 4, borderRadius: 5, background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--mist, rgba(255,255,255,0.5))',
              transition: 'all 120ms ease-out',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--red, #CC0C20)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
          >
            <XCircle style={{ width: 18, height: 18 }} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {/* STEP 1 — Preset selection */}
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <div className="text-xs uppercase tracking-wider text-terminal-dim mb-1">Step 1 of 3</div>
                <h3 className="text-lg font-bold text-terminal-text mb-1">Choose a preset</h3>
                <p className="text-xs text-terminal-dim">
                  Each preset has a phased workflow. You can customize the roster in step 3.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {presets.map(p => {
                  const selected = p.id === selectedPresetId;
                  return (
                    <button
                      key={p.id}
                      onClick={() => setSelectedPresetId(p.id)}
                      className={`text-left p-3 rounded-lg border transition-all ${
                        selected
                          ? 'border-terminal-green bg-terminal-green/10 ring-1 ring-terminal-green/30'
                          : 'border-terminal-border hover:border-terminal-dim bg-terminal-surface/30'
                      }`}
                    >
                      <div className="flex items-start justify-between mb-1">
                        <div className={`font-bold text-sm ${selected ? 'text-terminal-green' : 'text-terminal-text'}`}>
                          {p.name}
                        </div>
                        <span className="text-[10px] text-terminal-dim">{p.roles.length} agents</span>
                      </div>
                      <div className="text-[11px] text-terminal-dim leading-snug mb-2 line-clamp-3">
                        {p.description}
                      </div>

                      {/* Phase pipeline preview */}
                      {p.phases && p.phases.length > 0 && (
                        <div className="flex items-center gap-1 text-[10px] flex-wrap">
                          {p.phases.map((ph, i) => (
                            <span key={i} className="flex items-center gap-1">
                              {i > 0 && <span className="text-terminal-dim">→</span>}
                              <span
                                className={`px-1.5 py-0.5 rounded ${
                                  selected
                                    ? 'bg-terminal-surface text-terminal-green'
                                    : 'bg-terminal-surface/70 text-terminal-dim'
                                }`}
                              >
                                {ph.name}
                              </span>
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Role glyphs */}
                      <div className="flex items-center gap-1 mt-2 flex-wrap text-sm">
                        {p.roles.slice(0, 10).map((r, i) => (
                          <span key={i} className="text-terminal-dim" title={`${ROLE_LABEL[r.role] || r.role}: ${r.handle}`}>
                            {ROLE_GLYPHS[r.role] || '·'}
                          </span>
                        ))}
                        {p.roles.length > 10 && (
                          <span className="text-[10px] text-terminal-dim">+{p.roles.length - 10}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* STEP 2 — Mission brief */}
          {step === 2 && (
            <div className="space-y-4">
              <div>
                <div className="text-xs uppercase tracking-wider text-terminal-dim mb-1">Step 2 of 3</div>
                <h3 className="text-lg font-bold text-terminal-text mb-1">Mission brief</h3>
                <p className="text-xs text-terminal-dim">Link a chat, set the project path, describe the mission.</p>
              </div>

              {/* Chat link */}
              <div>
                <label className="block text-xs text-terminal-dim mb-1">
                  Link to a Chat <span className="text-terminal-cyan">(inherits keys, credentials, environment, history)</span>
                </label>
                <select
                  value={selectedChatId || '__none__'}
                  onChange={e => setSelectedChatId(e.target.value === '__none__' ? null : e.target.value)}
                  className="w-full bg-terminal-surface border border-terminal-border rounded px-3 py-2 text-sm text-terminal-text"
                >
                  <option value="__none__">No linked chat (manual setup)</option>
                  {parentChatContext?.sessionKey && <option value="__parent__">Current chat (auto-detected)</option>}
                  {availableChats.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.workspace ? ` — ${c.workspace.split('/').pop()}` : ''}
                      {c.keyFacts?.length ? ` (${c.keyFacts.length} keys)` : ''}
                    </option>
                  ))}
                </select>
                {resolvedContext && selectedChatId && selectedChatId !== '__none__' && (
                  <div className="mt-2 p-2 rounded bg-terminal-green/5 border border-terminal-green/20 text-xs space-y-0.5">
                    <div className="text-terminal-green font-bold">Context inherited:</div>
                    {resolvedContext.workspace && (
                      <div className="text-terminal-dim">
                        Workspace: <span className="text-terminal-text">{resolvedContext.workspace}</span>
                      </div>
                    )}
                    {resolvedContext.keyFacts && resolvedContext.keyFacts.length > 0 && (
                      <div className="text-terminal-dim">
                        Key facts: <span className="text-terminal-cyan">{resolvedContext.keyFacts.length} credentials/URLs/config</span>
                      </div>
                    )}
                    {resolvedContext.environment && (
                      <div className="text-terminal-dim">
                        Environment: <span className="text-terminal-amber">{resolvedContext.environment.name?.toUpperCase()}</span>
                      </div>
                    )}
                    {resolvedContext.githubRepo && (
                      <div className="text-terminal-dim">
                        GitHub: <span className="text-terminal-text">{(resolvedContext.githubRepo as any).fullName || (resolvedContext.githubRepo as any).name}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Project path */}
              <div>
                <label className="block text-xs text-terminal-dim mb-1">Project path *</label>
                <input
                  value={projectId}
                  onChange={e => setProjectId(e.target.value)}
                  className="w-full bg-terminal-surface border border-terminal-border rounded px-3 py-2 text-sm text-terminal-text font-mono"
                  placeholder="/home/user/project"
                />
              </div>

              {/* Name */}
              <div>
                <label className="block text-xs text-terminal-dim mb-1">Constellation name (optional)</label>
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full bg-terminal-surface border border-terminal-border rounded px-3 py-2 text-sm text-terminal-text"
                  placeholder={preset?.name || 'Orion'}
                />
              </div>

              {/* Mission brief */}
              <div>
                <label className="block text-xs text-terminal-dim mb-1">Mission brief</label>
                <textarea
                  value={goal}
                  onChange={e => setGoal(e.target.value)}
                  rows={4}
                  className="w-full bg-terminal-surface border border-terminal-border rounded px-3 py-2 text-sm text-terminal-text resize-none"
                  placeholder="Describe what you want the team to build/fix/research..."
                />
              </div>

              {/* Initial tasks */}
              <div>
                <label className="block text-xs text-terminal-dim mb-1">Initial tasks (optional)</label>
                <div className="space-y-1">
                  {tasks.map((t, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 text-xs text-terminal-text bg-terminal-surface/50 p-2 rounded"
                    >
                      <span className="flex-1 truncate">{t.title}</span>
                      <button
                        onClick={() => setTasks(prev => prev.filter((_, j) => j !== i))}
                        className="text-terminal-red hover:text-terminal-text"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  <input
                    value={newTaskTitle}
                    onChange={e => setNewTaskTitle(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newTaskTitle.trim()) {
                        setTasks(prev => [
                          ...prev,
                          { title: newTaskTitle.trim(), description: newTaskTitle.trim(), role_hint: 'builder' },
                        ]);
                        setNewTaskTitle('');
                      }
                    }}
                    className="w-full bg-terminal-surface border border-terminal-border rounded px-2 py-1 text-xs text-terminal-text"
                    placeholder="Add a task and press Enter..."
                  />
                </div>
              </div>

              {/* Plan first toggle */}
              {preset && roster.some(r => r.role === 'architect') && (
                <label className="flex items-center gap-3 p-3 rounded bg-terminal-surface/50 border border-terminal-border cursor-pointer">
                  <input
                    type="checkbox"
                    checked={planFirst}
                    onChange={e => setPlanFirst(e.target.checked)}
                    className="accent-terminal-green w-4 h-4"
                  />
                  <div>
                    <div className="text-sm text-terminal-text font-medium">Plan First</div>
                    <div className="text-xs text-terminal-dim">
                      ◆ Architect explores &amp; creates tasks before other agents spawn
                    </div>
                  </div>
                </label>
              )}

              {/* Plan approval gate toggle */}
              {preset && roster.some(r => r.role === 'architect') && (() => {
                const presetDefault = preset.default_settings?.require_plan_approval === true;
                const effective = requirePlanApproval ?? presetDefault;
                return (
                  <label className={`flex items-center gap-3 p-3 rounded border cursor-pointer ${
                    effective
                      ? 'bg-terminal-amber/5 border-terminal-amber/40'
                      : 'bg-terminal-surface/50 border-terminal-border'
                  }`}>
                    <input
                      type="checkbox"
                      checked={effective}
                      onChange={e => setRequirePlanApproval(e.target.checked)}
                      className="accent-terminal-amber w-4 h-4"
                    />
                    <div className="flex-1">
                      <div className="text-sm text-terminal-text font-medium flex items-center gap-2">
                        🔒 Require plan approval before team spawns
                        {presetDefault && requirePlanApproval === null && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-terminal-amber/20 text-terminal-amber uppercase tracking-wider">preset default</span>
                        )}
                        {requirePlanApproval !== null && requirePlanApproval !== presetDefault && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-terminal-cyan/20 text-terminal-cyan uppercase tracking-wider">overridden</span>
                        )}
                      </div>
                      <div className="text-xs text-terminal-dim mt-0.5">
                        Architect does recon → posts plan + questions → waits for your <b>Approve</b> before spawning the rest of the team.
                        {presetDefault && !effective && (
                          <span className="text-terminal-amber"> Warning: this preset is gated by default.</span>
                        )}
                      </div>
                    </div>
                  </label>
                );
              })()}
            </div>
          )}

          {/* STEP 3 — Roster + phases preview */}
          {step === 3 && (
            <div className="space-y-4">
              <div>
                <div className="text-xs uppercase tracking-wider text-terminal-dim mb-1">Step 3 of 3</div>
                <h3 className="text-lg font-bold text-terminal-text mb-1">Team roster &amp; workflow</h3>
                <p className="text-xs text-terminal-dim">
                  Review the team. Add, remove, or re-model agents before launch.
                </p>
              </div>

              {/* Phase workflow */}
              {preset?.phases && preset.phases.length > 0 && (
                <div className="p-3 rounded border border-terminal-border bg-terminal-surface/30">
                  <div className="text-[10px] uppercase tracking-wider text-terminal-dim mb-2">Workflow</div>
                  <div className="flex items-start gap-2 overflow-x-auto pb-1">
                    {preset.phases.map((ph, i) => (
                      <div key={i} className="flex items-center gap-2 flex-shrink-0">
                        {i > 0 && <span className="text-terminal-dim mt-2">→</span>}
                        <div className="p-2 rounded border border-terminal-border bg-terminal-bg min-w-[140px]">
                          <div className="flex items-center gap-1 mb-1">
                            <span className="text-terminal-dim">{PHASE_ICONS.pending}</span>
                            <span className="text-[11px] font-bold text-terminal-text">{ph.name}</span>
                          </div>
                          {ph.description && (
                            <div className="text-[10px] text-terminal-dim leading-snug mb-1">{ph.description}</div>
                          )}
                          <div className="flex items-center gap-1 text-sm">
                            {ph.roles.map(r => (
                              <span key={r} className="text-terminal-dim" title={ROLE_LABEL[r] || r}>
                                {ROLE_GLYPHS[r] || '·'}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Roster editor */}
              <div className="p-3 rounded border border-terminal-border bg-terminal-surface/30">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[10px] uppercase tracking-wider text-terminal-dim">
                    Roster ({roster.length} agents)
                  </div>
                  <select
                    onChange={e => {
                      if (e.target.value) {
                        addRosterAgent(e.target.value);
                        e.target.value = '';
                      }
                    }}
                    value=""
                    className="bg-terminal-surface border border-terminal-border rounded px-2 py-1 text-[11px] text-terminal-cyan"
                  >
                    <option value="">+ Add agent...</option>
                    {Object.keys(ROLE_LABEL).map(r => (
                      <option key={r} value={r}>
                        {ROLE_GLYPHS[r]} {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  {roster.length === 0 && (
                    <p className="text-center text-terminal-dim text-xs py-3">No agents — add at least one</p>
                  )}
                  {roster.map((r, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 p-2 rounded bg-terminal-bg border border-terminal-border text-xs"
                    >
                      <span className="text-base w-5 text-center">{ROLE_GLYPHS[r.role] || '·'}</span>
                      <select
                        value={r.role}
                        onChange={e => updateRosterAgent(i, { role: e.target.value })}
                        className="bg-terminal-surface border border-terminal-border rounded px-2 py-0.5 text-[11px] text-terminal-text"
                      >
                        {Object.keys(ROLE_LABEL).map(role => (
                          <option key={role} value={role}>
                            {ROLE_LABEL[role]}
                          </option>
                        ))}
                      </select>
                      <input
                        value={r.handle}
                        onChange={e => updateRosterAgent(i, { handle: e.target.value })}
                        className="flex-1 bg-terminal-surface border border-terminal-border rounded px-2 py-0.5 text-[11px] text-terminal-text"
                      />
                      <select
                        value={r.model}
                        onChange={e => updateRosterAgent(i, { model: e.target.value })}
                        className="bg-terminal-surface border border-terminal-border rounded px-2 py-0.5 text-[11px] text-terminal-dim"
                      >
                        {MODEL_OPTIONS.map(m => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => removeRosterAgent(i)}
                        className="text-terminal-red/60 hover:text-terminal-red p-1"
                        title="Remove"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Pre-flight estimate */}
              {(() => {
                const est = estimateRoster(roster);
                if (est.agentCount === 0) return null;
                const expensive = est.costMidUsd >= 5;
                return (
                  <div className={`p-3 rounded border text-xs ${expensive ? 'border-terminal-amber/40 bg-terminal-amber/5' : 'border-terminal-cyan/30 bg-terminal-cyan/5'}`}>
                    <div className="text-[10px] uppercase tracking-wider text-terminal-dim mb-1">Pre-flight estimate</div>
                    <div className={`font-mono ${expensive ? 'text-terminal-amber' : 'text-terminal-cyan'}`}>
                      {formatEstimate(est)}
                    </div>
                    <div className="text-[10px] text-terminal-dim mt-1">
                      Rough estimate from typical-tokens table; actuals depend on file sizes, recon depth, and rework cycles.
                    </div>
                  </div>
                );
              })()}

              {/* Summary */}
              <div className="p-3 rounded border border-terminal-border bg-terminal-surface/30 text-xs space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-terminal-dim mb-1">Summary</div>
                <div className="text-terminal-dim">
                  Project: <span className="text-terminal-text font-mono">{projectId || '(not set)'}</span>
                </div>
                <div className="text-terminal-dim">
                  Preset: <span className="text-terminal-green">{preset?.name || '—'}</span>
                </div>
                {goal && (
                  <div className="text-terminal-dim">
                    Goal: <span className="text-terminal-text">{goal.slice(0, 120)}{goal.length > 120 ? '…' : ''}</span>
                  </div>
                )}
                {resolvedContext?.sessionKey && (
                  <div className="text-terminal-dim">
                    Linked chat: <span className="text-terminal-cyan">yes — context will be inherited</span>
                  </div>
                )}
                {planFirst && (
                  <div className="text-terminal-amber">◆ Plan First enabled — architect plans before others spawn</div>
                )}
                {(() => {
                  const presetDefault = preset?.default_settings?.require_plan_approval === true;
                  const effective = requirePlanApproval ?? presetDefault;
                  if (effective) return (
                    <div className="text-terminal-amber">🔒 Plan approval gate ON — architect will pause for your Approve before spawning the team</div>
                  );
                  if (presetDefault && !effective) return (
                    <div className="text-terminal-red">⚠ Plan approval gate DISABLED (preset defaults to ON) — team will run without your review</div>
                  );
                  return null;
                })()}
              </div>

              {error && (
                <div className="p-3 rounded bg-terminal-red/10 border border-terminal-red/30 text-terminal-red text-sm">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer nav */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-terminal-border bg-terminal-surface/40">
          <button
            onClick={() => (step === 1 ? onClose() : setStep((step - 1) as Step))}
            className="flex items-center gap-1 px-3 py-2 text-sm rounded border border-terminal-border text-terminal-dim hover:text-terminal-text transition"
          >
            <ChevronLeft className="w-4 h-4" /> {step === 1 ? 'Cancel' : 'Back'}
          </button>

          {step < 3 && (
            <button
              onClick={() => {
                if (step === 1 && !canProceed1) return;
                if (step === 2 && !canProceed2) {
                  setError('Project path is required');
                  return;
                }
                setError(null);
                setStep((step + 1) as Step);
              }}
              disabled={(step === 1 && !canProceed1) || (step === 2 && !canProceed2)}
              className="flex items-center gap-1 px-4 py-2 text-sm rounded bg-terminal-green/20 border border-terminal-green/30 text-terminal-green hover:bg-terminal-green/30 transition disabled:opacity-50 font-bold"
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
          )}

          {step === 3 && (
            <button
              onClick={deploy}
              disabled={creating || roster.length === 0}
              className="flex items-center gap-1 px-5 py-2 text-sm rounded bg-terminal-green text-terminal-bg font-bold hover:bg-terminal-green/90 transition disabled:opacity-50"
            >
              {creating ? 'Deploying...' : <><Zap className="w-4 h-4" /> Deploy Constellation</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
