/**
 * ChatZoomController — invisible component that owns the chat-message
 * zoom level. Mounted once in app/page.tsx so the shortcut + listener
 * work across every chat surface.
 *
 * - Persists scale to localStorage `mc-chat-zoom` (defaults to 1.0)
 * - Sets CSS variable `--mc-chat-zoom` on document.documentElement so
 *   any selector scoped to the chat surface can scale via
 *   `font-size: calc(<base> * var(--mc-chat-zoom))`
 * - Keyboard shortcuts (works on any focus): Ctrl/Cmd + "+" or "=" to
 *   zoom in, Ctrl/Cmd + "-" to zoom out, Ctrl/Cmd + "0" to reset.
 * - Listens for `mc-chat-zoom` window events with detail
 *   `{ action: 'in' | 'out' | 'reset' | 'set', value?: number }` so
 *   the Tools menu (and any other button) can drive it without
 *   prop-drilling.
 */

'use client';

import { useEffect } from 'react';

const LS_KEY = 'mc-chat-zoom';
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
const STEP = 0.1;

function clamp(z: number): number {
  if (!isFinite(z)) return 1;
  // Pinch produces continuous values — round to 2 decimals so we don't
  // spam style updates. Keyboard/menu steps land on tenths naturally.
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
}

function apply(z: number): void {
  document.documentElement.style.setProperty('--mc-chat-zoom', String(z));
  try { localStorage.setItem(LS_KEY, String(z)); } catch { /* ignore */ }
}

function read(): number {
  if (typeof window === 'undefined') return 1;
  try { return clamp(parseFloat(localStorage.getItem(LS_KEY) || '1')); }
  catch { return 1; }
}

export function ChatZoomController() {
  useEffect(() => {
    apply(read());

    const adjust = (action: string, value?: number): number => {
      const current = read();
      const next =
        action === 'in'    ? clamp(current + STEP) :
        action === 'out'   ? clamp(current - STEP) :
        action === 'reset' ? 1 :
        action === 'set' && typeof value === 'number' ? clamp(value) :
        current;
      apply(next);
      return next;
    };

    const onEvent = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      adjust(d.action, d.value);
    };

    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Don't hijack browser-zoom inside inputs — common UX expects
      // Ctrl+/- to work everywhere on chat surfaces, but if the user
      // is typing in a textarea they likely want the browser default.
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (document.activeElement as HTMLElement)?.isContentEditable) {
        return;
      }
      if (e.key === '=' || e.key === '+') { e.preventDefault(); adjust('in'); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); adjust('out'); }
      else if (e.key === '0') { e.preventDefault(); adjust('reset'); }
    };

    /* ===== Pinch-to-zoom for mobile =====
       iOS PWA standalone mode disables native pinch-zoom regardless of
       the viewport meta. We implement it manually on the chat messages
       area: capture two-finger distance on touchstart, compute ratio on
       touchmove, apply via the same --mc-chat-zoom variable. */
    let pinchStartDist = 0;
    let pinchStartZoom = 1;
    let pinching = false;

    const fingerDist = (t: TouchList): number => {
      if (t.length < 2) return 0;
      const dx = t[0].clientX - t[1].clientX;
      const dy = t[0].clientY - t[1].clientY;
      return Math.hypot(dx, dy);
    };

    const isInsideChat = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      return !!target.closest('.fusio-main');
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      if (!isInsideChat(e.target)) return;
      pinchStartDist = fingerDist(e.touches);
      pinchStartZoom = read();
      pinching = pinchStartDist > 0;
      if (pinching) e.preventDefault();
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!pinching || e.touches.length !== 2) return;
      const dist = fingerDist(e.touches);
      if (!dist || !pinchStartDist) return;
      const ratio = dist / pinchStartDist;
      adjust('set', pinchStartZoom * ratio);
      e.preventDefault();
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (pinching && e.touches.length < 2) pinching = false;
    };

    /* ===== Trackpad pinch on desktop =====
       Browsers translate two-finger trackpad pinch into a `wheel` event
       with ctrlKey:true. Intercept that inside .fusio-main and apply
       to --mc-chat-zoom so desktop laptops can zoom without the keyboard
       or the Tools menu. */
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // only trap pinch (ctrlKey:true is the signal)
      if (!isInsideChat(e.target)) return;
      e.preventDefault();
      const current = read();
      // deltaY positive = pinch in (shrink). Invert + scale.
      const delta = -e.deltaY * 0.01;
      adjust('set', current + delta);
    };

    window.addEventListener('mc-chat-zoom', onEvent as EventListener);
    window.addEventListener('keydown', onKey);
    // touch-action: passive: false is required so preventDefault works
    // and the page doesn't try to native-zoom or scroll mid-pinch.
    document.addEventListener('touchstart', onTouchStart, { passive: false });
    document.addEventListener('touchmove',  onTouchMove,  { passive: false });
    document.addEventListener('touchend',   onTouchEnd);
    document.addEventListener('touchcancel', onTouchEnd);
    document.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      window.removeEventListener('mc-chat-zoom', onEvent as EventListener);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove',  onTouchMove);
      document.removeEventListener('touchend',   onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
      document.removeEventListener('wheel', onWheel);
    };
  }, []);

  return null;
}
