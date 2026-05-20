'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, AlertTriangle, Loader2, RefreshCcw } from 'lucide-react';
import { askArchitect } from '../teams/useTeamState';
import type { TeamMessage, AgentData } from '../teams/useTeamState';

interface ArchitectChatProps {
  teamId: string;
  teamStatus: string;
  thread: TeamMessage[];
  agents: AgentData[];
  onRefresh?: () => void;
  preset?: string | null;
  goal?: string | null;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  });
}

function roleForAgent(id: string | null, agents: AgentData[]): AgentData | null {
  if (!id) return null;
  return agents.find(a => a.id === id) || null;
}

export function ArchitectChat({
  teamId,
  teamStatus,
  thread,
  agents,
  onRefresh,
  goal,
}: ArchitectChatProps) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'message' | 'revision'>('message');
  const bottomRef = useRef<HTMLDivElement>(null);

  const architect = agents.find(a => a.role === 'architect') || null;
  const architectStatus = architect?.status || 'unknown';

  const isTerminal = ['done', 'completed', 'paused', 'error', 'cancelled'].includes(teamStatus);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread.length]);

  const send = async () => {
    const body = input.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await askArchitect(teamId, body, { resume: isTerminal, kind });
      setInput('');
      setKind('message');
      onRefresh?.();
    } catch (err: any) {
      setError(err.message || 'Send failed');
    } finally {
      setSending(false);
    }
  };

  const quickPrompts = useMemo(() => {
    if (isTerminal) {
      return [
        { label: 'Request revision', prompt: 'The team missed this — please revise:\n\n', kind: 'revision' as const },
        { label: 'Ask for next steps', prompt: 'Based on the deliverable, what should we do next?', kind: 'message' as const },
        { label: 'Extend the mission', prompt: 'Extend the mission to also cover:\n\n', kind: 'revision' as const },
      ];
    }
    return [
      { label: 'Status update', prompt: 'Give me a status update on where the team is right now.', kind: 'message' as const },
      { label: 'Change priority', prompt: 'Change priority: focus the team on ', kind: 'message' as const },
      { label: 'Add new task', prompt: 'Also have the team:\n\n', kind: 'message' as const },
    ];
  }, [isTerminal]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'var(--font-sans, system-ui)', color: 'var(--white, #fff)' }}>
      {/* Header */}
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
          background: 'var(--ink-2, #131319)',
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 22, borderRadius: 5,
              background: 'rgba(204, 12, 32, 0.12)',
              border: '1px solid rgba(204, 12, 32, 0.35)',
              color: 'var(--red, #CC0C20)',
              fontSize: 12,
            }}
          >
            ◆
          </span>
          <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>
            Architect
          </div>
        </div>
        {architect && (
          <span style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
            {architect.role_handle} ·{' '}
            <span style={{ color: architectStatus === 'working' ? 'var(--green, #4CC38A)' : architectStatus === 'idle' ? 'var(--cyan, #5EC4D9)' : 'var(--mist, rgba(255,255,255,0.5))' }}>
              {architectStatus}
            </span>
          </span>
        )}
        {isTerminal && (
          <span
            style={{
              fontFamily: 'var(--font-mono, ui-monospace)',
              fontSize: 9.5,
              letterSpacing: '0.12em',
              padding: '2px 8px',
              borderRadius: 4,
              background: 'rgba(232, 162, 59, 0.1)',
              color: 'var(--amber, #E8A23B)',
              border: '1px solid rgba(232, 162, 59, 0.3)',
            }}
          >
            Team paused — sending a message will re-open the team
          </span>
        )}
        <button
          onClick={onRefresh}
          title="Refresh"
          data-fusio
          style={{
            marginLeft: 'auto',
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--mist, rgba(255,255,255,0.5))',
            padding: 4, borderRadius: 4,
            transition: 'color 120ms ease-out',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
        >
          <RefreshCcw style={{ width: 13, height: 13 }} />
        </button>
      </div>

      {/* Thread */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {thread.length === 0 && (
          <div className="text-center text-terminal-dim py-6 space-y-2">
            <div className="text-3xl">◆</div>
            <p className="text-sm">Start a conversation with the architect.</p>
            <p className="text-xs max-w-md mx-auto leading-relaxed">
              You talk to the team lead. The architect relays instructions to the team, reports milestones,
              and handles revisions. Use this channel when you need to change direction, ask for status,
              or review completed work.
            </p>
            {goal && (
              <div className="text-[11px] text-terminal-dim italic mt-3">
                Current mission: <span className="text-terminal-text not-italic">"{goal.slice(0, 120)}{goal.length > 120 ? '…' : ''}"</span>
              </div>
            )}
          </div>
        )}

        {thread.map(msg => {
          const fromArchitect = msg.from_agent_id !== null;
          const fromAgent = roleForAgent(msg.from_agent_id, agents);
          let meta: Record<string, any> = {};
          try { meta = JSON.parse(msg.metadata_json || '{}'); } catch { /* ignore */ }
          const urgency = meta.urgency as string | undefined;
          const commanderKind = meta.kind as string | undefined;

          if (fromArchitect) {
            // Architect → commander
            const isPlanApproval = typeof msg.body === 'string' && /^\s*🔒\s*PLAN APPROVAL REQUIRED/i.test(msg.body);
            // Was this plan already replied-to by commander? Find any later
            // commander message — if yes, hide the approve/reject buttons.
            const hasLaterCommanderReply = isPlanApproval &&
              thread.some(m => m.from_agent_id === null && m.created_at > msg.created_at);

            return (
              <div key={msg.id} className="flex gap-2 items-start">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${isPlanApproval ? 'bg-terminal-amber/20 border border-terminal-amber/50 text-terminal-amber' : 'bg-terminal-green/20 border border-terminal-green/40 text-terminal-green'}`}>
                  {isPlanApproval ? '🔒' : '◆'}
                </div>
                <div className="flex-1 max-w-3xl">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={`text-[11px] font-bold ${isPlanApproval ? 'text-terminal-amber' : 'text-terminal-green'}`}>
                      {fromAgent?.role_handle || 'architect'}
                    </span>
                    {isPlanApproval && (
                      <span className="text-[9px] px-1.5 rounded bg-terminal-amber/20 text-terminal-amber uppercase tracking-wider font-bold">awaiting approval</span>
                    )}
                    {urgency === 'blocker' && (
                      <span className="text-[9px] px-1.5 rounded bg-terminal-red/20 text-terminal-red uppercase tracking-wider">blocker</span>
                    )}
                    {urgency === 'milestone' && !isPlanApproval && (
                      <span className="text-[9px] px-1.5 rounded bg-terminal-green/20 text-terminal-green uppercase tracking-wider">milestone</span>
                    )}
                    <span className="text-[10px] text-terminal-dim">{fmtTime(msg.created_at)}</span>
                  </div>
                  <div className={`rounded-lg rounded-tl-none px-3 py-2 text-[13px] text-terminal-text whitespace-pre-wrap leading-relaxed ${
                    isPlanApproval
                      ? 'bg-terminal-amber/5 border-2 border-terminal-amber/40'
                      : 'bg-terminal-surface border border-terminal-border'
                  }`}>
                    {msg.body}
                  </div>

                  {/* Plan approval quick-reply buttons */}
                  {isPlanApproval && !hasLaterCommanderReply && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        onClick={() => setInput('approve')}
                        className="px-3 py-2 text-xs rounded bg-terminal-green/15 border border-terminal-green/50 text-terminal-green hover:bg-terminal-green/25 font-bold min-h-[36px]"
                      >
                        ✓ Approve
                      </button>
                      <button
                        onClick={() => setInput('modify: ')}
                        className="px-3 py-2 text-xs rounded bg-terminal-cyan/10 border border-terminal-cyan/40 text-terminal-cyan hover:bg-terminal-cyan/20 min-h-[36px]"
                      >
                        ✎ Request changes
                      </button>
                      <button
                        onClick={() => setInput('reject: ')}
                        className="px-3 py-2 text-xs rounded bg-terminal-red/10 border border-terminal-red/40 text-terminal-red hover:bg-terminal-red/20 min-h-[36px]"
                      >
                        ✗ Reject
                      </button>
                      <span className="text-[10px] text-terminal-dim self-center">
                        (fills the composer below — edit before sending)
                      </span>
                    </div>
                  )}
                  {isPlanApproval && hasLaterCommanderReply && (
                    <div className="mt-1 text-[10px] text-terminal-dim italic">
                      You replied to this plan already.
                    </div>
                  )}
                </div>
              </div>
            );
          }

          // Commander → architect
          return (
            <div key={msg.id} className="flex gap-2 items-start justify-end">
              <div className="flex-1 max-w-3xl flex flex-col items-end">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[10px] text-terminal-dim">{fmtTime(msg.created_at)}</span>
                  {commanderKind === 'revision' && (
                    <span className="text-[9px] px-1.5 rounded bg-terminal-amber/20 text-terminal-amber uppercase tracking-wider">revision</span>
                  )}
                  <span className="text-[11px] font-bold text-terminal-cyan">you</span>
                </div>
                <div className="rounded-lg rounded-tr-none bg-terminal-cyan/10 border border-terminal-cyan/30 px-3 py-2 text-[13px] text-terminal-text whitespace-pre-wrap leading-relaxed">
                  {msg.body}
                </div>
              </div>
              <div className="w-7 h-7 rounded-full bg-terminal-cyan/20 border border-terminal-cyan/40 flex items-center justify-center flex-shrink-0 text-terminal-cyan text-[10px] font-bold">
                YOU
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Quick prompts */}
      {thread.length < 8 && (
        <div className="px-4 py-2 border-t border-terminal-border flex gap-1.5 flex-wrap">
          <span className="text-[10px] text-terminal-dim uppercase tracking-wider self-center">Quick:</span>
          {quickPrompts.map(q => (
            <button
              key={q.label}
              onClick={() => { setInput(q.prompt); setKind(q.kind); }}
              className="text-[11px] px-2 py-1 rounded border border-terminal-border text-terminal-dim hover:text-terminal-text hover:border-terminal-cyan/40 transition"
            >
              {q.label}
            </button>
          ))}
        </div>
      )}

      {/* Composer */}
      <div className="px-4 py-3 border-t border-terminal-border bg-terminal-surface/40">
        {error && (
          <div className="mb-2 px-2 py-1 text-xs rounded bg-terminal-red/10 border border-terminal-red/30 text-terminal-red flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3" /> {error}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={Math.min(6, Math.max(2, input.split('\n').length))}
              placeholder={isTerminal ? 'Describe the revision or follow-up… (⌘↵ to send)' : 'Message the architect… (⌘↵ to send)'}
              className="w-full bg-terminal-bg border border-terminal-border rounded-md px-3 py-2 text-sm text-terminal-text resize-none focus:border-terminal-cyan/50 focus:outline-none"
            />
            <div className="flex items-center gap-3 mt-1 text-[10px] text-terminal-dim">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="msg-kind"
                  value="message"
                  checked={kind === 'message'}
                  onChange={() => setKind('message')}
                  className="accent-terminal-cyan"
                />
                <span>message</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="msg-kind"
                  value="revision"
                  checked={kind === 'revision'}
                  onChange={() => setKind('revision')}
                  className="accent-terminal-amber"
                />
                <span>revision (high priority)</span>
              </label>
              {isTerminal && (
                <span className="ml-auto text-terminal-amber">↻ will reopen the team</span>
              )}
            </div>
          </div>
          <button
            onClick={send}
            disabled={!input.trim() || sending}
            className="px-3 py-2 rounded bg-terminal-cyan/20 border border-terminal-cyan/40 text-terminal-cyan hover:bg-terminal-cyan/30 transition disabled:opacity-50 self-stretch flex items-center gap-1 text-sm font-bold"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
