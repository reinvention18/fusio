'use client';

import { useState, useEffect, useRef } from 'react';
import { Loader2, CheckCircle, XCircle, ChevronDown, ChevronRight, Clock, Zap, Eye, EyeOff, Copy, Check, Maximize2, Minimize2 } from 'lucide-react';

export interface SubAgent {
  key: string;
  label: string;
  status: 'running' | 'complete' | 'failed';
  lastMessage: string;
  startedAt: Date;
  endedAt?: Date | null;
  durationMs?: number | null;
  task?: string;
  requester?: string;
  model?: string;
  resultPreview?: string;
  resultFull?: string;
}

interface SubAgentTrackerProps {
  subAgents: SubAgent[];
  onAgentClick?: (agent: SubAgent) => void;
  onCompletionNotice?: (agent: SubAgent) => void;
}

// Model color/badge config — mapped to Fusio palette tokens
// (violet for opus, cyan for sonnet, green for haiku, mist for default)
const MODEL_CONFIG: Record<string, { color: string; bg: string; border: string; icon: string }> = {
  opus:    { color: 'text-terminal-purple', bg: 'bg-terminal-purple/20', border: 'border-terminal-purple/30', icon: '🧠' },
  sonnet:  { color: 'text-terminal-cyan',   bg: 'bg-terminal-cyan/20',   border: 'border-terminal-cyan/30',   icon: '⚡' },
  haiku:   { color: 'text-terminal-green',  bg: 'bg-terminal-green/20',  border: 'border-terminal-green/30',  icon: '🍃' },
  default: { color: 'text-terminal-dim',    bg: 'bg-terminal-dim/20',    border: 'border-terminal-dim/30',    icon: '🤖' },
};

function getModelConfig(model?: string) {
  if (!model) return MODEL_CONFIG.default;
  return MODEL_CONFIG[model] || MODEL_CONFIG.default;
}

// Live elapsed timer component — ticks every second for running agents
function LiveTimer({ startedAt }: { startedAt: Date }) {
  const [now, setNow] = useState(Date.now());
  
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const diff = Math.floor((now - startedAt.getTime()) / 1000);
  const mins = Math.floor(diff / 60);
  const secs = diff % 60;
  
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    return <span className="font-mono">{hours}h {mins % 60}m {secs.toString().padStart(2, '0')}s</span>;
  }
  return <span className="font-mono">{mins}:{secs.toString().padStart(2, '0')}</span>;
}

