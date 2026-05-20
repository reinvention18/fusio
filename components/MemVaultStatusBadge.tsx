'use client';

/**
 * MemVaultStatusBadge — tiny status pills that make the claude-mem + Obsidian
 * integration observable at a glance: observation count for the current
 * session, and vault on/off.
 *
 * Used in the top-of-page header and on the ChatPanel / TeamsPanel headers.
 * Click → opens /memory-vault scoped to the current chat.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  chatId?: string;
  teamId?: string;
  compact?: boolean;
  onClick?: () => void;
}

interface MemInfo {
  sessionId: string | null;
  observationCount: number;
  pendingCount: number;
}

interface VaultInfo {
  enabled: boolean;
  path: string | null;
  exists: boolean;
}

export function MemVaultStatusBadge({ chatId, teamId, compact, onClick }: Props) {
  const [mem, setMem] = useState<MemInfo>({ sessionId: null, observationCount: 0, pendingCount: 0 });
  const [vault, setVault] = useState<VaultInfo>({ enabled: false, path: null, exists: false });
  const [pulse, setPulse] = useState(false);
  const lastCount = useRef(0);

  const refresh = useCallback(async () => {
    // Vault status
    try {
      const v = await fetch('/api/vault/config').then(r => r.json());
      setVault({
        enabled: !!v?.settings?.enabled,
        path: v?.settings?.path ?? null,
        exists: !!v?.exists,
      });
    } catch { /* ignore */ }

    // Mem status — only meaningful if we know the chat/team
    if (!chatId && !teamId) return;
    try {
      let sessionId: string | null = null;
      if (chatId) {
        const s = await fetch('/api/mem/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'chat', chat_id: chatId }),
        }).then(r => r.json());
        sessionId = s?.session?.id ?? null;
      } else if (teamId) {
        const s = await fetch('/api/mem/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'team_meta', team_id: teamId }),
        }).then(r => r.json());
        sessionId = s?.session?.id ?? null;
      }
      if (!sessionId) return;
      const t = await fetch(`/api/mem/timeline?session_id=${encodeURIComponent(sessionId)}&limit=100`)
        .then(r => r.json());
      const count = Array.isArray(t?.entries) ? t.entries.length : 0;
      setMem(m => ({ ...m, sessionId, observationCount: count }));
      if (count > lastCount.current) {
        lastCount.current = count;
        setPulse(true);
        setTimeout(() => setPulse(false), 1500);
      } else {
        lastCount.current = count;
      }
    } catch { /* ignore */ }
  }, [chatId, teamId]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  const go = () => {
    if (onClick) { onClick(); return; }
    const q = chatId ? `?chat=${encodeURIComponent(chatId)}` : '';
    window.open(`/memory-vault${q}`, '_blank');
  };

  const pillBase: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: compact ? '2px 7px' : '3px 9px',
    fontSize: compact ? 10 : 11,
    fontFamily: 'var(--font-mono, ui-monospace)',
    letterSpacing: '0.08em',
    borderRadius: 4,
    border: '1px solid var(--line, rgba(255,255,255,0.08))',
    cursor: 'pointer',
    transition: 'all 120ms ease-out',
  };

  return (
    <span className="memvault-status-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={go} title="Open Memory & Vault inspector">
      <span
        style={{
          ...pillBase,
          background: pulse ? 'rgba(76, 195, 138, 0.18)' : 'var(--ink-3, #1B1B23)',
          color: pulse ? 'var(--green, #4CC38A)' : 'var(--mist, rgba(255,255,255,0.5))',
          borderColor: pulse ? 'rgba(76, 195, 138, 0.5)' : 'var(--line, rgba(255,255,255,0.08))',
          boxShadow: pulse ? '0 0 8px rgba(76, 195, 138, 0.4)' : 'none',
        }}
        aria-label="Memory observations"
        onMouseEnter={e => { if (!pulse) (e.currentTarget as HTMLElement).style.borderColor = 'rgba(76, 195, 138, 0.4)'; }}
        onMouseLeave={e => { if (!pulse) (e.currentTarget as HTMLElement).style.borderColor = 'var(--line, rgba(255,255,255,0.08))'; }}
      >
        <span>🧠</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{mem.observationCount}</span>
      </span>
      <span
        style={{
          ...pillBase,
          background: vault.enabled && vault.exists ? 'rgba(76, 195, 138, 0.1)' : 'var(--ink-3, #1B1B23)',
          color: vault.enabled && vault.exists ? 'var(--green, #4CC38A)' : 'var(--mist, rgba(255,255,255,0.5))',
          borderColor: vault.enabled && vault.exists ? 'rgba(76, 195, 138, 0.35)' : 'var(--line, rgba(255,255,255,0.08))',
        }}
        aria-label="Vault status"
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(76, 195, 138, 0.4)'; }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLElement).style.borderColor = vault.enabled && vault.exists
            ? 'rgba(76, 195, 138, 0.35)'
            : 'var(--line, rgba(255,255,255,0.08))';
        }}
      >
        <span>📓</span>
        <span>{vault.enabled ? (vault.exists ? 'vault' : 'vault!') : 'off'}</span>
      </span>
    </span>
  );
}

export default MemVaultStatusBadge;
