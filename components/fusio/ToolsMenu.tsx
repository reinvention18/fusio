/**
 * FusioToolsMenu — popover that opens from the Tools pill in the chat
 * header. Uses the design's `.tools-panel` / `.tp-section` / `.tp-item`
 * classes from /fusio/mc.css.
 *
 * Houses everything that doesn't fit on the compact header bar: model
 * selector, permission mode, new chat, notepad, settings, skills, pull
 * latest, and add-project shortcut.
 *
 * Most actions dispatch existing window events that ChatPanel /
 * page.tsx already listen for — no prop-drilling needed.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import {
  X, Plus, FolderPlus, Sparkles, Settings, FileText, RefreshCw, Check,
  MessageSquarePlus, Brain, Shield, Zap, Wand2,
  Archive, Database, KeyRound, Link2, Users, Code2, Github,
  Bell, RotateCcw, Trash2, Paperclip, Image as ImageIcon, FileSearch,
  Bot, Workflow, MessageSquare, Server,
  ZoomIn, ZoomOut, Maximize2,
} from 'lucide-react';

interface ToolsMenuProps {
  open: boolean;
  onClose: () => void;
  /** Anchor rect for positioning (the Tools button itself). */
  anchorRect?: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  namespace?: 'mc' | 'seo' | 'missions';
}

interface ModelOption { id: string; label: string; hint: string; group: 'claude' | 'codex'; }
const MODELS: ModelOption[] = [
  // Anthropic — Claude Code CLI
  { id: 'default',              label: 'Auto',          hint: 'Workspace default (Sonnet 4.6)', group: 'claude' },
  { id: 'claude-opus-4-7',      label: 'Opus 4.7',      hint: 'Most capable · 200K ctx',       group: 'claude' },
  { id: 'claude-opus-4-7[1m]',  label: 'Opus 4.7 · 1M', hint: 'Most capable · 1M ctx',         group: 'claude' },
  { id: 'claude-sonnet-4-6',    label: 'Sonnet 4.6',    hint: 'Balanced default',              group: 'claude' },
  { id: 'claude-haiku-4-5',     label: 'Haiku 4.5',     hint: 'Fastest · cheap',               group: 'claude' },
  // OpenAI — Codex CLI
  { id: 'codex-default',        label: 'Codex · account default', hint: 'Whatever ChatGPT picks',     group: 'codex' },
  { id: 'codex-gpt-5-codex',    label: 'Codex · gpt-5-codex',     hint: 'Latest OpenAI Codex model',  group: 'codex' },
];

interface ModeOption { id: string; label: string; hint: string; }
const MODES: ModeOption[] = [
  { id: 'default',           label: 'Default',     hint: 'Ask before destructive edits' },
  { id: 'plan',              label: 'Plan',        hint: 'Read-only — no writes' },
  { id: 'acceptEdits',       label: 'Accept edits', hint: 'Auto-accept code edits' },
  { id: 'bypassPermissions', label: 'Bypass',      hint: 'No prompts (dangerous)' },
];

const modelMapKey = (ns: string) => `${ns}-modelMap`;
const modeMapKey  = (ns: string) => `${ns}-permissionModeMap`;

function readActive(key: string, sessionId: string | null): string {
  if (!sessionId) return 'default';
  try {
    const m = JSON.parse(localStorage.getItem(key) || '{}');
    return m[sessionId] || 'default';
  } catch { return 'default'; }
}

function writeActive(key: string, sessionId: string, value: string): void {
  try {
    const m = JSON.parse(localStorage.getItem(key) || '{}');
    m[sessionId] = value;
    localStorage.setItem(key, JSON.stringify(m));
  } catch { /* ignore */ }
}

