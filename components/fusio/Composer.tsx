/**
 * Fusio composer — pixel-faithful rounded composer matching the design's
 * `.composer-wrap` / `.composer` / `.composer-bar` styles. Renders below
 * ChatPanel (which has its internal composer hidden via `hideComposer`).
 *
 * Drives ChatPanel via the `mc-chat-send` window event. ChatPanel's bridge
 * useEffect picks it up, sets inputMap, and calls sendMessage().
 *
 * The wand button hits /api/chat/enhance-prompt directly. Model selector
 * dropdown writes to `${ns}-modelMap` localStorage which ChatPanel reads
 * on every send, plus dispatches `mc-set-session-model` for live UI.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { I } from './Icons';

interface ComposerProps {
  namespace?: 'mc' | 'seo' | 'missions';
}

/**
 * Quick-action shown in the .strip above the composer. The design has 3
 * built-in (Active agent / Undo / Diagnose); we surface them via state +
 * custom events ChatPanel can hook into for richer behavior later.
 */
type StripAction = 'undo' | 'diagnose';

interface ModelOption {
  id: string;
  label: string;
  hint: string;
  /** Accent for the active state. */
  tone: 'red' | 'cyan' | 'green' | 'amber' | 'violet';
}

const MODEL_OPTIONS: ModelOption[] = [
  { id: 'default',              label: 'Auto',           hint: 'Use workspace default',     tone: 'cyan' },
  { id: 'claude-opus-4-7',      label: 'Opus 4.7',       hint: 'Most capable · 200K ctx',   tone: 'violet' },
  { id: 'claude-opus-4-7[1m]',  label: 'Opus 4.7 · 1M',  hint: 'Most capable · 1M ctx',     tone: 'violet' },
  { id: 'claude-sonnet-4-6',    label: 'Sonnet 4.6',     hint: 'Balanced default',          tone: 'cyan' },
  { id: 'claude-haiku-4-5',     label: 'Haiku 4.5',      hint: 'Fastest · cheap',           tone: 'green' },
  // OpenAI Codex (CLI) — routes through the Codex auth mode
  { id: 'codex-default',        label: 'Codex',          hint: 'OpenAI Codex · account default', tone: 'green' },
  { id: 'codex-gpt-5-codex',    label: 'Codex · gpt-5',  hint: 'OpenAI Codex · gpt-5-codex',     tone: 'green' },
];

const lsKey = (ns: 'mc' | 'seo' | 'missions') => `${ns}-activeSessionId`;
const modelMapKey = (ns: 'mc' | 'seo' | 'missions') => `${ns}-modelMap`;

function readSessionModel(ns: 'mc' | 'seo' | 'missions', sessionId: string | null): string {
  if (!sessionId) return 'default';
  try {
    const raw = localStorage.getItem(modelMapKey(ns));
    if (!raw) return 'default';
    const m = JSON.parse(raw);
    return m[sessionId] || 'default';
  } catch { return 'default'; }
}

function writeSessionModel(ns: 'mc' | 'seo' | 'missions', sessionId: string, modelId: string) {
  try {
    const raw = localStorage.getItem(modelMapKey(ns));
    const m = raw ? JSON.parse(raw) : {};
    if (modelId === 'default') {
      delete m[sessionId];
    } else {
      m[sessionId] = modelId;
    }
    localStorage.setItem(modelMapKey(ns), JSON.stringify(m));
  } catch { /* ignore */ }
}

