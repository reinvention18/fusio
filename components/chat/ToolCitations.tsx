/**
 * ToolCitations — footer under an assistant message showing the sub-agents
 * and tool calls that produced the reply. Gets wired via MessageBubble's
 * `footer` prop. Collapsed by default; expand reveals each run's result.
 *
 * Attribution heuristic: any sub-agent whose `endedAt` falls between the
 * previous assistant message and this one (with a 60s grace window) belongs
 * to this assistant turn. Cheap but works well for the current streaming
 * protocol where all sub-agents finish before the final assistant text.
 */
'use client';
import { memo, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileCode, Terminal, Users } from 'lucide-react';
import type { SubAgent } from '../SubAgentTracker';

export interface ToolCitationsProps {
  subAgents: SubAgent[];
  prevAssistantAt: number | null;
  thisAssistantAt: number;
}

function toMs(v: Date | string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return isNaN(t) ? null : t;
}

function Impl(p: ToolCitationsProps) {
  const [open, setOpen] = useState(false);

  const matched = useMemo(() => {
    // For the FIRST assistant message in a chat there is no prior assistant
    // timestamp. Falling back to 0 (epoch) attributed every sub-agent ever
    // recorded across all chats — that produced the "63 sub-agents · 63 done"
    // ghost-footer. Cap the lookback to one turn (30 min is generous).
    const TURN_CEILING_MS = 30 * 60 * 1000;
    const lo = p.prevAssistantAt ?? (p.thisAssistantAt - TURN_CEILING_MS);
    const hi = p.thisAssistantAt + 60_000;
    return p.subAgents
      .filter(a => {
        const ended = toMs(a.endedAt);
        if (ended == null) return false;
        return ended >= lo && ended <= hi;
      })
      .sort((a, b) => (toMs(a.startedAt) ?? 0) - (toMs(b.startedAt) ?? 0));
  }, [p.subAgents, p.prevAssistantAt, p.thisAssistantAt]);

  if (matched.length === 0) return null;

  const doneCount = matched.filter(a => a.status === 'complete').length;
  const failedCount = matched.filter(a => a.status === 'failed').length;

  return (
    <div className="mt-1 text-[12px] md:text-[11px] text-terminal-dim border border-terminal-border/40 rounded-md bg-terminal-bg/40 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 md:px-2.5 py-2 md:py-1.5 hover:bg-terminal-bg/60 transition min-h-[36px] md:min-h-0"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <Users className="w-3 h-3 text-terminal-cyan" />
        <span>
          {matched.length} sub-agent{matched.length === 1 ? '' : 's'}
          {doneCount > 0 && <> · <span className="text-terminal-green">{doneCount} done</span></>}
          {failedCount > 0 && <> · <span className="text-terminal-red">{failedCount} failed</span></>}
        </span>
      </button>
      {open && (
        <div className="border-t border-terminal-border/40 divide-y divide-terminal-border/30">
          {matched.map(a => {
            const ended = toMs(a.endedAt);
            const started = toMs(a.startedAt);
            const dur = ended && started ? Math.round((ended - started) / 1000) : null;
            const durStr = dur == null ? '' : dur < 60 ? `${dur}s` : `${Math.floor(dur / 60)}m ${dur % 60}s`;
            return (
              <Citation key={a.key} agent={a} duration={durStr} />
            );
          })}
        </div>
      )}
    </div>
  );
}

interface CitationProps { agent: SubAgent; duration: string }

function Citation({ agent, duration }: CitationProps) {
  const [expanded, setExpanded] = useState(false);
  const preview = agent.resultPreview || (agent.resultFull || '').slice(0, 180);
  const hasMore = (agent.resultFull && agent.resultFull.length > (agent.resultPreview?.length ?? 0)) || false;
  const icon = agent.status === 'failed' ? <Terminal className="w-3 h-3 text-terminal-red" />
    : agent.status === 'running' ? <Terminal className="w-3 h-3 text-terminal-cyan animate-pulse" />
    : <FileCode className="w-3 h-3 text-terminal-green" />;
  return (
    <div className="px-2.5 py-1.5">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 hover:bg-terminal-bg/50 rounded -mx-1 px-1 py-0.5 transition"
      >
        {icon}
        <span className="text-terminal-text flex-1 text-left truncate">{agent.label}</span>
        {agent.model && <span className="text-terminal-dim/70 text-[10px] uppercase">{agent.model}</span>}
        {duration && <span className="text-terminal-dim/70 font-mono">{duration}</span>}
      </button>
      {expanded && (preview || agent.task) && (
        <div className="mt-1 space-y-1 text-terminal-dim">
          {agent.task && (
            <details className="text-[10px]">
              <summary className="cursor-pointer hover:text-terminal-text">prompt</summary>
              <pre className="mt-1 p-2 bg-terminal-bg/70 border border-terminal-border/40 rounded whitespace-pre-wrap text-[10px] max-h-40 overflow-y-auto">{agent.task}</pre>
            </details>
          )}
          {preview && (
            <pre className="p-2 bg-terminal-bg/70 border border-terminal-border/40 rounded whitespace-pre-wrap text-[10px] max-h-64 overflow-y-auto">{hasMore ? agent.resultFull : preview}</pre>
          )}
        </div>
      )}
    </div>
  );
}

export const ToolCitations = memo(Impl);
