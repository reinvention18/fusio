'use client';

import { useCallback, useEffect, useRef } from 'react';

export type NotifyKind = 'completed' | 'blocker' | 'milestone' | 'rework' | 'critical_finding' | 'task_failed' | 'audit_ready' | 'plan_approval';

export interface AppNotification {
  id: string;
  kind: NotifyKind;
  title: string;
  body: string;
  teamId?: string;
  chatSessionKey?: string;
  jumpTab?: string; // 'deliverable' | 'architect' | 'codex' etc
  createdAt: number;
}

interface UseNotificationsOpts {
  onShow: (n: AppNotification) => void;
}

/** Global singleton for push/show/subscribe. Can be used anywhere in the app. */
const listeners = new Set<(n: AppNotification) => void>();
const recent = new Map<string, number>(); // dedupe key → last shown timestamp

export function pushAppNotification(n: Omit<AppNotification, 'id' | 'createdAt'>): void {
  // Dedupe: same kind + teamId + title within 30s
  const key = `${n.kind}:${n.teamId || ''}:${n.title}`;
  const now = Date.now();
  const last = recent.get(key) || 0;
  if (now - last < 30_000) return;
  recent.set(key, now);

  const full: AppNotification = {
    ...n,
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
  };
  for (const fn of listeners) {
    try { fn(full); } catch { /* ignore */ }
  }

  // Browser desktop notification (if permitted)
  if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
    const icon = n.kind === 'completed' ? '/lobster.svg'
      : n.kind === 'blocker' || n.kind === 'critical_finding' || n.kind === 'task_failed' ? '/lobster.svg'
      : '/lobster.svg';
    try {
      const native = new Notification(full.title, {
        body: full.body,
        icon,
        tag: key,
      });
      native.onclick = () => {
        window.focus();
        if (full.teamId && full.jumpTab) {
          window.dispatchEvent(new CustomEvent('mc-jump-team-tab', {
            detail: { teamId: full.teamId, tab: full.jumpTab },
          }));
        }
        native.close();
      };
    } catch { /* silently ignore */ }
  }

  // Title flash for backgrounded tabs
  if (typeof document !== 'undefined' && document.hidden) {
    flashTitle(full.title);
  }
}

export function useAppNotifications({ onShow }: UseNotificationsOpts) {
  useEffect(() => {
    listeners.add(onShow);
    return () => { listeners.delete(onShow); };
  }, [onShow]);
}

// Title-flash: swap the document title until user focuses the tab.
let titleFlashTimer: ReturnType<typeof setInterval> | null = null;
let originalTitle = '';
function flashTitle(flashTo: string): void {
  if (typeof document === 'undefined') return;
  if (!originalTitle) originalTitle = document.title;
  if (titleFlashTimer) return;
  let toggle = false;
  titleFlashTimer = setInterval(() => {
    document.title = toggle ? originalTitle : `🔔 ${flashTo.slice(0, 40)}`;
    toggle = !toggle;
  }, 1500);

  const clear = () => {
    if (titleFlashTimer) { clearInterval(titleFlashTimer); titleFlashTimer = null; }
    if (originalTitle) document.title = originalTitle;
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('focus', clear);
  };
  const onVis = () => { if (!document.hidden) clear(); };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('focus', clear);
}

/** Request Notification permission — call on a user gesture (click). */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'denied';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * Watch a team's state and derive notifications from transitions.
 * Call this once in ConstellationPanel per selected team.
 */
export function useTeamNotifications(params: {
  teamId: string | null;
  teamStatus: string | undefined;
  threadLen: number;
  latestArchitectMsg?: { urgency?: string; body: string } | null;
  openCriticalFindings: number;
  tasks: Array<{ status: string }>;
}) {
  const prev = useRef<{
    status?: string;
    threadLen: number;
    criticals: number;
    failedTasks: number;
    blockedTasks: number;
  }>({ threadLen: 0, criticals: 0, failedTasks: 0, blockedTasks: 0 });

  useEffect(() => {
    const p = prev.current;
    const { teamId, teamStatus } = params;
    if (!teamId) return;

    // Team transitions into completed/done
    if (teamStatus && (teamStatus === 'completed' || teamStatus === 'done') && p.status !== teamStatus) {
      pushAppNotification({
        kind: 'completed',
        title: '✦ Mission Complete',
        body: 'The constellation finished. Codex audit starting; review the deliverable when you have a moment.',
        teamId,
        jumpTab: 'deliverable',
      });
    }

    // New architect milestone/blocker (thread length increased)
    if (params.threadLen > p.threadLen && params.latestArchitectMsg) {
      const u = params.latestArchitectMsg.urgency || 'info';
      const body = params.latestArchitectMsg.body || '';
      // Special-case: 🔒 PLAN APPROVAL REQUIRED — always surface loudly
      if (/^\s*🔒\s*PLAN APPROVAL REQUIRED/i.test(body)) {
        pushAppNotification({
          kind: 'plan_approval',
          title: '🔒 Architect needs your approval',
          body: 'Plan ready with task breakdown + questions. Approve / Modify / Reject in the Architect tab.',
          teamId,
          jumpTab: 'architect',
        });
      } else if (u === 'blocker') {
        pushAppNotification({
          kind: 'blocker',
          title: '⚠️ Architect: blocker',
          body: body.slice(0, 140),
          teamId,
          jumpTab: 'architect',
        });
      } else if (u === 'milestone') {
        pushAppNotification({
          kind: 'milestone',
          title: '◆ Architect update',
          body: body.slice(0, 140),
          teamId,
          jumpTab: 'architect',
        });
      }
    }

    // New critical Codex finding
    if (params.openCriticalFindings > p.criticals) {
      pushAppNotification({
        kind: 'critical_finding',
        title: '🛡 Critical finding',
        body: `${params.openCriticalFindings} open critical/high finding${params.openCriticalFindings === 1 ? '' : 's'} in Codex review.`,
        teamId,
        jumpTab: 'codex',
      });
    }

    // Failed / blocked tasks
    const failed = params.tasks.filter(t => t.status === 'failed').length;
    const blocked = params.tasks.filter(t => t.status === 'blocked').length;
    if (failed > p.failedTasks) {
      pushAppNotification({
        kind: 'task_failed',
        title: '✗ Task failed',
        body: `${failed} task${failed === 1 ? '' : 's'} hit a failure state.`,
        teamId,
        jumpTab: 'tasks',
      });
    }

    prev.current = {
      status: teamStatus,
      threadLen: params.threadLen,
      criticals: params.openCriticalFindings,
      failedTasks: failed,
      blockedTasks: blocked,
    };
  }, [params]);
}
