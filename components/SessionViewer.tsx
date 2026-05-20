'use client';

import { useEffect, useState } from 'react';
import { MessageSquare, User, Clock, ChevronRight, RefreshCw } from 'lucide-react';

interface Session {
  key: string;
  kind: string;
  lastMessage: string;
  lastActivity: Date;
  messageCount: number;
  label?: string;
  sessionKey?: string;
}

export default function SessionViewer() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch sessions from gateway
  const fetchSessions = async () => {
    setLoading(true);
    setError(null);

    try {
      // Get gateway config from localStorage
      const config = JSON.parse(localStorage.getItem('gatewayConfig') || '{}');
      const gatewayUrl = config.url || 'ws://localhost:18789';
      const token = config.token || '';

      if (!token) {
        setError('No gateway token configured');
        setSessions([]);
        return;
      }

      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          gatewayUrl, 
          token, 
          action: 'list' 
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch sessions: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (data.sessions && Array.isArray(data.sessions)) {
        const formattedSessions: Session[] = data.sessions.map((s: any) => ({
          key: s.sessionKey || s.key || s.name || 'unknown',
          kind: s.kind || (s.sessionKey?.includes(':isolated:') ? 'isolated' : 'main'),
          lastMessage: s.lastMessage?.content || s.lastMessage || 'No messages',
          lastActivity: new Date(s.lastActivity || s.modified || s.updatedAt || Date.now()),
          messageCount: s.messageCount || 0,
          label: s.label || s.name,
          sessionKey: s.sessionKey || s.key,
        }));

        setSessions(formattedSessions);
      } else {
        setSessions([]);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to fetch sessions');
      setSessions([]);
    } finally {
      setLoading(false);
    }
  };

  // Load sessions on mount
  useEffect(() => {
    fetchSessions();
    
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchSessions, 30000);
    
    return () => clearInterval(interval);
  }, []);

  const formatTime = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const mins = Math.floor(diff / 60000);
    
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString();
  };

  const getKindColor = (kind: string) => {
    switch (kind) {
      case 'main': return 'text-terminal-green';
      case 'isolated': return 'text-terminal-cyan';
      case 'group': return 'text-terminal-amber';
      default: return 'text-terminal-dim';
    }
  };

  const getKindBadge = (kind: string) => {
    switch (kind) {
      case 'main': return 'bg-terminal-green/20 border-terminal-green/30';
      case 'isolated': return 'bg-terminal-cyan/20 border-terminal-cyan/30';
      case 'group': return 'bg-terminal-amber/20 border-terminal-amber/30';
      default: return 'bg-terminal-dim/20 border-terminal-dim/30';
    }
  };

  return (
    <div className="fusio-panel p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, background: 'rgba(94, 196, 217, 0.12)', border: '1px solid rgba(94, 196, 217, 0.35)' }}>
            <MessageSquare style={{ width: 12, height: 12, color: 'var(--cyan, #5EC4D9)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Monitor · Sessions
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--white, #fff)', marginTop: 1 }}>
              Sessions
            </div>
          </div>
        </div>
        <button
          onClick={fetchSessions}
          disabled={loading}
          className={`p-1.5 text-terminal-dim hover:text-terminal-green rounded transition ${
            loading ? 'animate-spin' : ''
          }`}
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div className="bg-terminal-red/10 border border-terminal-red/30 rounded p-3 mb-4">
          <p className="text-terminal-red text-sm">{error}</p>
          <p className="text-terminal-dim text-xs mt-1">
            Check that OpenClaw gateway is running and configured.
          </p>
        </div>
      )}

      {/* Sessions List */}
      <div className="space-y-2">
        {loading && sessions.length === 0 ? (
          <div className="text-center py-8 text-terminal-dim">
            <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
            Loading sessions...
          </div>
        ) : sessions.length === 0 ? (
          <div className="text-terminal-dim text-center py-8 italic">
            No active sessions
          </div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.key}
              onClick={() => setSelectedSession(session)}
              className="bg-terminal-bg rounded p-3 border border-terminal-border 
                         hover:border-terminal-green/50 cursor-pointer transition group"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <User className="w-4 h-4 text-terminal-dim" />
                  <span className="text-terminal-text font-medium">
                    {session.label || session.key.split(':').pop() || session.key}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded border ${getKindBadge(session.kind)} ${getKindColor(session.kind)}`}>
                    {session.kind.toUpperCase()}
                  </span>
                </div>
                <ChevronRight className="w-4 h-4 text-terminal-dim opacity-0 group-hover:opacity-100 transition" />
              </div>
              
              <div className="mt-2 text-terminal-dim text-xs truncate">
                {session.lastMessage}
              </div>
              
              <div className="mt-2 flex items-center gap-3 text-xs text-terminal-dim">
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {formatTime(session.lastActivity)}
                </span>
                <span className="flex items-center gap-1">
                  <MessageSquare className="w-3 h-3" />
                  {session.messageCount} msgs
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Session Detail Modal */}
      {selectedSession && (
        <div 
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50"
          onClick={() => setSelectedSession(null)}
        >
          <div 
            className="fusio-panel p-6 w-full max-w-lg max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-terminal-green font-bold">
                SESSION: {selectedSession.label || selectedSession.key}
              </h3>
              <span className={`text-xs px-2 py-0.5 rounded border ${getKindBadge(selectedSession.kind)} ${getKindColor(selectedSession.kind)}`}>
                {selectedSession.kind.toUpperCase()}
              </span>
            </div>

            <div className="space-y-4">
              <div className="bg-terminal-bg rounded p-3">
                <div className="text-terminal-dim text-xs mb-1">SESSION KEY</div>
                <div className="text-terminal-text font-mono text-xs break-all">
                  {selectedSession.sessionKey || selectedSession.key}
                </div>
              </div>

              <div className="bg-terminal-bg rounded p-3">
                <div className="text-terminal-dim text-xs mb-1">LAST MESSAGE</div>
                <div className="text-terminal-text text-sm">{selectedSession.lastMessage}</div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-terminal-bg rounded p-3">
                  <div className="text-terminal-dim text-xs mb-1">MESSAGES</div>
                  <div className="text-terminal-cyan text-lg">{selectedSession.messageCount}</div>
                </div>
                <div className="bg-terminal-bg rounded p-3">
                  <div className="text-terminal-dim text-xs mb-1">LAST ACTIVE</div>
                  <div className="text-terminal-text text-sm">
                    {selectedSession.lastActivity.toLocaleString()}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end mt-6">
              <button
                onClick={() => setSelectedSession(null)}
                className="px-4 py-2 bg-terminal-bg hover:bg-terminal-elevated border border-terminal-border rounded text-terminal-text text-sm transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
