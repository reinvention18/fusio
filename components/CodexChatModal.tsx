/**
 * CodexChatModal — chat-side affordance for asking OpenAI Codex a question
 * with an optional persistent goal.
 *
 * Why this exists:
 *   • The chat panel is wired to Anthropic via the agent-SDK. Codex is a
 *     separate CLI tool with its own provider, sandbox, and goals feature.
 *     A modal keeps the integration contained and parallel to existing
 *     Tools-menu utilities (cross-chat puller, etc.).
 *   • Codex's `goals` feature (currently 'under development' in the CLI)
 *     wants a persistent goal that spans turns. The modal stores per-chat
 *     goals in localStorage so the next time the user opens it for the
 *     same chat, the goal is pre-populated.
 *
 * UX:
 *   1. User opens via Tools → "🤖 Ask Codex"
 *   2. Goal textarea (top) — optional, persisted per chat
 *   3. Prompt textarea (middle) — pre-filled with current composer text
 *   4. "Send to Codex" button → streams response inline
 *   5. After response: "Insert into chat" drops it as a markdown block in
 *      the composer (same UX as the cross-chat puller)
 */

'use client';

import { useEffect, useRef, useState } from 'react';

interface CodexChatModalProps {
  open: boolean;
  onClose: () => void;
  /** Chat id — used as the localStorage scope for the persistent goal. */
  chatId: string;
  /** Working directory codex should run in. */
  cwd: string;
  /** Initial prompt to seed the prompt textarea — typically the composer's
   *  current text so the user can route their in-progress question through
   *  Codex without retyping. */
  initialPrompt?: string;
  /** Called with the formatted markdown block when the user clicks Insert. */
  onInsert: (block: string) => void;
}

const STORAGE_KEY = (chatId: string) => `mc-codex-goal:${chatId}`;

