'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, Square, GitMerge, Trash2, Plus, Zap,
  FileText, MessageSquare, ClipboardList, ShieldAlert,
  MessageCircle, Layers, Target, Brain, Menu, Users, X,
} from 'lucide-react';
import { MemoryPanel } from '../mem/MemoryPanel';
import { useTeamNotifications } from '../notifications/useConstellationNotifications';
import MemVaultStatusBadge from '../MemVaultStatusBadge';
import {
  useTeamList, useTeamData, useTeamEvents,
  useTeamMessages, useTeamPhases, useTeamDecisions, useTeamReviews,
  useCommanderThread, useDeliverable,
  startTeam, haltTeam, mergeApproved,
  type TaskData, type AgentData,
} from '../teams/useTeamState';
import type { WizardChatContext } from './LaunchWizard';
import { PhaseBar } from './PhaseBar';
import { TeamRoster } from './TeamRoster';
import { TaskFlow } from './TaskFlow';
import { MessageLog } from './MessageLog';
import { CodexReviews } from './CodexReviews';
import { DecisionsLog } from './DecisionsLog';
import { LaunchWizard } from './LaunchWizard';
import { MissionBrief } from './MissionBrief';
import { ArchitectChat } from './ArchitectChat';
import { Deliverable } from './Deliverable';
import { Overview } from './Overview';
import { STATUS_COLORS, STATUS_DOTS, ROLE_GLYPHS } from './constants';

type MainTab = 'architect' | 'overview' | 'tasks' | 'deliverable' | 'messages' | 'decisions' | 'codex' | 'memory';

/**
 * Helper — build a Fusio-style action button (used in the panel header).
 * Returns inline styles tinted by the supplied accent. Hover brighten is
 * handled by the global polish layer (data-fusio + .card-btn-like patterns).
 */
function fusioActionBtn(accent: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '4px 10px',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: 10,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    borderRadius: 5,
    background: `color-mix(in srgb, ${accent} 10%, transparent)`,
    color: accent,
    border: `1px solid color-mix(in srgb, ${accent} 35%, transparent)`,
    cursor: 'pointer',
    transition: 'filter 120ms ease-out',
  };
}

interface AgentFocusProps {
  agent: AgentData;
  tasks: TaskData[];
  onClose: () => void;
}

function AgentFocus({ agent, tasks, onClose }: AgentFocusProps) {
  const currentTask = tasks.find(t => t.id === agent.current_task_id);
  const glyph = ROLE_GLYPHS[agent.role] || '●';
  const color = STATUS_COLORS[agent.status] || 'text-terminal-dim';

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className="md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="md:static md:border-l border-terminal-border bg-terminal-bg flex flex-col md:w-72 md:flex-shrink-0 fixed inset-x-0 top-0 bottom-0 z-50 md:z-auto md:inset-auto md:top-auto md:bottom-auto">
        <div className="p-3 border-b border-terminal-border flex items-center gap-2 bg-terminal-surface/40">
          <span className="text-xl">{glyph}</span>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-terminal-text text-base md:text-sm truncate">{agent.role_handle}</div>
            <div className={`text-[11px] ${color} uppercase`}>{agent.status}</div>
          </div>
          <button onClick={onClose} className="text-terminal-dim hover:text-terminal-text p-2 md:p-0 md:text-lg md:leading-none" aria-label="Close">
            <X className="w-5 h-5 md:w-4 md:h-4" />
          </button>
        </div>

      <div className="p-3 border-b border-terminal-border space-y-1 text-[11px]">
        <div className="text-terminal-dim">
          Role: <span className="text-terminal-text">{agent.role}</span>
        </div>
        <div className="text-terminal-dim">
          Model: <span className="text-terminal-text">{agent.model.replace('claude-', '').replace(/-\d.*/, '')}</span>
        </div>
        <div className="text-terminal-dim truncate" title={agent.worktree_path}>
          Worktree: <span className="text-terminal-cyan font-mono">{agent.worktree_path.split('/').pop()}</span>
        </div>
        {agent.branch_name && (
          <div className="text-terminal-dim truncate" title={agent.branch_name}>
            Branch: <span className="text-terminal-cyan font-mono">{agent.branch_name}</span>
          </div>
        )}
        {agent.status_reason && (
          <div className="text-terminal-red mt-1 break-words">{agent.status_reason}</div>
        )}
      </div>

      {currentTask && (
        <div className="p-3 border-b border-terminal-border">
          <div className="text-[10px] uppercase tracking-wider text-terminal-dim mb-1">Current task</div>
          <div className="text-[12px] text-terminal-text font-medium">{currentTask.title}</div>
          <div className="text-[10px] text-terminal-dim mt-1">
            Status: <span className={STATUS_COLORS[currentTask.status] || 'text-terminal-dim'}>{currentTask.status}</span>
          </div>
        </div>
      )}

        <div className="p-3 text-[11px] text-terminal-dim flex-1 overflow-y-auto">
          <p className="italic leading-relaxed">
            Talk to this agent's boss (the architect) to change their work. Use the 💬 Architect tab — they'll decide
            how to re-direct their team.
          </p>
        </div>
      </div>
    </>
  );
}

