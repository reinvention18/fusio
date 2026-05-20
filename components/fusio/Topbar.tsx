/**
 * Fusio topbar — 38 px chrome strip across the top of the shell grid.
 * Matches the design's TopBar from mc/app.jsx exactly: traffic-light dots
 * + "Fusio" blip on the left, breadcrumb + workspace path in the center,
 * Calls today / Connected / Clock UTC / Settings on the right.
 */

'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { I } from './Icons';

interface TopbarProps {
  connected?: boolean;
  /** Current active tab id — rendered as the breadcrumb segment. */
  tab?: string;
  /** Workspace path (full path, displayed in cyan in the center). */
  workspacePath?: string;
  onOpenSettings?: () => void;
  /** Optional slot rendered between the clock and the Settings button. */
  rightExtra?: ReactNode;
  /** Total agent / API calls today (number). Falls back to '—' if absent. */
  callsToday?: number;
}

function fmtNum(n?: number): string {
  if (n == null) return '—';
  return n.toLocaleString();
}

export function FusioTopbar({
  connected = false,
  tab,
  workspacePath,
  onOpenSettings,
  rightExtra,
  callsToday,
}: TopbarProps) {
  const [clock, setClock] = useState('');
  // 1 Hz clock for the topbar — matches the design's clock tick.
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setClock(
        `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const breadcrumb = (tab || '').replace(/-/g, ' ');

  return (
    <header className="topbar">
      <div className="topbar-left">
        {/* Traffic-light dots (close / min / max) removed — they mimic a
            macOS chrome that doesn't belong in a web app, and they were
            covering the mobile hamburger button. */}
        <span className="group">
          <span className="blip" />
          <span>Fusio</span>
        </span>
      </div>

      <div className="topbar-center">
        {breadcrumb && (
          <span className="group">
            <span style={{ color: 'var(--mist)' }}>/</span>
            <span className="v">{breadcrumb}</span>
          </span>
        )}
        {breadcrumb && workspacePath && <span className="sep" />}
        {workspacePath && (
          <span className="group" style={{ color: 'var(--cyan)' }}>
            {workspacePath}
          </span>
        )}
      </div>

      <div className="topbar-right">
        <span className="group" data-tb="calls">
          <span>Calls today</span>
          <span className="v">{fmtNum(callsToday)}</span>
        </span>
        <span className="sep" data-tb="sep" />
        <span className="group" data-tb="connected">
          <span className={connected ? 'blip' : 'red-blip'} />
          <span>{connected ? 'Connected' : 'Offline'}</span>
        </span>
        <span className="sep" data-tb="sep" />
        <span className="group" data-tb="clock">
          <span className="red-blip" />
          <span className="v">{clock} UTC</span>
        </span>
        {rightExtra && <span className="sep" data-tb="sep" />}
        {rightExtra}
        <span className="sep" data-tb="sep" />
        <button
          className="pill"
          data-tb="settings"
          onClick={onOpenSettings}
          style={{ background: 'transparent', cursor: 'pointer' }}
          title="Settings"
          aria-label="Settings"
        >
          {I.cog}
          <span>Settings</span>
        </button>
      </div>
    </header>
  );
}
