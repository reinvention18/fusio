/**
 * Browser notification utility for Mission Control.
 * Shows notifications when the tab is not focused (background tasks, responses).
 */

export async function requestPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.requestPermission();
}

export function getPermission(): NotificationPermission {
  if (!('Notification' in window)) return 'denied';
  return Notification.permission;
}

export function isTabFocused(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible';
}

/** Get user's notification preferences from localStorage */
export function getPreferences(): { enabled: boolean; onChatComplete: boolean; onTaskComplete: boolean } {
  try {
    const raw = localStorage.getItem('mc-notification-prefs');
    if (raw) return JSON.parse(raw);
  } catch {}
  return { enabled: true, onChatComplete: true, onTaskComplete: true };
}

export function savePreferences(prefs: { enabled: boolean; onChatComplete: boolean; onTaskComplete: boolean }) {
  localStorage.setItem('mc-notification-prefs', JSON.stringify(prefs));
}

/**
 * Show a notification if the tab is not focused and notifications are permitted.
 * Returns true if the notification was shown.
 */
export function notify(title: string, body: string, tag?: string): boolean {
  const prefs = getPreferences();
  if (!prefs.enabled) return false;
  if (isTabFocused()) return false;
  if (getPermission() !== 'granted') return false;

  try {
    new Notification(title, {
      body: body.slice(0, 200),
      icon: '/lobster.svg',
      tag: tag || 'mc-notification',
      silent: false,
    });
    return true;
  } catch {
    return false;
  }
}

/** Register the service worker (call once on app load) */
export async function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('[SW] Registration failed:', err);
  }
}
