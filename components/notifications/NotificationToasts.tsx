/**
 * NotificationToasts — bottom-right stack of dismissible toasts wired into
 * useAppNotifications. Each toast routes to the originating tab on click.
 *
 * Restructured for the AI Fusio design language: tokens from /fusio/mc.css
 * (palette + font vars), compact rounded cards with an accent pip and a thin
 * left bar carrying the kind color. Auto-dismiss + permission banner are
 * unchanged.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties, ComponentType } from 'react';
import { X, CheckCircle2, AlertTriangle, MessageCircle, ShieldAlert, XCircle, Bell, Zap, Lock } from 'lucide-react';
import {
  useAppNotifications,
  requestNotificationPermission,
  type AppNotification,
  type NotifyKind,
} from './useConstellationNotifications';

interface KindMeta {
  icon: ComponentType<{ style?: CSSProperties }>;
  /** CSS var name (without the leading `--`) carrying the accent hex. */
  token: 'green' | 'red' | 'cyan' | 'amber' | 'violet';
  /** Plain hex fallback if the token isn't resolved (used in rgba blends). */
  hex: string;
  /** Compact label shown as the toast's uppercase eyebrow. */
  label: string;
}

const KIND_META: Record<NotifyKind, KindMeta> = {
  completed:        { icon: CheckCircle2,  token: 'green',  hex: '#4CC38A', label: 'Completed' },
  blocker:          { icon: AlertTriangle, token: 'red',    hex: '#CC0C20', label: 'Blocker' },
  milestone:        { icon: MessageCircle, token: 'cyan',   hex: '#5EC4D9', label: 'Milestone' },
  rework:           { icon: Zap,           token: 'amber',  hex: '#E8A23B', label: 'Rework' },
  critical_finding: { icon: ShieldAlert,   token: 'red',    hex: '#CC0C20', label: 'Critical finding' },
  task_failed:      { icon: XCircle,       token: 'red',    hex: '#CC0C20', label: 'Task failed' },
  audit_ready:      { icon: CheckCircle2,  token: 'green',  hex: '#4CC38A', label: 'Audit ready' },
  plan_approval:    { icon: Lock,          token: 'amber',  hex: '#E8A23B', label: 'Plan approval' },
};

const AUTO_DISMISS_MS = 12_000;

/** Convert a hex (#RRGGBB) to rgba() with alpha. Used for soft-tint surfaces. */
function tint(hex: string, alpha: number) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function NotificationToasts() {
  const [notes, setNotes] = useState<AppNotification[]>([]);
  const [permRequested, setPermRequested] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return localStorage.getItem('mc-notif-perm-asked') === '1';
  });

  const onShow = useCallback((n: AppNotification) => {
    setNotes(prev => [...prev, n].slice(-5));
    setTimeout(() => {
      setNotes(prev => prev.filter(x => x.id !== n.id));
    }, AUTO_DISMISS_MS);
  }, []);

  useAppNotifications({ onShow });

  const dismiss = (id: string) => setNotes(prev => prev.filter(n => n.id !== id));

  const clickNote = (n: AppNotification) => {
    if (n.teamId && n.jumpTab) {
      window.dispatchEvent(new CustomEvent('mc-jump-team-tab', {
        detail: { teamId: n.teamId, tab: n.jumpTab },
      }));
    }
    dismiss(n.id);
  };

  const askPermission = async () => {
    localStorage.setItem('mc-notif-perm-asked', '1');
    setPermRequested(true);
    await requestNotificationPermission();
  };

  const showPermBanner =
    !permRequested &&
    typeof window !== 'undefined' &&
    'Notification' in window &&
    Notification.permission === 'default';

  return (
    <div
      className="notif-toasts"
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 380,
      }}
    >
      {/* Permission banner — cyan-accent card */}
      {showPermBanner && (
        <div
          className="card"
          style={{
            margin: 0,
            padding: '10px 12px',
            borderColor: tint('#5EC4D9', 0.35),
            background: 'var(--ink, #0A0A0E)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
          }}
        >
          <Bell style={{ width: 14, height: 14, color: 'var(--cyan, #5EC4D9)', marginTop: 2, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--cyan, #5EC4D9)',
                marginBottom: 2,
              }}
            >
              Enable desktop notifications?
            </div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--mist, rgba(255,255,255,0.5))',
                lineHeight: 1.45,
              }}
            >
              We'll ping you when the architect needs your attention or a constellation finishes.
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button
                type="button"
                onClick={askPermission}
                className="card-btn primary"
                style={{
                  fontSize: 10,
                  padding: '4px 10px',
                  background: 'var(--cyan, #5EC4D9)',
                  borderColor: 'var(--cyan, #5EC4D9)',
                  color: '#06181d',
                }}
              >
                Enable
              </button>
              <button
                type="button"
                onClick={() => { localStorage.setItem('mc-notif-perm-asked', '1'); setPermRequested(true); }}
                className="card-btn"
                style={{ fontSize: 10, padding: '4px 10px' }}
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast stack — each is a card with an accent left-bar */}
      {notes.map(n => {
        const meta = KIND_META[n.kind];
        const Icon = meta.icon;
        const accent = `var(--${meta.token}, ${meta.hex})`;
        return (
          <button
            key={n.id}
            type="button"
            onClick={() => clickNote(n)}
            className="card"
            style={{
              margin: 0,
              padding: 0,
              textAlign: 'left',
              cursor: 'pointer',
              background: 'var(--ink, #0A0A0E)',
              borderColor: tint(meta.hex, 0.35),
              boxShadow: `0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px ${tint(meta.hex, 0.08)}`,
              display: 'flex',
              alignItems: 'stretch',
              gap: 0,
              overflow: 'hidden',
              transition: 'filter 120ms ease-out, transform 120ms ease-out',
              maxWidth: 380,
              animation: 'fusio-toast-in 240ms cubic-bezier(0.2,0.8,0.2,1) both',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.filter = 'brightness(1.08)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.filter = 'brightness(1)'; }}
          >
            {/* Accent left bar */}
            <span
              aria-hidden
              style={{
                width: 3,
                flexShrink: 0,
                background: accent,
                boxShadow: `0 0 12px ${tint(meta.hex, 0.5)}`,
              }}
            />

            {/* Body */}
            <div style={{ flex: 1, minWidth: 0, padding: '10px 12px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <Icon style={{ width: 14, height: 14, color: accent, marginTop: 2, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9.5,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    color: accent,
                    marginBottom: 3,
                    opacity: 0.9,
                  }}
                >
                  {meta.label}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--white, #FFFFFF)',
                    lineHeight: 1.3,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {n.title}
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'var(--fog, rgba(255,255,255,0.78))',
                    lineHeight: 1.45,
                    marginTop: 2,
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {n.body}
                </div>
              </div>

              {/* Close */}
              <span
                role="button"
                tabIndex={0}
                onClick={e => { e.stopPropagation(); dismiss(n.id); }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); dismiss(n.id); } }}
                style={{
                  flexShrink: 0,
                  opacity: 0.55,
                  display: 'inline-flex',
                  cursor: 'pointer',
                  padding: 2,
                  marginTop: -2,
                  marginRight: -4,
                  color: 'var(--mist, rgba(255,255,255,0.5))',
                  transition: 'opacity 120ms ease-out',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '0.55'; }}
              >
                <X style={{ width: 12, height: 12 }} />
              </span>
            </div>
          </button>
        );
      })}

    </div>
  );
}
