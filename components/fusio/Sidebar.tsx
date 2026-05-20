/**
 * Fusio sidebar — uses the design's CSS class names directly so the static
 * /fusio/mc.css stylesheet provides the pixel-faithful styling. Component
 * just wires up state (active tab, collapsible sections, settings click)
 * against MC's tab system.
 */

'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { I } from './Icons';

export type Tab =
  | 'dashboard' | 'chat' | 'seo-chat' | 'lukes-chat' | 'teams'
  | 'docs' | 'notepad' | 'edit-activity' | 'remote'
  | 'dev' | 'workshop' | 'files' | 'browser' | 'github'
  | 'activity' | 'logs' | 'reports' | 'qa' | 'history' | 'digest'
  | 'memory-vault' | 'skills' | 'credentials' | 'agents' | 'innovation';

interface NavItem {
  id: Tab;
  ic: ReactNode;
  lbl: string;
  badge?: { txt: string; cls?: 'live' | 'red' | '' };
}

interface SidebarProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  onOpenSettings?: () => void;
  workspace?: { name: string; path: string };
  onNewChat?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

const PRIMARY: NavItem[] = [
  { id: 'dashboard',     ic: I.dash,    lbl: 'Dashboard' },
  { id: 'chat',          ic: I.chat,    lbl: 'Chat', badge: { txt: 'LIVE', cls: 'live' } },
  { id: 'seo-chat',      ic: I.seo,     lbl: 'SEO' },
  { id: 'lukes-chat',    ic: I.star,    lbl: "Luke's Chat" },
  { id: 'teams',         ic: I.layers,  lbl: 'Constellation' },
  { id: 'docs',          ic: I.docs,    lbl: 'Docs' },
  { id: 'notepad',       ic: I.notepad, lbl: 'Notepad' },
  { id: 'edit-activity', ic: I.edit,    lbl: 'Activity' },
  { id: 'remote',        ic: I.wifi,    lbl: 'Remote' },
];

const BUILD: NavItem[] = [
  { id: 'dev',      ic: I.terminal, lbl: 'Dev' },
  { id: 'workshop', ic: I.tools,    lbl: 'Workshop' },
  { id: 'files',    ic: I.folder,   lbl: 'Files' },
  { id: 'browser',  ic: I.globe,    lbl: 'Browser' },
  { id: 'github',   ic: I.github,   lbl: 'GitHub' },
];

const MONITOR: NavItem[] = [
  { id: 'activity', ic: I.activity, lbl: 'Activity Feed' },
  { id: 'logs',     ic: I.list,     lbl: 'Logs' },
  { id: 'reports',  ic: I.bug,      lbl: 'Reports' },
  { id: 'qa',       ic: I.shield,   lbl: 'QA' },
  { id: 'history',  ic: I.history,  lbl: 'History' },
  { id: 'digest',   ic: I.file,     lbl: 'Digest' },
];

const KNOWLEDGE: NavItem[] = [
  { id: 'memory-vault', ic: I.brain,     lbl: 'Memory & Vault' },
  { id: 'skills',       ic: I.zap,       lbl: 'Skills' },
  { id: 'credentials',  ic: I.key,       lbl: 'Credentials' },
  { id: 'agents',       ic: I.bot,       lbl: 'Agents' },
  { id: 'innovation',   ic: I.lightbulb, lbl: 'Radar' },
];

export function FusioSidebar({
  activeTab, onTabChange, onOpenSettings, workspace, onNewChat, onToggleCollapsed,
}: SidebarProps) {
  const [hidden, setHidden] = useState<Record<string, boolean>>({});

  const renderItem = (it: NavItem) => (
    <div
      key={it.id}
      className={'sidebar-item ' + (activeTab === it.id ? 'active' : '')}
      onClick={() => onTabChange(it.id)}
      role="button"
      tabIndex={0}
    >
      <span className="ic">{it.ic}</span>
      <span className="lbl">{it.lbl}</span>
      {it.badge && <span className={'badge ' + (it.badge.cls || '')}>{it.badge.txt}</span>}
    </div>
  );

  const renderSection = (title: string, items: NavItem[], sk: string) => {
    const isHidden = !!hidden[sk];
    return (
      <div className={'sidebar-section ' + (isHidden ? 'collapsed' : '')}>
        <div
          className="label"
          onClick={() => setHidden(s => ({ ...s, [sk]: !s[sk] }))}
        >
          <span className="lbl">{title}</span>
          <span className="chev">{I.chev}</span>
        </div>
        {!isHidden && <div className="sidebar-items">{items.map(renderItem)}</div>}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="logo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/fusio/logo.png" alt="Fusio" />
        </div>
        <button className="toggle" onClick={onToggleCollapsed} title="Toggle sidebar">
          {I.panelRight}
        </button>
      </div>

      <button
        className="sidebar-new"
        onClick={() => {
          onTabChange('chat');
          onNewChat?.();
          // Fallback: dispatch the same event ChatPanel listens for, so the
          // sidebar's New chat works even when no onNewChat prop is wired.
          // Defer the dispatch so ChatPanel has time to mount when switching
          // tabs from a non-chat surface (otherwise the listener doesn't
          // exist yet and the event is dropped).
          if (typeof window !== 'undefined') {
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent('mc-chat-new', { detail: { namespace: 'default' } }));
            }, 80);
          }
        }}
      >
        <span className="plus">{I.plus}</span>
        <span className="lbl">New chat</span>
        <span className="kbd">⌘N</span>
      </button>

      <div className="sidebar-scroll">
        <div className="sidebar-section">
          <div className="label"><span className="lbl">Workspaces</span></div>
          <div className="sidebar-items">{PRIMARY.map(renderItem)}</div>
        </div>
        {renderSection('Build', BUILD, 'build')}
        {renderSection('Monitor', MONITOR, 'monitor')}
        {renderSection('Knowledge', KNOWLEDGE, 'knowledge')}
      </div>

      <div className="sidebar-foot">
        <div
          className="row"
          onClick={onOpenSettings}
          role="button"
          tabIndex={0}
        >
          <span className="ws-ico">{I.folder}</span>
          <div className="ws">
            <span className="name">{workspace?.name || 'Set workspace'}</span>
            <span className="path">{workspace?.path || '—'}</span>
          </div>
          <span className="ic" style={{ color: 'var(--mist)' }}>{I.cog}</span>
        </div>
      </div>
    </aside>
  );
}
