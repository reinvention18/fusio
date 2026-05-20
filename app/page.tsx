'use client';

import { useEffect, useState } from 'react';
import { Settings, Wifi, WifiOff, Terminal, Folder, FolderOpen, Palette, Check } from 'lucide-react';
import { useTheme, themes, ThemeId } from '@/lib/useTheme';
import StatusPanel from '@/components/StatusPanel';
import Workshop from '@/components/Workshop';
import CronJobs from '@/components/CronJobs';
import SessionViewer from '@/components/SessionViewer';
import AgentHub from '@/components/AgentHub';
import PdfDigester from '@/components/PdfDigester';
import ActivityFeed from '@/components/ActivityFeed';
import CommandBar from '@/components/CommandBar';
import LogsViewer from '@/components/LogsViewer';
import MemoryViewer from '@/components/MemoryViewer';
import SkillsManager from '@/components/SkillsManager';
import NotificationsPanel from '@/components/NotificationsPanel';
import ChatHistory from '@/components/ChatHistory';
import UsageStats from '@/components/UsageStats';
import FileBrowser from '@/components/FileBrowser';
import dynamic from 'next/dynamic';
const CodeEditor = dynamic(() => import('@/components/CodeEditor'), { ssr: false });
const XTerminalPanel = dynamic(() => import('@/components/XTerminal'), { ssr: false });
import CronCalendar from '@/components/CronCalendar';
import Scratchpad from '@/components/Scratchpad';
import SystemHealth from '@/components/SystemHealth';
import QuickLinks from '@/components/QuickLinks';
import ChatPanel from '@/components/ChatPanel';
import MissionsDashboard from '@/components/MissionsDashboard';
import HistoryPanel from '@/components/HistoryPanel';
import QAPanel from '@/components/QAPanel';
import SkillsPanel from '@/components/SkillsPanel';
import CredentialsPanel from '@/components/CredentialsPanel';
import DeployDashboard from '@/components/DeployDashboard';
import GitPanel from '@/components/GitPanel';
import TestRunner from '@/components/TestRunner';
import ApiTester from '@/components/ApiTester';
import DatabaseExplorer from '@/components/DatabaseExplorer';
import EnvironmentBar from '@/components/EnvironmentBar';
import ErrorTracker from '@/components/ErrorTracker';
import CodeSnippets from '@/components/CodeSnippets';
import ReportsPanel from '@/components/ReportsPanel';
import TeamsPanel from '@/components/TeamsPanel';
import { NotificationToasts } from '@/components/notifications/NotificationToasts';
import InnovationRadar from '@/components/InnovationRadar';
import BrowserPanel from '@/components/BrowserPanel';
import GitHubPanel from '@/components/GitHubPanel';
import MobileNav from '@/components/MobileNav';
import { FusioSidebar, type Tab as FusioTab } from '@/components/fusio/Sidebar';
import { FusioTopbar } from '@/components/fusio/Topbar';
import { FusioSessions } from '@/components/fusio/Sessions';
import { FusioChatHeader } from '@/components/fusio/ChatHeader';
import { FusioComposer } from '@/components/fusio/Composer';
import { TerminalChat } from '@/components/fusio/TerminalChat';
import { FusioRightRail } from '@/components/fusio/RightRail';
import { FusioMobileDrawer } from '@/components/fusio/MobileDrawer';
import { FusioDashboard } from '@/components/fusio/Dashboard';
import { Menu } from 'lucide-react';
import { getGatewayConfig, saveGatewayConfig, GatewayConfig } from '@/lib/openclaw';
import MemoryVaultPanel from '@/components/MemoryVaultPanel';
import { SharedNotepad } from '@/components/SharedNotepad';
import MemVaultStatusBadge from '@/components/MemVaultStatusBadge';
import TopNavDropdown from '@/components/TopNavDropdown';
import RemotePanel from '@/components/RemotePanel';
import DocsPanel from '@/components/DocsPanel';
import ActivityPanel from '@/components/ActivityPanel';
import { IntegrationsSettings } from '@/components/fusio/IntegrationsSettings';
import { ChatZoomController } from '@/components/fusio/ChatZoomController';

