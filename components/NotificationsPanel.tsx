'use client';

import { useState, useEffect } from 'react';
import { Bell, X, Check, AlertTriangle, Info, CheckCircle } from 'lucide-react';

interface Notification {
  id: string;
  type: 'success' | 'warning' | 'error' | 'info';
  title: string;
  message: string;
  timestamp: Date;
  read: boolean;
}

export default function NotificationsPanel() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    // Load from localStorage
    const saved = localStorage.getItem('notifications');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setNotifications(parsed.map((n: any) => ({ ...n, timestamp: new Date(n.timestamp) })));
      } catch { /* ignore */ }
    }

    // Poll for Constellation team events (warn/error severity)
    const pollTeamEvents = async () => {
      try {
        const teamsRes = await fetch('/api/teams');
        const { teams } = await teamsRes.json();
        const activeTeams = (teams || []).filter((t: any) => ['running', 'paused', 'error'].includes(t.status));
        for (const team of activeTeams) {
          try {
            const evRes = await fetch(`/api/teams/${team.id}/events?limit=20`);
            const { events } = await evRes.json();
            const important = (events || []).filter((e: any) =>
              (e.severity === 'warn' || e.severity === 'error') &&
              e.created_at > Date.now() - 5 * 60 * 1000 // last 5 min
            );
            for (const evt of important) {
              const notifId = `team-evt-${evt.id}`;
              setNotifications(prev => {
                if (prev.some(n => n.id === notifId)) return prev;
                let payload: Record<string, unknown> = {};
                try { payload = JSON.parse(evt.payload); } catch { /* ignore */ }
                const newNotif: Notification = {
                  id: notifId,
                  type: evt.severity === 'error' ? 'error' : 'warning',
                  title: `✦ ${team.constellation || team.name}: ${evt.kind}`,
                  message: String(payload.error || payload.reason || payload.summary || payload.body || evt.kind).slice(0, 200),
                  timestamp: new Date(evt.created_at),
                  read: false,
                };
                const updated = [newNotif, ...prev].slice(0, 50);
                localStorage.setItem('notifications', JSON.stringify(updated));
                return updated;
              });
            }
          } catch { /* ignore per-team errors */ }
        }
      } catch { /* ignore */ }
    };
    pollTeamEvents();
    const interval = setInterval(pollTeamEvents, 15000);
    return () => clearInterval(interval);
  }, []);

  const saveNotifications = (updated: Notification[]) => {
    setNotifications(updated);
    localStorage.setItem('notifications', JSON.stringify(updated));
  };

  const markAllRead = () => {
    saveNotifications(notifications.map(n => ({ ...n, read: true })));
  };

  const clearAll = () => {
    saveNotifications([]);
  };

  const dismiss = (id: string) => {
    saveNotifications(notifications.filter(n => n.id !== id));
  };

  const unreadCount = notifications.filter(n => !n.read).length;

  const getIcon = (type: Notification['type']) => {
    switch (type) {
      case 'success': return <CheckCircle className="w-3 h-3 text-terminal-green" />;
      case 'warning': return <AlertTriangle className="w-3 h-3 text-terminal-amber" />;
      case 'error': return <AlertTriangle className="w-3 h-3 text-terminal-red" />;
      default: return <Info className="w-3 h-3 text-terminal-cyan" />;
    }
  };

  const formatTime = (date: Date) => {
    const mins = Math.floor((Date.now() - date.getTime()) / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const visibleNotifications = showAll ? notifications : notifications.slice(0, 5);

  return (
    <div className="fusio-panel p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 5, background: 'rgba(204, 12, 32, 0.12)', border: '1px solid rgba(204, 12, 32, 0.35)' }}>
            <Bell style={{ width: 11, height: 11, color: 'var(--red, #CC0C20)' }} />
            {unreadCount > 0 && (
              <span style={{ position: 'absolute', top: -3, right: -3, minWidth: 14, height: 14, padding: '0 4px', background: 'var(--red, #CC0C20)', borderRadius: 99, fontSize: 9, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontFamily: 'var(--font-mono, ui-monospace)', boxShadow: '0 0 6px rgba(204, 12, 32, 0.6)' }}>
                {unreadCount}
              </span>
            )}
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Monitor · Inbox
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--white, #fff)', marginTop: 1 }}>
              Alerts
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              className="text-xs text-terminal-dim hover:text-terminal-green transition"
            >
              Mark read
            </button>
          )}
          {notifications.length > 0 && (
            <button
              onClick={clearAll}
              className="p-1 text-terminal-dim hover:text-terminal-red rounded transition"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      <div className="space-y-1.5 max-h-48 overflow-y-auto">
        {visibleNotifications.map((notif) => (
          <div
            key={notif.id}
            className={`bg-terminal-bg rounded p-2 border transition ${
              notif.read ? 'border-terminal-border/50 opacity-70' : 'border-terminal-border'
            }`}
          >
            <div className="flex items-start gap-2">
              {getIcon(notif.type)}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-terminal-text text-xs font-medium">{notif.title}</span>
                  <span className="text-terminal-dim text-xs">{formatTime(notif.timestamp)}</span>
                </div>
                <div className="text-terminal-dim text-xs truncate">{notif.message}</div>
              </div>
              <button
                onClick={() => dismiss(notif.id)}
                className="p-0.5 text-terminal-dim hover:text-terminal-red transition"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
        ))}

        {notifications.length === 0 && (
          <div className="text-terminal-dim text-xs text-center py-4 italic">No notifications</div>
        )}

        {notifications.length > 5 && (
          <button
            onClick={() => setShowAll(!showAll)}
            className="w-full text-center text-terminal-cyan text-xs py-1 hover:underline"
          >
            {showAll ? 'Show less' : `Show ${notifications.length - 5} more`}
          </button>
        )}
      </div>
    </div>
  );
}
