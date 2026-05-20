'use client';

import { useState, useEffect } from 'react';
import { History, MessageSquare, User, Bot, Clock, ChevronRight, RefreshCw, Search, Calendar, Filter, X, FolderOpen, Terminal, Import } from 'lucide-react';

interface HistoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

interface Session {
  key: string;
  kind: string;
  lastMessage?: string;
  lastActivity?: string;
  messageCount?: number;
}

interface ClaudeProject {
  path: string;
  encodedPath: string;
  sessionCount: number;
  lastActivity: string;
}

interface ClaudeSession {
  id: string;
  filename: string;
  messageCount: number;
  firstMessage: string | null;
  lastMessage: string | null;
  lastActivity: string;
}

export default function HistoryPanel() {
  // Source toggle: openclaw vs claude-code
  const [source, setSource] = useState<'openclaw' | 'claude'>('openclaw');

  // OpenClaw sessions state
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [error, setError] = useState<string | null>(null);

  // Claude Code history state
  const [claudeProjects, setClaudeProjects] = useState<ClaudeProject[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSession[]>([]);
  const [claudeLoading, setClaudeLoading] = useState(false);

  const fetchClaudeProjects = async () => {
    setClaudeLoading(true);
    try {
      const res = await fetch('/api/claude-history?action=projects');
      const data = await res.json();
      setClaudeProjects(data.projects || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setClaudeLoading(false);
    }
  };

  const fetchClaudeSessions = async (encodedPath: string) => {
    setSelectedProject(encodedPath);
    setClaudeLoading(true);
    setClaudeSessions([]);
    setSelectedSession(null);
    setMessages([]);
    try {
      const res = await fetch(`/api/claude-history?action=sessions&project=${encodeURIComponent(encodedPath)}`);
      const data = await res.json();
      setClaudeSessions(data.sessions || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setClaudeLoading(false);
    }
  };

  const fetchClaudeMessages = async (sessionId: string) => {
    if (!selectedProject) return;
    setLoadingHistory(true);
    setSelectedSession(sessionId);
    setMessages([]);
    try {
      const res = await fetch(
        `/api/claude-history?action=messages&project=${encodeURIComponent(selectedProject)}&session=${encodeURIComponent(sessionId)}`
      );
      const data = await res.json();
      setMessages(data.messages || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoadingHistory(false);
    }
  };

  const fetchSessions = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch('/api/history?action=list');
      const data = await response.json();
      
      if (data.error && !data.sessions) {
        setError(data.error);
        return;
      }

      // Transform the transcript files into session format
      const sessions = (data.sessions || []).map((s: any) => ({
        key: s.id,
        kind: 'transcript',
        lastMessage: s.lastMessage,
        lastActivity: s.lastActivity,
        messageCount: s.messageCount,
      }));

      setSessions(sessions);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch sessions');
    } finally {
      setLoading(false);
    }
  };

  const fetchHistory = async (sessionKey: string) => {
    setLoadingHistory(true);
    setSelectedSession(sessionKey);
    setMessages([]);
    
    try {
      const response = await fetch(`/api/history?action=history&session=${encodeURIComponent(sessionKey)}`);
      const data = await response.json();
      
      if (data.error && !data.messages) {
        setError(data.error);
        return;
      }

      setMessages(data.messages || []);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch history');
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    fetchSessions();
    fetchClaudeProjects();
  }, []);

  // Filter sessions
  const filteredSessions = sessions.filter(s => {
    if (kindFilter !== 'all' && s.kind !== kindFilter) return false;
    if (search) {
      const searchLower = search.toLowerCase();
      return s.key.toLowerCase().includes(searchLower) || 
             s.lastMessage?.toLowerCase().includes(searchLower);
    }
    return true;
  });

  // Get unique kinds for filter
  const kinds = ['all', ...new Set(sessions.map(s => s.kind))];

  const formatTime = (timestamp?: string) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div style={{ display: 'flex', height: '100%', gap: 16, fontFamily: 'var(--font-sans, system-ui)' }}>
      {/* Sessions List */}
      <div
        style={{
          width: 320,
          background: 'var(--ink, #0A0A0E)',
          border: '1px solid var(--line, rgba(255,255,255,0.08))',
          borderRadius: 12,
          display: 'flex', flexDirection: 'column',
          color: 'var(--white, #fff)',
        }}
      >
        <div style={{ padding: 14, borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 22, height: 22, borderRadius: 5,
                  background: 'rgba(94, 196, 217, 0.12)',
                  border: '1px solid rgba(94, 196, 217, 0.35)',
                }}
              >
                <History style={{ width: 11, height: 11, color: 'var(--cyan, #5EC4D9)' }} />
              </span>
              <div>
                <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
                  Monitor · History
                </div>
                <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>
                  Sessions
                </div>
              </div>
            </div>
            <button
              onClick={() => { fetchSessions(); fetchClaudeProjects(); }}
              disabled={loading || claudeLoading}
              data-fusio
              title="Refresh"
              style={{
                padding: 5, borderRadius: 5, background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--mist, rgba(255,255,255,0.5))',
                transition: 'all 120ms ease-out',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
            >
              <RefreshCw style={{ width: 13, height: 13, animation: (loading || claudeLoading) ? 'spin 1s linear infinite' : undefined }} />
            </button>
          </div>

          {/* Source Toggle — Fusio segmented control */}
          <div
            style={{
              display: 'flex',
              marginBottom: 10,
              borderRadius: 6,
              border: '1px solid var(--line, rgba(255,255,255,0.08))',
              overflow: 'hidden',
              background: 'var(--ink-3, #1B1B23)',
            }}
          >
            <button
              onClick={() => setSource('openclaw')}
              data-fusio
              style={{
                flex: 1, padding: '6px 8px',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
                background: source === 'openclaw' ? 'rgba(204, 12, 32, 0.14)' : 'transparent',
                color: source === 'openclaw' ? 'var(--red, #CC0C20)' : 'var(--mist, rgba(255,255,255,0.5))',
                border: 'none',
                borderRight: '1px solid var(--line, rgba(255,255,255,0.08))',
                cursor: 'pointer',
                transition: 'all 120ms ease-out',
              }}
            >
              <MessageSquare style={{ width: 10, height: 10 }} />
              OpenClaw
            </button>
            <button
              onClick={() => setSource('claude')}
              data-fusio
              style={{
                flex: 1, padding: '6px 8px',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
                background: source === 'claude' ? 'rgba(139, 111, 232, 0.14)' : 'transparent',
                color: source === 'claude' ? 'var(--violet, #8B6FE8)' : 'var(--mist, rgba(255,255,255,0.5))',
                border: 'none',
                cursor: 'pointer',
                transition: 'all 120ms ease-out',
              }}
            >
              <Terminal style={{ width: 10, height: 10 }} />
              Claude Code
            </button>
          </div>

          {/* Search */}
          <div className="relative mb-2">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-terminal-dim" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sessions..."
              className="w-full bg-terminal-bg border border-terminal-border rounded pl-7 pr-2 py-1.5
                         text-xs text-terminal-text focus:border-terminal-green outline-none"
            />
          </div>

          {source === 'openclaw' && (
            <div className="flex items-center gap-2">
              <Filter className="w-3.5 h-3.5 text-terminal-dim" />
              <select
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value)}
                className="flex-1 bg-terminal-bg border border-terminal-border rounded px-2 py-1
                           text-xs text-terminal-text focus:border-terminal-green outline-none"
              >
                {kinds.map(k => (
                  <option key={k} value={k}>{k === 'all' ? 'All Sessions' : k}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Sessions List */}
        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="p-3 text-terminal-red text-sm">
              {error}
            </div>
          )}

          {/* Claude Code Projects & Sessions */}
          {source === 'claude' && (
            <>
              {claudeLoading ? (
                <div className="p-4 text-center text-terminal-dim">
                  <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
                  Loading projects...
                </div>
              ) : !selectedProject ? (
                <div className="p-2 space-y-1">
                  {claudeProjects
                    .filter(p => !search || p.path.toLowerCase().includes(search.toLowerCase()))
                    .map(project => (
                    <button
                      key={project.encodedPath}
                      onClick={() => fetchClaudeSessions(project.encodedPath)}
                      className="w-full text-left p-2 rounded transition hover:bg-terminal-bg border border-transparent"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <FolderOpen className="w-3.5 h-3.5 text-terminal-purple flex-shrink-0" />
                        <span className="text-terminal-text text-sm font-mono truncate">{project.path}</span>
                        <ChevronRight className="w-3.5 h-3.5 text-terminal-dim ml-auto flex-shrink-0" />
                      </div>
                      <div className="flex items-center gap-2 text-xs text-terminal-dim ml-5">
                        <span>{project.sessionCount} session{project.sessionCount !== 1 ? 's' : ''}</span>
                        {project.lastActivity && (
                          <>
                            <span>·</span>
                            <span>{formatTime(project.lastActivity)}</span>
                          </>
                        )}
                      </div>
                    </button>
                  ))}
                  {claudeProjects.length === 0 && (
                    <div className="p-4 text-center text-terminal-dim text-sm">
                      No Claude Code projects found
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <button
                    onClick={() => { setSelectedProject(null); setClaudeSessions([]); setSelectedSession(null); setMessages([]); }}
                    className="w-full text-left p-2 text-xs text-terminal-purple hover:text-terminal-text transition flex items-center gap-1 border-b border-terminal-border"
                  >
                    ← Back to projects
                  </button>
                  <div className="p-2 space-y-1">
                    {claudeSessions
                      .filter(s => !search || s.firstMessage?.toLowerCase().includes(search.toLowerCase()) || s.lastMessage?.toLowerCase().includes(search.toLowerCase()))
                      .map(session => (
                      <button
                        key={session.id}
                        onClick={() => fetchClaudeMessages(session.id)}
                        className={`w-full text-left p-2 rounded transition ${
                          selectedSession === session.id
                            ? 'bg-terminal-purple/20 border border-terminal-purple/30'
                            : 'hover:bg-terminal-bg border border-transparent'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-terminal-text text-xs font-mono truncate flex-1">
                            {session.id.slice(0, 8)}...
                          </span>
                          <span className="text-terminal-dim text-xs">{session.messageCount} msgs</span>
                        </div>
                        {session.firstMessage && (
                          <div className="text-xs text-terminal-dim truncate">{session.firstMessage}</div>
                        )}
                        <div className="text-xs text-terminal-dim mt-1 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatTime(session.lastActivity)}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* OpenClaw Sessions */}
          {source === 'openclaw' && loading ? (
            <div className="p-4 text-center text-terminal-dim">
              <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
              Loading sessions...
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="p-4 text-center text-terminal-dim text-sm">
              {search ? 'No matching sessions' : 'No sessions found'}
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {filteredSessions.map((session) => (
                <button
                  key={session.key}
                  onClick={() => fetchHistory(session.key)}
                  className={`w-full text-left p-2 rounded transition ${
                    selectedSession === session.key
                      ? 'bg-terminal-green/20 border border-terminal-green/30'
                      : 'hover:bg-terminal-bg border border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-terminal-text text-sm font-mono truncate flex-1">
                      {session.key}
                    </span>
                    <ChevronRight className="w-3.5 h-3.5 text-terminal-dim" />
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`px-1.5 py-0.5 rounded ${
                      session.kind === 'main' 
                        ? 'bg-terminal-cyan/20 text-terminal-cyan' 
                        : 'bg-terminal-yellow/20 text-terminal-yellow'
                    }`}>
                      {session.kind}
                    </span>
                    {session.messageCount && (
                      <span className="text-terminal-dim">{session.messageCount} msgs</span>
                    )}
                  </div>
                  {session.lastMessage && (
                    <div className="text-xs text-terminal-dim mt-1 truncate">
                      {session.lastMessage}
                    </div>
                  )}
                  {session.lastActivity && (
                    <div className="text-xs text-terminal-dim mt-1 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatTime(session.lastActivity)}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-2 border-t border-terminal-border text-xs text-terminal-dim text-center">
          {filteredSessions.length} session{filteredSessions.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Message History */}
      <div className="flex-1 fusio-panel flex flex-col">
        <div className="p-3 border-b border-terminal-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-terminal-green" />
            <h2 className="text-terminal-green font-bold">
              {selectedSession ? (
                <span className="font-mono">{selectedSession}</span>
              ) : (
                'SELECT A SESSION'
              )}
            </h2>
          </div>
          {selectedSession && (
            <button
              onClick={() => {
                setSelectedSession(null);
                setMessages([]);
              }}
              className="text-terminal-dim hover:text-terminal-text text-xs transition"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {!selectedSession ? (
            <div className="h-full flex items-center justify-center text-terminal-dim">
              <div className="text-center">
                <History className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>Select a session to view history</p>
                <p className="text-sm mt-2">Click on any session in the list</p>
              </div>
            </div>
          ) : loadingHistory ? (
            <div className="h-full flex items-center justify-center text-terminal-dim">
              <div className="text-center">
                <RefreshCw className="w-8 h-8 mx-auto mb-4 animate-spin" />
                <p>Loading history...</p>
              </div>
            </div>
          ) : messages.length === 0 ? (
            <div className="h-full flex items-center justify-center text-terminal-dim">
              <div className="text-center">
                <MessageSquare className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No messages in this session</p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((msg, idx) => (
                <div key={idx} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                  {msg.role !== 'user' && (
                    <div className={`w-8 h-8 rounded flex items-center justify-center flex-shrink-0 ${
                      msg.role === 'system' ? 'bg-terminal-dim/20' : 'bg-terminal-green/20'
                    }`}>
                      {msg.role === 'system' ? (
                        <MessageSquare className="w-4 h-4 text-terminal-dim" />
                      ) : (
                        <Bot className="w-4 h-4 text-terminal-green" />
                      )}
                    </div>
                  )}
                  
                  <div className={`max-w-[80%] ${msg.role === 'user' ? 'order-first' : ''}`}>
                    <div className={`rounded-lg px-4 py-2 ${
                      msg.role === 'user' 
                        ? 'bg-terminal-cyan/20 border border-terminal-cyan/30 text-terminal-text'
                        : msg.role === 'system'
                        ? 'bg-terminal-bg border border-terminal-border text-terminal-dim italic'
                        : 'bg-terminal-bg border border-terminal-border text-terminal-text'
                    }`}>
                      <div className="whitespace-pre-wrap text-sm break-words">
                        {msg.content.length > 2000 
                          ? msg.content.slice(0, 2000) + '...[truncated]'
                          : msg.content}
                      </div>
                    </div>
                    {msg.timestamp && (
                      <div className={`text-xs text-terminal-dim mt-1 ${msg.role === 'user' ? 'text-right' : ''}`}>
                        {new Date(msg.timestamp).toLocaleString()}
                      </div>
                    )}
                  </div>

                  {msg.role === 'user' && (
                    <div className="w-8 h-8 rounded bg-terminal-cyan/20 flex items-center justify-center flex-shrink-0">
                      <User className="w-4 h-4 text-terminal-cyan" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {selectedSession && messages.length > 0 && (
          <div className="p-2 border-t border-terminal-border text-xs text-terminal-dim text-center">
            {messages.length} message{messages.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>
    </div>
  );
}
