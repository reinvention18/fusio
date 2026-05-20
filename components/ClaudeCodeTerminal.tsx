'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import {
  Terminal,
  Play,
  Square,
  RefreshCw,
  Users,
  User,
  Trash2,
  ChevronDown,
  ChevronRight,
  Circle,
  Zap,
  AlertTriangle,
  Check,
  Copy,
  Send,
  Maximize2,
  Minimize2,
  Split,
} from 'lucide-react';
import { getGatewayConfig } from '@/lib/openclaw';

interface ClaudeSession {
  id: string;
  name: string;
  type: 'lead' | 'teammate' | 'solo';
  status: 'running' | 'stopped' | 'error';
  workspace: string;
  startedAt: string;
  teamMode: boolean;
  outputLength: number;
  lastOutput: string[];
}

interface ClaudeCodeStatus {
  installed: boolean;
  version?: string;
  teamsSupported?: boolean;
  error?: string;
}

export default function ClaudeCodeTerminal() {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const [outputOffset, setOutputOffset] = useState(0);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeCodeStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newPrompt, setNewPrompt] = useState('');
  const [teamMode, setTeamMode] = useState(true);
  const [sessionName, setSessionName] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [splitView, setSplitView] = useState(false);
  
  const outputRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // Check Claude Code installation status
  const checkClaudeStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/claude-code?action=check');
      const data = await response.json();
      setClaudeStatus(data);
    } catch (err) {
      setClaudeStatus({ installed: false, error: 'Failed to check Claude Code status' });
    }
  }, []);

  // Fetch sessions list
  const fetchSessions = useCallback(async () => {
    try {
      const response = await fetch('/api/claude-code?action=list');
      const data = await response.json();
      if (data.sessions) {
        setSessions(data.sessions);
      }
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Fetch output for selected session
  const fetchOutput = useCallback(async (sessionId: string, offset: number = 0) => {
    try {
      const response = await fetch(`/api/claude-code?action=output&sessionId=${sessionId}&offset=${offset}`);
      const data = await response.json();
      
      if (data.output) {
        if (offset === 0) {
          setOutput(data.output);
        } else {
          setOutput(prev => [...prev, ...data.output]);
        }
        setOutputOffset(data.totalLines);
        
        // Update session status
        setSessions(prev => prev.map(s => 
          s.id === sessionId ? { ...s, status: data.status } : s
        ));
      }
    } catch (err) {
      console.error('Failed to fetch output:', err);
    }
  }, []);

  // Start a new Claude Code session
  const startSession = async () => {
    const config = getGatewayConfig();
    const workspace = config.workspace;
    
    if (!workspace) {
      setError('No workspace configured. Set a workspace in Settings first.');
      return;
    }

    if (!newPrompt.trim()) {
      setError('Please enter a prompt or task description');
      return;
    }

    setIsStarting(true);
    setError(null);

    try {
      const response = await fetch('/api/claude-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          workspace,
          prompt: newPrompt,
          teamMode,
          name: sessionName || (teamMode ? 'Team Session' : 'Solo Session'),
        }),
      });

      const data = await response.json();

      if (data.success) {
        setNewPrompt('');
        setSessionName('');
        await fetchSessions();
        setSelectedSession(data.sessionId);
        setOutput([]);
        setOutputOffset(0);
      } else {
        setError(data.error || 'Failed to start session');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to start Claude Code');
    } finally {
      setIsStarting(false);
    }
  };

  // Stop a session
  const stopSession = async (sessionId: string) => {
    try {
      const response = await fetch('/api/claude-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', sessionId }),
      });
      
      const data = await response.json();
      if (data.success) {
        await fetchSessions();
      }
    } catch (err) {
      console.error('Failed to stop session:', err);
    }
  };

  // Clear a stopped session
  const clearSession = async (sessionId: string) => {
    try {
      const response = await fetch('/api/claude-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear', sessionId }),
      });
      
      const data = await response.json();
      if (data.success) {
        if (selectedSession === sessionId) {
          setSelectedSession(null);
          setOutput([]);
        }
        await fetchSessions();
      }
    } catch (err) {
      console.error('Failed to clear session:', err);
    }
  };

  // Initial load
  useEffect(() => {
    checkClaudeStatus();
    fetchSessions();
  }, [checkClaudeStatus, fetchSessions]);

  // Poll for updates when a session is selected
  useEffect(() => {
    if (selectedSession) {
      // Initial fetch
      fetchOutput(selectedSession);
      
      // Poll every 1 second
      pollRef.current = setInterval(() => {
        const session = sessions.find(s => s.id === selectedSession);
        if (session?.status === 'running') {
          fetchOutput(selectedSession, outputOffset);
        }
      }, 1000);
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, [selectedSession, sessions, outputOffset, fetchOutput]);

  // Auto-scroll output
  useEffect(() => {
    if (autoScroll && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output, autoScroll]);

  // Refresh sessions periodically
  useEffect(() => {
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running': return 'text-terminal-green';
      case 'stopped': return 'text-terminal-dim';
      case 'error': return 'text-terminal-red';
      default: return 'text-terminal-dim';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'running': return <Circle className="w-2 h-2 fill-terminal-green text-terminal-green animate-pulse" />;
      case 'stopped': return <Circle className="w-2 h-2 text-terminal-dim" />;
      case 'error': return <AlertTriangle className="w-3 h-3 text-terminal-red" />;
      default: return <Circle className="w-2 h-2 text-terminal-dim" />;
    }
  };

  const selectedSessionData = sessions.find(s => s.id === selectedSession);

  return (
    <div className="fusio-panel h-full flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-terminal-border">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, background: 'rgba(204, 12, 32, 0.12)', border: '1px solid rgba(204, 12, 32, 0.35)' }}>
              <Terminal style={{ width: 12, height: 12, color: 'var(--red, #CC0C20)' }} />
            </span>
            <div>
              <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
                Build · CLI
              </div>
              <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--white, #fff)', marginTop: 1 }}>
                Claude Code runner
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {claudeStatus?.installed ? (
              <span className="text-xs text-terminal-green flex items-center gap-1">
                <Check className="w-3 h-3" />
                v{claudeStatus.version}
                {claudeStatus.teamsSupported && (
                  <span className="ml-1 px-1.5 py-0.5 bg-terminal-cyan/20 text-terminal-cyan rounded">
                    Teams ✓
                  </span>
                )}
              </span>
            ) : (
              <span className="text-xs text-terminal-red flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                Not Installed
              </span>
            )}
            <button
              onClick={fetchSessions}
              className="p-2 text-terminal-dim hover:text-terminal-green transition rounded"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* New Session Form */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder="Session name (optional)"
              className="w-40 bg-terminal-bg border border-terminal-border rounded px-2 py-1.5 
                         text-sm text-terminal-text focus:border-terminal-green outline-none"
            />
            <button
              onClick={() => setTeamMode(!teamMode)}
              className={`flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium transition border ${
                teamMode
                  ? 'bg-terminal-cyan/20 text-terminal-cyan border-terminal-cyan/50'
                  : 'bg-terminal-surface text-terminal-dim border-terminal-border hover:border-terminal-cyan/50'
              }`}
              title={teamMode ? 'Team mode enabled' : 'Solo mode'}
            >
              {teamMode ? <Users className="w-3 h-3" /> : <User className="w-3 h-3" />}
              {teamMode ? 'TEAM' : 'SOLO'}
            </button>
          </div>
          
          <div className="flex gap-2">
            <textarea
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
              placeholder={teamMode 
                ? "Enter a team task (e.g., 'Debug this issue with 3 agents...')"
                : "Enter a prompt for Claude Code..."
              }
              className="flex-1 bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                         text-sm text-terminal-text focus:border-terminal-green outline-none resize-none"
              rows={2}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.ctrlKey) {
                  e.preventDefault();
                  startSession();
                }
              }}
            />
            <button
              onClick={startSession}
              disabled={isStarting || !claudeStatus?.installed}
              className={`px-4 py-2 rounded flex items-center gap-2 text-sm font-medium transition ${
                isStarting || !claudeStatus?.installed
                  ? 'bg-terminal-dim/20 text-terminal-dim cursor-not-allowed'
                  : 'bg-terminal-green/20 text-terminal-green border border-terminal-green/50 hover:bg-terminal-green/30'
              }`}
            >
              {isStarting ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  Start
                </>
              )}
            </button>
          </div>
          
          {error && (
            <div className="text-terminal-red text-xs flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              {error}
            </div>
          )}
          
          <div className="text-terminal-dim text-xs">
            Ctrl+Enter to start • {teamMode ? 'Agents will collaborate on the task' : 'Single Claude instance'}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className={`flex-1 flex ${splitView ? 'flex-row' : 'flex-col'} overflow-hidden`}>
        {/* Sessions List */}
        <div className={`${splitView ? 'w-1/3 border-r' : 'border-b'} border-terminal-border overflow-auto ${splitView ? '' : 'max-h-32'}`}>
          {isLoading ? (
            <div className="p-4 text-terminal-dim text-sm">Loading sessions...</div>
          ) : sessions.length === 0 ? (
            <div className="p-4 text-terminal-dim text-sm">
              No sessions. Start one above to begin coding.
            </div>
          ) : (
            <div className={`${splitView ? 'p-2 space-y-1' : 'flex gap-2 p-2 overflow-x-auto'}`}>
              {sessions.map((session) => (
                <div
                  key={session.id}
                  onClick={() => {
                    setSelectedSession(session.id);
                    setOutput([]);
                    setOutputOffset(0);
                  }}
                  className={`${splitView ? 'w-full' : 'flex-shrink-0 min-w-[200px]'} 
                              p-2 rounded cursor-pointer transition border ${
                    selectedSession === session.id
                      ? 'bg-terminal-green/10 border-terminal-green/50'
                      : 'bg-terminal-bg border-terminal-border hover:border-terminal-green/30'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      {getStatusIcon(session.status)}
                      <span className="text-terminal-text text-sm font-medium truncate max-w-[120px]">
                        {session.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {session.teamMode && (
                        <Users className="w-3 h-3 text-terminal-cyan" />
                      )}
                      {session.status === 'running' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            stopSession(session.id);
                          }}
                          className="p-1 text-terminal-red hover:bg-terminal-red/20 rounded transition"
                          title="Stop"
                        >
                          <Square className="w-3 h-3" />
                        </button>
                      )}
                      {session.status !== 'running' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            clearSession(session.id);
                          }}
                          className="p-1 text-terminal-dim hover:text-terminal-red transition"
                          title="Clear"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="text-xs text-terminal-dim truncate">
                    {new Date(session.startedAt).toLocaleTimeString()}
                    {session.outputLength > 0 && ` • ${session.outputLength} lines`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Terminal Output */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Output Header */}
          {selectedSession && (
            <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border bg-terminal-bg">
              <div className="flex items-center gap-2 text-sm">
                <Terminal className="w-4 h-4 text-terminal-cyan" />
                <span className="text-terminal-text">{selectedSessionData?.name}</span>
                <span className={`text-xs ${getStatusColor(selectedSessionData?.status || '')}`}>
                  ({selectedSessionData?.status})
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setAutoScroll(!autoScroll)}
                  className={`px-2 py-1 text-xs rounded transition ${
                    autoScroll
                      ? 'bg-terminal-green/20 text-terminal-green'
                      : 'text-terminal-dim hover:text-terminal-text'
                  }`}
                >
                  Auto-scroll
                </button>
                <button
                  onClick={() => setSplitView(!splitView)}
                  className="p-1 text-terminal-dim hover:text-terminal-cyan transition"
                  title={splitView ? 'Stack view' : 'Split view'}
                >
                  {splitView ? <Minimize2 className="w-4 h-4" /> : <Split className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(output.join('\n'));
                  }}
                  className="p-1 text-terminal-dim hover:text-terminal-cyan transition"
                  title="Copy output"
                >
                  <Copy className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
          
          {/* Output Content */}
          <div
            ref={outputRef}
            className="flex-1 overflow-auto p-3 font-mono text-xs bg-terminal-bg"
          >
            {selectedSession ? (
              output.length > 0 ? (
                output.map((line, i) => (
                  <div
                    key={i}
                    className={`${
                      line.startsWith('[stderr]')
                        ? 'text-terminal-red'
                        : line.startsWith('[')
                          ? 'text-terminal-amber'
                          : line.includes('✓') || line.includes('Success')
                            ? 'text-terminal-green'
                            : line.includes('Error') || line.includes('✗')
                              ? 'text-terminal-red'
                              : 'text-terminal-text'
                    }`}
                  >
                    {line}
                  </div>
                ))
              ) : (
                <div className="text-terminal-dim italic">
                  {selectedSessionData?.status === 'running'
                    ? 'Waiting for output...'
                    : 'No output'}
                </div>
              )
            ) : (
              <div className="h-full flex items-center justify-center text-terminal-dim">
                <div className="text-center">
                  <Terminal className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>Select a session to view output</p>
                  <p className="text-xs mt-1">Or start a new one above</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="p-2 border-t border-terminal-border text-xs text-terminal-dim flex items-center justify-between">
        <span>
          {sessions.filter(s => s.status === 'running').length} running • {sessions.length} total
        </span>
        <span className="flex items-center gap-2">
          {claudeStatus?.teamsSupported && (
            <span className="text-terminal-cyan">Agent Teams Ready</span>
          )}
        </span>
      </div>
    </div>
  );
}
