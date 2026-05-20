'use client';

import { useState, useEffect } from 'react';
import { BarChart3, Zap, MessageSquare, Clock } from 'lucide-react';

interface TokenUsage {
  used: number;
  max: number;
  outputTokens?: number;
}

export default function UsageStats() {
  const [sessionTime, setSessionTime] = useState(0);
  const [tokenUsageMap, setTokenUsageMap] = useState<Record<string, TokenUsage | null>>({});
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messageCount, setMessageCount] = useState(0);

  // Poll localStorage for real-time usage data written by ChatPanel
  useEffect(() => {
    const sync = () => {
      try {
        const raw = localStorage.getItem('mc-tokenUsageMap');
        if (raw) setTokenUsageMap(JSON.parse(raw));
        const sid = localStorage.getItem('mc-activeSessionId');
        if (sid) setActiveSessionId(sid);
        const mc = localStorage.getItem('mc-messageCount');
        if (mc) setMessageCount(parseInt(mc, 10) || 0);
      } catch {}
    };
    sync();
    const interval = setInterval(sync, 2000);
    return () => clearInterval(interval);
  }, []);

  // Count up session time
  useEffect(() => {
    const interval = setInterval(() => {
      setSessionTime(prev => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const currentUsage = activeSessionId ? tokenUsageMap?.[activeSessionId] : null;
  const allUsage = Object.values(tokenUsageMap || {}).filter(Boolean) as TokenUsage[];
  const totalTokens = allUsage.reduce((sum, u) => sum + u.used, 0);

  const contextPct = currentUsage ? Math.round((currentUsage.used / currentUsage.max) * 100) : 0;
  const contextBarColor = contextPct > 85 ? 'bg-terminal-red' : contextPct > 70 ? 'bg-terminal-amber' : 'bg-terminal-green';

  const formatTokens = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
  };

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fusio-panel p-3">
      <div className="flex items-center gap-2.5 mb-3">
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 5, background: 'rgba(232, 162, 59, 0.12)', border: '1px solid rgba(232, 162, 59, 0.35)' }}>
          <BarChart3 style={{ width: 11, height: 11, color: 'var(--amber, #E8A23B)' }} />
        </span>
        <div>
          <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
            Monitor · Tokens
          </div>
          <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--white, #fff)', marginTop: 1 }}>
            Usage
          </div>
        </div>
      </div>

      {/* Context Window Bar (active session) */}
      {currentUsage && (
        <div className="mb-3 bg-terminal-bg rounded p-2 border border-terminal-border">
          <div className="flex items-center justify-between mb-1">
            <span className="text-terminal-dim text-xs">Context Window</span>
            <span className="text-xs font-mono text-terminal-text">
              {formatTokens(currentUsage.used)} / {formatTokens(currentUsage.max)}
            </span>
          </div>
          <div className="h-2 bg-terminal-border rounded overflow-hidden">
            <div
              className={`h-full ${contextBarColor} transition-all duration-500`}
              style={{ width: `${Math.min(100, contextPct)}%` }}
            />
          </div>
          <div className="text-right text-xs text-terminal-dim mt-0.5">{contextPct}%</div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="bg-terminal-bg rounded p-2 border border-terminal-border">
          <div className="flex items-center gap-1 text-terminal-dim text-xs mb-1">
            <Zap className="w-3 h-3" />
            Input Tokens
          </div>
          <div className="text-terminal-cyan text-lg font-bold">
            {currentUsage ? formatTokens(currentUsage.used) : '—'}
          </div>
        </div>

        <div className="bg-terminal-bg rounded p-2 border border-terminal-border">
          <div className="flex items-center gap-1 text-terminal-dim text-xs mb-1">
            <Zap className="w-3 h-3" />
            Output Tokens
          </div>
          <div className="text-terminal-amber text-lg font-bold">
            {currentUsage?.outputTokens ? formatTokens(currentUsage.outputTokens) : '—'}
          </div>
        </div>

        <div className="bg-terminal-bg rounded p-2 border border-terminal-border">
          <div className="flex items-center gap-1 text-terminal-dim text-xs mb-1">
            <MessageSquare className="w-3 h-3" />
            Messages
          </div>
          <div className="text-terminal-green text-lg font-bold">{messageCount ?? 0}</div>
        </div>

        <div className="bg-terminal-bg rounded p-2 border border-terminal-border">
          <div className="flex items-center gap-1 text-terminal-dim text-xs mb-1">
            <Clock className="w-3 h-3" />
            Session
          </div>
          <div className="text-terminal-text text-lg font-bold font-mono">{formatTime(sessionTime)}</div>
        </div>
      </div>

      {/* All Sessions Total */}
      {allUsage.length > 1 && (
        <div className="mt-2 bg-terminal-bg rounded p-2 border border-terminal-border">
          <div className="flex items-center justify-between">
            <span className="text-terminal-dim text-xs">All Sessions</span>
            <span className="text-terminal-cyan text-sm font-bold">{formatTokens(totalTokens)} tokens</span>
          </div>
        </div>
      )}
    </div>
  );
}
