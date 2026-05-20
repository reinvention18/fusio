/**
 * Fusio chat header — sits above the existing ChatPanel for chat / SEO /
 * Luke's-chat tabs. Uses the design's `.chat-head` class family from
 * /fusio/mc.css for pixel-faithful styling.
 *
 * Adds an interactive Project pill (next to LIVE) — dropdown of recent
 * workspaces; selecting one dispatches `mc-set-session-workspace` which
 * ChatPanel listens for and applies to the active session.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { I } from './Icons';
import { FusioMobileSessionsDrawer } from './MobileSessionsDrawer';
import { AddProjectModal } from './AddProjectModal';
import { FusioToolsMenu } from './ToolsMenu';
import { Plus, Maximize2, Minimize2 } from 'lucide-react';

interface ChatHeaderProps {
  namespace?: 'mc' | 'seo' | 'missions';
  fallbackTitle?: string;
  onOpenTools?: () => void;
  onOpenNotepad?: () => void;
  /** Override the auto-derived stat chips. If omitted, header renders
   *  Model / Mode / Skills / Repo derived from active session state. */
  statChips?: Array<{ k: string; v: string; tone?: 'red' | 'green' | 'amber' | 'violet' }>;
}

function lsKey(ns: 'mc' | 'seo' | 'missions') {
  return `${ns}-activeSessionId`;
}

/** Short label for a workspace path — last segment, max 24 chars. */
function shortenWorkspace(ws: string): string {
  if (!ws) return 'no project';
  const parts = ws.split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) return 'no project';
  const last = parts[parts.length - 1];
  if (last.length <= 24) return last;
  return last.slice(0, 22) + '…';
}

/** Pretty-print a model id for the stat chip. */
function prettyModel(id: string): string {
  if (!id || id === 'default') return 'auto';
  if (id === 'claude-opus-4-7[1m]' || id === 'opus1m') return 'opus 4.7 · 1M';
  if (id === 'claude-opus-4-7' || id === 'opus' || id === 'opus47') return 'opus 4.7';
  if (id === 'claude-sonnet-4-6' || id === 'sonnet') return 'sonnet 4.6';
  if (id === 'claude-haiku-4-5' || id === 'haiku') return 'haiku 4.5';
  return id;
}

/** Pretty-print permission mode for the stat chip. */
function prettyMode(m: string): string {
  if (!m || m === 'default') return 'default';
  if (m === 'plan') return 'plan';
  if (m === 'bypassPermissions') return 'bypass';
  if (m === 'acceptEdits') return 'accept';
  return m;
}

