/**
 * AgentHub — live list of agent sessions (main + sub-agents). Polls /api/sessions
 * every 5s and lets the user expand any session to view recent messages.
 *
 * Restructured for the AI Fusio design language: tokens come from /fusio/mc.css
 * (palette + fonts), uppercase mono eyebrows, accent pip, compact rows.
 * Functional API + endpoints unchanged.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { Bot, RefreshCw, ChevronDown, ChevronRight, Clock, Activity, MessageSquare, Zap } from 'lucide-react';

interface Session {
  sessionKey: string;
  kind: string;
  size: number;
  modified: string;
  messageCount: number;
  lastMessage?: { role: string; content: string } | null;
  live?: boolean;
  gatewayData?: any;
  agent?: string;
  name?: string;
}

interface Message {
  role: string;
  content: string;
  timestamp?: string | null;
}

type SessionStatus = 'running' | 'idle' | 'completed' | 'aborted';

// Palette tokens (fall back to plain hex so the panel still reads if /fusio/mc.css
// is missing for any reason).
const VOID   = 'var(--bg-primary, #050507)';
const INK    = 'var(--bg-surface, #0A0A0E)';
const INK_2  = 'var(--bg-elevated, #131319)';
const INK_3  = 'var(--ink-3, #1B1B23)';
const LINE   = 'var(--border, rgba(255,255,255,0.08))';
const WHITE  = 'var(--text-primary, #FFFFFF)';
const FOG    = 'var(--fog, rgba(255,255,255,0.78))';
const MIST   = 'var(--mist, rgba(255,255,255,0.5))';
const DIM    = 'var(--dim, rgba(255,255,255,0.32))';
const RED    = 'var(--red, #CC0C20)';
const GREEN  = 'var(--green, #4CC38A)';
const CYAN   = 'var(--cyan, #5EC4D9)';
const AMBER  = 'var(--amber, #E8A23B)';
const VIOLET = 'var(--violet, #8B6FE8)';

const FONT_MONO    = 'var(--font-mono, ui-monospace, monospace)';
const FONT_SANS    = 'var(--font-sans, system-ui)';
const FONT_DISPLAY = 'var(--font-display, "Space Grotesk")';

const eyebrow = (color: string = MIST, size = 10): React.CSSProperties => ({
  fontFamily: FONT_MONO,
  fontSize: size,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color,
});

const STATUS_TOKEN: Record<SessionStatus, { color: string; hex: string; label: string }> = {
  running:   { color: GREEN,  hex: '#4CC38A', label: 'Running' },
  idle:      { color: AMBER,  hex: '#E8A23B', label: 'Idle' },
  aborted:   { color: RED,    hex: '#CC0C20', label: 'Aborted' },
  completed: { color: MIST,   hex: '#7d7d8a', label: 'Done' },
};

function tint(hex: string, alpha: number) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function AgentHub() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<Record<string, Message[]>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Gateway config from localStorage
  const getConfig = () => {
    if (typeof window === 'undefined') return { gatewayUrl: '', token: '' };
    const localConfig = JSON.parse(localStorage.getItem('gatewayConfig') || '{}');
    const gatewayUrl = (localConfig.url || 'ws://localhost:18789')
      .replace('ws://', 'http://')
      .replace('wss://', 'https://');
    const token = localConfig.token || '';
    return { gatewayUrl, token };
  };

  const fetchSessions = useCallback(async (isManualRefresh = false) => {
    try {
      if (isManualRefresh) setRefreshing(true);
      const config = getConfig();
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gatewayUrl: config.gatewayUrl,
          token: config.token,
          action: 'list',
        }),
      });
      if (response.ok) {
        const data = await response.json();
        setSessions(data.sessions || []);
      }
    } catch (error) {
      console.error('[AgentHub] Failed to fetch sessions:', error);
    } finally {
      setLoading(false);
      if (isManualRefresh) setRefreshing(false);
    }
  }, []);

  const fetchSessionMessages = useCallback(async (sessionKey: string) => {
    try {
      const response = await fetch(`/api/history?action=history&session=${encodeURIComponent(sessionKey)}`);
      if (response.ok) {
        const data = await response.json();
        setSessionMessages(prev => ({
          ...prev,
          [sessionKey]: data.messages || [],
        }));
      }
    } catch (error) {
      console.error('[AgentHub] Failed to fetch messages for', sessionKey, error);
    }
  }, []);

  const toggleSession = (sessionKey: string) => {
    if (expandedSession === sessionKey) {
      setExpandedSession(null);
    } else {
      setExpandedSession(sessionKey);
      if (!sessionMessages[sessionKey]) {
        fetchSessionMessages(sessionKey);
      }
    }
  };

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(() => fetchSessions(), 5000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  const getSessionStatus = (session: Session): SessionStatus => {
    if (session.live) return 'running';
    const modifiedTime = new Date(session.modified).getTime();
    const now = Date.now();
    const minutesSinceModified = (now - modifiedTime) / 1000 / 60;
    if (minutesSinceModified < 5) return 'idle';
    return 'completed';
  };

  const getRuntime = (session: Session): string => {
    const modified = new Date(session.modified).getTime();
    const now = Date.now();
    const diffMs = now - modified;
    const minutes = Math.floor(diffMs / 1000 / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m`;
    return '< 1m';
  };

  const getTaskDescription = (session: Session): string => {
    const content = session.lastMessage?.content || '';
    return content.slice(0, 100) + (content.length > 100 ? '…' : '');
  };

  const mainSession = sessions.find(s => s.kind === 'main' || s.sessionKey.includes(':main:main'));
  const subAgents = sessions.filter(s =>
    s.sessionKey.includes(':isolated:') ||
    s.sessionKey.includes(':spawn:') ||
    s.sessionKey.includes(':subagent:')
  );

  const activeCount = subAgents.filter(s => {
    const st = getSessionStatus(s);
    return st === 'running' || st === 'idle';
  }).length;
  const completedCount = subAgents.filter(s => getSessionStatus(s) === 'completed').length;

  const formatSessionKey = (key: string) => {
    const parts = key.split(':');
    if (parts.length > 2) return parts.slice(2).join(':');
    return key;
  };

  // Status badge — small mono uppercase pill with tinted bg
  const StatusBadge = ({ status }: { status: SessionStatus }) => {
    const t = STATUS_TOKEN[status];
    return (
      <span
        style={{
          ...eyebrow(t.color, 9),
          padding: '2px 6px',
          background: tint(t.hex, 0.12),
          border: `1px solid ${tint(t.hex, 0.35)}`,
          borderRadius: 4,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {status === 'running' && (
          <span
            style={{
              width: 5, height: 5, borderRadius: '50%',
              background: t.color,
              boxShadow: `0 0 6px ${t.color}`,
              animation: 'fusio-pulse 1.6s ease-in-out infinite',
            }}
          />
        )}
        {t.label}
      </span>
    );
  };

  return (
    <div
      style={{
        background: INK,
        border: `1px solid ${LINE}`,
        borderRadius: 12,
        padding: 16,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: FONT_SANS,
        color: WHITE,
        overflow: 'hidden',
      }}
    >
      {/* HEAD */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 24, height: 24, borderRadius: 6,
              background: tint('#5EC4D9', 0.12), border: `1px solid ${tint('#5EC4D9', 0.35)}`,
            }}
          >
            <Bot style={{ width: 12, height: 12, color: CYAN }} />
          </span>
          <div>
            <div style={eyebrow(MIST)}>Monitor · Runtime</div>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', color: WHITE, marginTop: 1 }}>
              Agent hub
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ ...eyebrow(CYAN, 10) }}>
            <span style={{ color: GREEN }}>{activeCount}</span> active · <span style={{ color: MIST }}>{completedCount}</span> done
          </div>
          <button
            type="button"
            onClick={() => fetchSessions(true)}
            disabled={refreshing}
            className="card-btn"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              opacity: refreshing ? 0.5 : 1,
              cursor: refreshing ? 'not-allowed' : 'pointer',
              fontSize: 11,
              padding: '5px 12px',
            }}
          >
            <RefreshCw style={{ width: 12, height: 12, animation: refreshing ? 'spin 1s linear infinite' : undefined }} />
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: MIST }}>
          <RefreshCw style={{ width: 22, height: 22, animation: 'spin 1s linear infinite' }} />
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* MAIN AGENT */}
          {mainSession && (
            <div
              style={{
                border: `1px solid ${tint('#4CC38A', 0.4)}`,
                borderRadius: 10,
                background: tint('#4CC38A', 0.04),
                overflow: 'hidden',
              }}
            >
              {/* Head bar */}
              <div
                style={{
                  padding: '10px 12px',
                  borderBottom: `1px solid ${tint('#4CC38A', 0.25)}`,
                  background: tint('#4CC38A', 0.08),
                  display: 'flex', alignItems: 'center', gap: 10,
                }}
              >
                <Zap style={{ width: 14, height: 14, color: GREEN }} />
                <span style={eyebrow(GREEN)}>Main agent</span>
                <span style={{ marginLeft: 'auto' }}>
                  <StatusBadge status={getSessionStatus(mainSession)} />
                </span>
              </div>
              {/* Body */}
              <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, ...eyebrow(MIST, 10) }}>
                  <span style={{ color: CYAN, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <MessageSquare style={{ width: 11, height: 11 }} />
                    {mainSession.messageCount} msgs
                  </span>
                  <span style={{ color: AMBER, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Clock style={{ width: 11, height: 11 }} />
                    {getRuntime(mainSession)}
                  </span>
                </div>
                {mainSession.lastMessage && (
                  <div
                    style={{
                      fontSize: 12,
                      color: FOG,
                      background: INK_2,
                      borderRadius: 8,
                      padding: '8px 10px',
                      border: `1px solid ${LINE}`,
                      lineHeight: 1.5,
                    }}
                  >
                    {mainSession.lastMessage.content.slice(0, 150)}
                    {mainSession.lastMessage.content.length > 150 && '…'}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* SUB-AGENTS */}
          <div>
            <div style={{ ...eyebrow(MIST, 10), marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Activity style={{ width: 11, height: 11 }} />
              Sub-agents · {subAgents.length}
            </div>

            {subAgents.length === 0 ? (
              <div
                style={{
                  textAlign: 'center',
                  padding: '24px 12px',
                  fontSize: 12,
                  fontStyle: 'italic',
                  color: MIST,
                  background: INK_2,
                  borderRadius: 8,
                  border: `1px solid ${LINE}`,
                }}
              >
                No sub-agents active
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {subAgents.map(session => {
                  const status = getSessionStatus(session);
                  const statusTok = STATUS_TOKEN[status];
                  const isExpanded = expandedSession === session.sessionKey;
                  const messages = sessionMessages[session.sessionKey] || [];

                  return (
                    <div
                      key={session.sessionKey}
                      style={{
                        border: `1px solid ${tint(statusTok.hex, 0.35)}`,
                        background: tint(statusTok.hex, 0.04),
                        borderRadius: 8,
                        transition: 'background 120ms ease-out',
                      }}
                    >
                      {/* Row head */}
                      <div
                        onClick={() => toggleSession(session.sessionKey)}
                        style={{
                          padding: '10px 12px',
                          cursor: 'pointer',
                          display: 'flex', alignItems: 'flex-start', gap: 8,
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = tint(statusTok.hex, 0.06); }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                      >
                        <div style={{ marginTop: 2 }}>
                          {isExpanded
                            ? <ChevronDown style={{ width: 14, height: 14, color: CYAN }} />
                            : <ChevronRight style={{ width: 14, height: 14, color: MIST }} />}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                            <span
                              style={{
                                fontFamily: FONT_MONO,
                                fontSize: 12,
                                color: statusTok.color,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                maxWidth: 320,
                              }}
                              title={formatSessionKey(session.sessionKey)}
                            >
                              {formatSessionKey(session.sessionKey)}
                            </span>
                            <StatusBadge status={status} />
                          </div>

                          <div style={{ ...eyebrow(MIST, 9.5), display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <MessageSquare style={{ width: 10, height: 10 }} />
                              {session.messageCount}
                            </span>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <Clock style={{ width: 10, height: 10 }} />
                              {getRuntime(session)}
                            </span>
                            {session.gatewayData?.model && (
                              <span style={{ color: CYAN }}>{session.gatewayData.model}</span>
                            )}
                          </div>

                          {session.lastMessage && (
                            <div
                              style={{
                                fontSize: 12,
                                color: FOG,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {getTaskDescription(session)}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Expanded message log */}
                      {isExpanded && (
                        <div
                          style={{
                            borderTop: `1px solid ${LINE}`,
                            padding: 12,
                            background: VOID,
                          }}
                        >
                          <div style={{ ...eyebrow(MIST, 9.5), marginBottom: 8 }}>Recent messages</div>
                          {messages.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '16px 0', fontSize: 11, fontStyle: 'italic', color: MIST }}>
                              Loading messages…
                            </div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 384, overflowY: 'auto' }}>
                              {messages.slice(-10).map((msg, idx) => {
                                const isUser = msg.role === 'user';
                                return (
                                  <div key={idx} style={{ fontSize: 11.5 }}>
                                    <div
                                      style={{
                                        ...eyebrow(isUser ? CYAN : AMBER, 9.5),
                                        marginBottom: 4,
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 6,
                                      }}
                                    >
                                      <span>{isUser ? '→ User' : '← Assistant'}</span>
                                      {msg.timestamp && (
                                        <span style={{ ...eyebrow(DIM, 9), letterSpacing: '0.08em' }}>
                                          {new Date(msg.timestamp).toLocaleTimeString()}
                                        </span>
                                      )}
                                    </div>
                                    <div
                                      style={{
                                        color: WHITE,
                                        background: INK_2,
                                        borderRadius: 8,
                                        padding: '8px 10px',
                                        border: `1px solid ${LINE}`,
                                        whiteSpace: 'pre-wrap',
                                        wordBreak: 'break-word',
                                        fontFamily: FONT_SANS,
                                        lineHeight: 1.5,
                                      }}
                                    >
                                      {msg.content.slice(0, 500)}
                                      {msg.content.length > 500 && (
                                        <span style={{ color: DIM }}> [truncated]</span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