export default function SubAgentTracker({ subAgents, onAgentClick, onCompletionNotice }: SubAgentTrackerProps) {
  const [expanded, setExpanded] = useState(true);
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [justCompleted, setJustCompleted] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // Track which agents we've already fired completion notices for
  const notifiedRef = useRef<Set<string>>(new Set());

  const running = subAgents.filter(a => a.status === 'running');
  const completed = subAgents.filter(a => a.status === 'complete');
  const failed = subAgents.filter(a => a.status === 'failed');

  // Track status transitions to highlight newly completed agents + fire notices
  useEffect(() => {
    const newCompleted = new Set<string>();
    completed.forEach(agent => {
      if (!justCompleted.has(agent.key) && !notifiedRef.current.has(agent.key)) {
        newCompleted.add(agent.key);
      }
    });

    if (newCompleted.size > 0) {
      setJustCompleted(prev => new Set([...prev, ...newCompleted]));
      
      // Fire completion notices for new completions
      newCompleted.forEach(key => {
        notifiedRef.current.add(key);
        const agent = completed.find(a => a.key === key);
        if (agent && onCompletionNotice) {
          onCompletionNotice(agent);
        }
      });
      
      // Remove highlight after 5 seconds
      const timer = setTimeout(() => {
        setJustCompleted(prev => {
          const updated = new Set(prev);
          newCompleted.forEach(key => updated.delete(key));
          return updated;
        });
      }, 5000);

      return () => clearTimeout(timer);
    }
  }, [completed.length]);

  // Also fire notices for failed agents
  useEffect(() => {
    failed.forEach(agent => {
      if (!notifiedRef.current.has(agent.key)) {
        notifiedRef.current.add(agent.key);
        if (onCompletionNotice) {
          onCompletionNotice(agent);
        }
      }
    });
  }, [failed.length]);

  const formatDuration = (ms: number) => {
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ${secs % 60}s`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  };

  const toggleAgent = (key: string) => {
    setExpandedAgents(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const copyResult = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const getStatusIcon = (status: SubAgent['status']) => {
    switch (status) {
      case 'running':
        return <Loader2 className="w-3.5 h-3.5 animate-spin text-terminal-cyan" />;
      case 'complete':
        return <CheckCircle className="w-3.5 h-3.5 text-terminal-green" />;
      case 'failed':
        return <XCircle className="w-3.5 h-3.5 text-terminal-red" />;
    }
  };

  if (subAgents.length === 0) return null;

  // Mono uppercase pill — shared by the running/done/failed counters
  const counterPill = (color: string, hex: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '2px 8px',
    fontFamily: 'var(--font-mono, ui-monospace)',
    fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase',
    borderRadius: 4,
    background: `${hex}1A`,
    color,
    border: `1px solid ${hex}50`,
  });

  return (
    <div
      style={{
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 10,
        overflow: 'hidden',
        fontFamily: 'var(--font-sans, system-ui)',
        color: 'var(--white, #fff)',
      }}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        data-fusio
        style={{
          width: '100%',
          padding: '8px 12px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          transition: 'background 120ms ease-out',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 22, borderRadius: 5,
              background: 'rgba(94, 196, 217, 0.12)',
              border: '1px solid rgba(94, 196, 217, 0.35)',
            }}
          >
            <Zap style={{ width: 11, height: 11, color: 'var(--cyan, #5EC4D9)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Monitor · Spawn
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--white, #fff)', marginTop: 1 }}>
              Sub-agents
            </div>
          </div>
          {running.length > 0 && (
            <span style={counterPill('var(--cyan, #5EC4D9)', '#5EC4D9')}>
              <Loader2 style={{ width: 10, height: 10, animation: 'spin 1s linear infinite' }} />
              {running.length} running
            </span>
          )}
          {completed.length > 0 && (
            <span style={counterPill('var(--green, #4CC38A)', '#4CC38A')}>
              ✓ {completed.length}
            </span>
          )}
          {failed.length > 0 && (
            <span style={counterPill('var(--red, #CC0C20)', '#CC0C20')}>
              ✗ {failed.length}
            </span>
          )}
          {/* Model summary */}
          {running.length > 0 && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {Array.from(new Set(running.map(a => a.model || 'default'))).map(model => {
                const cfg = getModelConfig(model);
                const count = running.filter(a => (a.model || 'default') === model).length;
                return (
                  <span
                    key={model}
                    className={`${cfg.bg} ${cfg.color} ${cfg.border} border`}
                    style={{
                      padding: '2px 7px',
                      fontFamily: 'var(--font-mono, ui-monospace)',
                      fontSize: 9.5,
                      letterSpacing: '0.08em',
                      borderRadius: 4,
                    }}
                  >
                    {cfg.icon} {model} ×{count}
                  </span>
                );
              })}
            </div>
          )}
        </div>
        {expanded ? (
          <ChevronDown style={{ width: 13, height: 13, color: 'var(--mist, rgba(255,255,255,0.5))' }} />
        ) : (
          <ChevronRight style={{ width: 13, height: 13, color: 'var(--mist, rgba(255,255,255,0.5))' }} />
        )}
      </button>

      {/* Agent List */}
      {expanded && (
        <div className="border-t border-terminal-border">
          {/* Running Agents */}
          {running.length > 0 && (
            <div className="p-2 space-y-1">
              <div className="text-xs text-terminal-dim px-2 py-1 flex items-center gap-2">
                <span>RUNNING</span>
                <span className="w-1.5 h-1.5 bg-terminal-cyan rounded-full animate-pulse" />
              </div>
              {running.map(agent => (
                <AgentRow
                  key={agent.key}
                  agent={agent}
                  onClick={onAgentClick}
                  onToggle={() => toggleAgent(agent.key)}
                  isExpanded={expandedAgents.has(agent.key)}
                  formatDuration={formatDuration}
                  getStatusIcon={getStatusIcon}
                  highlight={false}
                  onCopyResult={copyResult}
                  copiedKey={copiedKey}
                />
              ))}
            </div>
          )}

          {/* Completed Agents */}
          {completed.length > 0 && (
            <div className="p-2 space-y-1 border-t border-terminal-border/50">
              <div className="text-xs text-terminal-dim px-2 py-1">COMPLETED</div>
              {completed.map(agent => (
                <AgentRow
                  key={agent.key}
                  agent={agent}
                  onClick={onAgentClick}
                  onToggle={() => toggleAgent(agent.key)}
                  isExpanded={expandedAgents.has(agent.key)}
                  formatDuration={formatDuration}
                  getStatusIcon={getStatusIcon}
                  highlight={justCompleted.has(agent.key)}
                  onCopyResult={copyResult}
                  copiedKey={copiedKey}
                />
              ))}
            </div>
          )}

          {/* Failed Agents */}
          {failed.length > 0 && (
            <div className="p-2 space-y-1 border-t border-terminal-border/50">
              <div className="text-xs text-terminal-dim px-2 py-1">FAILED</div>
              {failed.map(agent => (
                <AgentRow
                  key={agent.key}
                  agent={agent}
                  onClick={onAgentClick}
                  onToggle={() => toggleAgent(agent.key)}
                  isExpanded={expandedAgents.has(agent.key)}
                  formatDuration={formatDuration}
                  getStatusIcon={getStatusIcon}
                  highlight={false}
                  onCopyResult={copyResult}
                  copiedKey={copiedKey}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AgentRow({
  agent,
  onClick,
  onToggle,
  isExpanded,
  formatDuration,
  getStatusIcon,
  highlight,
  onCopyResult,
  copiedKey,
}: {
  agent: SubAgent;
  onClick?: (agent: SubAgent) => void;
  onToggle: () => void;
  isExpanded: boolean;
  formatDuration: (ms: number) => string;
  getStatusIcon: (status: SubAgent['status']) => React.ReactNode;
  highlight: boolean;
  onCopyResult: (text: string, key: string) => void;
  copiedKey: string | null;
}) {
  const modelCfg = getModelConfig(agent.model);
  const hasResult = agent.status !== 'running' && (agent.resultPreview || agent.resultFull);
  
  return (
    <div
      className={`rounded transition overflow-hidden ${
        highlight
          ? 'bg-terminal-green/15 border border-terminal-green/40 shadow-lg shadow-terminal-green/10'
          : 'hover:bg-terminal-bg/50 border border-transparent'
      }`}
    >
      {/* Main row */}
      <div className="flex items-start gap-2 px-2 py-2">
        <div className="mt-0.5 flex-shrink-0">{getStatusIcon(agent.status)}</div>
        
        <div className="flex-1 min-w-0">
          {/* Label + Model badge */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-terminal-text font-medium truncate max-w-[200px]">
              {agent.label || agent.key}
            </span>
            {/* Model badge */}
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded font-medium ${modelCfg.bg} ${modelCfg.color} border ${modelCfg.border}`}>
              {modelCfg.icon} {(agent.model || 'default').toUpperCase()}
            </span>
            {/* Completion flash */}
            {highlight && (
              <span className="px-1.5 py-0.5 text-[10px] bg-terminal-green/30 text-terminal-green rounded animate-pulse font-bold">
                JUST FINISHED
              </span>
            )}
          </div>
          
          {/* Task preview */}
          {agent.task && (
            <div className="text-xs text-terminal-dim truncate mt-0.5 max-w-[300px]">
              {agent.task}
            </div>
          )}
          
          {/* Timer + actions row */}
          <div className="flex items-center gap-3 mt-1.5">
            {/* Live timer or final duration */}
            <span className="flex items-center gap-1 text-xs text-terminal-dim">
              <Clock className="w-3 h-3" />
              {agent.status === 'running' ? (
                <span className="text-terminal-cyan font-medium">
                  <LiveTimer startedAt={agent.startedAt} />
                </span>
              ) : agent.durationMs ? (
                <span className="text-terminal-text">
                  {formatDuration(agent.durationMs)}
                </span>
              ) : (
                <span>—</span>
              )}
            </span>
            
            {/* View output button */}
            {hasResult && (
              <button
                onClick={(e) => { e.stopPropagation(); onToggle(); }}
                className="flex items-center gap-1 text-xs text-terminal-cyan hover:text-terminal-cyan/80 transition"
              >
                {isExpanded ? (
                  <>
                    <EyeOff className="w-3 h-3" />
                    <span>Hide output</span>
                  </>
                ) : (
                  <>
                    <Eye className="w-3 h-3" />
                    <span>View output</span>
                  </>
                )}
              </button>
            )}
            
            {/* Click to inject into chat */}
            {hasResult && onClick && (
              <button
                onClick={(e) => { e.stopPropagation(); onClick(agent); }}
                className="flex items-center gap-1 text-xs text-terminal-green hover:text-terminal-green/80 transition"
                title="Inject result into chat"
              >
                <Maximize2 className="w-3 h-3" />
                <span>To chat</span>
              </button>
            )}
          </div>
        </div>
      </div>
      
      {/* Expanded output panel */}
      {isExpanded && hasResult && (
        <div className="mx-2 mb-2 p-3 bg-terminal-bg rounded border border-terminal-border/50 relative">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-terminal-dim uppercase font-medium">Sub-Agent Output</span>
            <button
              onClick={() => onCopyResult(agent.resultFull || agent.resultPreview || '', agent.key)}
              className="flex items-center gap-1 text-[10px] text-terminal-dim hover:text-terminal-cyan transition px-1.5 py-0.5 rounded hover:bg-terminal-cyan/10"
            >
              {copiedKey === agent.key ? (
                <>
                  <Check className="w-3 h-3 text-terminal-green" />
                  <span className="text-terminal-green">Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>Copy all</span>
                </>
              )}
            </button>
          </div>
          <div className="text-xs text-terminal-text whitespace-pre-wrap max-h-64 overflow-y-auto font-mono leading-relaxed">
            {agent.resultFull || agent.resultPreview || '(no output)'}
          </div>
          {agent.resultFull && agent.resultFull.length > 500 && (
            <div className="mt-2 pt-2 border-t border-terminal-border/30 text-[10px] text-terminal-dim">
              {agent.resultFull.length.toLocaleString()} characters
            </div>
          )}
        </div>
      )}
    </div>
  );
}