export function FusioChatHeader({
  namespace = 'mc',
  fallbackTitle,
  onOpenTools,
  onOpenNotepad,
  statChips = [],
}: ChatHeaderProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState<string>(fallbackTitle || '');
  const [sessionWorkspace, setSessionWorkspace] = useState<string>('');
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);

  // Stat-chip data — Model / Mode / Skills / Repo. Auto-derived from the
  // active session's localStorage entries unless the caller passes
  // statChips explicitly (which takes precedence).
  const [activeModel, setActiveModel] = useState<string>('default');
  const [activeMode, setActiveMode] = useState<string>('default');
  const [skillsCount, setSkillsCount] = useState<number>(0);

  const [projectOpen, setProjectOpen] = useState(false);
  const projectRef = useRef<HTMLDivElement>(null);

  /** Mobile-only sessions drawer (the desktop sessions column is hidden
   *  at ≤767px — without this, mobile users have no way to switch chats). */
  const [sessionsDrawerOpen, setSessionsDrawerOpen] = useState(false);

  /** Add-project modal — opened from the project dropdown's "+ New project"
   *  entry. Captures path + per-project credential overrides. */
  const [addProjectOpen, setAddProjectOpen] = useState(false);

  /** Tools popover — opens from the Tools pill in the chat header. */
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsAnchorRect, setToolsAnchorRect] = useState<DOMRect | null>(null);
  const toolsBtnRef = useRef<HTMLButtonElement>(null);

  /** Full-screen chat mode (the "terminal" look). Hides the sidebar /
   *  topbar / sessions column and applies a denser, mono-typography
   *  theme to messages. Toggled from the maximize button in this header
   *  or with Cmd/Ctrl+. — persists in localStorage so the mode survives
   *  reloads and tab switches. ESC exits. */
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Hydrate from localStorage on mount.
    const stored = localStorage.getItem('mc-chat-fullscreen') === '1';
    setFullscreen(stored);
    if (stored) document.body.setAttribute('data-mc-fullscreen-chat', '1');
    // Listen for cross-component toggles (e.g. from a keyboard shortcut
    // bound at the page level, or from the mobile drawer).
    const onToggle = () => setFullscreen(v => !v);
    window.addEventListener('mc-toggle-fullscreen-chat', onToggle);
    // ESC exits fullscreen (only if it's currently on).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.body.getAttribute('data-mc-fullscreen-chat') === '1') {
        setFullscreen(false);
      }
      // Cmd/Ctrl + . — power-user shortcut for quick toggle.
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault();
        setFullscreen(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mc-toggle-fullscreen-chat', onToggle);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (fullscreen) {
      document.body.setAttribute('data-mc-fullscreen-chat', '1');
      try { localStorage.setItem('mc-chat-fullscreen', '1'); } catch { /* quota */ }
    } else {
      document.body.removeAttribute('data-mc-fullscreen-chat');
      try { localStorage.setItem('mc-chat-fullscreen', '0'); } catch { /* quota */ }
    }
  }, [fullscreen]);

  // Cross-component event: Tools menu dispatches `mc-open-add-project` so
  // the user can jump from Tools → Add project without nav.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onAdd = () => setAddProjectOpen(true);
    window.addEventListener('mc-open-add-project', onAdd);
    return () => window.removeEventListener('mc-open-add-project', onAdd);
  }, []);

  // Track active session id via storage events + custom events from Sessions.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const key = lsKey(namespace);
    setActiveId(localStorage.getItem(key));
    const onStorage = (e: StorageEvent) => { if (e.key === key) setActiveId(e.newValue); };
    const onSelect = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.id) setActiveId(detail.id);
      // If the picker handed us a name + workspace, set them immediately
      // so the user doesn't see a "New chat" flash while the API fetch
      // runs. The subsequent effect-driven fetch will re-confirm.
      if (typeof detail?.name === 'string' && detail.name) {
        setSessionName(detail.name);
      }
      if (typeof detail?.workspace === 'string') {
        setSessionWorkspace(detail.workspace);
      }
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('mc-chat-select', onSelect);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('mc-chat-select', onSelect);
    };
  }, [namespace]);

  // When active id changes, look up the session name + workspace.
  // Also collect the union of all sessions' workspaces for the dropdown.
  useEffect(() => {
    let alive = true;
    // Fetch saved project records in parallel — they augment the
    // workspaces list with anything the user added via "+ New project".
    const savedProjectsP = fetch('/api/projects', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : { projects: [] })
      .catch(() => ({ projects: [] }));
    Promise.all([
      fetch('/api/chats?lite=true', { cache: 'no-store' }).then(r => r.json()),
      savedProjectsP,
    ]).then(([j, sp]: any) => {
        if (!alive) return;
        const list = (j?.sessions || []) as Array<{ id: string; name?: string; workspace?: string }>;
        const ws = new Set<string>();
        try {
          const cfg = JSON.parse(localStorage.getItem('gatewayConfig') || '{}');
          if (cfg.workspace) ws.add(cfg.workspace);
        } catch { /* ignore */ }
        for (const s of list) if (s.workspace) ws.add(s.workspace);
        for (const p of (sp?.projects || [])) if (p.path) ws.add(p.path);
        setRecentWorkspaces(Array.from(ws));

        if (activeId) {
          const s = list.find(x => x.id === activeId);
          if (s) {
            setSessionName(s.name || fallbackTitle || 'Untitled chat');
            setSessionWorkspace(s.workspace || '');
          } else {
            setSessionName(fallbackTitle || 'New chat');
            try {
              const cfg = JSON.parse(localStorage.getItem('gatewayConfig') || '{}');
              setSessionWorkspace(cfg.workspace || '');
            } catch { setSessionWorkspace(''); }
          }
        } else {
          setSessionName(fallbackTitle || '');
          try {
            const cfg = JSON.parse(localStorage.getItem('gatewayConfig') || '{}');
            setSessionWorkspace(cfg.workspace || '');
          } catch { setSessionWorkspace(''); }
        }
      })
      .catch(() => { if (alive) setSessionName(fallbackTitle || 'Chat'); });
    return () => { alive = false; };
  }, [activeId, fallbackTitle]);

  // Derive Model + Mode from the namespace-scoped localStorage maps the
  // legacy ChatPanel uses. Re-read on session change AND on the cross-
  // component custom events the composer dispatches.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const readMaps = () => {
      try {
        const mm = JSON.parse(localStorage.getItem(`${namespace}-modelMap`) || '{}');
        setActiveModel(activeId ? (mm[activeId] || 'default') : 'default');
      } catch { setActiveModel('default'); }
      try {
        const pm = JSON.parse(localStorage.getItem(`${namespace}-permissionModeMap`) || '{}');
        setActiveMode(activeId ? (pm[activeId] || 'default') : 'default');
      } catch { setActiveMode('default'); }
    };
    readMaps();
    const onModel = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (d.namespace && d.namespace !== namespace) return;
      if (typeof d.modelId === 'string') setActiveModel(d.modelId);
    };
    const onMode = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (d.namespace && d.namespace !== namespace) return;
      if (typeof d.mode === 'string') setActiveMode(d.mode);
    };
    const onStorage = (e: StorageEvent) => {
      if (!e.key) return;
      if (e.key === `${namespace}-modelMap` || e.key === `${namespace}-permissionModeMap`) readMaps();
    };
    window.addEventListener('mc-set-session-model', onModel);
    window.addEventListener('mc-set-session-mode', onMode);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('mc-set-session-model', onModel);
      window.removeEventListener('mc-set-session-mode', onMode);
      window.removeEventListener('storage', onStorage);
    };
  }, [namespace, activeId]);

  // Skills count — fetch once and cache. Light poll so live install/uninstall
  // shows up in the chip.
  useEffect(() => {
    let alive = true;
    const fetchSkills = () => {
      fetch('/api/skills?action=list', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (alive && Array.isArray(j?.skills)) setSkillsCount(j.skills.length); })
        .catch(() => { /* ignore */ });
    };
    fetchSkills();
    const id = setInterval(fetchSkills, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Click outside / Escape closes the project dropdown
  useEffect(() => {
    if (!projectOpen) return;
    const onDown = (e: MouseEvent) => {
      if (projectRef.current && !projectRef.current.contains(e.target as Node)) {
        setProjectOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setProjectOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [projectOpen]);

  const setProject = (ws: string) => {
    setSessionWorkspace(ws);
    setProjectOpen(false);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('mc-set-session-workspace', {
        detail: { sessionId: activeId, namespace, workspace: ws },
      }));
    }
  };

  return (
    <div className="chat-head">
      <div className="title">
        <span className="ic">{I.chat}</span>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span className="name">{sessionName || (fallbackTitle || 'New chat')}</span>
          <span className="sub">{sessionWorkspace ? shortenWorkspace(sessionWorkspace) : 'READY'}</span>
        </div>
      </div>
      <div className="head-actions">
        {/* Mobile-only Chats button — opens FusioMobileSessionsDrawer.
            Hidden ≥768px (where the sessions column is visible). */}
        <button
          type="button"
          className="pill chats-mobile-only"
          onClick={() => setSessionsDrawerOpen(true)}
          title="Switch chat session"
          aria-label="Open chats list"
          style={{ background: 'transparent', cursor: 'pointer' }}
        >
          {I.chat}
          <span>Chats</span>
        </button>

        <span className="pill live">Live</span>

        {/* Project selector — pill with dropdown */}
        <div ref={projectRef} style={{ position: 'relative' }}>
          <button
            type="button"
            className="pill"
            onClick={() => setProjectOpen(o => !o)}
            title="Switch project · workspace this chat operates in"
            style={{
              cursor: 'pointer',
              color: sessionWorkspace ? 'var(--cyan, #5EC4D9)' : 'var(--mist, rgba(255,255,255,0.5))',
              borderColor: sessionWorkspace ? 'rgba(94, 196, 217, 0.35)' : undefined,
            }}
          >
            {I.folder}
            <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {sessionWorkspace ? shortenWorkspace(sessionWorkspace) : 'Project'}
            </span>
            <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
          </button>
          {projectOpen && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                left: 0,
                zIndex: 100,
                minWidth: 280,
                maxWidth: 420,
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
                Project · workspace
              </div>
              {recentWorkspaces.length === 0 && (
                <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--mist, rgba(255,255,255,0.5))', fontStyle: 'italic' }}>
                  No projects saved yet. Set one in Settings → Workspace.
                </div>
              )}
              {recentWorkspaces.map(ws => {
                const isActive = ws === sessionWorkspace;
                return (
                  <button
                    key={ws}
                    type="button"
                    onClick={() => setProject(ws)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 10px',
                      borderRadius: 6,
                      background: isActive ? 'rgba(94, 196, 217, 0.12)' : 'transparent',
                      border: `1px solid ${isActive ? 'rgba(94, 196, 217, 0.4)' : 'transparent'}`,
                      color: 'var(--white, #fff)',
                      cursor: 'pointer',
                      transition: 'background 120ms ease-out',
                      display: 'flex', flexDirection: 'column', gap: 2,
                    }}
                    onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; }}
                    onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600, color: isActive ? 'var(--cyan, #5EC4D9)' : 'var(--white, #fff)' }}>
                      {shortenWorkspace(ws)}
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, color: 'var(--mist, rgba(255,255,255,0.5))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {ws}
                    </span>
                  </button>
                );
              })}

              {/* + New project entry — always at the bottom of the dropdown */}
              <div style={{ borderTop: '1px solid var(--line)', margin: '6px 0 4px' }} />
              <button
                type="button"
                onClick={() => { setProjectOpen(false); setAddProjectOpen(true); }}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: 'transparent',
                  border: '1px dashed var(--line)',
                  color: 'var(--cyan, #5EC4D9)',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(94,196,217,0.08)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <Plus size={13} /> New project
              </button>
            </div>
          )}
        </div>

        <button
          className="pill notepad"
          onClick={() => {
            // Honor the prop if the parent wired one (rare), otherwise
            // navigate to the global Notepad tab via the cross-component
            // event page.tsx listens for.
            if (onOpenNotepad) { onOpenNotepad(); return; }
            window.dispatchEvent(new CustomEvent('mc-navigate', { detail: { tab: 'notepad' } }));
          }}
          title="Shared notepad"
          type="button"
          style={{ background: 'transparent', cursor: 'pointer' }}
        >
          {I.notepad}
          <span>Notepad</span>
        </button>
        <button
          ref={toolsBtnRef}
          className="pill tools"
          onClick={() => {
            // Prefer the parent's handler if wired; otherwise open our
            // built-in FusioToolsMenu anchored to this button.
            if (onOpenTools) { onOpenTools(); return; }
            const rect = toolsBtnRef.current?.getBoundingClientRect() || null;
            setToolsAnchorRect(rect);
            setToolsOpen(true);
          }}
          title="Tools menu"
          type="button"
          aria-haspopup="menu"
          aria-expanded={toolsOpen}
          style={{ cursor: 'pointer' }}
        >
          {I.tools}
          <span>Tools</span>
        </button>
        <button
          className="pill fusio-exit-btn"
          onClick={() => setFullscreen(v => !v)}
          title={fullscreen ? 'Exit fullscreen chat (ESC or ⌘.)' : 'Fullscreen chat — terminal look (⌘.)'}
          type="button"
          aria-pressed={fullscreen}
          style={{ cursor: 'pointer', background: 'transparent' }}
        >
          {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          <span>{fullscreen ? 'Exit' : 'Full'}</span>
        </button>
      </div>
      {(() => {
        // If the caller passed explicit chips, honor them. Otherwise auto-
        // derive Model / Mode / Skills / Repo from session state + storage.
        const chips = statChips.length > 0 ? statChips : [
          { k: 'Model',  v: prettyModel(activeModel) },
          { k: 'Mode',   v: prettyMode(activeMode), tone: (activeMode === 'plan' ? 'violet' : activeMode === 'bypassPermissions' ? 'amber' : undefined) as 'violet' | 'amber' | undefined },
          { k: 'Skills', v: skillsCount > 0 ? String(skillsCount) : '—', tone: 'green' as const },
          { k: 'Repo',   v: sessionWorkspace ? shortenWorkspace(sessionWorkspace) : '—', tone: 'red' as const },
        ];
        return (
          <div className="stat-chips">
            {chips.map((chip, i) => (
              <span key={i} className={'chip ' + (chip.tone || '')}>
                <span className="k">{chip.k}</span>
                <span className="v">{chip.v}</span>
              </span>
            ))}
          </div>
        );
      })()}

      <FusioMobileSessionsDrawer
        open={sessionsDrawerOpen}
        onClose={() => setSessionsDrawerOpen(false)}
        namespace={namespace === 'mc' ? 'default' : namespace}
        title={namespace === 'seo' ? 'SEO chats' : namespace === 'missions' ? "Luke's chats" : 'Conversations'}
      />

      <AddProjectModal
        open={addProjectOpen}
        onClose={() => setAddProjectOpen(false)}
        onCreated={(path) => {
          setRecentWorkspaces(prev => prev.includes(path) ? prev : [path, ...prev]);
          setProject(path);
        }}
      />

      <FusioToolsMenu
        open={toolsOpen}
        onClose={() => setToolsOpen(false)}
        anchorRect={toolsAnchorRect ? {
          left: toolsAnchorRect.left, top: toolsAnchorRect.top,
          right: toolsAnchorRect.right, bottom: toolsAnchorRect.bottom,
          width: toolsAnchorRect.width, height: toolsAnchorRect.height,
        } : undefined}
        namespace={namespace}
      />
    </div>
  );
}