export function FusioComposer({ namespace = 'mc' }: ComposerProps) {
  const [text, setText] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [currentModel, setCurrentModel] = useState<string>('default');
  const [modelOpen, setModelOpen] = useState(false);
  /** Streaming flag — driven by `mc-chat-streaming` events ChatPanel
   *  dispatches when a turn starts/ends. Drives the Stop button below. */
  const [streaming, setStreaming] = useState(false);
  /** Live "active agent" label shown in the .strip pulse pill. ChatPanel
   *  dispatches `mc-chat-active-agent` with a freeform label when a tool
   *  call is mid-flight. Empty string hides the pill. */
  const [activeAgent, setActiveAgent] = useState<string>('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);

  // Track active session id from localStorage + custom select events.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const key = lsKey(namespace);
    setSessionId(localStorage.getItem(key));
    const onStorage = (e: StorageEvent) => { if (e.key === key) setSessionId(e.newValue); };
    const onSelect = (e: Event) => {
      const id = (e as CustomEvent).detail?.id;
      if (typeof id === 'string') setSessionId(id);
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('mc-chat-select', onSelect);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('mc-chat-select', onSelect);
    };
  }, [namespace]);

  // When session changes, refresh the model display from the modelMap.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setCurrentModel(readSessionModel(namespace, sessionId));
  }, [namespace, sessionId]);

  // Listen for model changes from other components (e.g. /opus slash command
  // in ChatPanel) so the dropdown label stays in sync.
  useEffect(() => {
    const onModelChange = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (detail.namespace !== namespace) return;
      if (detail.sessionId && detail.sessionId !== sessionId) return;
      if (typeof detail.modelId === 'string') setCurrentModel(detail.modelId);
    };
    window.addEventListener('mc-set-session-model', onModelChange);
    return () => window.removeEventListener('mc-set-session-model', onModelChange);
  }, [namespace, sessionId]);

  // Streaming state — ChatPanel dispatches `mc-chat-streaming` with
  // { namespace, sessionId, streaming: bool } at turn boundaries.
  useEffect(() => {
    const onStream = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (detail.namespace && detail.namespace !== namespace) return;
      if (detail.sessionId && detail.sessionId !== sessionId) return;
      if (typeof detail.streaming === 'boolean') setStreaming(detail.streaming);
    };
    window.addEventListener('mc-chat-streaming', onStream);
    return () => window.removeEventListener('mc-chat-streaming', onStream);
  }, [namespace, sessionId]);

  // Active agent label — ChatPanel dispatches `mc-chat-active-agent` with
  // { namespace, sessionId, label } when a tool call kicks off; empty
  // label hides the strip's pulse pill.
  useEffect(() => {
    const onAgent = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (detail.namespace && detail.namespace !== namespace) return;
      if (detail.sessionId && detail.sessionId !== sessionId) return;
      if (typeof detail.label === 'string') setActiveAgent(detail.label);
    };
    window.addEventListener('mc-chat-active-agent', onAgent);
    return () => window.removeEventListener('mc-chat-active-agent', onAgent);
  }, [namespace, sessionId]);

  // Click-outside / Escape closes the model dropdown
  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setModelOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [modelOpen]);

  const selectModel = (modelId: string) => {
    setCurrentModel(modelId);
    setModelOpen(false);
    if (sessionId) writeSessionModel(namespace, sessionId, modelId);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('mc-set-session-model', {
        detail: { namespace, sessionId, modelId },
      }));
    }
  };

  const currentModelOption = MODEL_OPTIONS.find(m => m.id === currentModel) || MODEL_OPTIONS[0];

  // Spawn a sub-agent task with the current composer text. ChatPanel's
  // `mc-chat-spawn-task` listener picks it up and routes through its
  // normal spawn-task UI; the composer just packages the input.
  const spawnTask = () => {
    if (!text.trim()) return;
    window.dispatchEvent(new CustomEvent('mc-chat-spawn-task', {
      detail: { namespace, sessionId, text: text.trim() },
    }));
    // Don't clear — user may want to also send normally.
  };

  // Stop the in-flight stream. ChatPanel listens for `mc-chat-stop`.
  const stop = () => {
    if (!streaming) return;
    window.dispatchEvent(new CustomEvent('mc-chat-stop', {
      detail: { namespace, sessionId },
    }));
  };

  // Strip quick-actions
  const undoLastTurn = () => {
    window.dispatchEvent(new CustomEvent('mc-chat-undo', {
      detail: { namespace, sessionId },
    }));
  };

  const diagnoseLoop = () => {
    window.dispatchEvent(new CustomEvent('mc-chat-diagnose', {
      detail: { namespace, sessionId },
    }));
  };

  const autosize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
  };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    window.dispatchEvent(new CustomEvent('mc-chat-send', {
      detail: { sessionId, text: t, namespace },
    }));
    setText('');
    setTimeout(autosize, 0);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const enhance = async () => {
    if (!text.trim() || enhancing) return;
    setEnhancing(true);
    try {
      const r = await fetch('/api/chat/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, chatId: sessionId || undefined }),
      });
      if (r.ok) {
        const j = await r.json();
        if (typeof j?.enhanced === 'string' && j.enhanced.trim()) {
          setText(j.enhanced);
          setTimeout(autosize, 0);
        }
      }
    } catch (e) {
      console.warn('[fusio composer] enhance failed', e);
    } finally {
      setEnhancing(false);
    }
  };

  return (
    <>
      {/* Quick-action strip ABOVE the composer — matches design's chat.jsx
          .strip with 3 items: Active agent (green pulse, only when streaming
          or an agent label is set), Undo last turn (cyan), Diagnose this
          loop (amber). */}
      <div className="strip">
        {(streaming || activeAgent) && (
          <button
            type="button"
            className="item activity"
            title="An agent is currently working in this chat"
          >
            Active agent · {activeAgent || (streaming ? 'streaming' : 'idle')}
          </button>
        )}
        <button
          type="button"
          className="item undo"
          onClick={undoLastTurn}
          title="Roll back the last user/assistant turn"
        >
          Undo last turn
        </button>
        <button
          type="button"
          className="item diagnose"
          onClick={diagnoseLoop}
          title="Ask the agent to summarize what it's doing and unblock itself"
        >
          Diagnose this loop
        </button>
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => { setText(e.target.value); autosize(); }}
            onKeyDown={onKey}
            placeholder="Message Fusio… ⌘K for commands · @ to mention"
            rows={1}
          />
          <div className="composer-bar">
            <div className="left">
              <button className="ico" title="Attach file" type="button">
                {I.paperclip}
              </button>
              <button className="ico" title="Project assets" type="button">
                {I.image}
              </button>

            {/* Model selector — dropdown pill */}
            <div ref={modelRef} style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setModelOpen(o => !o)}
                title={`Model · ${currentModelOption.label}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '4px 10px',
                  height: 30,
                  fontFamily: 'var(--font-mono, ui-monospace)',
                  fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
                  borderRadius: 6,
                  background: 'var(--ink-3, #1B1B23)',
                  border: '1px solid var(--line, rgba(255,255,255,0.08))',
                  color: 'var(--fog, rgba(255,255,255,0.78))',
                  cursor: 'pointer',
                  transition: 'all 120ms ease-out',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--line-3, rgba(255,255,255,0.16))'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--line, rgba(255,255,255,0.08))'; }}
              >
                <span>{currentModelOption.label}</span>
                <span style={{ fontSize: 8, opacity: 0.6 }}>▾</span>
              </button>
              {modelOpen && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 'calc(100% + 8px)',
                    left: 0,
                    zIndex: 100,
                    minWidth: 240,
                    background: 'var(--ink, #0A0A0E)',
                    border: '1px solid var(--line, rgba(255,255,255,0.08))',
                    borderRadius: 10,
                    boxShadow: '0 12px 32px rgba(0,0,0,0.6)',
                    padding: 6,
                    fontFamily: 'var(--font-sans, system-ui)',
                  }}
                >
                  <div
                    style={{
                      fontFamily: 'var(--font-mono, ui-monospace)',
                      fontSize: 9.5, letterSpacing: '0.16em', textTransform: 'uppercase',
                      color: 'var(--dim, rgba(255,255,255,0.32))',
                      padding: '6px 10px 4px',
                    }}
                  >
                    Model · this chat
                  </div>
                  {MODEL_OPTIONS.map(m => {
                    const isActive = m.id === currentModel;
                    const accent = `var(--${m.tone}, #5EC4D9)`;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => selectModel(m.id)}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 10px',
                          borderRadius: 6,
                          background: isActive ? `color-mix(in srgb, ${accent} 14%, transparent)` : 'transparent',
                          border: `1px solid ${isActive ? `color-mix(in srgb, ${accent} 35%, transparent)` : 'transparent'}`,
                          color: 'var(--white, #fff)',
                          cursor: 'pointer',
                          transition: 'background 120ms ease-out',
                          display: 'flex', flexDirection: 'column', gap: 2,
                        }}
                        onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; }}
                        onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 600, color: isActive ? accent : 'var(--white, #fff)' }}>
                          {m.label}{isActive && ' ✓'}
                        </span>
                        <span style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, color: 'var(--mist, rgba(255,255,255,0.5))', letterSpacing: '0.04em' }}>
                          {m.hint}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Spawn task — violet zap matching design */}
            <button
              className="ico violet"
              title="Spawn this prompt as a parallel sub-agent task"
              onClick={spawnTask}
              disabled={!text.trim()}
              type="button"
            >
              {I.zap}
            </button>

            {/* Wand — amber, on the LEFT cluster per design (was on right) */}
            <button
              className="ico amber"
              title={enhancing ? 'Sonnet is rewriting your draft…' : 'Wand · Sonnet rewrites your draft with the right skills'}
              onClick={enhance}
              disabled={!text.trim() || enhancing}
              type="button"
            >
              {enhancing
                ? <svg width="14" height="14" viewBox="0 0 24 24" style={{ animation: 'spin 1s linear infinite' }}><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="40 60"/></svg>
                : I.wand}
            </button>
          </div>
          <div className="right">
            {streaming ? (
              <button
                className="stop"
                title="Stop the in-flight stream"
                onClick={stop}
                type="button"
              >
                {I.stop || I.send /* fallback if Icons.tsx lacks stop */}
              </button>
            ) : (
              <button
                className="send"
                title="Send"
                onClick={send}
                disabled={!text.trim()}
                type="button"
              >
                {I.send}
              </button>
            )}
          </div>
        </div>
      </div>
      {/* Composer meta hints — design spec */}
      <div className="composer-meta">
        <span><span className="kbd">⌘ Enter</span> Send</span>
        <span><span className="kbd">⌘ K</span> Commands · <span className="kbd">⌘ /</span> Notepad</span>
      </div>
      </div>
    </>
  );
}
