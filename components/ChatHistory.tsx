/**
 * ChatHistory — compact recent-chat strip for the Dashboard. Re-skinned
 * for the AI Fusio design.
 */
'use client';

import { useState, useEffect } from 'react';
import { MessageSquare, RefreshCw, User, Bot } from 'lucide-react';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

const FONT_MONO    = 'var(--font-mono, ui-monospace, monospace)';
const FONT_SANS    = 'var(--font-sans, system-ui)';
const FONT_DISPLAY = 'var(--font-display, "Space Grotesk")';

const eyebrow = (color = 'var(--mist, rgba(255,255,255,0.5))', size = 10): React.CSSProperties => ({
  fontFamily: FONT_MONO,
  fontSize: size,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color,
});

export default function ChatHistory() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const mockMessages: ChatMessage[] = [
      { id: '1', role: 'user',      content: 'Build the Mission Control dashboard', timestamp: new Date(Date.now() - 3600000) },
      { id: '2', role: 'assistant', content: "I'll create a Next.js app with dark terminal vibes…", timestamp: new Date(Date.now() - 3500000) },
      { id: '3', role: 'user',      content: 'Add all the features from ClawDeck', timestamp: new Date(Date.now() - 1800000) },
      { id: '4', role: 'assistant', content: 'Adding 5-column kanban, multiple boards, priorities…', timestamp: new Date(Date.now() - 1700000) },
      { id: '5', role: 'user',      content: 'Test all the features', timestamp: new Date(Date.now() - 900000) },
      { id: '6', role: 'assistant', content: 'Testing Dashboard, Workshop, Activity, Agents, Digest…', timestamp: new Date(Date.now() - 800000) },
    ];
    setMessages(mockMessages);
  }, []);

  const refresh = () => {
    setLoading(true);
    setTimeout(() => setLoading(false), 1000);
  };

  const formatTime = (date: Date) => {
    const mins = Math.floor((Date.now() - date.getTime()) / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  return (
    <div
      style={{
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 12,
        padding: 14,
        fontFamily: FONT_SANS,
        color: 'var(--white, #fff)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 22, borderRadius: 5,
              background: 'rgba(204, 12, 32, 0.12)',
              border: '1px solid rgba(204, 12, 32, 0.35)',
            }}
          >
            <MessageSquare style={{ width: 11, height: 11, color: 'var(--red, #CC0C20)' }} />
          </span>
          <div>
            <div style={eyebrow()}>Monitor · Chat</div>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 1 }}>
              Recent
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={refresh}
          data-fusio
          style={{
            padding: 4, borderRadius: 4, background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--mist, rgba(255,255,255,0.5))',
            transition: 'all 120ms ease-out',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
        >
          <RefreshCw style={{ width: 11, height: 11, animation: loading ? 'spin 1s linear infinite' : undefined }} />
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 264, overflowY: 'auto' }}>
        {messages.map(msg => (
          <div
            key={msg.id}
            style={{
              background: 'var(--ink-2, #131319)',
              border: '1px solid var(--line, rgba(255,255,255,0.08))',
              borderRadius: 8,
              padding: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              {msg.role === 'user' ? (
                <User style={{ width: 11, height: 11, color: 'var(--cyan, #5EC4D9)', flexShrink: 0, marginTop: 2 }} />
              ) : (
                <Bot style={{ width: 11, height: 11, color: 'var(--red, #CC0C20)', flexShrink: 0, marginTop: 2 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={eyebrow(msg.role === 'user' ? 'var(--cyan, #5EC4D9)' : 'var(--red, #CC0C20)', 9.5)}>
                    {msg.role === 'user' ? 'You' : 'Agent'}
                  </span>
                  <span style={eyebrow('var(--dim, rgba(255,255,255,0.32))', 9)}>{formatTime(msg.timestamp)}</span>
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'var(--white, #fff)',
                    marginTop: 2,
                    lineHeight: 1.45,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {msg.content}
                </div>
              </div>
            </div>
          </div>
        ))}

        {messages.length === 0 && (
          <div style={{ ...eyebrow('var(--dim, rgba(255,255,255,0.32))', 10), textAlign: 'center', padding: '16px 0', fontStyle: 'italic', textTransform: 'none', letterSpacing: '0.04em' }}>
            No recent messages
          </div>
        )}
      </div>
    </div>
  );
}
