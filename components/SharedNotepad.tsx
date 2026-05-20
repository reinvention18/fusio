/**
 * SharedNotepad — realtime shared scratchpad across Linux, PC, and mobile.
 *
 * - On mount: GET /api/notepad?id=<padId> for initial content
 * - Subscribes to /api/notepad/listen?id=<padId>&clientId=<clientId> SSE
 * - When user types: debounced 300ms → POST /api/notepad with current text
 * - When server broadcasts an update from a DIFFERENT client: merge it in,
 *   but only if the local user hasn't typed in the last 800ms (don't fight
 *   the user's cursor)
 *
 * Last-write-wins on conflict — this is a casual shared pad, not a true
 * collaborative editor. For concurrent typing, the last keystroke wins.
 */

'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2, Wifi, WifiOff, Save, AlertTriangle } from 'lucide-react';

interface SharedNotepadProps {
  /** Pad id — change to switch which document this notepad shows.
   *  Default = "default". URL-safe; only [a-z0-9-] is preserved. */
  padId?: string;
  /** Tailwind classes for the outer wrapper. */
  className?: string;
  /** Optional title row above the textarea. */
  title?: string;
}

interface PadState {
  content: string;
  version: number;
  updatedAt: string;
  updatedBy?: string;
}

const DEBOUNCE_MS = 300;
const TYPING_GRACE_MS = 800;

function makeClientId(): string {
  // Stable per-tab id so the server can filter our own broadcasts back.
  // Stored in sessionStorage so it survives reloads but a fresh tab gets
  // a new id.
  if (typeof window === 'undefined') return 'srv';
  try {
    let id = sessionStorage.getItem('mc-notepad-cid');
    if (!id) {
      id = `${typeof navigator !== 'undefined' ? (navigator.platform || 'web').replace(/[^a-z0-9]/gi, '').slice(0, 6) : 'web'}-${Math.random().toString(36).slice(2, 8)}`;
      sessionStorage.setItem('mc-notepad-cid', id);
    }
    return id;
  } catch { return 'web-' + Math.random().toString(36).slice(2, 8); }
}