interface ConstellationPanelProps {
  parentChatContext?: WizardChatContext;
}

export function ConstellationPanel({ parentChatContext }: ConstellationPanelProps) {
  const { teams, loading: listLoading, refresh: refreshList } = useTeamList();
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [activePhaseFilter, setActivePhaseFilter] = useState<string | null>(null);
  const [mainTab, setMainTab] = useState<MainTab>('architect');
  const [showLauncher, setShowLauncher] = useState(false);
  const [launcherContext, setLauncherContext] = useState<WizardChatContext | undefined>(parentChatContext);
  const [mobileTeamsOpen, setMobileTeamsOpen] = useState(false);
  const [mobileRosterOpen, setMobileRosterOpen] = useState(false);

  const { data: teamData, refresh: refreshTeam } = useTeamData(selectedTeamId);
  const events = useTeamEvents(selectedTeamId);
  const messages = useTeamMessages(selectedTeamId);
  const phases = useTeamPhases(selectedTeamId);
  const decisions = useTeamDecisions(selectedTeamId);
  const { reviews, findings } = useTeamReviews(selectedTeamId);
  const { messages: thread, refresh: refreshThread } = useCommanderThread(selectedTeamId);
  const deliverable = useDeliverable(selectedTeamId);

  // Listen for deploy-from-chat events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.action === 'deploy-constellation') {
        setLauncherContext(detail.chatContext || undefined);
        setShowLauncher(true);
      }
    };
    window.addEventListener('mc-constellation', handler);
    return () => window.removeEventListener('mc-constellation', handler);
  }, []);

  // Auto-select first team
  useEffect(() => {
    if (!selectedTeamId && teams.length > 0) setSelectedTeamId(teams[0].id);
  }, [teams, selectedTeamId]);

  const autoJumpedForTeam = useRef<string | null>(null);

  // Auto-switch to Deliverable when mission first completes — fire whenever
  // the team transitions to a completed state and a deliverable exists, not
  // only when the architect tab is empty. The deliverable is the headline
  // outcome; the commander shouldn't have to hunt for it.
  const team = teamData?.team;
  const deliverableReady = Boolean(deliverable?.scratchpad_section || deliverable?.scribe_report);
  const lastAutoTabbedTeam = useRef<string | null>(null);
  useEffect(() => {
    if (!team) return;
    const isComplete = ['done', 'completed'].includes(team.status);
    if (isComplete && deliverableReady && lastAutoTabbedTeam.current !== team.id) {
      lastAutoTabbedTeam.current = team.id;
      setMainTab('deliverable');
    }
  }, [team, deliverableReady]);
  const agents = useMemo(() => teamData?.agents || [], [teamData]);
  const tasks = useMemo(() => teamData?.tasks || [], [teamData]);
  const summary = teamData?.summary;
  const selectedAgent = agents.find(a => a.id === selectedAgentId) || null;

  const openCritical = useMemo(
    () => findings.filter(f => f.status === 'open' && (f.severity === 'critical' || f.severity === 'high')).length,
    [findings],
  );

  // Unread commander messages indicator (architect messages we haven't shown yet)
  const unreadFromArchitect = useMemo(() => {
    return thread.filter(m => m.from_agent_id !== null && !m.delivered_at).length;
  }, [thread]);

  // Watch team state for notification-worthy transitions
  const latestArchitectMsg = useMemo(() => {
    const fromArch = thread.filter(m => m.from_agent_id !== null);
    if (fromArch.length === 0) return null;
    const last = fromArch[fromArch.length - 1];
    let meta: any = {};
    try { meta = JSON.parse(last.metadata_json || '{}'); } catch { /* ignore */ }
    return { urgency: meta.urgency, body: last.body };
  }, [thread]);

  // Detect an unanswered plan-approval request — the architect posted "🔒 PLAN
  // APPROVAL REQUIRED" and no later commander message has landed.
  const awaitingPlanApproval = useMemo(() => {
    let pending: { body: string; createdAt: number } | null = null;
    for (const m of thread) {
      if (m.from_agent_id && /^\s*🔒\s*PLAN APPROVAL REQUIRED/i.test(m.body || '')) {
        pending = { body: m.body, createdAt: m.created_at };
      } else if (!m.from_agent_id && pending && m.created_at > pending.createdAt) {
        pending = null; // commander replied → resolved
      }
    }
    return pending;
  }, [thread]);

  // Auto-jump to Architect tab the first time an awaiting-approval team is
  // selected, so the plan is visible immediately.
  useEffect(() => {
    if (!team || !awaitingPlanApproval) return;
    if (autoJumpedForTeam.current !== team.id) {
      autoJumpedForTeam.current = team.id;
      setMainTab('architect');
    }
  }, [team, awaitingPlanApproval]);

  useTeamNotifications({
    teamId: team?.id || null,
    teamStatus: team?.status,
    threadLen: thread.length,
    latestArchitectMsg,
    openCriticalFindings: openCritical,
    tasks: tasks.map(t => ({ status: t.status })),
  });

  // External navigation requests from notifications
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.teamId) return;
      if (detail.teamId !== selectedTeamId) setSelectedTeamId(detail.teamId);
      if (detail.tab && ['architect', 'overview', 'tasks', 'deliverable', 'memory', 'messages', 'decisions', 'codex'].includes(detail.tab)) {
        setMainTab(detail.tab);
      }
    };
    window.addEventListener('mc-jump-team-tab', handler);
    return () => window.removeEventListener('mc-jump-team-tab', handler);
  }, [selectedTeamId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key.toLowerCase();
      if (key === 'n' && !e.metaKey && !e.ctrlKey) { setShowLauncher(true); e.preventDefault(); }
      if (key === 'escape') { setSelectedAgentId(null); setActivePhaseFilter(null); }
      if (key === 'p' && !e.metaKey && !e.ctrlKey && team?.status === 'running') {
        haltTeam(team.id).then(refreshTeam);
      }
      if (key === 'r' && !e.metaKey && !e.ctrlKey && (team?.status === 'idle' || team?.status === 'paused')) {
        startTeam(team!.id).then(refreshTeam);
      }
      if (key === 'm' && !e.metaKey && !e.ctrlKey && team && tasks.some(t => t.status === 'approved')) {
        mergeApproved(team.id).then(refreshTeam);
      }
      // Tab switcher: 1..7
      const map: Record<string, MainTab> = {
        '1': 'architect', '2': 'overview', '3': 'tasks', '4': 'deliverable',
        '5': 'messages', '6': 'decisions', '7': 'codex',
      };
      if (map[e.key]) { setMainTab(map[e.key]); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [team, tasks, refreshTeam]);

  const tabs: Array<{ id: MainTab; label: string; icon: React.ComponentType<{ className?: string }>; count?: number; alert?: boolean }> = [
    { id: 'architect', label: 'Architect', icon: MessageCircle, count: thread.length, alert: unreadFromArchitect > 0 },
    { id: 'overview', label: 'Overview', icon: Layers },
    { id: 'tasks', label: 'Tasks', icon: ClipboardList, count: summary?.total },
    { id: 'deliverable', label: 'Deliverable', icon: Target, alert: deliverableReady },
    { id: 'memory', label: 'Memory', icon: Brain },
    { id: 'messages', label: 'Messages', icon: MessageSquare, count: messages.length },
    { id: 'decisions', label: 'Decisions', icon: FileText, count: decisions.length + phases.length },
    { id: 'codex', label: 'Codex', icon: ShieldAlert, count: findings.length, alert: openCritical > 0 },
  ];

  return (
    <div
      style={{
        height: '100%',
        display: 'flex', flexDirection: 'column',
        background: 'var(--void, #050507)',
        minHeight: 0,
        fontFamily: 'var(--font-sans, system-ui)',
        color: 'var(--white, #fff)',
      }}
    >
      {/* ─── Header (sticky) ─── */}
      <header
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
          background: 'var(--ink, #0A0A0E)',
          display: 'flex',
          alignItems: 'center', justifyContent: 'space-between', gap: 12,
          flexShrink: 0, flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {/* Mobile: teams drawer toggle */}
          <button
            onClick={() => setMobileTeamsOpen(true)}
            className="md:hidden"
            data-fusio
            aria-label="Open teams list"
            style={{
              padding: 6, borderRadius: 5,
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--red, #CC0C20)',
            }}
          >
            <Menu style={{ width: 18, height: 18 }} />
          </button>
          <span
            className="hidden md:inline-flex"
            style={{
              alignItems: 'center', justifyContent: 'center',
              width: 24, height: 24, borderRadius: 6,
              background: 'rgba(204, 12, 32, 0.12)',
              border: '1px solid rgba(204, 12, 32, 0.35)',
              color: 'var(--red, #CC0C20)',
              fontSize: 14,
            }}
          >
            ✦
          </span>
          <div className="hidden md:block">
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Build · Teams
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 1 }}>
              Constellation
            </div>
          </div>
          <span className="md:hidden" style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--red, #CC0C20)', fontWeight: 600 }}>
            Constellation
          </span>
          {team && (
            <>
              <span className="hidden md:inline" style={{ color: 'var(--dim, rgba(255,255,255,0.32))' }}>·</span>
              <span
                style={{
                  fontFamily: 'var(--font-display, "Space Grotesk")',
                  fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em',
                  color: 'var(--white, #fff)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  maxWidth: 200,
                }}
              >
                {team.constellation || team.name}
              </span>
              <span
                className={STATUS_COLORS[team.status] || 'text-terminal-dim'}
                style={{
                  fontFamily: 'var(--font-mono, ui-monospace)',
                  fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase',
                  padding: '2px 7px',
                  borderRadius: 4,
                  background: 'var(--ink-2, #131319)',
                  border: '1px solid var(--line, rgba(255,255,255,0.08))',
                }}
              >
                {team.status}
              </span>
              <MemVaultStatusBadge teamId={team.id} compact />
              {/* Mobile: roster drawer toggle */}
              <button
                onClick={() => setMobileRosterOpen(true)}
                className="md:hidden"
                data-fusio
                aria-label="Open team roster"
                style={{
                  marginLeft: 'auto',
                  padding: 6, borderRadius: 5,
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--cyan, #5EC4D9)',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  fontFamily: 'var(--font-mono, ui-monospace)',
                  fontSize: 11, fontWeight: 600,
                }}
              >
                <Users style={{ width: 14, height: 14 }} />
                <span>{agents.length}</span>
              </button>
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {team && (team.status === 'running' || team.status === 'planning') && (
            <button
              onClick={() => haltTeam(team.id).then(refreshTeam)}
              data-fusio
              style={fusioActionBtn('var(--red, #CC0C20)')}
            >
              <Square style={{ width: 11, height: 11, display: 'inline-block', marginRight: 4 }} /> Halt
            </button>
          )}
          {team && team.status === 'planning' && (
            <button
              onClick={() => fetch(`/api/teams/${team.id}/start?promote=true`, { method: 'POST' }).then(refreshTeam)}
              data-fusio
              style={fusioActionBtn('var(--amber, #E8A23B)')}
            >
              <Zap style={{ width: 11, height: 11, display: 'inline-block', marginRight: 4 }} /> Launch now
            </button>
          )}
          {team && (team.status === 'idle' || team.status === 'paused' || team.status === 'completed' || team.status === 'done') && (
            <button
              onClick={() => startTeam(team.id).then(refreshTeam)}
              data-fusio
              style={fusioActionBtn('var(--green, #4CC38A)')}
            >
              <Play style={{ width: 11, height: 11, display: 'inline-block', marginRight: 4 }} /> {team.status === 'paused' ? 'Resume' : 'Start'}
            </button>
          )}
          {team && tasks.some(t => t.status === 'approved') && (
            <button
              onClick={() => mergeApproved(team.id).then(refreshTeam)}
              data-fusio
              style={fusioActionBtn('var(--cyan, #5EC4D9)')}
            >
              <GitMerge style={{ width: 11, height: 11, display: 'inline-block', marginRight: 4 }} /> Merge
            </button>
          )}
          {team && team.status !== 'running' && (
            <button
              onClick={async () => {
                if (!confirm(`Permanently delete "${team.constellation || team.name}"?`)) return;
                await fetch(`/api/teams/${team.id}?purge=true`, { method: 'DELETE' });
                refreshList();
                setSelectedTeamId(null);
              }}
              data-fusio
              style={fusioActionBtn('var(--red, #CC0C20)')}
            >
              <Trash2 style={{ width: 11, height: 11, display: 'inline-block', marginRight: 4 }} /> Delete
            </button>
          )}
          <button
            onClick={() => { setLauncherContext(parentChatContext); setShowLauncher(true); }}
            data-fusio
            className="card-btn primary"
            style={{
              ...fusioActionBtn('var(--red, #CC0C20)'),
              background: 'var(--red, #CC0C20)',
              color: '#fff',
              borderColor: 'var(--red, #CC0C20)',
              boxShadow: '0 0 14px rgba(204,12,32,0.35)',
            }}
          >
            <Plus style={{ width: 11, height: 11, display: 'inline-block', marginRight: 4 }} /> New
          </button>
        </div>
      </header>

      {/* ─── Blocker indicator: what is the team waiting on RIGHT NOW ─── */}
      {team && teamData?.blocker && !awaitingPlanApproval && ['running', 'planning', 'paused'].includes(team.status) && (
        <div
          className={`flex items-center gap-2 px-3 md:px-4 py-1.5 border-b text-xs flex-shrink-0 ${
            teamData.blocker.severity === 'error' ? 'bg-terminal-red/10 border-terminal-red/40 text-terminal-red'
              : teamData.blocker.severity === 'warn' ? 'bg-terminal-amber/10 border-terminal-amber/30 text-terminal-amber'
              : 'bg-terminal-surface/40 border-terminal-border text-terminal-dim'
          }`}
          title={teamData.blocker.detail}
        >
          <span className="font-bold uppercase tracking-wider text-[10px] flex-shrink-0">Live:</span>
          <span className="truncate flex-1">{teamData.blocker.headline}</span>
        </div>
      )}

      {/* ─── Awaiting-approval banner ─── */}
      {team && awaitingPlanApproval && (
        <button
          onClick={() => setMainTab('architect')}
          className="flex items-center gap-3 px-4 py-2.5 bg-terminal-amber/15 border-b border-terminal-amber/50 hover:bg-terminal-amber/25 transition w-full text-left"
        >
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-terminal-amber/30 border border-terminal-amber/60 flex items-center justify-center animate-pulse">
            🔒
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-terminal-amber uppercase tracking-wider">
                Awaiting your approval
              </span>
              <span className="text-[10px] text-terminal-dim">
                posted {Math.round((Date.now() - awaitingPlanApproval.createdAt) / 1000)}s ago
              </span>
            </div>
            <div className="text-xs text-terminal-dim truncate md:whitespace-normal md:line-clamp-2">
              Architect finished recon and posted its plan. Team won't spawn until you reply. Tap to review.
            </div>
          </div>
          <span className="flex-shrink-0 text-terminal-amber text-sm">→</span>
        </button>
      )}

      {/* ─── Mission Brief (sticky) + Phase Bar ─── */}
      {team && (
        <div className="flex-shrink-0">
          <MissionBrief
            team={team}
            phases={phases}
            summary={summary}
            deliverableReady={deliverableReady}
            onJumpToDeliverable={() => setMainTab('deliverable')}
            onJumpToArchitect={() => setMainTab('architect')}
          />
          {phases.length > 0 && (
            <div className="px-3 md:px-4 pt-2 overflow-x-auto">
              <PhaseBar
                phases={phases.map(p => ({ id: p.id, name: p.name, status: p.status, ordering: p.ordering }))}
                teamStatus={team.status}
                onPhaseClick={id => {
                  setActivePhaseFilter(id || null);
                  if (id) setMainTab('tasks');
                }}
                activePhaseFilter={activePhaseFilter}
              />
            </div>
          )}
        </div>
      )}

      {/* ─── Mobile teams drawer ─── */}
      {mobileTeamsOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex" onClick={() => setMobileTeamsOpen(false)}>
          <div className="w-72 max-w-[80vw] bg-terminal-bg border-r border-terminal-border flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-3 py-3 border-b border-terminal-border bg-terminal-surface/50">
              <div className="flex items-center gap-2">
                <span className="text-terminal-green text-lg">✦</span>
                <span className="text-sm font-bold text-terminal-green">Constellations</span>
              </div>
              <button onClick={() => setMobileTeamsOpen(false)} className="p-2 text-terminal-dim hover:text-terminal-text" aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {listLoading && <div className="text-xs text-terminal-dim p-2">Loading…</div>}
              {!listLoading && teams.length === 0 && (
                <div className="text-xs text-terminal-dim p-4 text-center">
                  No constellations yet.
                  <button onClick={() => { setShowLauncher(true); setMobileTeamsOpen(false); }} className="block text-terminal-green mt-3 mx-auto hover:underline">
                    Deploy your first ✦
                  </button>
                </div>
              )}
              {teams.map(t => (
                <button
                  key={t.id}
                  onClick={() => {
                    setSelectedTeamId(t.id);
                    setSelectedAgentId(null);
                    setActivePhaseFilter(null);
                    setMainTab('architect');
                    setMobileTeamsOpen(false);
                  }}
                  className={`w-full text-left p-3 rounded text-sm transition ${
                    selectedTeamId === t.id
                      ? 'bg-terminal-green/10 border border-terminal-green/30 text-terminal-green'
                      : 'hover:bg-terminal-surface text-terminal-dim hover:text-terminal-text border border-transparent'
                  }`}
                >
                  <div className="font-bold truncate">✦ {t.constellation || t.name}</div>
                  <div className="flex items-center gap-1 mt-0.5 text-xs">
                    <span className={`w-2 h-2 rounded-full ${STATUS_DOTS[t.status] || 'bg-terminal-dim'}`} />
                    <span>{t.status}</span>
                  </div>
                </button>
              ))}
            </div>
            <div className="p-3 border-t border-terminal-border">
              <button
                onClick={() => { setLauncherContext(parentChatContext); setShowLauncher(true); setMobileTeamsOpen(false); }}
                className="w-full flex items-center justify-center gap-1 py-2 text-sm rounded bg-terminal-green/20 border border-terminal-green/40 text-terminal-green hover:bg-terminal-green/30"
              >
                <Plus className="w-4 h-4" /> New Constellation
              </button>
            </div>
          </div>
          <div className="flex-1 bg-black/60" onClick={() => setMobileTeamsOpen(false)} />
        </div>
      )}

      {/* ─── Mobile roster drawer ─── */}
      {mobileRosterOpen && team && (
        <div className="md:hidden fixed inset-0 z-50 flex justify-end" onClick={() => setMobileRosterOpen(false)}>
          <div className="flex-1 bg-black/60" />
          <div className="w-72 max-w-[80vw] bg-terminal-bg border-l border-terminal-border flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-3 py-3 border-b border-terminal-border bg-terminal-surface/50">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-terminal-cyan" />
                <span className="text-sm font-bold text-terminal-text">Team Roster</span>
                <span className="text-xs text-terminal-dim">({agents.length})</span>
              </div>
              <button onClick={() => setMobileRosterOpen(false)} className="p-2 text-terminal-dim hover:text-terminal-text" aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <TeamRoster
                agents={agents}
                selectedAgentId={selectedAgentId}
                onSelectAgent={id => { setSelectedAgentId(id === selectedAgentId ? null : id); setMobileRosterOpen(false); }}
              />
            </div>
          </div>
        </div>
      )}

      {/* ─── Main body ─── */}
      <div className="flex-1 flex min-h-0">
        {/* Team list sidebar (desktop) */}
        <aside className="w-44 border-r border-terminal-border bg-terminal-surface/30 overflow-y-auto p-2 space-y-1 flex-shrink-0 hidden md:block">
          {listLoading && <div className="text-xs text-terminal-dim p-2">Loading...</div>}
          {!listLoading && teams.length === 0 && (
            <div className="text-xs text-terminal-dim p-2 text-center">
              No constellations yet.
              <button onClick={() => setShowLauncher(true)} className="block text-terminal-green mt-2 mx-auto hover:underline">
                Deploy your first ✦
              </button>
            </div>
          )}
          {teams.map(t => (
            <button
              key={t.id}
              onClick={() => { setSelectedTeamId(t.id); setSelectedAgentId(null); setActivePhaseFilter(null); setMainTab('architect'); }}
              className={`w-full text-left p-2 rounded text-xs transition ${
                selectedTeamId === t.id
                  ? 'bg-terminal-green/10 border border-terminal-green/30 text-terminal-green'
                  : 'hover:bg-terminal-surface text-terminal-dim hover:text-terminal-text border border-transparent'
              }`}
            >
              <div className="font-bold truncate">✦ {t.constellation || t.name}</div>
              <div className="flex items-center gap-1 mt-0.5">
                <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOTS[t.status] || 'bg-terminal-dim'}`} />
                <span>{t.status}</span>
              </div>
            </button>
          ))}
        </aside>

        {!team ? (
          <div className="flex-1 flex items-center justify-center text-terminal-dim">
            <div className="text-center">
              <span className="text-5xl block opacity-40 mb-3">✦</span>
              <p className="text-sm">Select a constellation or deploy a new one</p>
            </div>
          </div>
        ) : (
          <>
            {/* Compact roster */}
            <aside className="w-52 border-r border-terminal-border p-3 flex-shrink-0 overflow-y-auto min-h-0 hidden md:block">
              <TeamRoster
                agents={agents}
                selectedAgentId={selectedAgentId}
                onSelectAgent={id => setSelectedAgentId(id === selectedAgentId ? null : id)}
              />
            </aside>

            {/* Main tab area */}
            <main className="flex-1 flex flex-col min-h-0 min-w-0">
              {/* Tab bar */}
              <div className="border-b border-terminal-border bg-terminal-surface/30 flex-shrink-0">
                <nav className="flex overflow-x-auto scrollbar-hide">
                  {tabs.map(tab => {
                    const Icon = tab.icon;
                    const active = mainTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        onClick={() => setMainTab(tab.id)}
                        className={`px-3 md:px-3 py-3 md:py-2 text-sm md:text-xs font-medium transition border-b-2 flex items-center gap-1.5 flex-shrink-0 min-h-[44px] md:min-h-0 ${
                          active
                            ? 'text-terminal-green border-terminal-green'
                            : 'text-terminal-dim border-transparent hover:text-terminal-text'
                        }`}
                      >
                        <Icon className={`w-4 h-4 md:w-3.5 md:h-3.5 ${tab.alert && !active ? 'text-terminal-amber' : ''}`} />
                        <span>{tab.label}</span>
                        {tab.count !== undefined && tab.count > 0 && (
                          <span className={`text-[9px] px-1.5 rounded ${
                            tab.alert
                              ? 'bg-terminal-amber/20 text-terminal-amber'
                              : active
                              ? 'bg-terminal-green/20 text-terminal-green'
                              : 'bg-terminal-surface text-terminal-dim'
                          }`}>
                            {tab.count}
                          </span>
                        )}
                        {tab.alert && tab.count === undefined && (
                          <span className="w-1.5 h-1.5 rounded-full bg-terminal-amber animate-pulse" />
                        )}
                      </button>
                    );
                  })}
                </nav>
              </div>

              {/* Tab content — fills remaining space */}
              <div className="flex-1 min-h-0 overflow-hidden">
                {mainTab === 'architect' && (
                  <ArchitectChat
                    teamId={team.id}
                    teamStatus={team.status}
                    thread={thread}
                    agents={agents}
                    onRefresh={refreshThread}
                    preset={team.preset}
                    goal={team.goal}
                  />
                )}
                {mainTab === 'overview' && (
                  <Overview teamId={team.id} events={events} agents={agents} />
                )}
                {mainTab === 'tasks' && (
                  <div className="h-full overflow-auto p-3">
                    {activePhaseFilter && phases.find(p => p.id === activePhaseFilter) && (
                      <div className="mb-2 flex items-center gap-2 text-xs">
                        <span className="text-terminal-dim">Filtered to phase:</span>
                        <span className="text-terminal-green font-bold">
                          {phases.find(p => p.id === activePhaseFilter)?.name}
                        </span>
                        <button
                          onClick={() => setActivePhaseFilter(null)}
                          className="text-terminal-amber hover:text-terminal-text"
                        >
                          clear ✕
                        </button>
                      </div>
                    )}
                    <TaskFlow tasks={tasks} phaseFilter={activePhaseFilter} />
                  </div>
                )}
                {mainTab === 'deliverable' && (
                  <Deliverable
                    teamId={team.id}
                    teamStatus={team.status}
                    data={deliverable}
                    onRefresh={() => { refreshTeam(); refreshThread(); }}
                    onJumpToArchitect={() => setMainTab('architect')}
                  />
                )}
                {mainTab === 'memory' && (
                  <MemoryPanel
                    teamId={team.id}
                    title={`Team Memory — ${team.constellation || team.name}`}
                  />
                )}
                {mainTab === 'messages' && <MessageLog messages={messages} agents={agents} />}
                {mainTab === 'decisions' && (
                  <DecisionsLog decisions={decisions} phases={phases} agents={agents} />
                )}
                {mainTab === 'codex' && (
                  <CodexReviews reviews={reviews} findings={findings} tasks={tasks} />
                )}
              </div>
            </main>

            {/* Agent focus (optional right pane) */}
            {selectedAgent && (
              <AgentFocus
                agent={selectedAgent}
                tasks={tasks}
                onClose={() => setSelectedAgentId(null)}
              />
            )}
          </>
        )}
      </div>

      {/* Launcher */}
      {showLauncher && (
        <LaunchWizard
          onClose={() => setShowLauncher(false)}
          onCreated={id => { setSelectedTeamId(id); refreshList(); setMainTab('architect'); }}
          parentChatContext={launcherContext}
        />
      )}
    </div>
  );
}
