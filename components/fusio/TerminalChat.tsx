/**
 * TerminalChat — a Claude-Code-in-Termius style chat surface.
 *
 * Replaces the regular FusioChatHeader + ChatPanel + FusioComposer stack
 * when fullscreen mode is on. NOT a CSS restyle of the existing chat —
 * this is a separate component that renders its own message stream and
 * input area from scratch. That's the whole point: the existing chat has
 * bubbles, avatars, multi-button composer chrome, project pills, etc.,
 * and trying to CSS-override all that produced half-broken results.
 *
 * Data flow:
 *   - Reads the active chat id from localStorage (same keys as the regular
 *     chat surface uses, so switching modes preserves context).
 *   - Hydrates messages from /api/chats?id=<id> (or namespaced equivalent).
 *   - Subscribes to /api/chat/listen?chatId=<id> for live SSE deltas during
 *     a turn — same broadcast channel the regular chat uses, so both
 *     surfaces stay in sync if both happen to be mounted.
 *   - Dispatches the existing `mc-chat-send` window event to send messages.
 *     ChatPanel (mounted but hidden) handles the actual /api/chat POST and
 *     manages the SDK session. We just consume the resulting stream.
 *
 * Visual targets (the screenshot the user shared):
 *   - Dark, edge-to-edge, monospace everywhere
 *   - No bubbles, no avatars
 *   - User messages: muted-teal full-width highlight bar
 *   - Assistant messages: leading ● pip, then plain rendered markdown
 *   - Tables: thin ASCII box-drawn borders
 *   - Inline code: cyan-tinted pill with subtle border
 *   - Bottom: > prompt + textarea, no buttons
 *   - Below: single dim hint line
 */

'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { MessageContent } from '../chat/MessageContent';

type Namespace = 'mc' | 'seo' | 'missions';

interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
  voice?: 'claude' | 'codex' | 'orchestrator';
}

function activeIdKey(ns: Namespace): string {
  if (ns === 'mc') return 'mc-activeSessionId';
  if (ns === 'seo') return 'seo-activeSessionId';
  return 'missions-activeSessionId';
}

function chatsApi(ns: Namespace): string {
  if (ns === 'mc') return '/api/chats';
  if (ns === 'seo') return '/api/seo-chats';
  return '/api/lukes-chats';
}

function sessionKeyPrefix(ns: Namespace): string {
  if (ns === 'mc') return 'mc-';
  if (ns === 'seo') return 'seo-';
  return 'lukes-';
}