export default function CodexChatModal({ open, onClose, chatId, cwd, initialPrompt = '', onInsert }: CodexChatModalProps) {
  const [goal, setGoal] = useState('');
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sandbox, setSandbox] = useState<'read-only' | 'workspace-write'>('read-only');
  const [duration, setDuration] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Hydrate goal from localStorage when the modal opens for this chat.
  // Refresh the prompt with the latest composer text only when opening.
  useEffect(() => {
    if (!open) return;
    try {
      const stored = localStorage.getItem(STORAGE_KEY(chatId));
      setGoal(stored || '');
    } catch { /* localStorage may be blocked */ }
    setPrompt(initialPrompt);
    setResponse('');
    setError(null);
    setDuration(null);
  }, [open, chatId, initialPrompt]);

  const persistGoal = (next: string) => {
    setGoal(next);
    try {
      if (next.trim()) localStorage.setItem(STORAGE_KEY(chatId), next);
      else localStorage.removeItem(STORAGE_KEY(chatId));
    } catch { /* private mode */ }
  };

  const send = async () => {
    if (!prompt.trim() || running) return;
    setRunning(true);
    setError(null);
    setResponse('');
    setDuration(null);
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const resp = await fetch('/api/chat/codex', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), goal: goal.trim() || undefined, cwd, sandbox }),
        signal: ctl.signal,
      });
      if (!resp.body) throw new Error('no response body');
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let carry = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        carry += dec.decode(value, { stream: true });
        let idx;
        while ((idx = carry.indexOf('\n\n')) >= 0) {
          const frame = carry.slice(0, idx);
          carry = carry.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const ev = JSON.parse(payload);
              if (ev.type === 'codex-chunk' && typeof ev.text === 'string') {
                setResponse(prev => prev + (prev && !prev.endsWith('\n') ? '\n' : '') + ev.text);
              } else if (ev.type === 'codex-end') {
                setDuration(typeof ev.duration_ms === 'number' ? ev.duration_ms : null);
                if (ev.exit_code !== 0) {
                  setError(`Codex exited ${ev.exit_code}${ev.stderr_tail ? ` — ${ev.stderr_tail.slice(0, 300)}` : ''}`);
                }
              } else if (ev.type === 'codex-error') {
                setError(`Codex error: ${ev.message}`);
              }
              // codex-event frames (turn.started, etc.) are intentionally
              // ignored in the UI — they're useful for debugging but noise
              // for the user. The full stream is in the network panel.
            } catch { /* skip non-JSON heartbeats */ }
          }
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setError('Cancelled.');
      } else {
        setError(String(err?.message || err));
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  const formatBlock = () => {
    const lines: string[] = [];
    lines.push(`🤖 **Codex says** (${cwd})`);
    if (goal.trim()) lines.push(`_Goal: ${goal.trim()}_`);
    lines.push('');
    lines.push(response.trim());
    if (duration) lines.push(`\n_(${(duration / 1000).toFixed(1)}s)_`);
    return lines.join('\n');
  };

  if (!open) return null;
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.72)',
        backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !running) onClose(); }}
    >
      <div
        className="card"
        style={{
          margin: 0,
          width: '100%',
          maxWidth: 768,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          overflow: 'hidden',
          fontFamily: 'var(--font-sans, system-ui)',
        }}
      >
        {/* Modal head */}
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Tools · External · OpenAI
            </div>
            <h2 style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--white, #fff)', marginTop: 2 }}>
              🤖 Ask Codex
            </h2>
            <p style={{ fontSize: 11, color: 'var(--mist, rgba(255,255,255,0.5))', marginTop: 4 }}>
              OpenAI Codex turn with a persistent goal. Goal stays attached to this chat across turns.
              {goal.trim() && <span style={{ marginLeft: 8, color: 'var(--amber, #E8A23B)' }}>🎯 goal active</span>}
            </p>
          </div>
          <button
            onClick={() => { if (!running) onClose(); }}
            disabled={running}
            data-fusio
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--mist, rgba(255,255,255,0.5))',
              fontFamily: 'var(--font-mono, ui-monospace)',
              fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
              opacity: running ? 0.5 : 1,
              transition: 'color 120ms ease-out',
            }}
            onMouseEnter={e => { if (!running) (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
          >
            Close
          </button>
        </div>

        {/* Inputs */}
        <div
          style={{
            padding: 18,
            borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
            display: 'flex', flexDirection: 'column', gap: 14,
          }}
        >
          <div>
            <div
              style={{
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
                color: 'var(--mist, rgba(255,255,255,0.5))',
                marginBottom: 6,
                display: 'flex', alignItems: 'center', gap: 8,
              }}
            >
              <span>🎯 Goal · persistent · auto-saved per chat</span>
              {goal.trim() && (
                <button
                  onClick={() => persistGoal('')}
                  disabled={running}
                  data-fusio
                  style={{
                    color: 'var(--red, #CC0C20)',
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    fontFamily: 'var(--font-mono, ui-monospace)',
                    fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            <textarea
              value={goal}
              onChange={(e) => persistGoal(e.target.value)}
              rows={2}
              placeholder="e.g. We're refactoring lib/missions/runner.ts to remove the verdict state machine. Focus on minimal-surface changes that preserve the test harness."
              disabled={running}
              data-fusio
              style={{
                width: '100%',
                background: 'var(--ink-3, #1B1B23)',
                border: '1px solid var(--line, rgba(255,255,255,0.08))',
                borderRadius: 8,
                padding: '10px 12px',
                color: 'var(--white, #fff)',
                fontFamily: 'var(--font-sans, system-ui)',
                fontSize: 13,
                outline: 'none',
                resize: 'vertical',
              }}
              onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(232, 162, 59, 0.5)'; }}
              onBlur={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--line, rgba(255,255,255,0.08))'; }}
            />
          </div>

          <div>
            <div
              style={{
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
                color: 'var(--mist, rgba(255,255,255,0.5))',
                marginBottom: 6,
              }}
            >
              Prompt for this turn
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              placeholder="What do you want Codex to do this turn?"
              disabled={running}
              data-fusio
              style={{
                width: '100%',
                background: 'var(--ink-3, #1B1B23)',
                border: '1px solid var(--line, rgba(255,255,255,0.08))',
                borderRadius: 8,
                padding: '10px 12px',
                color: 'var(--white, #fff)',
                fontFamily: 'var(--font-sans, system-ui)',
                fontSize: 13,
                outline: 'none',
                resize: 'vertical',
              }}
              onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(76, 195, 138, 0.5)'; }}
              onBlur={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--line, rgba(255,255,255,0.08))'; }}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 12, color: 'var(--mist, rgba(255,255,255,0.5))' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="radio"
                name="codex-sandbox"
                checked={sandbox === 'read-only'}
                onChange={() => setSandbox('read-only')}
                disabled={running}
                style={{ accentColor: 'var(--cyan, #5EC4D9)' }}
              />
              <span>Read-only</span>
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="radio"
                name="codex-sandbox"
                checked={sandbox === 'workspace-write'}
                onChange={() => setSandbox('workspace-write')}
                disabled={running}
                style={{ accentColor: 'var(--amber, #E8A23B)' }}
              />
              <span style={{ color: 'var(--amber, #E8A23B)' }}>Workspace-write</span>
              <span style={{ color: 'var(--dim, rgba(255,255,255,0.32))' }}>(can edit files in cwd)</span>
            </label>
          </div>
        </div>

        {/* Response area */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 18, minHeight: 120 }}>
          {!response && !running && !error && (
            <div style={{ fontSize: 11.5, color: 'var(--dim, rgba(255,255,255,0.32))', fontStyle: 'italic' }}>
              Codex's response will stream here.
            </div>
          )}
          {running && !response && (
            <div style={{ fontSize: 11.5, color: 'var(--amber, #E8A23B)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: 'var(--amber, #E8A23B)',
                  boxShadow: '0 0 8px rgba(232, 162, 59, 0.6)',
                  animation: 'fusio-pulse 1.6s ease-in-out infinite',
                }}
              />
              Codex thinking…
            </div>
          )}
          {response && (
            <div style={{ fontSize: 13, color: 'var(--white, #fff)', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono, ui-monospace)', wordBreak: 'break-word', lineHeight: 1.55 }}>
              {response}
              {running && (
                <span
                  style={{
                    display: 'inline-block',
                    width: 8, height: 8, borderRadius: '50%',
                    background: 'var(--green, #4CC38A)',
                    boxShadow: '0 0 8px rgba(76, 195, 138, 0.6)',
                    marginLeft: 8,
                    animation: 'fusio-pulse 1.6s ease-in-out infinite',
                  }}
                />
              )}
            </div>
          )}
          {duration !== null && !running && (
            <div style={{ marginTop: 10, fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Done in {(duration / 1000).toFixed(1)}s
            </div>
          )}
          {error && (
            <div
              style={{
                marginTop: 10,
                fontSize: 11.5,
                color: 'var(--red, #CC0C20)',
                background: 'rgba(204, 12, 32, 0.1)',
                border: '1px solid rgba(204, 12, 32, 0.35)',
                borderRadius: 8,
                padding: 10,
                whiteSpace: 'pre-wrap',
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Foot — cwd + actions */}
        <div
          style={{
            padding: '14px 18px',
            borderTop: '1px solid var(--line, rgba(255,255,255,0.08))',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 10, flexWrap: 'wrap',
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--mist, rgba(255,255,255,0.5))' }}>
            {sandbox === 'workspace-write'
              ? <span style={{ color: 'var(--amber, #E8A23B)' }}>⚠️ Codex can edit files in <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--amber, #E8A23B)' }}>{cwd}</code></span>
              : <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--mist, rgba(255,255,255,0.5))' }}>{cwd}</code>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {running ? (
              <button
                onClick={cancel}
                className="card-btn danger"
                data-fusio
                style={{ fontSize: 11.5, padding: '6px 14px' }}
              >
                Cancel
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!prompt.trim()}
                className="card-btn primary"
                data-fusio
                style={{
                  fontSize: 11.5, padding: '6px 14px',
                  background: 'var(--green, #4CC38A)', borderColor: 'var(--green, #4CC38A)',
                  color: '#0a1612',
                  opacity: !prompt.trim() ? 0.5 : 1,
                  cursor: !prompt.trim() ? 'not-allowed' : 'pointer',
                }}
              >
                {response ? '🔁 Re-run' : '🚀 Send to Codex'}
              </button>
            )}
            <button
              onClick={() => { onInsert(formatBlock()); onClose(); }}
              disabled={!response.trim() || running}
              className="card-btn"
              data-fusio
              style={{
                fontSize: 11.5, padding: '6px 14px',
                opacity: (!response.trim() || running) ? 0.5 : 1,
                cursor: (!response.trim() || running) ? 'not-allowed' : 'pointer',
              }}
            >
              📎 Insert into chat
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