export function FusioToolsMenu({ open, onClose, anchorRect, namespace = 'mc' }: ToolsMenuProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<string>('default');
  const [activeMode, setActiveMode] = useState<string>('default');

  // Track active session id + its current model/mode.
  // NOTE: ChatPanel writes activeSessionId to `${ns}-activeSessionId` (hyphen).
  // FusioSessions historically used `${ns}.activeSessionId` (dot) which created
  // a key mismatch — both are checked so we don't depend on either side.
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const lsKeys = [
      `${namespace}-activeSessionId`,
      `${namespace}.activeSessionId`,
    ];
    const refresh = () => {
      let id: string | null = null;
      for (const k of lsKeys) { id = id || localStorage.getItem(k); }
      setActiveSessionId(id);
      setActiveModel(readActive(modelMapKey(namespace), id));
      setActiveMode(readActive(modeMapKey(namespace), id));
    };
    refresh();
    const onSelect = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (detail?.id) {
        setActiveSessionId(detail.id);
        setActiveModel(readActive(modelMapKey(namespace), detail.id));
        setActiveMode(readActive(modeMapKey(namespace), detail.id));
        return;
      }
      refresh();
    };
    window.addEventListener('mc-chat-select', onSelect);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('mc-chat-select', onSelect);
      window.removeEventListener('storage', refresh);
    };
  }, [open, namespace]);

  // Close on click outside + Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current) return;
      if (!panelRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const pickModel = (id: string) => {
    setActiveModel(id);
    // Persist to the per-session map if we have one; otherwise store as
    // the namespace default so the next session inherits it.
    if (activeSessionId) {
      writeActive(modelMapKey(namespace), activeSessionId, id);
    } else {
      try { localStorage.setItem(`${namespace}-defaultModel`, id); } catch { /* ignore */ }
    }
    window.dispatchEvent(new CustomEvent('mc-set-session-model', {
      detail: { namespace, modelId: id, sessionId: activeSessionId },
    }));
    onClose();
  };

  const pickMode = (id: string) => {
    setActiveMode(id);
    if (activeSessionId) {
      writeActive(modeMapKey(namespace), activeSessionId, id);
    } else {
      try { localStorage.setItem(`${namespace}-defaultMode`, id); } catch { /* ignore */ }
    }
    window.dispatchEvent(new CustomEvent('mc-set-session-mode', {
      detail: { namespace, mode: id, sessionId: activeSessionId },
    }));
    onClose();
  };

  const dispatch = (type: string, detail?: any) => {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  };

  // Anchor positioning: below the Tools button if we have a rect,
  // else fall back to top-right of viewport.
  const pos = anchorRect
    ? {
        top: Math.round(anchorRect.bottom + 8),
        right: Math.max(12, window.innerWidth - anchorRect.right),
      }
    : { top: 60, right: 16 };

  return (
    <div
      ref={panelRef}
      className="tools-panel"
      style={{
        position: 'fixed',
        zIndex: 220,
        top: pos.top,
        right: pos.right,
        width: 'min(340px, calc(100vw - 24px))',
      }}
    >
      <div className="tp-head">
        <h3>Tools</h3>
        <button className="close" onClick={onClose} type="button" aria-label="Close tools">
          <X size={14} />
        </button>
      </div>

      <div className="tp-scroll">
        {/* Chat actions */}
        <div className="tp-section">
          <div className="tp-title">Chat</div>
          <button
            type="button"
            className="tp-item"
            onClick={() => {
              dispatch('mc-chat-new', { namespace: namespace === 'mc' ? 'default' : namespace });
              onClose();
            }}
          >
            <span className="ic"><MessageSquarePlus size={14} /></span>
            <span className="info">
              <span className="name">New chat</span>
              <span className="desc">Start a fresh conversation</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-chat-action', { action: 'reset-session', namespace }); onClose(); }}
          >
            <span className="ic"><RotateCcw size={14} /></span>
            <span className="info">
              <span className="name">Reset session</span>
              <span className="desc">Fresh CLI session, keep messages</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item red"
            onClick={() => {
              if (confirm('Clear all messages in this chat?')) {
                dispatch('mc-chat-action', { action: 'clear-chat', namespace });
                onClose();
              }
            }}
          >
            <span className="ic"><Trash2 size={14} /></span>
            <span className="info">
              <span className="name">Clear chat</span>
              <span className="desc">Remove all messages</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-navigate', { tab: 'notepad' }); onClose(); }}
          >
            <span className="ic"><FileText size={14} /></span>
            <span className="info">
              <span className="name">Open notepad</span>
              <span className="desc">Shared realtime scratchpad</span>
            </span>
          </button>
        </div>

        {/* Agents */}
        <div className="tp-section">
          <div className="tp-title">Agents</div>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-chat-action', { action: 'pair-mode-cycle', namespace }); onClose(); }}
          >
            <span className="ic"><Users size={14} /></span>
            <span className="info">
              <span className="name">Pair mode</span>
              <span className="desc">Solo · Pair · Orchestrate (click to cycle)</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item cyan"
            onClick={() => { dispatch('mc-chat-action', { action: 'show-subagents', namespace }); onClose(); }}
          >
            <span className="ic"><Bot size={14} /></span>
            <span className="info">
              <span className="name">Sub-agents</span>
              <span className="desc">Active background runs</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-chat-action', { action: 'delegate-claude', namespace }); onClose(); }}
          >
            <span className="ic"><Code2 size={14} /></span>
            <span className="info">
              <span className="name">Delegate to Claude Code</span>
              <span className="desc">Hand off to local Claude CLI</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-chat-action', { action: 'spawn-task', namespace }); onClose(); }}
          >
            <span className="ic"><Zap size={14} /></span>
            <span className="info">
              <span className="name">Spawn background task</span>
              <span className="desc">Uses your current draft</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-chat-action', { action: 'ask-codex', namespace }); onClose(); }}
          >
            <span className="ic"><Bot size={14} /></span>
            <span className="info">
              <span className="name">Ask Codex</span>
              <span className="desc">OpenAI Codex turn with a goal</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item green"
            onClick={() => { dispatch('mc-chat-action', { action: 'deploy-constellation', namespace }); onClose(); }}
          >
            <span className="ic"><Workflow size={14} /></span>
            <span className="info">
              <span className="name">Deploy constellation</span>
              <span className="desc">Team of parallel agents</span>
            </span>
          </button>
        </div>

        {/* Context */}
        <div className="tp-section">
          <div className="tp-title">Context</div>
          <button
            type="button"
            className="tp-item violet"
            onClick={() => { dispatch('mc-chat-action', { action: 'compress-context', namespace }); onClose(); }}
          >
            <span className="ic"><Archive size={14} /></span>
            <span className="info">
              <span className="name">Compress context</span>
              <span className="desc">Snapshot + summarize long threads</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item amber"
            onClick={() => { dispatch('mc-chat-action', { action: 'show-key-facts', namespace }); onClose(); }}
          >
            <span className="ic"><KeyRound size={14} /></span>
            <span className="info">
              <span className="name">Key facts</span>
              <span className="desc">Captured facts from this chat</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-chat-action', { action: 'show-memory', namespace }); onClose(); }}
          >
            <span className="ic"><Database size={14} /></span>
            <span className="info">
              <span className="name">Memory panel</span>
              <span className="desc">Turns · episodes · search</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-chat-action', { action: 'link-chat', namespace }); onClose(); }}
          >
            <span className="ic"><Link2 size={14} /></span>
            <span className="info">
              <span className="name">Link another chat</span>
              <span className="desc">Cross-reference a second session</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-chat-action', { action: 'pull-cross-chat', namespace }); onClose(); }}
          >
            <span className="ic"><Server size={14} /></span>
            <span className="info">
              <span className="name">Pull chat context</span>
              <span className="desc">Linux MC · PC · SEO · Luke's</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-chat-action', { action: 'gateway-session', namespace }); onClose(); }}
          >
            <span className="ic"><MessageSquare size={14} /></span>
            <span className="info">
              <span className="name">Gateway session</span>
              <span className="desc">Attach to a running CLI session</span>
            </span>
          </button>
        </div>

        {/* Composer */}
        <div className="tp-section">
          <div className="tp-title">Composer</div>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-chat-action', { action: 'attach-file', namespace }); onClose(); }}
          >
            <span className="ic"><Paperclip size={14} /></span>
            <span className="info">
              <span className="name">Attach file</span>
              <span className="desc">Image · PDF · text → next message</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-chat-action', { action: 'project-assets', namespace }); onClose(); }}
          >
            <span className="ic"><FileSearch size={14} /></span>
            <span className="info">
              <span className="name">Project assets</span>
              <span className="desc">Browse the workspace</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-pull-latest', { namespace }); onClose(); }}
          >
            <span className="ic"><RefreshCw size={14} /></span>
            <span className="info">
              <span className="name">Pull latest</span>
              <span className="desc">Sync code from git</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item violet"
            onClick={() => { dispatch('mc-chat-action', { action: 'attach-github', namespace }); onClose(); }}
          >
            <span className="ic"><Github size={14} /></span>
            <span className="info">
              <span className="name">Attach GitHub repo</span>
              <span className="desc">Pin a repo to this chat</span>
            </span>
          </button>
        </div>

        {/* History + reports */}
        <div className="tp-section">
          <div className="tp-title">History</div>
          <button
            type="button"
            className="tp-item red"
            onClick={() => { dispatch('mc-chat-action', { action: 'show-reports', namespace }); onClose(); }}
          >
            <span className="ic"><FileText size={14} /></span>
            <span className="info">
              <span className="name">Reports</span>
              <span className="desc">Attach an issue / bug report</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item"
            onClick={() => {
              if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
                Notification.requestPermission();
              }
              onClose();
            }}
          >
            <span className="ic"><Bell size={14} /></span>
            <span className="info">
              <span className="name">Browser notifications</span>
              <span className="desc">Get pinged when the agent finishes</span>
            </span>
          </button>
        </div>

        {/* Model — Claude */}
        <div className="tp-section">
          <div className="tp-title">Model · Claude</div>
          {MODELS.filter(m => m.group === 'claude').map(m => (
            <button
              key={m.id}
              type="button"
              className={'tp-item ' + (activeModel === m.id ? 'violet' : '')}
              onClick={() => pickModel(m.id)}
            >
              <span className="ic">{activeModel === m.id ? <Check size={14} /> : <Brain size={14} />}</span>
              <span className="info">
                <span className="name">{m.label}</span>
                <span className="desc">{m.hint}</span>
              </span>
            </button>
          ))}
        </div>

        {/* Model — OpenAI Codex */}
        <div className="tp-section">
          <div className="tp-title">Model · Codex (OpenAI)</div>
          {MODELS.filter(m => m.group === 'codex').map(m => (
            <button
              key={m.id}
              type="button"
              className={'tp-item ' + (activeModel === m.id ? 'green' : '')}
              onClick={() => pickModel(m.id)}
            >
              <span className="ic">{activeModel === m.id ? <Check size={14} /> : <Bot size={14} />}</span>
              <span className="info">
                <span className="name">{m.label}</span>
                <span className="desc">{m.hint}</span>
              </span>
            </button>
          ))}
        </div>

        {/* Permission mode */}
        <div className="tp-section">
          <div className="tp-title">Permission mode</div>
          {MODES.map(m => {
            const tone = m.id === 'plan' ? 'violet'
                       : m.id === 'bypassPermissions' ? 'amber'
                       : m.id === 'acceptEdits' ? 'green'
                       : '';
            return (
              <button
                key={m.id}
                type="button"
                className={'tp-item ' + (activeMode === m.id ? tone : '')}
                onClick={() => pickMode(m.id)}
              >
                <span className="ic">{activeMode === m.id ? <Check size={14} /> : <Shield size={14} />}</span>
                <span className="info">
                  <span className="name">{m.label}</span>
                  <span className="desc">{m.hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        {/* View — chat-message zoom */}
        <div className="tp-section">
          <div className="tp-title">View</div>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-chat-zoom', { action: 'in' }); }}
          >
            <span className="ic"><ZoomIn size={14} /></span>
            <span className="info">
              <span className="name">Zoom in</span>
              <span className="desc">Bigger message text · ⌘ +</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-chat-zoom', { action: 'out' }); }}
          >
            <span className="ic"><ZoomOut size={14} /></span>
            <span className="info">
              <span className="name">Zoom out</span>
              <span className="desc">Smaller message text · ⌘ −</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-chat-zoom', { action: 'reset' }); onClose(); }}
          >
            <span className="ic"><Maximize2 size={14} /></span>
            <span className="info">
              <span className="name">Reset zoom</span>
              <span className="desc">Back to 100% · ⌘ 0</span>
            </span>
          </button>
        </div>

        {/* Workspace */}
        <div className="tp-section">
          <div className="tp-title">Workspace</div>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-open-add-project'); onClose(); }}
          >
            <span className="ic"><FolderPlus size={14} /></span>
            <span className="info">
              <span className="name">Add project</span>
              <span className="desc">New workspace + per-project credentials</span>
            </span>
          </button>
        </div>

        {/* App */}
        <div className="tp-section">
          <div className="tp-title">App</div>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-navigate', { tab: 'skills' }); onClose(); }}
          >
            <span className="ic"><Sparkles size={14} /></span>
            <span className="info">
              <span className="name">Manage skills</span>
              <span className="desc">Install / enable skills</span>
            </span>
          </button>
          <button
            type="button"
            className="tp-item"
            onClick={() => { dispatch('mc-open-settings'); onClose(); }}
          >
            <span className="ic"><Settings size={14} /></span>
            <span className="info">
              <span className="name">Settings</span>
              <span className="desc">Workspace · theme · API keys</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