export function SharedNotepad({ padId = 'default', className = '', title }: SharedNotepadProps) {
  const [content, setContent] = useState<string>('');
  const [version, setVersion] = useState<number>(0);
  const [updatedBy, setUpdatedBy] = useState<string | undefined>();
  const [updatedAt, setUpdatedAt] = useState<string | undefined>();
  const [connected, setConnected] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [conflict, setConflict] = useState<boolean>(false);
  const [initialLoaded, setInitialLoaded] = useState<boolean>(false);

  const clientIdRef = useRef<string>('');
  const lastLocalEditRef = useRef<number>(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const versionRef = useRef<number>(0);
  const contentRef = useRef<string>('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep ref in sync so async callbacks see latest values
  useEffect(() => { versionRef.current = version; }, [version]);
  useEffect(() => { contentRef.current = content; }, [content]);

  // Initial load + SSE subscribe
  useEffect(() => {
    if (typeof window === 'undefined') return;
    clientIdRef.current = makeClientId();
    let abort = false;
    let es: EventSource | null = null;

    (async () => {
      try {
        const r = await fetch(`/api/notepad?id=${encodeURIComponent(padId)}`);
        if (!r.ok) throw new Error(`GET ${r.status}`);
        const j: PadState = await r.json();
        if (abort) return;
        setContent(j.content || '');
        setVersion(j.version || 0);
        setUpdatedAt(j.updatedAt);
        setUpdatedBy(j.updatedBy);
        setInitialLoaded(true);
      } catch (e) {
        console.warn('[notepad] initial load failed:', e);
        setInitialLoaded(true);
      }

      if (abort) return;
      const url = `/api/notepad/listen?id=${encodeURIComponent(padId)}&clientId=${encodeURIComponent(clientIdRef.current)}`;
      es = new EventSource(url);
      es.onopen = () => { if (!abort) setConnected(true); };
      es.onerror = () => { if (!abort) setConnected(false); };
      es.onmessage = (ev) => {
        if (abort) return;
        try {
          const j = JSON.parse(ev.data);
          // Only apply incoming text if user hasn't typed very recently.
          // Otherwise we'd overwrite their in-flight keystrokes.
          const since = Date.now() - lastLocalEditRef.current;
          if (j.type === 'snapshot' || j.type === 'update') {
            const incoming: PadState = {
              content: j.content || '',
              version: j.version || 0,
              updatedAt: j.updatedAt,
              updatedBy: j.updatedBy,
            };
            // Only accept if newer version. (LWW with version monotonic.)
            if (incoming.version > versionRef.current && since > TYPING_GRACE_MS) {
              setContent(incoming.content);
              setVersion(incoming.version);
              setUpdatedAt(incoming.updatedAt);
              setUpdatedBy(incoming.updatedBy);
            } else if (incoming.version > versionRef.current) {
              // User is typing — buffer the version bump but don't overwrite
              // text. They'll merge on next idle save.
              setVersion(incoming.version);
              setUpdatedAt(incoming.updatedAt);
              setUpdatedBy(incoming.updatedBy);
            }
          }
        } catch { /* ignore parse */ }
      };
    })();

    return () => {
      abort = true;
      if (es) { try { es.close(); } catch {} }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [padId]);

  // Debounced save
  const scheduleSave = useCallback((next: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaving(true);
      setConflict(false);
      try {
        const r = await fetch(`/api/notepad?id=${encodeURIComponent(padId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: next,
            baseVersion: versionRef.current,
            clientId: clientIdRef.current,
          }),
        });
        if (!r.ok) throw new Error(`POST ${r.status}`);
        const j = await r.json();
        setVersion(j.version || 0);
        setUpdatedAt(j.updatedAt);
        setUpdatedBy(clientIdRef.current);
        if (j.conflicted) {
          setConflict(true);
          setTimeout(() => setConflict(false), 2500);
        }
      } catch (e) {
        console.warn('[notepad] save failed:', e);
      } finally {
        setSaving(false);
      }
    }, DEBOUNCE_MS);
  }, [padId]);

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setContent(v);
    lastLocalEditRef.current = Date.now();
    scheduleSave(v);
  };

  const updatedAgo = updatedAt ? friendlyAgo(updatedAt) : '';
  const byLabel = updatedBy && updatedBy !== clientIdRef.current
    ? `by ${updatedBy}`
    : (updatedBy === clientIdRef.current ? 'by you' : '');

  return (
    <div className={`flex flex-col h-full ${className}`}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border bg-terminal-bg/50">
        <div className="flex items-center gap-2 text-xs text-terminal-dim">
          <span className="font-medium text-terminal-text">{title || `Shared Notepad${padId !== 'default' ? ` / ${padId}` : ''}`}</span>
          {connected
            ? <Wifi className="w-3.5 h-3.5 text-terminal-green" aria-label="connected" />
            : <WifiOff className="w-3.5 h-3.5 text-terminal-red" aria-label="disconnected" />}
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin text-terminal-cyan" aria-label="saving" />}
          {!saving && version > 0 && <Save className="w-3.5 h-3.5 text-terminal-dim" aria-label="saved" />}
          {conflict && (
            <span className="flex items-center gap-1 text-terminal-yellow">
              <AlertTriangle className="w-3.5 h-3.5" /> merged remote edit
            </span>
          )}
        </div>
        <div className="text-[10px] text-terminal-dim font-mono">
          v{version} {byLabel} {updatedAgo}
        </div>
      </div>
      <textarea
        ref={textareaRef}
        value={content}
        onChange={onChange}
        disabled={!initialLoaded}
        placeholder={initialLoaded ? 'Type here — everyone connected sees the same text…' : 'Loading…'}
        spellCheck={true}
        className="flex-1 w-full bg-terminal-bg text-terminal-text font-mono text-sm leading-relaxed p-3
                   outline-none border-0 resize-none placeholder:text-terminal-dim/60"
      />
    </div>
  );
}

function friendlyAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t || isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
