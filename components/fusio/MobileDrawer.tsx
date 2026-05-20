/**
 * Fusio mobile sidebar drawer — hamburger button on the topbar opens a
 * slide-in overlay containing <FusioSidebar>. Only mounts on viewports
 * below md (768 px). Closes on backdrop tap, escape, or after a tab
 * change.
 */

'use client';

import { useEffect } from 'react';
import { FusioSidebar, type Tab } from './Sidebar';
import { I } from './Icons';

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  workspace?: { name: string; path: string };
  onOpenSettings?: () => void;
}

export function FusioMobileDrawer({
  open, onClose, activeTab, onTabChange, workspace, onOpenSettings,
}: MobileDrawerProps) {
  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // Lock body scroll while open
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      className="fusio-mobile-drawer"
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.62)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="fusio-mobile-drawer-panel"
        style={{
          width: 'min(85vw, 320px)',
          height: '100%',
          animation: 'fusio-drawer-in 220ms cubic-bezier(.16,.84,.3,1)',
          boxShadow: '0 0 50px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--void, #050507)',
        }}
      >
        <FusioSidebar
          activeTab={activeTab}
          onTabChange={(t) => { onTabChange(t); onClose(); }}
          workspace={workspace}
          onOpenSettings={() => { onOpenSettings?.(); onClose(); }}
        />
      </div>
      <button
        onClick={onClose}
        title="Close menu"
        style={{
          alignSelf: 'flex-start',
          margin: 12,
          width: 36, height: 36,
          borderRadius: 8,
          background: 'rgba(0,0,0,0.4)',
          border: '1px solid rgba(255,255,255,0.12)',
          color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer',
        }}
      >
        {I.close}
      </button>
      <style jsx global>{`
        @keyframes fusio-drawer-in {
          from { transform: translateX(-100%); opacity: 0.5; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