export function TerminalChat({ namespace }: { namespace: Namespace }) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState<string>('');
  const [streaming, setStreaming] = useState(false);
  const [input, setInput] = useState('');
  const streamRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const elapsedRef = useRef<{ start: number; timer: ReturnType<typeof setInterval> | null }>({ start: 0, timer: null });
  const [elapsed, setElapsed] = useState<string>('');

  /** Hydrate chatId from localStorage. Re-poll because the user might
   *  switch sessions in the regular UI before opening fullscreen. */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const refresh = () => {
      const id = localStorage.getItem(activeIdKey(namespace));
      setChatId(id);
    };
    refresh();
    const interval = setInterval(refresh, 1000); // cheap, drives session changes
    return () => clearInterval(interval);
  }, [namespace]);

  /** Fetch messages from the chat file. Triggered on chatId change and
   *  whenever a turn ends so the final committed messages replace any
   *  streaming buffer.
   *
   *  Route shape (all three namespaces match):
   *    GET /api/<ns>?sessionId=<chatId>  →  { session: { messages: [...] } }
   *  Note: it's `sessionId`, NOT `id`. First version got this wrong and the
   *  endpoint returned a list of all sessions instead, which then failed
   *  the chat-id match and rendered an empty stream. */
  const refetch = useCallback(async () => {
    if (!chatId) return;
    try {
      const url = `${chatsApi(namespace)}?sessionId=${encodeURIComponent(chatId)}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const chat = data?.session;
      if (!chat) return;
      const msgs: ChatMessage[] = (chat.messages || []).filter((m: any) =>
        typeof m?.content === 'string' && (m.role === 'user' || m.role === 'assistant' || m.role === 'system')
      );
      setMessages(msgs);
    } catch { /* ignore — next refresh will retry */ }
  }, [chatId, namespace]);

  useEffect(() => { refetch(); }, [refetch]);

  /** SSE listener — the existing chat-broadcast layer fans out the
   *  in-flight assistant reply to /api/chat/listen?chatId=X with the same
   *  shape as /api/chat. We just consume deltas and accumulate. */
  useEffect(() => {
    if (!chatId) return;
    try { streamRef.current?.close(); } catch { /* ignore */ }
    setStreamingText('');
    setStreaming(false);

    const es = new EventSource(`/api/chat/listen?chatId=${encodeURIComponent(chatId)}`);
    streamRef.current = es;

    es.onmessage = (e) => {
      if (!e.data || e.data.startsWith(':')) return;
      if (e.data === '[DONE]') return;
      try {
        const parsed = JSON.parse(e.data);
        // Text delta (OpenAI-shaped chunk)
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          setStreamingText(s => s + delta);
          if (!streaming) {
            setStreaming(true);
            elapsedRef.current.start = Date.now();
            if (elapsedRef.current.timer) clearInterval(elapsedRef.current.timer);
            elapsedRef.current.timer = setInterval(() => {
              const ms = Date.now() - elapsedRef.current.start;
              setElapsed(formatElapsed(ms));
            }, 500);
          }
        }
        // Sync-replay frame — caller reconnected; reset the buffer to
        // the authoritative content the server has so far.
        if (parsed?.type === 'sync-replay' && typeof parsed?.content === 'string') {
          setStreamingText(parsed.content);
          setStreaming(true);
        }
      } catch { /* malformed frame; skip */ }
    };

    // Server signals end-of-turn via a typed event (or stream close);
    // handle both. After end, refetch the chat file to lock in the
    // committed assistant message and clear the streaming buffer.
    const onEnd = () => {
      setStreaming(false);
      setStreamingText('');
      setElapsed('');
      if (elapsedRef.current.timer) {
        clearInterval(elapsedRef.current.timer);
        elapsedRef.current.timer = null;
      }
      // Refetch after a short delay to let the server-side commit happen.
      setTimeout(() => { refetch(); }, 400);
    };
    es.addEventListener('end', onEnd as EventListener);
    es.addEventListener('close', onEnd as EventListener);
    es.onerror = () => {
      // EventSource will auto-reconnect; we just clear streaming state if
      // we were in the middle of one so the UI doesn't show a stale spinner.
      // Don't refetch on error — too noisy. Let onmessage drive recovery.
    };

    return () => {
      try { es.close(); } catch { /* ignore */ }
      streamRef.current = null;
      if (elapsedRef.current.timer) {
        clearInterval(elapsedRef.current.timer);
        elapsedRef.current.timer = null;
      }
    };
  }, [chatId, refetch]);

  /** Auto-scroll to bottom on new content. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // requestAnimationFrame so the DOM has flushed
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [messages.length, streamingText]);

  /** Send the typed message. We dispatch `mc-chat-send` which the regular
   *  ChatPanel (kept mounted but visually hidden) handles — the SDK session
   *  state, model selection, MCP fabric, memory injection all stay in
   *  ChatPanel where they belong. We just trigger the send. */
  const send = useCallback(() => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    // Optimistic user-message render so the prompt appears immediately
    // (the SSE stream + refetch will replace it with the committed one).
    setMessages(prev => [
      ...prev,
      { role: 'user', content: text, timestamp: Date.now() } as ChatMessage,
    ]);
    try {
      window.dispatchEvent(new CustomEvent('mc-chat-send', { detail: { text } }));
    } catch { /* ignore */ }
    // Refocus the textarea
    setTimeout(() => textareaRef.current?.focus(), 10);
  }, [input, streaming]);

  /** Auto-grow textarea — terminal-style, single line by default,
   *  expands to up to ~8 lines if the user types more. */
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const max = parseInt(getComputedStyle(ta).lineHeight) * 8 || 200;
    ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
  }, [input]);

  /** Autofocus on mount — terminal-y UX, no need to click. */
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  /** Exit fullscreen mode. Same dispatch that the ⌘./Ctrl+. shortcut and
   *  ESC keypress use, but as a tappable affordance for mobile (where
   *  there's no keyboard). */
  const exitFullscreen = useCallback(() => {
    window.dispatchEvent(new CustomEvent('mc-toggle-fullscreen-chat'));
  }, []);

  return (
    <div className="terminal-chat">
      {/* Top-right exit pin — visible tap target on mobile since there's
          no ESC key. Stays subtle so it doesn't break the terminal vibe. */}
      <button
        type="button"
        className="terminal-exit-btn"
        onClick={exitFullscreen}
        title="Exit fullscreen (ESC or ⌘.)"
        aria-label="Exit fullscreen chat"
      >
        × exit
      </button>

      <div className="terminal-stream" ref={scrollRef}>
        {messages.map((m, i) => (
          <TerminalMessage key={i} message={m} />
        ))}
        {streaming && streamingText && (
          <TerminalMessage
            message={{ role: 'assistant', content: streamingText }}
            streaming
          />
        )}
        {streaming && (
          <div className="terminal-elapsed">⊰ Baked for {elapsed || '0s'}</div>
        )}
      </div>

      <div className="terminal-input-wrap">
        <span className="terminal-prompt">{'>'}</span>
        <textarea
          ref={textareaRef}
          className="terminal-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              window.dispatchEvent(new CustomEvent('mc-toggle-fullscreen-chat'));
            }
          }}
          rows={1}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder=""
        />
      </div>
      <div className="terminal-hint">
        ▒▒▒ press ESC or ⌘. to exit fullscreen · shift+enter for newline
      </div>
    </div>
  );
}

function TerminalMessage({ message, streaming }: { message: ChatMessage; streaming?: boolean }) {
  if (message.role === 'user') {
    return (
      <div className="terminal-msg-user">
        <div className="text">{message.content}</div>
      </div>
    );
  }
  if (message.role === 'system') {
    return (
      <div className="terminal-msg-system">
        <span className="pip">▢</span>
        <div className="text">{message.content}</div>
      </div>
    );
  }
  return (
    <div className={`terminal-msg-assistant ${streaming ? 'streaming' : ''}`}>
      <span className="pip">●</span>
      <div className="text">
        <MessageContent content={message.content} />
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}