type Tab = 'dashboard' | 'dev' | 'chat' | 'seo-chat' | 'lukes-chat' | 'history' | 'qa' | 'workshop' | 'agents' | 'teams' | 'innovation' | 'digest' | 'activity' | 'logs' | 'files' | 'skills' | 'credentials' | 'reports' | 'browser' | 'github' | 'memory-vault' | 'remote' | 'docs' | 'edit-activity' | 'notepad';

/** Theme swatch gradient — used by the Fusio settings modal's
 *  .theme-card .swatch. Each theme id maps to a gradient that hints at
 *  its actual palette so the user can pick without enabling. */
function themeSwatch(id: string): string {
  switch (id) {
    case 'terminal': return 'linear-gradient(135deg, #050507 0%, #1B1B23 50%, #CC0C20 100%)';
    case 'aurora':   return 'linear-gradient(135deg, #0f0f1a 0%, #1e1e32 50%, #a855f7 100%)';
    case 'ember':    return 'linear-gradient(135deg, #0d0907 0%, #211a16 50%, #f97316 100%)';
    case 'frost':    return 'linear-gradient(135deg, #e8f0f5 0%, #c0d4e0 100%)';
    default:         return 'linear-gradient(135deg, #050507 0%, #CC0C20 100%)';
  }
}

