/**
 * Mobile-only slide-up overlay that surfaces the FusioSessions list.
 * On desktop the sessions column lives between sidebar and main, but
 * on mobile we hide it (no room). This drawer brings it back via a
 * "Chats" button in the chat header.
 */

'use client';

import { useEffect } from 'react';
import { FusioSessions } from './Sessions';
import { I } from './Icons';

interface MobileSessionsDrawerProps {
  open: boolean;
  onClose: () => void;
  namespace: 'default' | 'seo' | 'missions';
  title?: string;
}

export function FusioMobileSessionsDrawer({
  open, onClose, namespace, title,
}: MobileSessionsDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  // Auto-close when the user picks a session OR creates a new chat.
  // Both events fire from inside FusioSessions; closing on new-chat lets
  // the user see the empty ChatPanel ready for their first message.
  useEffect(() => {
    if (!open) return;
    const onCloseEvent = () => onClose();
    window.addEventListener('mc-chat-select', onCloseEvent);
    window.addEventListener('mc-chat-new', onCloseEvent);
    return () => {
      window.removeEventListener('mc-chat-select', onCloseEvent);
      window.removeEventListener('mc-chat-new', onCloseEvent);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      className="fusio-mobile-sessions-drawer"
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.62)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        flexDirection: 'row',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="fusio-mobile-sessions-panel"
        style={{
          width: 'min(90vw, 360px)',
          height: '100%',
          animation: 'fusio-drawer-in 220ms cubic-bezier(.16,.84,.3,1)',
          boxShadow: '0 0 50px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--void, #050507)',
          borderRight: '1px solid var(--line, rgba(255,255,255,0.08))',
        }}
      >
        <FusioSessions namespace={namespace} title={title || 'Conversations'} />
      </div>
      <button
        onClick={onClose}
        title="Close"
        aria-label="Close chats"
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
    </div>
  );
}
