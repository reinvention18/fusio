'use client';

import { useState } from 'react';
import {
  LayoutDashboard,
  MessageSquare,
  Wrench,
  Users,
  Bot,
  MoreHorizontal,
  X,
  History,
  ShieldCheck,
  Beaker,
  Activity,
  ScrollText,
  FolderOpen,
  Key,
  BookOpen,
  BarChart3,
  Lightbulb,
  FileText,
  Globe,
  Github,
  Zap,
  Brain,
  ClipboardList,
  Wifi,
  FileEdit,
  Notebook,
} from 'lucide-react';

type Tab =
  | 'dashboard'
  | 'dev'
  | 'chat'
  | 'seo-chat'
  | 'lukes-chat'
  | 'history'
  | 'qa'
  | 'workshop'
  | 'agents'
  | 'teams'
  | 'remote'
  | 'docs'
  | 'edit-activity'
  | 'innovation'
  | 'digest'
  | 'activity'
  | 'logs'
  | 'files'
  | 'skills'
  | 'credentials'
  | 'reports'
  | 'browser'
  | 'github'
  | 'memory-vault'
  | 'notepad';

interface MobileNavProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

const primaryTabs: { id: Tab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'notepad', label: 'Notepad', icon: Notebook },
  { id: 'docs', label: 'Docs', icon: ClipboardList },
  { id: 'remote', label: 'Remote', icon: Wifi },
];

const moreTabs: { id: Tab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Dash', icon: LayoutDashboard },
  { id: 'seo-chat', label: 'SEO', icon: FileText },
  { id: 'teams', label: 'Constel', icon: Users },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'innovation', label: 'Radar', icon: Lightbulb },
  { id: 'skills', label: 'Skills', icon: Zap },
  { id: 'history', label: 'History', icon: History },
  { id: 'qa', label: 'QA', icon: ShieldCheck },
  { id: 'workshop', label: 'Workshop', icon: Beaker },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'logs', label: 'Logs', icon: ScrollText },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'credentials', label: 'Vault', icon: Key },
  { id: 'memory-vault', label: 'Mem/Vault', icon: Brain },
  { id: 'digest', label: 'Digest', icon: FileText },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
  { id: 'browser', label: 'Browser', icon: Globe },
  { id: 'github', label: 'GitHub', icon: Github },
  { id: 'edit-activity', label: 'Edits', icon: FileEdit },
];

export default function MobileNav({ activeTab, onTabChange }: MobileNavProps) {
  const [showMore, setShowMore] = useState(false);

  const isMoreTabActive = moreTabs.some((t) => t.id === activeTab);

  const handleMoreTab = (tab: Tab) => {
    onTabChange(tab);
    setShowMore(false);
  };

  return (
    <>
      {/* More drawer overlay */}
      {showMore && (
        <div className="fixed inset-0 z-[60] md:hidden" onClick={() => setShowMore(false)}>
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

          {/* Drawer */}
          <div
            className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+60px)] left-0 right-0
                        bg-terminal-surface border-t border-x border-terminal-border rounded-t-2xl
                        max-h-[60vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-terminal-green text-xs font-bold tracking-wider">ALL PANELS</span>
                <button
                  onClick={() => setShowMore(false)}
                  className="p-1 text-terminal-dim hover:text-terminal-text"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {moreTabs.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => handleMoreTab(tab.id)}
                      className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl transition-all ${
                        isActive
                          ? 'bg-terminal-green/15 text-terminal-green'
                          : 'text-terminal-dim hover:text-terminal-text hover:bg-terminal-elevated'
                      }`}
                    >
                      <Icon className="w-5 h-5" />
                      <span className="text-[10px] font-medium">{tab.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bottom nav bar */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-50 md:hidden border-t border-terminal-border
                    bg-terminal-surface/95 backdrop-blur-md"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="flex items-stretch justify-around h-[60px]">
          {primaryTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => {
                  onTabChange(tab.id);
                  setShowMore(false);
                }}
                className={`flex flex-col items-center justify-center flex-1 gap-0.5 transition-colors ${
                  isActive
                    ? 'text-terminal-green'
                    : 'text-terminal-dim active:text-terminal-text'
                }`}
              >
                <Icon className={`w-5 h-5 ${isActive ? 'drop-shadow-[0_0_6px_var(--accent-primary)]' : ''}`} />
                <span className={`text-[10px] font-medium ${isActive ? 'text-terminal-green' : ''}`}>
                  {tab.label}
                </span>
                {isActive && (
                  <div className="absolute top-0 w-8 h-0.5 bg-terminal-green rounded-full" />
                )}
              </button>
            );
          })}

          {/* More button */}
          <button
            onClick={() => setShowMore(!showMore)}
            className={`flex flex-col items-center justify-center flex-1 gap-0.5 transition-colors relative ${
              isMoreTabActive || showMore
                ? 'text-terminal-green'
                : 'text-terminal-dim active:text-terminal-text'
            }`}
          >
            <MoreHorizontal
              className={`w-5 h-5 ${isMoreTabActive ? 'drop-shadow-[0_0_6px_var(--accent-primary)]' : ''}`}
            />
            <span className={`text-[10px] font-medium ${isMoreTabActive ? 'text-terminal-green' : ''}`}>
              More
            </span>
            {isMoreTabActive && (
              <div className="absolute top-0 w-8 h-0.5 bg-terminal-green rounded-full" />
            )}
          </button>
        </div>
      </nav>
    </>
  );
}