export default function MissionControl() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [config, setConfig] = useState<GatewayConfig>({ url: 'ws://localhost:18789', token: '' });
  const [settingsTab, setSettingsTab] = useState<'general' | 'integrations'>('general');
  const [currentTime, setCurrentTime] = useState<string>('');
  const [mounted, setMounted] = useState(false);
  /** Total agent + API calls today — feeds the Fusio topbar's "Calls today"
   *  group. Refreshes every 30s from /api/usage/today. */
  const [callsToday, setCallsToday] = useState<number | undefined>(undefined);
  /** Sidebar collapsed state — drives .shell.collapsed which the design CSS
   *  re-grids to a 72px icon-only sidebar. Persisted to localStorage so
   *  the user's choice survives reloads. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return localStorage.getItem('mc-sidebar-collapsed') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('mc-sidebar-collapsed', sidebarCollapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [sidebarCollapsed]);
  
  // Theme system
  const { theme, setTheme, mounted: themeMounted } = useTheme();

  // Embed mode: when ?embed=1 the whole shell collapses to ONLY the chat surface.
  // Used by the REMOTE tab (which iframes a peer MC) so the user sees just the
  // peer's chat, not its full MC chrome (nav, status, dashboards, etc.).
  // Lazy initializer reads URL synchronously on first client render — SSR returns
  // false (no window) which matches the static-build-friendly prerender path.
  const [embed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('embed') === '1';
  });

  // Read ?tab= from URL on mount (for PWA shortcuts + REMOTE iframe forcing chat)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab') as Tab | null;
    const validTabs: Tab[] = ['dashboard','dev','chat','seo-chat','lukes-chat','history','qa','workshop','agents','teams','innovation','digest','activity','logs','files','skills','credentials','reports','browser','github','docs','remote','edit-activity','notepad','memory-vault'];
    if (embed) {
      setActiveTab('chat');
    } else if (tab && validTabs.includes(tab)) {
      setActiveTab(tab);
    }
  }, [embed]);

  useEffect(() => {
    setMounted(true);

    // Load config - try localStorage first, then fetch from server
    const loadConfig = async () => {
      let savedConfig = getGatewayConfig();
      
      // If no token in localStorage, fetch from server
      if (!savedConfig.token) {
        try {
          const response = await fetch('/api/config');
          const serverConfig = await response.json();
          if (serverConfig.token) {
            savedConfig = { ...savedConfig, ...serverConfig };
            saveGatewayConfig(savedConfig); // Save to localStorage for next time
          }
        } catch (e) {
          console.error('Failed to fetch server config:', e);
        }
      }
      
      setConfig(savedConfig);
      return savedConfig;
    };
    
    // Check gateway connection via server-side API (works from any device).
    // We hit `/api/status` with a per-call cache-buster + cache:'no-store' so
    // the service worker / browser HTTP cache can never feed us a stale
    // response. Without this, an SW that captured a 308/error during a
    // server restart could pin connected=false until the SW is unregistered.
    const checkConnection = async (cfg: GatewayConfig) => {
      try {
        const gatewayUrl = (cfg.url || 'ws://localhost:18789')
          .replace('ws://', 'http://')
          .replace('wss://', 'https://');
        const url = `/api/status?gateway=${encodeURIComponent(gatewayUrl)}&_=${Date.now()}`;
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) {
          setConnected(false);
          return;
        }
        const data = await response.json();
        setConnected(!!data.connected);
      } catch {
        setConnected(false);
      }
    };
    
    loadConfig().then(cfg => {
      checkConnection(cfg);
    });
    
    const connectionInterval = setInterval(() => {
      const cfg = getGatewayConfig();
      checkConnection(cfg);
    }, 10000);
    
    // Update time every second (client-side only)
    setCurrentTime(new Date().toLocaleTimeString());
    const timeInterval = setInterval(() => {
      setCurrentTime(new Date().toLocaleTimeString());
    }, 1000);

    // Poll today's call count for the topbar "Calls today" group.
    // /api/usage/today returns the rolling 24h count; falls back gracefully
    // if the endpoint doesn't exist on this machine.
    const fetchCalls = () => {
      fetch('/api/usage/today', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (j && typeof j.count === 'number') setCallsToday(j.count);
          else if (j && typeof j.total === 'number') setCallsToday(j.total);
        })
        .catch(() => { /* endpoint may not exist on every host — silent fail */ });
    };
    fetchCalls();
    const callsInterval = setInterval(fetchCalls, 30000);

    // Listen for cross-component navigation events (e.g., ChatPanel → Constellation tab)
    const handleNavEvent = (e: Event) => {
      const tab = (e as CustomEvent).detail?.tab;
      if (tab) setActiveTab(tab as Tab);
    };
    window.addEventListener('mc-navigate', handleNavEvent);

    // Open Settings modal — fired by the chat-header Tools menu's
    // Settings entry so user doesn't have to hunt for the gear icon.
    const handleOpenSettings = () => setShowSettings(true);
    window.addEventListener('mc-open-settings', handleOpenSettings);

    return () => {
      clearInterval(connectionInterval);
      clearInterval(timeInterval);
      clearInterval(callsInterval);
      window.removeEventListener('mc-navigate', handleNavEvent);
      window.removeEventListener('mc-open-settings', handleOpenSettings);
    };
  }, []);

  const handleSaveConfig = () => {
    saveGatewayConfig(config);
    setShowSettings(false);
    setConnected(false);
    setTimeout(() => setConnected(true), 1000);
  };

  // Top nav: three primary tabs are flat; the remaining 16 go into three
  // category dropdowns so the bar doesn't need horizontal scrolling.
  const primaryTabs = [
    { id: 'dashboard' as Tab, label: 'DASHBOARD' },
    { id: 'chat' as Tab, label: 'CHAT' },
    { id: 'seo-chat' as Tab, label: '📝 SEO' },
    { id: 'lukes-chat' as Tab, label: "🛰️ LUKE'S CHAT" },
    { id: 'teams' as Tab, label: '✦ CONSTELLATION' },
    { id: 'docs' as Tab, label: '📋 DOCS' },
    { id: 'notepad' as Tab, label: '📓 NOTEPAD' },
    { id: 'edit-activity' as Tab, label: '📝 ACTIVITY' },
    { id: 'remote' as Tab, label: '🛰 REMOTE' },
  ];
  const buildMenu = [
    { id: 'dev', label: '🔧 Dev' },
    { id: 'workshop', label: 'Workshop' },
    { id: 'files', label: 'Files' },
    { id: 'browser', label: '🌐 Browser' },
    { id: 'github', label: '🐙 GitHub' },
  ];
  const monitorMenu = [
    { id: 'activity', label: 'Activity' },
    { id: 'logs', label: 'Logs' },
    { id: 'reports', label: '🐛 Reports' },
    { id: 'qa', label: 'QA' },
    { id: 'history', label: 'History' },
    { id: 'digest', label: 'Digest' },
  ];
  const knowledgeMenu = [
    { id: 'memory-vault', label: '🧠 Memory & Vault' },
    { id: 'skills', label: 'Skills' },
    { id: 'credentials', label: '🔐 Credentials' },
    { id: 'agents', label: 'Agents' },
    { id: 'innovation', label: '💡 Radar' },
  ];
  // For mobile nav label lookup
  const tabs = [
    ...primaryTabs,
    ...buildMenu.map(i => ({ id: i.id as Tab, label: i.label.toUpperCase() })),
    ...monitorMenu.map(i => ({ id: i.id as Tab, label: i.label.toUpperCase() })),
    ...knowledgeMenu.map(i => ({ id: i.id as Tab, label: i.label.toUpperCase() })),
  ];

  // Embed mode: drop everything except the chat panel itself.
  // Same component, same styles — just no header / nav / footer / status.
  // Used by the REMOTE tab to iframe a peer's MC and show only its chat.
  if (embed) {
    return (
      <div className="h-screen bg-terminal-bg text-terminal-text font-mono overflow-hidden">
        <ChatPanel />
        <NotificationToasts />
      </div>
    );
  }

  const wsName = config.workspace ? (config.workspace.split(/[/\\]/).pop() || 'workspace') : 'Set workspace';
  const wsPath = config.workspace || '—';
  const modelHint = ''; // populated by chat tab if needed in later phases

  return (
    <>
    {/* Fusio shell — design grid via /fusio/mc.css (static asset).
        Columns: sidebar | sessions(auto-collapses) | main | right-rail.
        For non-chat tabs we use `.no-sessions` so the main column gets
        the freed-up space. */}
    <div
      className={[
        'shell',
        (activeTab === 'chat' || activeTab === 'seo-chat' || activeTab === 'lukes-chat') ? '' : 'no-sessions',
        sidebarCollapsed ? 'collapsed' : '',
      ].filter(Boolean).join(' ')}
    >
      {/* Topbar spans all columns */}
      <FusioTopbar
        connected={connected}
        tab={activeTab}
        workspacePath={config.workspace || undefined}
        onOpenSettings={() => setShowSettings(true)}
        callsToday={callsToday}
        rightExtra={<MemVaultStatusBadge onClick={() => setActiveTab('memory-vault')} />}
      />

      {/* Left sidebar — rendered as a direct .shell child so it participates
          in the design's grid layout at column 1. Mobile responsive handling
          is done inside the sidebar itself (slides off-screen at narrow
          widths via the `.shell.mobile-hidden-sidebar` modifier in
          globals.css), with the hamburger button toggling visibility. */}
      <FusioSidebar
        activeTab={activeTab as FusioTab}
        onTabChange={(t) => setActiveTab(t as Tab)}
        workspace={{ name: wsName, path: wsPath }}
        onOpenSettings={() => setShowSettings(true)}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed(c => !c)}
      />

      {/* Mobile hamburger — floats over the topbar on mobile only. */}
      <button
        onClick={() => setMobileDrawerOpen(true)}
        className="md:hidden"
        title="Menu"
        aria-label="Open menu"
        style={{
          position: 'fixed',
          top: 'calc(env(safe-area-inset-top, 0px) + 4px)',
          left: 'calc(env(safe-area-inset-left, 0px) + 6px)',
          zIndex: 150,
          width: 36, height: 32, padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', color: 'rgba(255,255,255,0.85)',
          border: 0, cursor: 'pointer',
        }}
      >
        <Menu className="w-4 h-4" />
      </button>

      <FusioMobileDrawer
        open={mobileDrawerOpen}
        onClose={() => setMobileDrawerOpen(false)}
        activeTab={activeTab as FusioTab}
        onTabChange={(t) => setActiveTab(t as Tab)}
        workspace={{ name: wsName, path: wsPath }}
        onOpenSettings={() => setShowSettings(true)}
      />

      {/* Sessions column — only on chat tabs. Goes in `.shell`'s column 2;
          main column then sits at column 3. */}
      {(activeTab === 'chat' || activeTab === 'seo-chat' || activeTab === 'lukes-chat') && (
        <FusioSessions
          namespace={activeTab === 'seo-chat' ? 'seo' : activeTab === 'lukes-chat' ? 'missions' : 'default'}
          title={activeTab === 'seo-chat' ? 'SEO chats' : activeTab === 'lukes-chat' ? "Luke's chats" : 'Conversations'}
        />
      )}

      {/* Right rail — only on chat tabs. Tasks / Notepad / Agents tabs. */}
      {(activeTab === 'chat' || activeTab === 'seo-chat' || activeTab === 'lukes-chat') && (
        <FusioRightRail open initialMode="tasks" />
      )}

      {/* Main column. The design's `.main` CSS (from /fusio/mc.css) handles
          grid placement automatically — column 3 with sessions, column 2 in
          .shell.no-sessions, plus flex-column + overflow:hidden. We add
          `fusio-main` as a sibling class so the Phase 22 polish layer keeps
          scoping its overrides correctly. Inner-scroll is owned by panel
          content (.dash uses flex:1 + overflow-y:auto, etc.). */}
      <main className="main fusio-main">
        {activeTab === 'dashboard' && (
          <FusioDashboard connected={connected} />
        )}

        {activeTab === 'dev' && (
          <div className="fusio-scroll-pad space-y-4">
            <EnvironmentBar />
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              <div className="lg:col-span-4 space-y-4">
                <DeployDashboard />
                <GitPanel />
              </div>
              <div className="lg:col-span-4 space-y-4">
                <TestRunner />
                <ApiTester />
              </div>
              <div className="lg:col-span-4 space-y-4">
                <ErrorTracker />
                <DatabaseExplorer />
                <CodeSnippets />
              </div>
            </div>
            <div className="h-[400px]">
              <XTerminalPanel />
            </div>
          </div>
        )}

        {activeTab === 'chat' && (
          <div className="h-full flex flex-col" style={{ background: 'var(--black)' }}>
            <FusioChatHeader namespace="mc" />
            <div className="flex-1 min-h-0 overflow-hidden">
              <ChatPanel hideSessionsSidebar hideChatHeader hideComposer />
            </div>
            <FusioComposer namespace="mc" />
            {/* Terminal-look overlay — only visible when fullscreen mode is
                on (body[data-mc-fullscreen-chat="1"]). Renders ITS OWN
                message stream and input; the regular ChatPanel above is
                hidden via CSS but kept mounted so mc-chat-send / SDK
                sessions still work. */}
            <TerminalChat namespace="mc" />
          </div>
        )}

        {activeTab === 'seo-chat' && (
          <div className="h-full flex flex-col" style={{ background: 'var(--black)' }}>
            <FusioChatHeader namespace="seo" fallbackTitle="SEO" />
            <div className="flex-1 min-h-0 overflow-hidden">
              <ChatPanel
                namespace="seo"
                lockedWorkspace="~/<your-seo-workspace>"
                panelTitle="SEO"
                hideConstellationUi
                hideSessionsSidebar
                hideChatHeader
                hideComposer
              />
            </div>
            <FusioComposer namespace="seo" />
            <TerminalChat namespace="seo" />
          </div>
        )}

        {activeTab === 'lukes-chat' && (
          <div className="h-full flex flex-col" style={{ background: 'var(--black)' }}>
            <FusioChatHeader namespace="missions" fallbackTitle="Luke's Chat" />
            <MissionsDashboard />
            <div className="flex-1 min-h-0 overflow-hidden">
              <ChatPanel
                namespace="missions"
                panelTitle="Luke's Chat"
                hideConstellationUi
                hideSessionsSidebar
                hideChatHeader
                hideComposer
              />
            </div>
            <TerminalChat namespace="missions" />
            {/* (composer rendered right below — wrapped by data-mc-fullscreen
                CSS that hides .composer-wrap globally in fullscreen mode) */}
            <FusioComposer namespace="missions" />
          </div>
        )}

        {activeTab === 'skills' && (
          <div className="fusio-scroll-pad" style={{ maxWidth: 1024, margin: '0 auto', width: '100%' }}>
            <SkillsPanel />
          </div>
        )}

        {activeTab === 'memory-vault' && (
          <div className="fusio-scroll-pad fusio-panel" style={{ maxWidth: 1024, margin: '0 auto', width: '100%' }}>
            <MemoryVaultPanel />
          </div>
        )}

        {activeTab === 'credentials' && (
          <div className="fusio-scroll-pad" style={{ maxWidth: 1280, margin: '0 auto', width: '100%' }}>
            <CredentialsPanel />
          </div>
        )}

        {activeTab === 'history' && (
          <div className="fusio-scroll-pad" style={{ maxWidth: 1440, margin: '0 auto', width: '100%' }}>
            <HistoryPanel />
          </div>
        )}

        {activeTab === 'qa' && (
          <div className="fusio-scroll-pad" style={{ maxWidth: 1440, margin: '0 auto', width: '100%' }}>
            <QAPanel />
          </div>
        )}

        {activeTab === 'workshop' && (
          <div className="fusio-scroll-pad">
            <Workshop />
          </div>
        )}

        {activeTab === 'activity' && (
          <div className="fusio-scroll-pad" style={{ maxWidth: 1024, margin: '0 auto', width: '100%' }}>
            <ActivityFeed />
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="fusio-scroll-pad">
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3 md:gap-4">
              <div className="md:col-span-9">
                <LogsViewer />
              </div>
              <div className="md:col-span-3 space-y-3 md:space-y-4 hidden md:block">
                <MemoryViewer />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'files' && (
          <div className="fusio-scroll-pad">
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3 md:gap-4">
              <div className="md:col-span-4">
                <FileBrowser onFileOpen={(path: string) => setOpenFilePath(path)} />
              </div>
              <div className="md:col-span-8 space-y-3 md:space-y-4">
                {openFilePath ? (
                  <div className="h-[600px]">
                    <CodeEditor filePath={openFilePath} onClose={() => setOpenFilePath(null)} />
                  </div>
                ) : (
                  <>
                    <MemoryViewer />
                    <div className="hidden md:block">
                      <Scratchpad />
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'agents' && (
          <div className="fusio-scroll-pad">
            <AgentHub />
          </div>
        )}

        {activeTab === 'teams' && (
          <div className="fusio-scroll-pad">
            <TeamsPanel />
          </div>
        )}

        {activeTab === 'innovation' && (
          <div className="fusio-scroll-pad">
            <InnovationRadar />
          </div>
        )}

        {activeTab === 'digest' && (
          <div className="fusio-scroll-pad" style={{ maxWidth: 768, margin: '0 auto', width: '100%' }}>
            <PdfDigester />
          </div>
        )}

        {activeTab === 'browser' && (
          <div className="fusio-scroll-pad" style={{ maxWidth: 1280, margin: '0 auto', width: '100%' }}>
            <BrowserPanel />
          </div>
        )}

        {activeTab === 'reports' && (
          <div className="fusio-scroll-pad" style={{ maxWidth: 1440, margin: '0 auto', width: '100%' }}>
            <ReportsPanel />
          </div>
        )}

        {activeTab === 'github' && (
          <div className="fusio-scroll-pad" style={{ maxWidth: 1280, margin: '0 auto', width: '100%' }}>
            <GitHubPanel onAttachRepo={(repo) => {
              window.dispatchEvent(new CustomEvent('mc-attach-github', { detail: repo }));
              setActiveTab('chat');
            }} />
          </div>
        )}

        {activeTab === 'remote' && (
          <div className="fusio-scroll-pad">
            <RemotePanel />
          </div>
        )}

        {activeTab === 'docs' && (
          <div className="fusio-scroll-pad">
            <DocsPanel />
          </div>
        )}

        {activeTab === 'notepad' && (
          <div className="fusio-scroll-pad fusio-panel" style={{ maxWidth: 1024, margin: '0 auto', width: '100%' }}>
            <SharedNotepad padId="default" title="Shared Notepad — realtime across Linux, PC, mobile" />
          </div>
        )}

        {activeTab === 'edit-activity' && (
          <div className="fusio-scroll-pad">
            <ActivityPanel />
          </div>
        )}
      </main>
    </div>{/* /shell */}

      {/* App-wide notification toasts (constellation events) */}
      <NotificationToasts />
      {/* Owns chat-message zoom (Ctrl/Cmd +/-/0 + mc-chat-zoom events). */}
      <ChatZoomController />
      {/* Removed in Phase 60:
          - <MobileNav> (replaced by FusioMobileDrawer + hamburger in Phase 56)
          - <footer fixed bottom-0> (design has no footer; topbar already
            shows connection + workspace info via its right-side groups). */}

      {/* Settings Modal — uses the design's .modal-bg / .modal / .modal-head
          / .modal-body / .modal-section / .modal-input / .theme-grid /
          .theme-card / .modal-foot classes from /fusio/mc.css (Phase 59). */}
      {showSettings && (
        <div
          className="modal-bg"
          onClick={(e) => {
            const t = e.target as HTMLElement;
            if (t.classList && t.classList.contains('modal-bg')) setShowSettings(false);
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2><em>Settings</em></h2>
              <button
                className="close"
                onClick={() => setShowSettings(false)}
                title="Close"
                type="button"
              >
                ✕
              </button>
            </div>

            {/* Settings sub-tabs: General (workspace/theme/gateway) vs
                Integrations (API keys, subscriptions, services). */}
            <div style={{
              display: 'flex', gap: 4, padding: '0 20px',
              borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
            }}>
              {([['general', 'General'], ['integrations', 'Integrations · API keys']] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSettingsTab(id)}
                  style={{
                    padding: '10px 14px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: '2px solid ' + (settingsTab === id ? 'var(--red, #CC0C20)' : 'transparent'),
                    color: settingsTab === id ? 'var(--white)' : 'var(--mist)',
                    fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.16em', textTransform: 'uppercase',
                    cursor: 'pointer',
                    marginBottom: -1,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="modal-body" style={{ display: settingsTab === 'integrations' ? 'none' : undefined }}>
              {/* Active workspace */}
              <div className="modal-section">
                <div className="stitle">Active workspace</div>
                <div className="modal-input">
                  <input
                    type="text"
                    value={config.workspace || ''}
                    onChange={(e) => setConfig({ ...config, workspace: e.target.value })}
                    placeholder="/home/user/projects/myapp"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      if ('showDirectoryPicker' in window) {
                        try {
                          const dirHandle = await (window as any).showDirectoryPicker();
                          alert(`Selected: ${dirHandle.name}\n\nNote: For full path support, please type the complete path manually.`);
                        } catch { /* user cancelled */ }
                      } else {
                        alert('Folder picker not supported in this browser. Please type the path manually.');
                      }
                    }}
                    title="Browse for folder"
                  >
                    <FolderOpen className="w-4 h-4" /> Browse
                  </button>
                </div>
                {config.workspace && (
                  <div className="modal-confirm">Working in: {config.workspace}</div>
                )}
              </div>

              {/* Theme */}
              <div className="modal-section">
                <div className="stitle">Theme</div>
                <div className="theme-grid">
                  {themes.map((t) => (
                    <div
                      key={t.id}
                      className={'theme-card ' + (theme === t.id ? 'active' : '')}
                      onClick={() => setTheme(t.id)}
                      role="button"
                      tabIndex={0}
                    >
                      <div
                        className="swatch"
                        style={{ background: themeSwatch(t.id) }}
                      />
                      <div className="name">{t.name}</div>
                      <div className="desc">{t.description}</div>
                      {theme === t.id && (
                        <div className="check"><Check className="w-3 h-3" /></div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Gateway */}
              <div className="modal-section">
                <div className="stitle">Gateway connection</div>
                <div className="modal-input">
                  <input
                    type="text"
                    value={config.url}
                    onChange={(e) => setConfig({ ...config, url: e.target.value })}
                    placeholder="ws://localhost:18789"
                  />
                </div>
                <div className="modal-input" style={{ marginTop: 8 }}>
                  <input
                    type="password"
                    value={config.token}
                    onChange={(e) => setConfig({ ...config, token: e.target.value })}
                    placeholder="Auth token"
                  />
                </div>
              </div>
            </div>

            {/* Integrations tab body — only mounted when active so the
                /api/integrations fetch doesn't run on every modal open. */}
            {settingsTab === 'integrations' && (
              <div className="modal-body">
                <IntegrationsSettings />
              </div>
            )}

            {/* Modal footer only shows for the General tab; integrations
                has its own sticky save button inside the panel. */}
            {settingsTab === 'general' && (
              <div className="modal-foot">
                <button className="cancel" onClick={() => setShowSettings(false)} type="button">Cancel</button>
                <button className="save" onClick={handleSaveConfig} type="button">Save settings</button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
