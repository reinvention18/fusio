'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { generateId } from '../lib/generateId';

// Stable per-browser identifier. Persisted in localStorage so that a page
// reload keeps the same id — the broadcast layer uses this to avoid
// echoing the initiator's own stream back to itself.
function getClientId(): string {
  if (typeof window === 'undefined') return 'ssr';
  try {
    let id = localStorage.getItem('mc-client-id');
    if (!id) {
      id = 'c-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem('mc-client-id', id);
    }
    return id;
  } catch { return 'anon'; }
}
import { useTheme, type DensityId } from '../lib/useTheme';
import { useChatSession } from '../lib/use-chat-session';
import { MessageSquare, Send, Loader2, User, Bot, Paperclip, X, FileText, Wifi, Plus, Trash2, Edit2, Check, FolderOpen, ChevronDown, ChevronRight, Home, HardDrive, Search, ArrowLeft, FolderCheck, History, RefreshCw, Link2, Unlink, ChevronUp, Copy, RotateCcw, Quote, MoreHorizontal, Pencil, Bug, Sparkles, StickyNote, AlertTriangle, CheckCircle, Globe, Maximize2, Minimize2, Users, Zap, Terminal, Play, Square, Radio, Image as ImageIcon, Grid, Download, Eye, Archive, Bell, Key, Trash, Settings, Brain, GitBranch, Wand2, Notebook } from 'lucide-react';
import { SharedNotepad } from './SharedNotepad';
import TaskPanel, { parseTaskItems, extractFilePath, ActiveTask, TaskItem } from './TaskPanel';
import { MessageBubble } from './chat/MessageBubble';
import { SessionStatusBar } from './chat/SessionStatusBar';
import { ActivityStrip } from './chat/ActivityStrip';
import { ThreadSearch } from './chat/ThreadSearch';
import { DateScrubber } from './chat/DateScrubber';
import { ToolCitations } from './chat/ToolCitations';
import { ShortcutOverlay } from './chat/ShortcutOverlay';
import { OnboardingStrip } from './chat/OnboardingStrip';
import { ApprovalModal, type ApprovalRequest } from './chat/ApprovalModal';
import CrossChatPullModal from './CrossChatPullModal';
import CodexChatModal from './CodexChatModal';
import { ThreadArea } from './chat/ThreadArea';
import { HeaderToolsMenu } from './chat/HeaderToolsMenu';
import { extractKeyFacts, formatKeyFactsForContext } from '../lib/key-facts';
import SubAgentTracker, { SubAgent } from './SubAgentTracker';
import { MemoryPanel } from './mem/MemoryPanel';
import MemVaultStatusBadge from './MemVaultStatusBadge';
import { RunningLobster } from './chat/RunningLobster';
import { MessageContent } from './chat/MessageContent';
import { MemoryStatsPill } from './chat/MemoryStatsPill';
import PairModeChip, { type PairMode } from './PairModeChip';
import PlanCard, { type PlanCardData } from './PlanCard';
import CodexQuestionCard from './CodexQuestionCard';
import PhaseStuckCard from './PhaseStuckCard';

/** Strip a [[PLANCARD:b64]] marker out of a text segment and return both the
 *  plain text (without the marker) and the parsed card if present. Used at
 *  pair-mode finalize time to attach the card to the right voice block. */
function extractPlanCardFromText(text: string): { content: string; planCard: PlanCardData | null } {
  const m = text.match(/\[\[PLANCARD:([A-Za-z0-9+/=]+)\]\]/);
  if (!m) return { content: text, planCard: null };
  let card: PlanCardData | null = null;
  try {
    const json = decodeURIComponent(escape(atob(m[1])));
    const parsed = JSON.parse(json);
    card = {
      goal: parsed.goal || '',
      approach: parsed.approach || '',
      claude_points: Array.isArray(parsed.claude_points) ? parsed.claude_points : [],
      codex_points: Array.isArray(parsed.codex_points) ? parsed.codex_points : [],
      resolution: parsed.resolution || '',
      open_questions: Array.isArray(parsed.open_questions) ? parsed.open_questions : [],
      signed_off: parsed.signed_off || { claude: true, codex: false },
      protocol: parsed.protocol || 'debate',
      phases: Array.isArray(parsed.phases) ? parsed.phases : undefined,
      rework_cap: typeof parsed.rework_cap === 'number' ? parsed.rework_cap : undefined,
    };
  } catch { /* ignore */ }
  return { content: text.replace(m[0], '').trim(), planCard: card };
}

/** Extract autopilot lifecycle / question / finish events from text. Each
 *  marker carries a base64-encoded JSON event payload. Returns the cleaned
 *  text and the parsed events (in order they appeared). */
function extractAutopilotEvents(text: string): {
  content: string;
  phaseEvents: any[];
  codexQuestion: any | null;
  phaseStuck: any | null;
  autopilotFinish: any | null;
} {
  const phaseEvents: any[] = [];
  let codexQuestion: any | null = null;
  let phaseStuck: any | null = null;
  let autopilotFinish: any | null = null;
  let cleaned = text;
  const decode = (b64: string): any => {
    try { return JSON.parse(decodeURIComponent(escape(atob(b64)))); } catch { return null; }
  };
  cleaned = cleaned.replace(/\[\[AUTOPHASE:([A-Za-z0-9+/=]+)\]\]/g, (_, b64) => {
    const obj = decode(b64);
    if (obj) {
      phaseEvents.push(obj);
      // The stuck event carries resume hints — pull it out so the UI can
      // render a dedicated Retry/Skip card without scanning event arrays.
      if (obj.status === 'stuck') phaseStuck = obj;
    }
    return '';
  });
  cleaned = cleaned.replace(/\[\[CODEXQ:([A-Za-z0-9+/=]+)\]\]/g, (_, b64) => {
    const obj = decode(b64); if (obj) codexQuestion = obj; return '';
  });
  cleaned = cleaned.replace(/\[\[AUTOFIN:([A-Za-z0-9+/=]+)\]\]/g, (_, b64) => {
    const obj = decode(b64); if (obj) autopilotFinish = obj; return '';
  });
  return { content: cleaned.trim(), phaseEvents, codexQuestion, phaseStuck, autopilotFinish };
}

/** Strip all pair/autopilot marker tokens from text — used for the live
 *  streaming preview so the user doesn't see raw marker blobs. */
function stripPairMarkers(text: string): string {
  return text
    .replace(/\[\[VOICE:[^\]]+\]\]/g, '')
    .replace(/\[\[PLANCARD:[A-Za-z0-9+/=]+\]\]/g, '')
    .replace(/\[\[AUTOPHASE:[A-Za-z0-9+/=]+\]\]/g, '')
    .replace(/\[\[CODEXQ:[A-Za-z0-9+/=]+\]\]/g, '')
    .replace(/\[\[AUTOFIN:[A-Za-z0-9+/=]+\]\]/g, '');
}
import { MentionDropdown } from './chat/MentionDropdown';
import { DocAttachDropdown } from './chat/DocAttachDropdown';
import { PullLatestButton } from './chat/PullLatestButton';

// RunningLobster, MessageContent, MemoryStatsPill, MentionDropdown extracted to ./chat/*.tsx

interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  url: string;
  assetPath?: string; // If saved to project assets
}

interface ProjectAsset {
  id: string;
  name: string;
  filename: string;
  type: string;
  size: number;
  path: string;
  project: string;
  uploadedAt: string;
  url: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  pending?: boolean;
  attachments?: Attachment[];
  sentiment?: 'up' | 'down';
  pinned?: boolean;
  resolved?: boolean;
  /** Pair-mode: which voice authored this message ('claude' | 'codex' | 'orchestrator').
   *  Undefined for legacy messages and solo turns; treated as 'claude' for assistant. */
  voice?: 'claude' | 'codex' | 'orchestrator';
  /** Pair-mode: synthesized plan card (rendered inline). Only assistant role. */
  planCard?: import('./PlanCard').PlanCardData;
  /** Pair-mode: whether this card has been approved/locked. */
  planCardLocked?: boolean;
  /** Pair-mode: phase label for sub-organization within a turn. */
  pairPhase?: string;
  /** Autopilot: phase lifecycle events accumulated in this voice block. */
  autopilotEvents?: any[];
  /** Autopilot: a Codex question paused on this block, with answer textbox. */
  codexQuestion?: { index: number; question: string; audit_summary?: string; resume_attempt?: number; audit_history?: string[] } | null;
  /** Autopilot: whether the codex question has been answered (lock the card). */
  codexQuestionAnswered?: boolean;
  /** Autopilot: phase-stuck event with resume hints (cap bump / skip). */
  phaseStuck?: { index: number; name: string; total: number; attempts_used: number; rework_cap: number; resume_attempt: number; audit_history: string[]; last_concerns: string[] } | null;
  /** Autopilot: whether the stuck card has been resolved (lock UI). */
  phaseStuckResolved?: boolean;
  /** Autopilot: completion banner. */
  autopilotFinish?: { summary: string } | null;
}

interface KeyFact {
  id: string;
  category: 'credential' | 'url' | 'person' | 'config' | 'decision' | 'reference';
  label: string;
  value: string;
  source: 'auto' | 'manual';
  extractedAt: number;
}

interface AttachedDocRef {
  /** 'local' or peer host id */
  host: string;
  /** doc id on that host */
  id: string;
  /** title — for display only */
  title: string;
  /** type — 'note' or 'plan' */
  type: 'note' | 'plan';
}

interface ChatSession {
  id: string;
  name: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  workspace?: string;
  sessionKey?: string;
  contextSnapshot?: string;
  contextSnapshotAt?: number;
  keyFacts?: KeyFact[];
  githubRepo?: { name: string; fullName: string; url: string; defaultBranch: string }; // Attached GitHub repo
  /** Notes/plans attached to this chat — content is prepended to each user message
   *  while the chat has them attached. Mirrors the linkedSession pattern. */
  attachedDocs?: AttachedDocRef[];
  /** Pair-mode setting per chat. Default 'solo'. Switchable mid-conversation. */
  pairMode?: 'solo' | 'consult' | 'debate' | 'pair-build' | 'autopilot';
}


export interface ChatPanelProps {
  /** 'mc' = regular mission-control chat; 'seo' = SEO Machine chat;
   *  'missions' = Luke's Chat (missions architecture surface). Default 'mc'. */
  namespace?: 'mc' | 'seo' | 'missions';
  /** If set, locks the chat's workspace to this path and hides the workspace picker. */
  lockedWorkspace?: string;
  /** Header label (falls back to active session name, else "CHAT"). */
  panelTitle?: string;
  /** Hide the Deploy Constellation / team-link UI (forced off for non-'mc'). */
  hideConstellationUi?: boolean;
  /** Hide the internal sessions sidebar — the Fusio shell renders its own
   *  `<FusioSessions>` column in the `.shell` grid, so ChatPanel's built-in
   *  sidebar would be a duplicate. Set true when nested in the Fusio shell. */
  hideSessionsSidebar?: boolean;
  /** Hide the internal chat header (title + status pills + tools menu).
   *  The Fusio shell renders <FusioChatHeader> above ChatPanel instead. */
  hideChatHeader?: boolean;
  /** Hide the internal composer (input row + buttons). The Fusio shell
   *  renders <FusioComposer> below ChatPanel and bridges to ChatPanel's
   *  sendMessage() via the `mc-chat-send` window event. */
  hideComposer?: boolean;
}

// Computed-once namespace configuration derived from the `namespace` prop.
interface NsConfig {
  storagePrefix: string;      // e.g. 'mc' or 'seo'
  sessionsApi: string;        // e.g. '/api/chats' or '/api/seo-chats'
  sessionKeyPrefix: string;   // e.g. 'mc' or 'seo'
  sessionsLocalKey: string;   // e.g. NS.sessionsLocalKey or 'seoChatSessions'
  activeSessionLsKey: string; // e.g. NS.activeSessionLsKey or 'seo-activeSessionId'
  panelLabel: string;         // fallback header label
  hideConstellationUi: boolean;
}

function buildNsConfig(props: ChatPanelProps): NsConfig {
  const ns = props.namespace || 'mc';
  const isSeo = ns === 'seo';
  return {
    storagePrefix: ns,
    sessionsApi: isSeo ? '/api/seo-chats' : '/api/chats',
    sessionKeyPrefix: ns,
    sessionsLocalKey: isSeo ? 'seoChatSessions' : 'chatSessions',
    activeSessionLsKey: `${ns}-activeSessionId`,
    panelLabel: props.panelTitle || (isSeo ? 'SEO' : 'CHAT'),
    hideConstellationUi: props.hideConstellationUi ?? isSeo,
  };
}

export default function ChatPanel(props: ChatPanelProps = {}) {
  const NS = useMemo(() => buildNsConfig(props), [props.namespace, props.panelTitle, props.hideConstellationUi]);
  const { theme: activeTheme, setTheme: setActiveTheme, density, setDensity } = useTheme();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const sessionsReadyRef = useRef(false); // Guard: don't save until initial load completes
  
  // PER-SESSION STATE - each chat has its own input, loading state, attachments, streaming content
  const [inputMap, setInputMap] = useState<Record<string, string>>({});
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  // 429 rate-limit gate state — set when /api/chat returns 429. While
  // entry.until > Date.now() the composer/send is disabled and a calm
  // banner shows the countdown. Cleared automatically when timer runs out.
  interface RateLimitGate { until: number; hitCount: number; reason: string }
  const [rateLimitGateMap, setRateLimitGateMap] = useState<Record<string, RateLimitGate>>({});
  // Lightweight tick to re-render the countdown every second while a gate is active
  const [rateLimitTick, setRateLimitTick] = useState(0);
  useEffect(() => {
    const hasActive = Object.values(rateLimitGateMap).some(g => g.until > Date.now());
    if (!hasActive) return;
    const t = setInterval(() => setRateLimitTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [rateLimitGateMap]);
  const activeRateLimitGate = (sid: string | null): RateLimitGate | null => {
    if (!sid) return null;
    const g = rateLimitGateMap[sid];
    if (!g) return null;
    if (g.until <= Date.now()) return null;
    return g;
  };
  // Per-session set of "user dismissed the heavy-chat nudge"; in-memory only,
  // resets on reload. Keeps the banner from being naggy.
  const heavyChatDismissedRef = useRef<Set<string>>(new Set());
  const [streamingMap, setStreamingMap] = useState<Record<string, string>>({});
  // Live activity — heartbeat + subagent tallies per session. Replaces the
  // in-content heartbeat injection so the streaming bubble stays clean.
  interface LiveActivity {
    status: string;
    elapsedSec: number;
    silentSec?: number;
    toolsUsed?: number;
    subagentsRunning?: number;
    subagentsDone?: number;
    lastTool?: string;
    lastUpdate: number;
  }
  const [activityMap, setActivityMap] = useState<Record<string, LiveActivity | null>>({});
  const [attachmentMap, setAttachmentMap] = useState<Record<string, Attachment[]>>({});
  const [showAssets, setShowAssets] = useState(false);
  // Shared notepad drawer — same content visible on every device that has
  // MC open. Backed by /api/notepad + /api/notepad/listen SSE.
  const [showNotepad, setShowNotepad] = useState(false);
  const [projectAssets, setProjectAssets] = useState<ProjectAsset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetPreview, setAssetPreview] = useState<ProjectAsset | null>(null);
  // Mobile-only "Tools" panel above the input — collapsed by default so banners,
  // attachment preview, and the action-button row don't crowd the chat. Sticks
  // across reloads via localStorage. Desktop ignores this entirely.
  const [mobileToolsOpen, setMobileToolsOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return localStorage.getItem(`${NS.storagePrefix}-mobileToolsOpen`) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(`${NS.storagePrefix}-mobileToolsOpen`, mobileToolsOpen ? '1' : '0'); } catch {}
  }, [mobileToolsOpen]);
  const abortControllers = useRef<Record<string, AbortController>>({});
  const inputValueRefs = useRef<Record<string, string>>({});
  // Pair-mode: when the user clicks Approve on a Plan Card, we set this ref
  // and fire a synthetic send. The send handler reads it, overrides the body
  // mode to 'pair-build-execute', includes the approved plan, then clears.
  const pendingPairExecuteRef = useRef<{ sessionId: string; plan: PlanCardData; messageId: string } | null>(null);
  // Autopilot: when the user answers a paused codex-question, the next send
  // resumes the run with the answer + the phase + attempt + audit history so
  // the orchestrator picks up exactly where it stopped (no fresh attempts).
  const pendingAutopilotResumeRef = useRef<{
    sessionId: string;
    plan: PlanCardData;
    phaseIndex: number;
    answer: string;
    resumeAttempt?: number;
    auditHistory?: string[];
    overrideReworkCap?: number;
  } | null>(null);
  // Last approved autopilot plan per chat — kept around so a question reply
  // or stuck-phase retry can re-submit the same plan to the autopilot endpoint.
  const lastAutopilotPlanRef = useRef<Record<string, PlanCardData>>({});
  
  // Token usage tracking per session (real data from CLI result messages)
  const [tokenUsageMap, setTokenUsageMap] = useState<Record<string, { used: number; max: number; outputTokens?: number } | null>>({});

  // Persist usage data to localStorage so UsageStats dashboard widget can read it
  useEffect(() => {
    try { localStorage.setItem(`${NS.storagePrefix}-tokenUsageMap`, JSON.stringify(tokenUsageMap)); } catch {}
  }, [tokenUsageMap]);
  useEffect(() => {
    try { localStorage.setItem(NS.activeSessionLsKey, activeSessionId || ''); } catch {}
  }, [activeSessionId]);

  // Permission mode per session (persisted to localStorage)
  const [permissionModeMap, setPermissionModeMap] = useState<Record<string, string>>(() => {
    if (typeof window !== 'undefined') {
      try { return JSON.parse(localStorage.getItem(`${NS.storagePrefix}-permissionModeMap`) || '{}'); } catch { return {}; }
    }
    return {};
  });
  useEffect(() => {
    try { localStorage.setItem(`${NS.storagePrefix}-permissionModeMap`, JSON.stringify(permissionModeMap)); } catch {}
  }, [permissionModeMap]);
  const permissionModeMapRef = useRef<Record<string, string>>({});
  permissionModeMapRef.current = permissionModeMap;
  const activePermissionMode = permissionModeMap[activeSessionId || ''] || 'default';

  // Model selection per session (persisted to localStorage)
  const [modelMap, setModelMap] = useState<Record<string, string>>(() => {
    if (typeof window !== 'undefined') {
      try { return JSON.parse(localStorage.getItem(`${NS.storagePrefix}-modelMap`) || '{}'); } catch { return {}; }
    }
    return {};
  });
  // Persist model selections
  useEffect(() => {
    try { localStorage.setItem(`${NS.storagePrefix}-modelMap`, JSON.stringify(modelMap)); } catch {}
  }, [modelMap]);

  // One-shot migration: upgrade pre-4.7 aliases ('opus', 'sonnet', 'haiku')
  // stored in localStorage to the explicit model IDs the new selector uses.
  // Safe idempotent — runs once per load, only mutates if a legacy alias is found.
  useEffect(() => {
    setModelMap(prev => {
      const aliasMap: Record<string, string> = {
        opus: 'claude-opus-4-7',
        sonnet: 'claude-sonnet-4-6',
        haiku: 'claude-haiku-4-5',
      };
      let changed = false;
      const next: Record<string, string> = { ...prev };
      for (const [k, v] of Object.entries(prev)) {
        if (aliasMap[v]) { next[k] = aliasMap[v]; changed = true; }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Composer mode per session — tunes how much context gets assembled.
  //   quick         — haiku, no long-term recall, minimal context
  //   work          — current default behaviour
  //   constellation — leans on commander team tools
  type ComposerMode = 'quick' | 'work' | 'constellation';
  const [modeMap, setModeMap] = useState<Record<string, ComposerMode>>(() => {
    if (typeof window !== 'undefined') {
      try { return JSON.parse(localStorage.getItem(`${NS.storagePrefix}-modeMap`) || '{}'); } catch { return {}; }
    }
    return {};
  });
  useEffect(() => {
    try { localStorage.setItem(`${NS.storagePrefix}-modeMap`, JSON.stringify(modeMap)); } catch {}
  }, [modeMap]);
  const modeMapRef = useRef<Record<string, ComposerMode>>({});
  modeMapRef.current = modeMap;
  const oneShotModelRef = useRef<Record<string, string>>({});
  // Available models fetched from gateway
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; provider: string; context_window?: number }>>([]);
  useEffect(() => {
    fetch('/api/models')
      .then(r => r.json())
      .then(data => {
        if (data?.models?.length) {
          // Filter out openclaw proxy models — they're not selectable models
          const real = data.models.filter((m: any) =>
            !m.id?.startsWith('openclaw') && m.id !== 'default'
          );
          if (real.length) setAvailableModels(real);
        }
      })
      .catch(() => {});
  }, []);

  // Mirror modelMap to a ref so sendMessage always reads the latest value (avoids stale closures)
  const modelMapRef = useRef<Record<string, string>>({});
  modelMapRef.current = modelMap;
  // Track last model actually sent to gateway to avoid redundant /model switches
  const lastSentModelRef = useRef<Record<string, string>>({});
  
  // One hook call derives every per-active-session field. Previously spread
  // across ~9 lookups here and ~30 inline `map[activeSessionId || '']` reads
  // throughout the render — those still work (they hit the same source of
  // truth) but new code should prefer `session.*` for clarity.
  const session = useChatSession(activeSessionId, {
    inputMap,
    attachmentMap,
    loadingMap,
    streamingMap,
    modelMap,
    modeMap: modeMap as any,
    tokenUsageMap,
    permissionModeMap,
    activityMap,
  });
  const input = session.input;
  const isLoading = session.isLoading;
  // Strip pair-mode marker tokens from the live streaming preview so the user
  // never sees [[VOICE:...]] / [[PLANCARD:...]] sentinels mid-stream.
  const streamingContent = stripPairMarkers(session.streamingContent || '');
  const attachments = session.attachments;
  const activeModel = session.model;
  const tokenUsage = session.tokenUsage;
  
  const [loadingElapsed, setLoadingElapsed] = useState(0);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [showWorkspaceDropdown, setShowWorkspaceDropdown] = useState(false);
  const [workspaceInput, setWorkspaceInput] = useState('');
  const [browserPath, setBrowserPath] = useState('');
  const [browserItems, setBrowserItems] = useState<any[]>([]);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserSearch, setBrowserSearch] = useState('');
  const [browserParent, setBrowserParent] = useState<string | null>(null);
  const [browserIsProject, setBrowserIsProject] = useState(false);
  
  // OpenClaw Session Selector
  const [showSessionDropdown, setShowSessionDropdown] = useState(false);
  const [gatewaySessions, setGatewaySessions] = useState<any[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [selectedGatewaySession, setSelectedGatewaySession] = useState<string | null>(null);
  
  // Active Skills Tracker
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  
  // Linked Chat Feature - allows two chats to see each other (PER-SESSION)
  const [linkedSessionMap, setLinkedSessionMap] = useState<Record<string, string>>({});
  const linkedSessionId = activeSessionId ? linkedSessionMap[activeSessionId] || null : null;
  const setLinkedSessionId = (id: string | null) => {
    if (!activeSessionId) return;
    setLinkedSessionMap(prev => {
      const next = { ...prev };
      if (id) {
        next[activeSessionId] = id;
      } else {
        delete next[activeSessionId];
      }
      return next;
    });
  };
  const [showLinkDropdown, setShowLinkDropdown] = useState(false);
  // Cross-namespace / cross-machine chat-context puller. Pulls recent
  // messages from Linux MC, Linux SEO, PC MC, PC SEO, or Luke's Chat
  // and inserts them as a markdown block in the composer.
  const [showCrossChatPull, setShowCrossChatPull] = useState(false);
  // OpenAI Codex turn modal — sibling to the cross-chat puller. Lets
  // the user route a single turn to Codex with an optional persistent
  // goal (the codex `goals` feature flag is enabled server-side).
  const [showCodexModal, setShowCodexModal] = useState(false);
  const [showLinkedMessages, setShowLinkedMessages] = useState(true);
  const linkDropdownRef = useRef<HTMLDivElement>(null);
  
  // Agents Panel toggle
  const [showAgentsPanel, setShowAgentsPanel] = useState(false);
  const agentsPanelRef = useRef<HTMLDivElement>(null);

  // Reports Feature - add reports to chat
  const [showReportDropdown, setShowReportDropdown] = useState(false);
  const [reports, setReports] = useState<any[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const reportDropdownRef = useRef<HTMLDivElement>(null);
  
  // Context Compression
  const [showCompressModal, setShowCompressModal] = useState(false);
  const [compressLoading, setCompressLoading] = useState(false);
  const [compressPreview, setCompressPreview] = useState<{
    totalMessages: number;
    userMessages: number;
    assistantMessages: number;
    totalChars: number;
    estimatedTokens: number;
    estimatedCompressedTokens: number;
  } | null>(null);
  const [compressResult, setCompressResult] = useState<{
    summary: string;
    stats: { originalMessages: number; estimatedTokens: number; compressedTokens: number; ratio: number };
    savedTo?: string;
  } | null>(null);
  const [compressMode, setCompressMode] = useState<'replace' | 'save'>('replace');
  const [compressKeepCount, setCompressKeepCount] = useState(10);

  // Claude Code Teams Delegation
  const [showDelegateModal, setShowDelegateModal] = useState(false);

  // ── Constellation integration ──────────────────────────────────────
  const [linkedTeamId, setLinkedTeamId] = useState<string | null>(null);
  const [linkedTeamStatus, setLinkedTeamStatus] = useState<string | null>(null);
  const [linkedTeamName, setLinkedTeamName] = useState<string | null>(null);
  const [linkedTeamProgress, setLinkedTeamProgress] = useState<string>('');
  const [showConstellationDeploy, setShowConstellationDeploy] = useState(false);
  const [delegateTeamMode, setDelegateTeamMode] = useState(true);
  const [delegatePrompt, setDelegatePrompt] = useState('');
  const [delegateLoading, setDelegateLoading] = useState(false);
  const [claudeInstalled, setClaudeInstalled] = useState<{ installed: boolean; version?: string; teamsSupported?: boolean } | null>(null);
  const [activeClaudeSession, setActiveClaudeSession] = useState<{ id: string; name: string; status: string } | null>(null);
  const [claudeOutput, setClaudeOutput] = useState<string[]>([]);
  const [showClaudeTerminal, setShowClaudeTerminal] = useState(false);
  
  // Sub-Agent Tracker — all agents stored globally, displayed per-chat
  const [allSubAgents, setAllSubAgents] = useState<SubAgent[]>([]);
  // Track which sub-agents we've already shown completion notices for (persists across session switches)
  const notifiedSubAgentsRef = useRef<Set<string>>(new Set());
  const notifiedSubAgentsInitialized = useRef(false);
  // Persist sub-agent → chat mapping in localStorage so it survives refreshes
  const subAgentChatMap = useRef<Record<string, string>>({});
  const subAgentMapInitialized = useRef(false);
  if (!subAgentMapInitialized.current && typeof window !== 'undefined') {
    try { subAgentChatMap.current = JSON.parse(localStorage.getItem('subAgentChatMap') || '{}'); } catch { /* */ }
    subAgentMapInitialized.current = true;
  }
  // Show sub-agents: tagged to this chat, or untagged (show everywhere until tagged)
  const subAgents = allSubAgents.filter(a => {
    const mapped = subAgentChatMap.current[a.key];
    // Only show agents explicitly mapped to this chat
    // Unmapped (legacy) agents are hidden — they belong to no chat
    return mapped === activeSessionId;
  });
  const subAgentPollInterval = useRef<NodeJS.Timeout | null>(null);
  const prevRunningCount = useRef<number>(0);
  const claudeOutputRef = useRef<HTMLDivElement>(null);
  const claudePollRef = useRef<NodeJS.Timeout | null>(null);
  
  // Active Task State (uses ActiveTask from TaskPanel)
  const [activeTask, setActiveTask] = useState<ActiveTask | null>(null);
  const [taskHistory, setTaskHistory] = useState<ActiveTask[]>([]);
  const [showTaskHistory, setShowTaskHistory] = useState(false);
  const [activeView, setActiveView] = useState<'chat' | 'tasks'>('chat');
  const [isTaskMinimized, setIsTaskMinimized] = useState(false);
  // debug state removed
  const taskExecutionRef = useRef<{ running: boolean; itemIndex: number }>({ running: false, itemIndex: 0 });

  // Persist tasks to server (with localStorage fallback)
  const saveTasksToStorage = async (
    sessionId: string, 
    tasks: ActiveTask[], 
    currentTaskId?: string | null,
    minimized?: boolean
  ) => {
    const serialized = tasks.map(t => ({
      ...t,
      startedAt: t.startedAt instanceof Date ? t.startedAt.toISOString() : t.startedAt,
      completedAt: t.completedAt instanceof Date ? t.completedAt.toISOString() : t.completedAt,
    }));
    
    try {
      const res = await fetch('/api/active-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          sessionId, 
          tasks: serialized,
          currentTaskId: currentTaskId !== undefined ? currentTaskId : activeTask?.id,
          isMinimized: minimized !== undefined ? minimized : isTaskMinimized,
        }),
      });
      if (!res.ok) throw new Error('Server save failed');
    } catch (e) {
      console.error('[Tasks] Server save failed, falling back to localStorage:', e);
      // Fallback to localStorage
      try {
        const allTasks = JSON.parse(localStorage.getItem('missionControlTasks') || '{}');
        allTasks[sessionId] = { 
          tasks: serialized, 
          currentTaskId: currentTaskId !== undefined ? currentTaskId : activeTask?.id,
          isMinimized: minimized !== undefined ? minimized : isTaskMinimized,
        };
        localStorage.setItem('missionControlTasks', JSON.stringify(allTasks));
      } catch (le) {
        console.error('[Tasks] localStorage fallback also failed:', le);
      }
    }
  };

  // Load tasks from server (with localStorage fallback)
  const loadTasksFromStorage = async (sessionId: string): Promise<{
    tasks: ActiveTask[];
    currentTaskId?: string | null;
    isMinimized?: boolean;
  }> => {
    try {
      const res = await fetch(`/api/active-tasks?sessionId=${encodeURIComponent(sessionId)}`);
      if (!res.ok) throw new Error('Server load failed');
      const data = await res.json();
      const tasks = (data.tasks || []).map((t: any) => ({
        ...t,
        startedAt: new Date(t.startedAt),
        completedAt: t.completedAt ? new Date(t.completedAt) : undefined,
      }));
      return { 
        tasks, 
        currentTaskId: data.currentTaskId,
        isMinimized: data.isMinimized,
      };
    } catch (e) {
      console.error('[Tasks] Server load failed, falling back to localStorage:', e);
      // Fallback to localStorage
      try {
        const allData = JSON.parse(localStorage.getItem('missionControlTasks') || '{}');
        const sessionData = allData[sessionId];
        // Handle old format (just array) vs new format (object with tasks/currentTaskId/isMinimized)
        const tasks = Array.isArray(sessionData) ? sessionData : (sessionData?.tasks || []);
        return {
          tasks: tasks.map((t: any) => ({
            ...t,
            startedAt: new Date(t.startedAt),
            completedAt: t.completedAt ? new Date(t.completedAt) : undefined,
          })),
          currentTaskId: sessionData?.currentTaskId,
          isMinimized: sessionData?.isMinimized,
        };
      } catch (le) {
        console.error('[Tasks] localStorage fallback also failed:', le);
        return { tasks: [] };
      }
    }
  };

  // Update task in history (and persist)
  const updateTaskInHistory = (task: ActiveTask) => {
    if (!activeSessionId) return;
    
    // Compute the updated tasks list synchronously first
    setTaskHistory(prev => {
      let updatedTasks: ActiveTask[];
      const existing = prev.findIndex(t => t.id === task.id);
      if (existing >= 0) {
        updatedTasks = [...prev];
        updatedTasks[existing] = task;
      } else {
        updatedTasks = [task, ...prev];
      }
      // Keep only last 20 tasks per session to prevent storage bloat
      if (updatedTasks.length > 20) {
        updatedTasks = updatedTasks.slice(0, 20);
      }
      
      // Save INSIDE the callback where we have the correct value
      // Use setTimeout to avoid blocking the state update
      setTimeout(() => {
        saveTasksToStorage(activeSessionId, updatedTasks, task.id, isTaskMinimized);
      }, 0);
      
      return updatedTasks;
    });
  };

  // Clear completed/failed tasks from history
  const clearTaskHistory = () => {
    if (!activeSessionId) return;
    const activeTasks = taskHistory.filter(t => 
      t.status === 'running' || t.status === 'paused' || t.status === 'loading' || t.status === 'clarifying'
    );
    setTaskHistory(activeTasks);
    saveTasksToStorage(activeSessionId, activeTasks); // async, won't block
  };
  
  // Team prompt templates
  const TEAM_TEMPLATES = [
    {
      title: "🔍 Debug Investigation",
      description: "5 agents explore different bug hypotheses",
      prompt: `Spin up 5 agent teammates to investigate this bug from different angles:
- Agent 1: Database/query issues
- Agent 2: Race conditions  
- Agent 3: State management bugs
- Agent 4: API response problems
- Agent 5: Cache invalidation

Have them debate findings and reach consensus.`
    },
    {
      title: "🏗️ Feature Build",
      description: "Coordinated full-stack implementation",
      prompt: `Create an agent team to implement this feature:
- Lead: Architecture & coordination
- Backend Agent: API implementation
- Frontend Agent: UI components
- Test Agent: Coverage & validation
- Docs Agent: Documentation

Each agent updates task status and communicates blockers.`
    },
    {
      title: "🔐 Code Review",
      description: "Multi-perspective security & performance analysis",
      prompt: `Spin up 3 agents to review this code:
- Security Agent: Vulnerabilities, auth, data exposure
- Performance Agent: Bottlenecks, memory leaks, slow queries
- Architecture Agent: Patterns, coupling, maintainability

Broadcast findings and compile a unified report.`
    },
    {
      title: "♻️ Refactor Sprint",
      description: "Team tackles different refactoring aspects",
      prompt: `Create a refactoring team:
- Architecture Agent: Plan new structure
- Migration Agent: Move code without breaking tests
- Cleanup Agent: Remove dead code, fix linting
- Testing Agent: Ensure coverage during transition

Coordinate through shared task list.`
    }
  ];
  
  // Environment — production only (no staging)
  type Environment = 'production';
  const [activeEnvironment, setActiveEnvironment] = useState<Environment>('production');
  const envConfig = {
    staging: {
      supabaseRef: 'zbshprhsogdnawuviqgq',
      saasUrl: 'https://staging.example.com',
      appUrl: 'https://app-staging.example.com',
      branch: 'staging',
      color: 'terminal-yellow',
      label: 'STAGING',
      icon: AlertTriangle,
      warning: 'Safe for testing',
    },
    production: {
      supabaseRef: 'nqzhoplyamubcbqjuvxh',
      saasUrl: 'https://example.com',
      appUrl: 'https://app.example.com',
      branch: 'main',
      color: 'terminal-green',
      label: 'PRODUCTION',
      icon: CheckCircle,
      warning: '⚠️ LIVE DATA - Deploy carefully!',
    },
  };
  
  // Message Actions Dropdown
  const [activeMessageMenu, setActiveMessageMenu] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const messageMenuRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  
  const sessionDropdownRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workspaceDropdownRef = useRef<HTMLDivElement>(null);

  // Get active session
  const activeSession = sessions.find(s => s.id === activeSessionId);
  const allMessages = activeSession?.messages || [];

  // Broadcast the active session whenever it changes so FusioChatHeader
  // (and any other listener) can update without waiting on its own
  // /api/chats fetch. Includes name + workspace so the header doesn't
  // need to refetch to display them.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!activeSession) return;
    const eventNs = NS.storagePrefix === 'mc' ? 'default' : NS.storagePrefix;
    window.dispatchEvent(new CustomEvent('mc-chat-select', {
      detail: {
        id: activeSession.id,
        namespace: eventNs,
        name: activeSession.name,
        workspace: activeSession.workspace,
      },
    }));
  }, [activeSession?.id, activeSession?.name, activeSession?.workspace, NS.storagePrefix]);

  // Autopilot: hydrate the in-memory plan ref from chat history on every chat
  // switch / reload. Without this, a page refresh leaves Retry/Skip stranded
  // because the ref starts empty and we only populated it on Approve. Walk
  // the messages newest-to-oldest and grab the first message that carries a
  // phased plan card.
  useEffect(() => {
    if (!activeSessionId || !allMessages.length) return;
    if (lastAutopilotPlanRef.current[activeSessionId]) return; // already hydrated
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const m: any = allMessages[i];
      const card = m?.planCard;
      if (card && Array.isArray(card.phases) && card.phases.length > 0) {
        lastAutopilotPlanRef.current[activeSessionId] = card;
        break;
      }
    }
  }, [activeSessionId, allMessages.length]);
  
  // Get linked session
  const linkedSession = linkedSessionId ? sessions.find(s => s.id === linkedSessionId) : null;
  const linkedMessages = linkedSession?.messages || [];
  
  // Get available sessions to link (exclude current)
  const linkableSessions = sessions.filter(s => s.id !== activeSessionId);
  
  // Limit displayed messages to prevent crashes
  const MAX_DISPLAYED_MESSAGES = 50;
  const [showAllMessages, setShowAllMessages] = useState(false);
  const [showShortcutOverlay, setShowShortcutOverlay] = useState(false);
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequest[]>([]);
  const approvalDecide = async (id: string, allow: boolean, note?: string) => {
    try {
      await fetch('/api/chat/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, allow, note }),
      });
    } catch (e) {
      console.error('[approve] POST failed', e);
    } finally {
      setApprovalQueue(prev => prev.filter(r => r.id !== id));
    }
  };

  // Cross-device live sync. Opens an SSE to /api/chat/listen for the
  // active chat; the server broadcasts every in-flight turn there so a
  // phone-initiated reply shows up live on the desktop (and vice versa),
  // and backgrounded mobile reconnects cleanly on foreground.
  useEffect(() => {
    if (!activeSessionId) return;
    if (typeof window === 'undefined') return;
    let closed = false;
    let reopenTimer: NodeJS.Timeout | null = null;
    const clientId = getClientId();

    const open = () => {
      if (closed) return;
      const url = `/api/chat/listen?chatId=${encodeURIComponent(activeSessionId)}&clientId=${encodeURIComponent(clientId)}`;
      const es = new EventSource(url);
      let streamed = '';
      // True only when we've actually received streaming payloads for this
      // turn — i.e. we're the cross-device listener, not the originator.
      // The origin client's listen SSE only receives sync-done; without
      // sync-delta/start/replay preceding it, we know not to run the
      // canonical refetch (the originator's own POST handler just
      // committed locally and a racing fetch would clobber it).
      let receivedContent = false;
      es.onmessage = (ev) => {
        if (!ev.data) return;
        let parsed: any;
        try { parsed = JSON.parse(ev.data); } catch { return; }
        if (!parsed || !parsed.type) return;

        if (parsed.type === 'sync-start') {
          streamed = '';
          receivedContent = true;
          setStreamingMap(prev => ({ ...prev, [activeSessionId]: '' }));
          setLoadingMap(prev => ({ ...prev, [activeSessionId]: true }));
        } else if (parsed.type === 'user-message' && typeof parsed.content === 'string') {
          // Another device sent a prompt to this chat — render it locally so
          // the user (on this device) sees what was asked instantly. Idempotent:
          // skip if a matching user message already sits at the tail (the
          // server already committed it; refetch on sync-done will reconcile).
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSessionId) return s;
            const msgs = s.messages || [];
            const tail = msgs[msgs.length - 1];
            const head = parsed.content.slice(0, 200);
            if (tail?.role === 'user' && typeof tail.content === 'string'
                && tail.content.slice(0, 200) === head) {
              return s;
            }
            return {
              ...s,
              messages: [...msgs, {
                id: parsed.messageId || generateId(),
                role: 'user' as const,
                content: parsed.content,
                timestamp: new Date(),
              }],
              updatedAt: new Date(),
            };
          }));
        } else if (parsed.type === 'sync-replay' && typeof parsed.content === 'string') {
          streamed = parsed.content;
          receivedContent = true;
          setStreamingMap(prev => ({ ...prev, [activeSessionId]: streamed }));
          setLoadingMap(prev => ({ ...prev, [activeSessionId]: true }));
        } else if (parsed.type === 'sync-delta' && typeof parsed.delta === 'string') {
          streamed += parsed.delta;
          receivedContent = true;
          setStreamingMap(prev => ({ ...prev, [activeSessionId]: streamed }));
        } else if (parsed.type === 'heartbeat') {
          setActivityMap(prev => ({
            ...prev,
            [activeSessionId]: {
              status: parsed.status,
              elapsedSec: parsed.elapsedSec || 0,
              silentSec: parsed.silentSec,
              toolsUsed: parsed.toolsUsed,
              subagentsRunning: parsed.subagentsRunning,
              subagentsDone: parsed.subagentsDone,
              lastUpdate: Date.now(),
            },
          }));
        } else if (parsed.type === 'sync-done') {
          // Only act on this when we're a non-origin listener — if
          // receivedContent is false we never saw any streaming, which
          // means the server filtered us out as the origin. The origin's
          // own POST handler is in charge of committing + save-one.
          if (!receivedContent) {
            streamed = '';
            return;
          }
          setLoadingMap(prev => ({ ...prev, [activeSessionId]: false }));
          setStreamingMap(prev => ({ ...prev, [activeSessionId]: '' }));
          setActivityMap(prev => ({ ...prev, [activeSessionId]: null }));
          // Refresh the canonical saved chat so the committed assistant
          // message arrives with its real id/timestamp.
          fetch(`${NS.sessionsApi}?sessionId=${encodeURIComponent(activeSessionId)}`)
            .then(r => r.json())
            .then(data => {
              if (!data?.session?.messages) return;
              setSessions(prev => prev.map(s =>
                s.id === activeSessionId
                  ? { ...s, messages: data.session.messages.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) })) }
                  : s,
              ));
            })
            .catch(() => { /* best-effort reload */ });
          // Reset for the next turn on this connection.
          receivedContent = false;
          streamed = '';
        } else if (parsed.type === 'sync-hello') {
          // server confirms subscription; no-op
        }
      };
      es.onerror = () => {
        // Browser will auto-retry EventSource on network drops; add our
        // own backoff for hard failures.
        es.close();
        if (!closed) {
          reopenTimer = setTimeout(open, 2000);
        }
      };
      // Expose for cleanup
      (open as any)._es = es;
    };

    open();
    // Reopen on page visibility change (mobile backgrounding) so we catch
    // any replies that streamed while the tab was suspended.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        const es = (open as any)._es as EventSource | undefined;
        if (!es || es.readyState === 2 /* CLOSED */) open();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      closed = true;
      if (reopenTimer) clearTimeout(reopenTimer);
      const es = (open as any)._es as EventSource | undefined;
      try { es?.close(); } catch { /* ignore */ }
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // Global `?` to open the shortcut overlay. Ignored while typing in any input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as any).isContentEditable);
      if (inField) return;
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        setShowShortcutOverlay(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  
  // Scroll to bottom when session changes OR when messages load for new session
  const lastScrolledSessionRef = useRef<string | null>(null);
  
  useEffect(() => {
    if (!activeSessionId) return;
    setShowAllMessages(false);
    prevMessageCountRef.current = 0;
    lastScrolledSessionRef.current = null;

    // One-time key facts scan of all existing messages when switching to a session
    setSessions(prev => {
      const session = prev.find(s => s.id === activeSessionId);
      if (!session || (session.keyFacts && session.keyFacts.length > 0)) return prev; // Already has facts
      const allText = session.messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => m.content || '')
        .join('\n');
      if (!allText) return prev;
      const facts = extractKeyFacts(allText);
      if (facts.length === 0) return prev;
      console.log('[KeyFacts] Backfill: extracted %d facts from existing messages', facts.length);
      return prev.map(s => s.id === activeSessionId ? { ...s, keyFacts: facts } : s);
    });
  }, [activeSessionId]);
  
  useEffect(() => {
    // Virtuoso handles follow-output for streaming; we only need to jump to the
    // last item when switching chats. Fire a couple of frames late so Virtuoso
    // has measured item heights.
    if (!activeSessionId || allMessages.length === 0) return;
    if (lastScrolledSessionRef.current === activeSessionId) return;
    lastScrolledSessionRef.current = activeSessionId;
    const goLast = () => {
      try {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST' as any, behavior: 'auto', align: 'end' });
      } catch { /* ignore */ }
    };
    requestAnimationFrame(goLast);
    const t = setTimeout(goLast, 200);
    return () => clearTimeout(t);
  }, [activeSessionId, allMessages.length]);
  
  // Tool-lifecycle chrome (sub-agent done banners, per-tool heartbeats) that
  // duplicates SubAgentTracker in the right rail. Filter out of the main thread
  // so user↔assistant conversation stays readable. Errors, compression markers,
  // and ad-hoc system notes remain in thread.
  const isToolTimelineEvent = (msg: Message): boolean => {
    if (msg.role !== 'system') return false;
    const t = typeof msg.content === 'string' ? msg.content : '';
    return (
      /^✅\s*\*\*Sub-agent done\*\*/i.test(t) ||
      /^🔄\s/.test(t) ||
      /^⏳\s/.test(t) ||
      /^🚀\s*Agent working/i.test(t) ||
      /^📋\s/.test(t)
    );
  };
  const timelineEvents = useMemo(
    () => allMessages.filter(isToolTimelineEvent),
    [allMessages],
  );
  const threadMessages = useMemo(
    () => allMessages.filter((m) => !isToolTimelineEvent(m)),
    [allMessages],
  );
  const [showTimelineRail, setShowTimelineRail] = useState(false);
  const messages = showAllMessages
    ? threadMessages
    : threadMessages.slice(-MAX_DISPLAYED_MESSAGES);
  const hasHiddenMessages = threadMessages.length > MAX_DISPLAYED_MESSAGES && !showAllMessages;

  // Parse skills from message content (looks for <!-- skills: skill1, skill2 --> or 📚 Using: skill1, skill2)
  const parseSkillsFromContent = (content: string): string[] => {
    // Check for HTML comment format: <!-- skills: skill1, skill2 -->
    const commentMatch = content.match(/<!--\s*skills?:\s*([^>]+)\s*-->/i);
    if (commentMatch) {
      return commentMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    }
    
    // Check for emoji format: 📚 Using: skill1, skill2
    const emojiMatch = content.match(/📚\s*(?:Using|Skills?):\s*([^\n]+)/i);
    if (emojiMatch) {
      return emojiMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    }
    
    return [];
  };

  // Strip skills markers from displayed content
  const stripSkillsMarker = (content: string): string => {
    return content
      .replace(/<!--\s*skills?:\s*[^>]+\s*-->\n*/gi, '')
      .replace(/📚\s*(?:Using|Skills?):\s*[^\n]+\n*/gi, '')
      .trim();
  };

  // Update active skills when messages change
  useEffect(() => {
    const assistantMessages = allMessages.filter(m => m.role === 'assistant');
    if (assistantMessages.length > 0) {
      const lastAssistant = assistantMessages[assistantMessages.length - 1];
      const skills = parseSkillsFromContent(lastAssistant.content);
      setActiveSkills(prev => {
        const joined = skills.join(',');
        return prev.join(',') === joined ? prev : skills;
      });
    } else {
      setActiveSkills(prev => prev.length === 0 ? prev : []);
    }
  }, [allMessages]);

  // Load sessions from server on mount — lite mode first (no messages), then hydrate active session
  useEffect(() => {
    const loadSessions = async () => {
      try {
        // Fetch full session list including messages
        const response = await fetch(NS.sessionsApi);
        const data = await response.json();

        if (data.sessions && data.sessions.length > 0) {
          const loadedSessions = data.sessions.map((s: any) => ({
            ...s,
            createdAt: new Date(s.createdAt),
            updatedAt: new Date(s.updatedAt),
            messages: (s.messages || []).map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) })),
            sessionKey: s.sessionKey || `mc-${s.id.slice(0, 8)}-${new Date(s.createdAt).getTime()}`,
            // Preserve lite metadata for sidebar rendering before messages load
            _messageCount: s.messageCount ?? s.messages?.length ?? 0,
            _lastMessagePreview: s.lastMessagePreview ?? null,
          }));
          suppressSaveCountRef.current++;
          setSessions(loadedSessions);
          sessionsReadyRef.current = true;

          // Set active session to most recent
          const sorted = [...loadedSessions].sort((a: ChatSession, b: ChatSession) =>
            b.updatedAt.getTime() - a.updatedAt.getTime()
          );
          const activeId = sorted[0].id;
          setActiveSessionId(activeId);

          // Now hydrate the active session with full messages
          try {
            const fullRes = await fetch(`?sessionId=${activeId}`);
            const fullData = await fullRes.json();
            if (fullData.session) {
              const fullSession = fullData.session;
              setSessions(prev => prev.map(s => s.id === activeId ? {
                ...s,
                messages: (fullSession.messages || []).map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) })),
                _messageCount: fullSession.messages?.length ?? 0,
              } : s));
            }
          } catch (e) {
            console.warn('[Chat] Failed to hydrate active session messages:', e);
          }
        } else {
          // No server sessions, check localStorage for migration
          const saved = localStorage.getItem(NS.sessionsLocalKey);
          if (saved) {
            const parsed = JSON.parse(saved);
            const loadedSessions = parsed.map((s: any) => ({
              ...s,
              createdAt: new Date(s.createdAt),
              updatedAt: new Date(s.updatedAt),
              messages: s.messages.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) })),
              sessionKey: s.sessionKey || `mc-${s.id.slice(0, 8)}-${new Date(s.createdAt).getTime()}`,
            }));
            suppressSaveCountRef.current++;
            setSessions(loadedSessions);
            sessionsReadyRef.current = true;

            // Migrate to server
            await fetch(NS.sessionsApi, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'save-all', sessions: loadedSessions }),
            });

            // Clear localStorage after migration
            localStorage.removeItem(NS.sessionsLocalKey);

            if (loadedSessions.length > 0) {
              const sorted = [...loadedSessions].sort((a: ChatSession, b: ChatSession) =>
                b.updatedAt.getTime() - a.updatedAt.getTime()
              );
              setActiveSessionId(sorted[0].id);
            }
          } else {
            // Create default session
            sessionsReadyRef.current = true;
            createNewSession();
          }
        }
      } catch (error) {
        console.error('Failed to load sessions from server:', error);
        // Fallback to localStorage
        const saved = localStorage.getItem(NS.sessionsLocalKey);
        if (saved) {
          const parsed = JSON.parse(saved);
          const loadedSessions = parsed.map((s: any) => ({
            ...s,
            createdAt: new Date(s.createdAt),
            updatedAt: new Date(s.updatedAt),
            messages: s.messages.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) })),
            sessionKey: s.sessionKey || `mc-${s.id.slice(0, 8)}-${new Date(s.createdAt).getTime()}`,
          }));
          suppressSaveCountRef.current++;
          setSessions(loadedSessions);
          sessionsReadyRef.current = true;
          if (loadedSessions.length > 0) {
            setActiveSessionId(loadedSessions[0].id);
          }
        } else {
          sessionsReadyRef.current = true;
          createNewSession();
        }
      }
    };

    loadSessions();

    return () => {
      // DON'T abort on unmount — let background streams finish.
      // The server-side pending-response buffer captures output even if
      // the client disconnects. We'll recover on re-mount.
    };
  }, []);

  // Lazy-hydrate messages when switching to a session that was loaded in lite mode
  useEffect(() => {
    if (!activeSessionId || !sessionsReadyRef.current) return;
    const session = sessions.find(s => s.id === activeSessionId);
    // If the session has no messages but _messageCount says it should, fetch them
    if (session && session.messages.length === 0 && (session as any)._messageCount > 0) {
      (async () => {
        try {
          const res = await fetch(`?sessionId=${activeSessionId}`);
          const data = await res.json();
          if (data.session && data.session.messages?.length > 0) {
            suppressSaveCountRef.current++;
            setSessions(prev => prev.map(s => s.id === activeSessionId ? {
              ...s,
              messages: (data.session.messages || []).map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) })),
              _messageCount: data.session.messages?.length ?? 0,
            } : s));
          }
        } catch (e) {
          console.warn('[Chat] Failed to hydrate session messages:', e);
        }
      })();
    }
  }, [activeSessionId]);

  // Recover in-flight responses after tab switch / remount
  useEffect(() => {
    // Always sweep stale chat_partial_response on mount, independent of
    // whether there's an active request. Otherwise a partial from a long-ago
    // hung request can be replayed in the "stream ended with no content"
    // fallback path and make every new send look like it returns the same reply.
    try {
      const staleBackup = localStorage.getItem('chat_partial_response');
      if (staleBackup) {
        const parsed = JSON.parse(staleBackup);
        if (!parsed.timestamp || Date.now() - parsed.timestamp > 600_000) {
          console.warn('[Chat] Clearing stale chat_partial_response on mount (age:',
            parsed.timestamp ? Math.round((Date.now() - parsed.timestamp) / 1000) : 'unknown', 's)');
          localStorage.removeItem('chat_partial_response');
        }
      }
    } catch {
      localStorage.removeItem('chat_partial_response');
    }

    const recover = async () => {
      try {
        const raw = localStorage.getItem('chat_active_request');
        if (!raw) return;
        const { requestId, sessionId, startedAt } = JSON.parse(raw);
        // Only recover if the request started recently (within 15 minutes)
        if (!requestId || !sessionId || Date.now() - startedAt > 900_000) {
          localStorage.removeItem('chat_active_request');
          localStorage.removeItem('chat_partial_response');
          return;
        }
        // Show a visible "recovering" indicator so the user knows we're
        // fetching their in-flight response.
        const ageSec = Math.round((Date.now() - startedAt) / 1000);
        setLoadingMap(prev => ({ ...prev, [sessionId]: true }));
        // Brief, calm: shows in the streaming-indicator slot above the
        // composer, not as a permanent chat message. Cleared as soon as the
        // server returns content (or a "still working" status).
        setStreamingMap(prev => ({
          ...prev,
          [sessionId]: ageSec < 60
            ? `_Reconnecting…_`
            : `_Picking up where we left off (${Math.round(ageSec/60)}m ago)…_`,
        }));
        console.log('[Chat] Recovering orphaned request on mount:', requestId, 'session:', sessionId);
        // Poll the server-side buffer
        const res = await fetch(`/api/chat?requestId=${encodeURIComponent(requestId)}`);
        const data = await res.json();
        if (data.found && data.content && data.done) {
          // Recovered! Add the response to the correct session
          const recoveredMsg: Message = {
            id: generateId(),
            role: 'assistant',
            content: data.content,
            timestamp: new Date(),
          };
          setSessions(prev => prev.map(s =>
            s.id === sessionId
              ? { ...s, messages: [...s.messages, recoveredMsg], updatedAt: new Date() }
              : s
          ));
          setLoadingMap(prev => ({ ...prev, [sessionId]: false }));
          setStreamingMap(prev => ({ ...prev, [sessionId]: '' }));
          localStorage.removeItem('chat_active_request');
          localStorage.removeItem('chat_partial_response');
          console.log('[Chat] Recovered background response for session', sessionId, ':', data.content.length, 'chars');
        } else if (data.found && data.done && !data.content) {
          // Server finished but produced no text — show a clear nudge.
          const emptyMsg: Message = {
            id: generateId(),
            role: 'system',
            content: `⚠️ The agent finished working while you were away, but didn't write a reply. This usually means sub-agents did the work but the parent agent didn't summarize.\n\n**Fix:** type **"summarize what you just did"** or **"continue"** and the agent will recap. Nothing was lost — tool outputs are still in the session.`,
            timestamp: new Date(),
          };
          setSessions(prev => prev.map(s =>
            s.id === sessionId
              ? { ...s, messages: [...s.messages, emptyMsg], updatedAt: new Date() }
              : s
          ));
          setLoadingMap(prev => ({ ...prev, [sessionId]: false }));
          setStreamingMap(prev => ({ ...prev, [sessionId]: '' }));
          localStorage.removeItem('chat_active_request');
          localStorage.removeItem('chat_partial_response');
          console.warn('[Chat] Recovery: agent turn ended empty for session', sessionId);
        } else if (data.found && !data.done) {
          // Still in progress — mark session as loading and show partial content
          setLoadingMap(prev => ({ ...prev, [sessionId]: true }));
          if (data.content) {
            setStreamingMap(prev => ({ ...prev, [sessionId]: data.content }));
          }
          // Keep polling
          const pollInterval = setInterval(async () => {
            try {
              const pollRes = await fetch(`/api/chat?requestId=${encodeURIComponent(requestId)}`);
              const pollData = await pollRes.json();
              if (pollData.found && pollData.content) {
                setStreamingMap(prev => ({ ...prev, [sessionId]: pollData.content }));
              }
              if (pollData.done || !pollData.found) {
                clearInterval(pollInterval);
                if (pollData.content) {
                  const msg: Message = {
                    id: generateId(),
                    role: 'assistant',
                    content: pollData.content,
                    timestamp: new Date(),
                  };
                  setSessions(prev => prev.map(s =>
                    s.id === sessionId
                      ? { ...s, messages: [...s.messages, msg], updatedAt: new Date() }
                      : s
                  ));
                }
                setLoadingMap(prev => ({ ...prev, [sessionId]: false }));
                setStreamingMap(prev => ({ ...prev, [sessionId]: '' }));
                localStorage.removeItem('chat_active_request');
              }
            } catch {
              clearInterval(pollInterval);
            }
          }, 2000);
          // Safety: stop polling after 5 minutes
          setTimeout(() => clearInterval(pollInterval), 300_000);
        }
      } catch (e) {
        console.warn('[Chat] Recovery failed:', e);
      }
    };
    // Small delay to let sessions load first
    const timer = setTimeout(recover, 1000);
    return () => clearTimeout(timer);
  }, []);

  // Save sessions to server whenever they change
  // GUARD: only save after initial load is complete to prevent overwriting
  // server data with an empty/default session list during startup.
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastKnownVersionRef = useRef<number>(0);
  const isSavingRef = useRef(false);
  // Only save when sessions are dirty (user-initiated changes, not server loads).
  // Server loads set suppressSaveCountRef to skip N subsequent save triggers.
  const suppressSaveCountRef = useRef(0);
  useEffect(() => {
    if (!sessionsReadyRef.current) return;
    if (suppressSaveCountRef.current > 0) {
      suppressSaveCountRef.current--;
      return;
    }
    // Safety: never save if total messages is drastically lower than what server has
    const totalMsgs = sessions.reduce((sum, s) => sum + (s.messages?.length || 0), 0);
    if (sessions.length > 2 && totalMsgs === 0) {
      console.warn('[Chat] BLOCKED save: 0 total messages');
      return;
    }
    if (sessions.length > 0) {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = setTimeout(async () => {
        // Double-check: re-read sessions from state via the closure
        // and verify we're not about to wipe data
        const currentTotalMsgs = sessions.reduce((sum, s) => sum + (s.messages?.length || 0), 0);
        if (sessions.length > 2 && currentTotalMsgs === 0) {
          console.warn('[Chat] BLOCKED save in timeout: 0 total messages');
          return;
        }
        isSavingRef.current = true;
        try {
          await fetch(NS.sessionsApi, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'save-all', sessions }),
          });
          const vRes = await fetch(`${NS.sessionsApi}?check=version`);
          const vData = await vRes.json();
          lastKnownVersionRef.current = vData.version || 0;
        } catch (err) {
          console.error('Failed to save sessions:', err);
        } finally {
          isSavingRef.current = false;
        }
      }, 500);
    }
  }, [sessions]);

  // ── Cross-device sync: poll server for changes made by other browsers ──
  useEffect(() => {
    if (!sessionsReadyRef.current) return;

    const SYNC_INTERVAL = 5000; // 5 seconds

    const syncPoll = async () => {
      // Don't sync while we're saving (would see our own write)
      if (isSavingRef.current) return;
      // Don't sync while AI is streaming (avoid overwriting in-progress state)
      const anyLoading = Object.values(loadingMap).some(Boolean);
      if (anyLoading) return;

      try {
        const res = await fetch(`${NS.sessionsApi}?check=version`);
        const { version } = await res.json();

        if (lastKnownVersionRef.current > 0 && version !== lastKnownVersionRef.current) {
          console.log('[Sync] Server data changed — pulling updates');
          const fullRes = await fetch(NS.sessionsApi);
          const { sessions: serverSessions } = await fullRes.json();
          if (serverSessions && serverSessions.length > 0) {
            // Safety: only accept if server data actually has messages
            const serverMsgCount = serverSessions.reduce((sum: number, s: any) => sum + (s.messages?.length || 0), 0);
            if (serverMsgCount === 0) {
              console.warn('[Sync] Server returned 0 total messages — skipping to protect local data');
              lastKnownVersionRef.current = version;
              return;
            }
            const loaded = serverSessions.map((s: any) => ({
              ...s,
              createdAt: new Date(s.createdAt),
              updatedAt: new Date(s.updatedAt),
              messages: (s.messages || []).map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) })),
              sessionKey: s.sessionKey || `mc-${s.id.slice(0, 8)}-${new Date(s.createdAt).getTime()}`,
            }));
            suppressSaveCountRef.current++;
            setSessions(loaded);
          }
        }
        lastKnownVersionRef.current = version;
      } catch {
        // Network error — skip this poll
      }
    };

    // Seed the initial version
    fetch(`${NS.sessionsApi}?check=version`)
      .then(r => r.json())
      .then(d => { lastKnownVersionRef.current = d.version || 0; })
      .catch(() => {});

    const interval = setInterval(syncPoll, SYNC_INTERVAL);

    // Also sync on tab/window focus (user comes back to desktop)
    const onFocus = () => { syncPoll(); };
    window.addEventListener('focus', onFocus);

    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadingMap]);

  // ── Cross-tab GitHub-attach bridge ────────────────────────────────
  // The standalone GITHUB tab dispatches `mc-attach-github` when the user
  // clicks Attach on a repo. We listen here so the same flow that the
  // chat-header `🐙 GitHub` button uses also fires for the page tab.
  // Ensures: pick a repo from anywhere → it lands on the active chat.
  useEffect(() => {
    const onAttach = (e: Event) => {
      const repo = (e as CustomEvent).detail as
        | { name: string; fullName: string; url: string; defaultBranch?: string }
        | undefined;
      if (!repo || !repo.fullName) return;
      // Make sure we have an active chat — if not, create one so the
      // attachment doesn't drop on the floor.
      let targetId = activeSessionId;
      if (!targetId) {
        const newId = generateId();
        const newSessionKey = `${NS.sessionKeyPrefix}-${newId.slice(0, 8)}-${Date.now()}`;
        const newSession: ChatSession = {
          id: newId,
          name: `Chat ${sessions.length + 1}`,
          sessionKey: newSessionKey,
          messages: [{
            id: generateId(),
            role: 'system',
            content: 'New conversation started. Send a message to chat with your agent.',
            timestamp: new Date(),
          }],
          createdAt: new Date(),
          updatedAt: new Date(),
          githubRepo: { name: repo.name, fullName: repo.fullName, url: repo.url, defaultBranch: repo.defaultBranch || 'main' },
        };
        setSessions(prev => [newSession, ...prev]);
        setActiveSessionId(newId);
        return;
      }
      setSessions(prev => prev.map(s =>
        s.id === targetId
          ? { ...s, githubRepo: { name: repo.name, fullName: repo.fullName, url: repo.url, defaultBranch: repo.defaultBranch || 'main' } }
          : s,
      ));
    };
    window.addEventListener('mc-attach-github', onAttach);
    return () => window.removeEventListener('mc-attach-github', onAttach);
  }, [activeSessionId, sessions.length, NS.sessionKeyPrefix]);

  // ── Fusio composer bridge: <FusioComposer> dispatches `mc-chat-send`
  // with { sessionId, text } when the user submits. We update the local
  // inputMap + inputValueRefs for the matching session, then call
  // sendMessage() on the next tick so the closure picks up the new input.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const text: string = typeof detail.text === 'string' ? detail.text : '';
      const sid: string | undefined = detail.sessionId;
      if (!text.trim()) return;
      const target = sid || activeSessionId;
      if (!target) return;
      // If a different session is currently active, briefly switch to it so
      // sendMessage's `activeSessionId` closure picks up the right id.
      if (target !== activeSessionId) {
        setActiveSessionId(target);
      }
      setInputMap(prev => ({ ...prev, [target]: text }));
      inputValueRefs.current[target] = text;
      // Defer the send a tick so React state propagates.
      setTimeout(() => { sendMessage(); }, 30);
    };
    window.addEventListener('mc-chat-send', handler as EventListener);
    return () => window.removeEventListener('mc-chat-send', handler as EventListener);
    // sendMessage is defined later in this component; we read it via
    // closure each invocation. Re-bind when activeSessionId changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // ── Fusio Project pill bridge: <FusioChatHeader> dispatches
  // `mc-set-session-workspace` when the user picks a project from its
  // dropdown. We patch the matching session's workspace inline; the
  // existing autosave (POST /api/chats save-one) picks it up on the next
  // flush so it sticks across page reloads.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const sid: string | undefined = detail.sessionId;
      const ws: string | undefined = detail.workspace;
      if (!ws) return;
      const target = sid || activeSessionId;
      if (!target) return;
      setSessions(prev => prev.map(s => s.id === target ? { ...s, workspace: ws } : s));
    };
    window.addEventListener('mc-set-session-workspace', handler as EventListener);
    return () => window.removeEventListener('mc-set-session-workspace', handler as EventListener);
  }, [activeSessionId]);

  // ── Fusio Model selector bridge: <FusioComposer> dispatches
  // `mc-set-session-model` when the user picks a model from its dropdown.
  // We mirror it to modelMap (which is already persisted to localStorage
  // by another effect) so sendMessage picks up the new model on its next
  // turn without a remount.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const sid: string | undefined = detail.sessionId;
      const modelId: string | undefined = detail.modelId;
      if (!modelId) return;
      const target = sid || activeSessionId;
      if (!target) return;
      setModelMap(prev => {
        const next = { ...prev };
        if (modelId === 'default') delete next[target];
        else next[target] = modelId;
        return next;
      });
    };
    window.addEventListener('mc-set-session-model', handler as EventListener);
    return () => window.removeEventListener('mc-set-session-model', handler as EventListener);
  }, [activeSessionId]);

  // ── Fusio composer feedback channel ────────────────────────────────
  // Mirror loadingMap → `mc-chat-streaming` events so <FusioComposer>'s
  // .strip pill + Stop button can react. Fires whenever the active
  // session's loading state flips.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!activeSessionId) return;
    window.dispatchEvent(new CustomEvent('mc-chat-streaming', {
      detail: {
        namespace: NS.storagePrefix,
        sessionId: activeSessionId,
        streaming: !!loadingMap[activeSessionId],
      },
    }));
  }, [loadingMap, activeSessionId]);

  // Mirror streamingMap['{id}'] (the live activity label, e.g. "Pulling
  // CRM schema") → `mc-chat-active-agent` so the .strip's pulse pill
  // shows what the agent is currently doing.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!activeSessionId) return;
    const label = streamingMap[activeSessionId] || '';
    window.dispatchEvent(new CustomEvent('mc-chat-active-agent', {
      detail: {
        namespace: NS.storagePrefix,
        sessionId: activeSessionId,
        label: label.slice(0, 80),
      },
    }));
  }, [streamingMap, activeSessionId]);

  // ── Fusio composer button listeners ────────────────────────────────
  // Stop: abort the in-flight stream for the matching session.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (detail.namespace && detail.namespace !== NS.storagePrefix) return;
      const target = detail.sessionId || activeSessionId;
      if (!target) return;
      const ctl = abortControllers.current[target];
      if (ctl) {
        try { ctl.abort(); } catch { /* ignore */ }
      }
      setLoadingMap(prev => ({ ...prev, [target]: false }));
      setStreamingMap(prev => ({ ...prev, [target]: '' }));
    };
    window.addEventListener('mc-chat-stop', handler as EventListener);
    return () => window.removeEventListener('mc-chat-stop', handler as EventListener);
  }, [activeSessionId]);

  // New chat: fired by FusioSessions / FusioSidebar / FusioMobileSessionsDrawer
  // "+" button. Creates a fresh session in this ChatPanel instance and
  // makes it active. Namespace mapping: Sessions sends 'default' for the
  // main chat; ChatPanel's NS.storagePrefix is 'mc' for that same tab.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const eventNs = detail.namespace || 'default';
      const mappedNs = eventNs === 'default' ? 'mc' : eventNs;
      if (mappedNs !== NS.storagePrefix) return;
      createNewSession();
    };
    window.addEventListener('mc-chat-new', handler as EventListener);
    return () => window.removeEventListener('mc-chat-new', handler as EventListener);
  }, [NS.storagePrefix, sessions.length, props.lockedWorkspace, props.namespace]);

  // Omnibus action handler — FusioToolsMenu dispatches `mc-chat-action`
  // with { action, namespace } for every entry that needs ChatPanel state.
  // Each action maps to the same handler the inline button would have run.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const eventNs = detail.namespace || 'default';
      const mappedNs = eventNs === 'default' ? 'mc' : eventNs;
      if (mappedNs !== NS.storagePrefix) return;
      switch (detail.action) {
        case 'reset-session':
          if (activeSessionId) resetSession(activeSessionId);
          break;
        case 'clear-chat':
          clearChat();
          break;
        case 'compress-context':
          openCompressModal();
          break;
        case 'show-memory':
          setShowMemoryPanel(true);
          break;
        case 'show-subagents':
          setShowAgentsPanel(true);
          break;
        case 'show-reports':
          setShowReportDropdown(true);
          break;
        case 'link-chat':
          setShowLinkDropdown(true);
          break;
        case 'pull-cross-chat':
          setShowCrossChatPull(true);
          break;
        case 'ask-codex':
          setShowCodexModal(true);
          break;
        case 'gateway-session':
          setShowSessionDropdown(true);
          break;
        case 'deploy-constellation':
          setShowConstellationDeploy(true);
          break;
        case 'delegate-claude':
          openDelegateModal();
          break;
        case 'spawn-task':
          spawnTask();
          break;
        case 'attach-file':
          fileInputRef.current?.click();
          break;
        case 'project-assets': {
          const ws = activeSession?.workspace || getConfig().workspace;
          if (!ws) { alert('Set a workspace/project for this chat first.'); return; }
          if (!showAssets) fetchProjectAssets(ws);
          setShowAssets(prev => !prev);
          break;
        }
        case 'attach-github': {
          const fullName = prompt('GitHub repo (owner/name):');
          if (fullName && activeSessionId && /^[\w.-]+\/[\w.-]+$/.test(fullName)) {
            const name = fullName.split('/')[1];
            setSessions(prev => prev.map(s =>
              s.id === activeSessionId ? {
                ...s,
                githubRepo: { name, fullName, url: `https://github.com/${fullName}`, defaultBranch: 'main' },
              } : s
            ));
          }
          break;
        }
        case 'show-key-facts':
          // Key-facts panel is inline-rendered when there are facts; toggle
          // the memory panel as a reasonable surface for "show me facts".
          setShowMemoryPanel(true);
          break;
        case 'pair-mode-cycle': {
          if (!activeSessionId) return;
          const order: PairMode[] = ['solo', 'consult', 'debate', 'pair-build', 'autopilot'];
          const cur = (activeSession?.pairMode as PairMode | undefined) || 'solo';
          const idx = order.indexOf(cur);
          const next: PairMode = order[(idx + 1) % order.length];
          setSessions(prev => prev.map(s =>
            s.id === activeSessionId ? { ...s, pairMode: next, updatedAt: new Date() } : s
          ));
          break;
        }
        default:
          // Unknown action — silent, future-proof.
          break;
      }
    };
    window.addEventListener('mc-chat-action', handler as EventListener);
    return () => window.removeEventListener('mc-chat-action', handler as EventListener);
  }, [NS.storagePrefix, activeSessionId, activeSession, showAssets]);

  // Inject-skill from FusioRightRail Skills tab. Adds a system message
  // to the active session with a parseable skill marker (HTML comment +
  // 📚 prefix) so the existing parseSkillsFromContent effect picks it up
  // and pushes the skill name into activeSkills. Stacks on top of any
  // skills already active — clicking multiple times just appends.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const name = detail.name;
      if (!name || !activeSessionId) return;
      const description = detail.description ? ` — ${String(detail.description).slice(0, 200)}` : '';
      const content =
        `<!-- skill: ${name} -->\n` +
        `📚 Skill activated: **${name}**${description}\n\n` +
        `_The agent will reference this skill in subsequent responses. ` +
        `Click another in the Skills tab to stack additional context._`;
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSessionId) return s;
        const newMessage = {
          id: generateId(),
          role: 'system' as const,
          content,
          timestamp: new Date(),
        };
        return {
          ...s,
          messages: [...(s.messages || []), newMessage],
          updatedAt: new Date(),
        };
      }));
      // Also push into activeSkills directly so the chip updates without
      // waiting for an assistant response to parse-out the marker.
      setActiveSkills(prev => prev.includes(name) ? prev : [...prev, name]);
    };
    window.addEventListener('mc-chat-inject-skill', handler as EventListener);
    return () => window.removeEventListener('mc-chat-inject-skill', handler as EventListener);
  }, [activeSessionId]);

  // Chat-select from FusioSessions / FusioMobileSessionsDrawer: switch
  // this ChatPanel's active session to the picked id and hydrate its
  // messages if we don't already have them.
  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const eventNs = detail.namespace || 'default';
      const mappedNs = eventNs === 'default' ? 'mc' : eventNs;
      if (mappedNs !== NS.storagePrefix) return;
      const id = detail.id;
      if (!id || id === activeSessionId) return;
      setActiveSessionId(id);
      // Hydrate full messages for the picked session if we only have the
      // lite version (or haven't loaded it at all).
      try {
        const res = await fetch(`/api/chats?sessionId=${encodeURIComponent(id)}`, { cache: 'no-store' });
        const data = await res.json();
        if (data?.session) {
          const full = data.session;
          setSessions(prev => {
            const exists = prev.find(s => s.id === id);
            const hydrated = {
              ...(exists || {}),
              id: full.id,
              name: full.name,
              sessionKey: full.sessionKey,
              workspace: full.workspace,
              createdAt: new Date(full.createdAt),
              updatedAt: new Date(full.updatedAt),
              messages: (full.messages || []).map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) })),
            } as ChatSession;
            if (exists) return prev.map(s => s.id === id ? hydrated : s);
            return [hydrated, ...prev];
          });
        }
      } catch (err) {
        console.warn('[Chat] Failed to hydrate picked session:', err);
      }
    };
    window.addEventListener('mc-chat-select', handler as EventListener);
    return () => window.removeEventListener('mc-chat-select', handler as EventListener);
  }, [NS.storagePrefix, activeSessionId]);

  // Spawn task: open the existing spawn-task UI with the composer's
  // current text. We just open the modal — ChatPanel already has a
  // spawn-task flow; if the modal isn't visible yet, hold the text in a
  // ref so the modal can pre-fill on open. For now we surface it through
  // the same path as a normal sub-agent prompt by appending to the input.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (detail.namespace && detail.namespace !== NS.storagePrefix) return;
      const target = detail.sessionId || activeSessionId;
      const text = typeof detail.text === 'string' ? detail.text : '';
      if (!target || !text.trim()) return;
      // Pre-fill the spawn-task seed via input value ref, then let the
      // existing setShowDelegate / spawn UI take over. We just stage it
      // here for the upcoming modal open.
      try {
        sessionStorage.setItem(`${NS.storagePrefix}-spawn-seed-${target}`, text);
      } catch { /* ignore */ }
      // Open the existing delegate modal if available — many MC builds
      // use setShowDelegate; we look it up via window for tolerance.
      window.dispatchEvent(new CustomEvent('mc-open-spawn-task', {
        detail: { sessionId: target, text },
      }));
    };
    window.addEventListener('mc-chat-spawn-task', handler as EventListener);
    return () => window.removeEventListener('mc-chat-spawn-task', handler as EventListener);
  }, [activeSessionId]);

  // Undo: drop the last user + assistant turn from the active session,
  // then save. This is non-destructive (the messages still exist in the
  // chat file backup at data/chats/*.{id}.{ts}.json) but quickly removes
  // the latest turn from the live view.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (detail.namespace && detail.namespace !== NS.storagePrefix) return;
      const target = detail.sessionId || activeSessionId;
      if (!target) return;
      setSessions(prev => prev.map(s => {
        if (s.id !== target) return s;
        const msgs = [...(s.messages || [])];
        // Drop the trailing assistant first, then the user before it.
        if (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
        if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs.pop();
        return { ...s, messages: msgs };
      }));
    };
    window.addEventListener('mc-chat-undo', handler as EventListener);
    return () => window.removeEventListener('mc-chat-undo', handler as EventListener);
  }, [activeSessionId]);

  // Diagnose: drop the design's diagnose prompt into the composer for
  // the active session, then send it on the next tick.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (detail.namespace && detail.namespace !== NS.storagePrefix) return;
      const target = detail.sessionId || activeSessionId;
      if (!target) return;
      const prompt = "Diagnose this loop — we're going in circles. Please:\n\n1. State the root hypothesis in one sentence.\n2. List the two concrete signals you need to confirm it (logs/tests/outputs).\n3. Either run those checks yourself or ask me to run them before proposing another fix.";
      setInputMap(prev => ({ ...prev, [target]: prompt }));
      inputValueRefs.current[target] = prompt;
      if (target !== activeSessionId) setActiveSessionId(target);
      setTimeout(() => { sendMessage(); }, 30);
    };
    window.addEventListener('mc-chat-diagnose', handler as EventListener);
    return () => window.removeEventListener('mc-chat-diagnose', handler as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // ── Constellation: check if this chat has an active team ──────────
  useEffect(() => {
    if (NS.hideConstellationUi) { setLinkedTeamId(null); return; }
    if (!activeSession?.sessionKey) { setLinkedTeamId(null); return; }
    const checkTeam = async () => {
      try {
        const res = await fetch('/api/teams');
        const { teams } = await res.json();
        const linked = (teams || []).find((t: any) =>
          t.parent_chat_key === activeSession.sessionKey && !t.archived_at
        );
        if (linked) {
          setLinkedTeamId(linked.id);
          setLinkedTeamStatus(linked.status);
          setLinkedTeamName(linked.constellation || linked.name);
          // Fetch task summary
          try {
            const tRes = await fetch(`/api/teams/${linked.id}`);
            const tData = await tRes.json();
            if (tData.summary) {
              setLinkedTeamProgress(`${tData.summary.done}/${tData.summary.total}`);
            }
          } catch { /* ignore */ }
        } else {
          setLinkedTeamId(null);
          setLinkedTeamStatus(null);
          setLinkedTeamName(null);
        }
      } catch { /* ignore */ }
    };
    checkTeam();
    const interval = setInterval(checkTeam, 5000);
    return () => clearInterval(interval);
  }, [activeSession?.sessionKey]);

  // Load tasks when session changes
  useEffect(() => {
    if (activeSessionId) {
      loadTasksFromStorage(activeSessionId).then(({ tasks, currentTaskId, isMinimized }) => {
        setTaskHistory(tasks);
        
        // Restore the current task by ID, or find most recent active one
        let taskToRestore: ActiveTask | null = null;
        if (currentTaskId) {
          taskToRestore = tasks.find(t => t.id === currentTaskId) || null;
        }
        // Fallback: find any running task
        if (!taskToRestore) {
          taskToRestore = tasks.find(t => 
            t.status === 'running' || t.status === 'paused' || 
            t.status === 'loading' || t.status === 'clarifying'
          ) || null;
        }
        
        setActiveTask(taskToRestore);
        setIsTaskMinimized(isMinimized ?? false);
      });
    } else {
      setTaskHistory([]);
      setActiveTask(null);
      setIsTaskMinimized(false);
    }
  }, [activeSessionId]);

  // Sync activeTask changes to history (persists to localStorage)
  useEffect(() => {
    if (activeTask && activeSessionId) {
      updateTaskInHistory(activeTask);
    }
  }, [activeTask]);

  // Save when minimize state changes
  useEffect(() => {
    if (activeSessionId && taskHistory.length > 0) {
      saveTasksToStorage(activeSessionId, taskHistory, activeTask?.id, isTaskMinimized);
    }
  }, [isTaskMinimized]);

  const [serverConfig, setServerConfig] = useState<any>(null);

  // Fetch server config on mount if localStorage doesn't have token
  useEffect(() => {
    const localConfig = JSON.parse(localStorage.getItem('gatewayConfig') || '{}');

    // One-shot migration: legacy default workspace → MyMobileApp.
    // The legacy default sent every chat into the openclaw workspace, which is
    // almost never what we want. New chats should target the user's primary
    // project. Existing per-chat workspaces (ChatSession.workspace) are not
    // touched — only the global default for *new* chats is updated.
    const LEGACY_WS = '~/.openclaw/workspace';
    const FIELDREPAPP_WS = '~/<your-mobile-app>';
    if ((localConfig.workspace === LEGACY_WS || !localConfig.workspace)
        && !localStorage.getItem('mc:workspaceMigratedV1')) {
      localConfig.workspace = FIELDREPAPP_WS;
      localStorage.setItem('gatewayConfig', JSON.stringify(localConfig));
      localStorage.setItem('mc:workspaceMigratedV1', '1');
    }

    if (!localConfig.token) {
      fetch('/api/config')
        .then(res => res.json())
        .then(cfg => {
          if (cfg.token) {
            setServerConfig(cfg);
            // Re-read localConfig after migration may have updated it.
            // CRITICAL: cfg goes FIRST, localConfig SECOND, so the user's
            // explicit workspace choice wins over the server default.
            const fresh = JSON.parse(localStorage.getItem('gatewayConfig') || '{}');
            localStorage.setItem('gatewayConfig', JSON.stringify({
              ...cfg,
              ...fresh,
            }));
          }
        })
        .catch(e => console.error('Failed to fetch server config:', e));
    }
  }, []);

  // Load saved environment preference
  useEffect(() => {
    const savedEnv = localStorage.getItem('activeEnvironment') as Environment | null;
    if (savedEnv && savedEnv === 'production') {
      setActiveEnvironment(savedEnv);
    }
  }, []);

  // Fetch token usage when switching sessions
  useEffect(() => {
    if (activeSessionId) {
      fetchTokenUsage(activeSessionId);
    }
  }, [activeSessionId]);

  // Poll for sub-agents when a chat session is active
  useEffect(() => {
    const fetchSubAgents = async () => {
      if (!activeSessionId) return;
      
      try {
        const response = await fetch('/api/subagents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        if (response.ok) {
          const data = await response.json();
          const newSubAgents: SubAgent[] = (data.subAgents || []).map((sa: any) => ({
            key: sa.key,
            label: sa.label,
            status: sa.status,
            lastMessage: sa.lastMessage || sa.task?.slice(0, 100) || '',
            startedAt: new Date(sa.startedAt),
            endedAt: sa.endedAt ? new Date(sa.endedAt) : null,
            durationMs: sa.durationMs || null,
            task: sa.task || '',
            model: sa.model || 'default',
            resultPreview: sa.resultPreview || '',
            resultFull: sa.resultFull || '',
          }));

          // On first poll, pre-seed notifiedSubAgentsRef with already-completed agents
          // so we don't re-fire completion notices for old agents on page refresh
          if (!notifiedSubAgentsInitialized.current) {
            notifiedSubAgentsInitialized.current = true;
            newSubAgents.forEach(agent => {
              if (agent.status === 'complete' || agent.status === 'failed') {
                notifiedSubAgentsRef.current.add(agent.key);
              }
            });
          }

          // Only tag TRULY NEW sub-agents (ones we've never seen before in any poll)
          const currentChatId = activeSessionId || '';
          let mapChanged = false;
          setAllSubAgents(prevAgents => {
            const prevKeys = new Set(prevAgents.map(a => a.key));
            newSubAgents.forEach(agent => {
              // Only tag if: 1) not in our map AND 2) wasn't in the previous poll (truly new)
              if (!subAgentChatMap.current[agent.key] && !prevKeys.has(agent.key)) {
                subAgentChatMap.current[agent.key] = currentChatId;
                mapChanged = true;
              }
            });
            if (mapChanged) {
              try { localStorage.setItem('subAgentChatMap', JSON.stringify(subAgentChatMap.current)); } catch { /* */ }
            }
            // Detect newly completed/failed agents — rich notifications handled by SubAgentTracker.onCompletionNotice
            return newSubAgents;
          });

          // Auto-nudge: when running sub-agents drop from >0 to 0, poke the chat
          // so the main agent picks up where it left off (it yielded waiting for results)
          const currentRunning = newSubAgents.filter(a => {
            const mapped = subAgentChatMap.current[a.key];
            return mapped === currentChatId && a.status === 'running';
          }).length;
          
          if (prevRunningCount.current > 0 && currentRunning === 0) {
            console.log('[SubAgents] All sub-agents finished — nudging chat', currentChatId);
            // Small delay to let the gateway finalize
            setTimeout(() => {
              const session = sessions.find(s => s.id === currentChatId);
              if (!session) return;
              const { workspace } = getConfig();
              const sk = session.sessionKey;
              if (!sk) return;
              // Send a nudge message to continue after sub-agents complete
              fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  messages: [{ role: 'user', content: '[All sub-agents have completed. Please review their results and continue.]' }],
                  sessionKey: sk,
                  requestId: `nudge-${currentChatId}-${Date.now()}`,
                  workspace,
                }),
              }).then(async (res) => {
                if (!res.ok) return;
                // Stream the nudge response into the chat
                const reader = res.body?.getReader();
                if (!reader) return;
                const decoder = new TextDecoder();
                let nudgeContent = '';
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  const chunk = decoder.decode(value, { stream: true });
                  for (const line of chunk.split('\n')) {
                    if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
                      try {
                        const delta = JSON.parse(line.slice(6))?.choices?.[0]?.delta?.content;
                        if (delta) nudgeContent += delta;
                      } catch {}
                    }
                  }
                }
                if (nudgeContent) {
                  const msg: Message = {
                    id: generateId(),
                    role: 'assistant',
                    content: nudgeContent,
                    timestamp: new Date(),
                  };
                  // Use the safe append (functional setSessions) — reading
                  // sessions from the closure here is stale and would erase
                  // any messages added during the stream.
                  appendSessionMessage(currentChatId, msg);
                }
              }).catch(() => {});
            }, 2000);
          }
          prevRunningCount.current = currentRunning;

        }
      } catch (error) {
        // Silent fail - don't spam errors
      }
    };

    if (activeSessionId) {
      // Initial fetch
      fetchSubAgents();
      
      // Poll every 5 seconds
      subAgentPollInterval.current = setInterval(fetchSubAgents, 5000);
    }

    return () => {
      if (subAgentPollInterval.current) {
        clearInterval(subAgentPollInterval.current);
        subAgentPollInterval.current = null;
      }
    };
  }, [activeSessionId]);

  // Save environment preference when changed
  const toggleEnvironment = () => {
    const newEnv: Environment = 'production';
    if (newEnv === 'production') {
      const confirmed = window.confirm(
        '⚠️ Switch to PRODUCTION?\n\n' +
        'This means:\n' +
        '• Deploys go to example.com / app.example.com\n' +
        '• Database changes affect LIVE users\n' +
        '• Git operations target the main branch\n\n' +
        'Are you sure?'
      );
      if (!confirmed) return;
    }
    setActiveEnvironment(newEnv);
    localStorage.setItem('activeEnvironment', newEnv);
  };

  const getConfig = () => {
    const localConfig = JSON.parse(localStorage.getItem('gatewayConfig') || '{}');
    const config = { ...serverConfig, ...localConfig };
    const globalWorkspace = config.workspace || '';
    const workspace = activeSession?.workspace || globalWorkspace;
    // Keep gatewayUrl/token as empty strings for backwards compat with any remaining callers
    return { gatewayUrl: '', token: '', workspace, globalWorkspace };
  };

  const setSessionWorkspace = (workspace: string | undefined) => {
    if (!activeSessionId) return;
    setSessions(prev => prev.map(s =>
      s.id === activeSessionId ? { ...s, workspace } : s
    ));
    setShowWorkspaceDropdown(false);
    setWorkspaceInput('');
  };

  // Get list of recent workspaces from all sessions + global
  const getRecentWorkspaces = (): string[] => {
    const config = JSON.parse(localStorage.getItem('gatewayConfig') || '{}');
    const workspaces = new Set<string>();
    
    // Add global workspace first if set
    if (config.workspace) {
      workspaces.add(config.workspace);
    }
    
    // Add workspaces from other sessions
    sessions.forEach(s => {
      if (s.workspace && s.id !== activeSessionId) {
        workspaces.add(s.workspace);
      }
    });
    
    return Array.from(workspaces);
  };

  // Token usage is now tracked via SSE 'usage' events from the CLI result.
  // This function is kept as a no-op for any callers that still reference it.
  const fetchTokenUsage = async (_sessionId: string) => {
    // Real token data arrives via the usage SSE event in sendMessage()
  };

  // Reset session context — deletes CLI session mapping so next message starts fresh
  const resetOpenClawSession = async () => {
    if (!activeSession?.sessionKey || !activeSessionId) return;

    try {
      // Delete the CLI session mapping so next message creates a fresh session
      await fetch('/api/session-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: activeSession.sessionKey }),
      });

      // Clear context snapshot
      setSessions(prev => prev.map(s =>
        s.id === activeSessionId
          ? { ...s, contextSnapshot: undefined, contextSnapshotAt: undefined }
          : s
      ));

      const resetMsg: Message = {
        id: generateId(),
        role: 'system',
        content: '🔄 **Session context reset** — next message will start a fresh Claude Code session. Chat history preserved locally.',
        timestamp: new Date(),
      };
      // FIX (data loss): use functional append so messages sent during the
      // async resetSession call can't be wiped by a stale `allMessages` closure.
      appendSessionMessage(activeSessionId, resetMsg);

      // Clear token usage
      setTokenUsageMap(prev => ({ ...prev, [activeSessionId]: null }));
    } catch (e: any) {
      console.error('[Reset] Failed:', e);
      const errorMsg: Message = {
        id: generateId(),
        role: 'system',
        content: `❌ Failed to reset session: ${e.message}`,
        timestamp: new Date(),
      };
      appendSessionMessage(activeSessionId, errorMsg);
    }
  };

  // Context Compression Functions
  const openCompressModal = async () => {
    if (!activeSessionId) return;
    setShowCompressModal(true);
    setCompressResult(null);
    setCompressPreview(null);
    setCompressLoading(true);

    const { workspace: _ws } = getConfig();
    try {
      const res = await fetch('/api/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({

          messages: allMessages.map(m => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
          })),
          mode: 'preview',
        }),
      });
      const data = await res.json();
      if (data.stats) {
        setCompressPreview(data.stats);
      }
    } catch (e: any) {
      console.error('[Compress] Preview error:', e);
    } finally {
      setCompressLoading(false);
    }
  };

  /** Background auto-compression. Triggered when the post-turn token meter
   *  crosses 80% AND no compression has fired in the last 5 min. Runs the
   *  same /api/compress flow but applies the snapshot silently and resets
   *  the CLI session so the next turn starts lean. The user gets a single
   *  system message showing before/after sizes; no modal interruption. */
  const autoCompressInFlightRef = useRef<Set<string>>(new Set());
  const autoCompressLastAtRef = useRef<Record<string, number>>({});
  const autoCompressIfHigh = async (targetSessionId: string): Promise<void> => {
    if (!targetSessionId) return;
    if (autoCompressInFlightRef.current.has(targetSessionId)) return;
    const last = autoCompressLastAtRef.current[targetSessionId] || 0;
    if (Date.now() - last < 5 * 60_000) return; // dedupe within 5 min
    const usage = tokenUsageMap[targetSessionId];
    if (!usage || usage.max <= 0) return;
    if (usage.used / usage.max < 0.80) return;
    // CRITICAL: never compress while a stream is in-flight on this chat —
    // applying the snapshot resets the CLI session and aborts the open
    // request, which is what was making messages disappear mid-response.
    if (loadingMap[targetSessionId]) {
      console.log('[autoCompress] deferred — stream in-flight on', targetSessionId);
      return;
    }

    autoCompressInFlightRef.current.add(targetSessionId);
    autoCompressLastAtRef.current[targetSessionId] = Date.now();

    const startedMsg: Message = {
      id: generateId(),
      role: 'system',
      content: `🗜️ **Auto-compressing context…** ${Math.round(usage.used / usage.max * 100)}% full (${Math.round(usage.used / 1000)}K / ${Math.round(usage.max / 1000)}K tokens). This takes ~30 s and runs in the background — keep typing.`,
      timestamp: new Date(),
    };
    appendSessionMessage(targetSessionId, startedMsg);

    try {
      const sess = sessions.find(s => s.id === targetSessionId);
      const sessionMessages = sess?.messages || [];
      const truncated = sessionMessages
        .filter(m => m.role !== 'system')
        .slice(-200)
        .map(m => ({
          role: m.role,
          content: (m.content || '').slice(0, 3000) + ((m.content || '').length > 3000 ? '...[truncated]' : ''),
        }));
      const res = await fetch('/api/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: truncated,
          mode: 'compress',
          keyFacts: sess?.keyFacts || [],
        }),
      });
      const data = await res.json();
      if (data.error || !data.summary) throw new Error(data.error || 'empty summary');

      // If a turn started during the compress round-trip, defer the apply
      // and warn — applying now would reset the CLI session mid-stream.
      if (loadingMap[targetSessionId]) {
        const deferMsg: Message = {
          id: generateId(),
          role: 'system',
          content: `🗜️ Compression ready but a turn is in-flight — will apply when this reply finishes. Send "compress" or use Tools ▾ → Compress context to apply manually.`,
          timestamp: new Date(),
        };
        appendSessionMessage(targetSessionId, deferMsg);
        // Stash the pending snapshot so a later trigger could apply it.
        autoCompressLastAtRef.current[targetSessionId] = 0;
        return;
      }

      // Apply snapshot — mirror applyCompression's replace path. Use functional
      // setSessions so any messages added during the compress round-trip survive.
      // We DO NOT call resetSession() here: that aborts in-flight streams and
      // clears streamingMap, which is what was nuking your messages mid-reply.
      // The snapshot takes effect on the NEXT user message via the
      // contextSnapshot branch in /api/chat — old session keeps its CLI state
      // until then, but the next prompt sends only [snapshot + last N msgs].
      const keep = compressKeepCount || 10;
      setSessions(prev => prev.map(s => {
        if (s.id !== targetSessionId) return s;
        const curLen = s.messages.length;
        const newKey = `${NS.sessionKeyPrefix}-${s.id.slice(0, 8)}-${Date.now()}`;
        return {
          ...s,
          contextSnapshot: data.summary,
          contextSnapshotAt: Math.max(0, curLen - keep),
          // Rotate sessionKey so the SDK starts a fresh CLI session on the
          // next turn — guarantees the bloated transcript doesn't carry over.
          // Safe because there's no in-flight stream at this point (checked
          // above), so nothing's listening on the old key.
          sessionKey: newKey,
          updatedAt: new Date(),
        };
      }));
      // Clear the stale meter reading so the UI doesn't keep showing the
      // old pre-compress number until the next turn replaces it.
      setTokenUsageMap(prev => ({ ...prev, [targetSessionId]: null }));

      const stats = data.stats || {};
      const ratio = stats.ratio ?? '?';
      const orig = stats.originalMessages ?? truncated.length;
      const compressedTokens = stats.compressedTokens ?? 0;
      const doneMsg: Message = {
        id: generateId(),
        role: 'system',
        content: `🗜️ **Context auto-compressed** — ${orig} messages → ${Math.round(compressedTokens / 1000)}K-token summary (${ratio}% smaller). Keeping the last ${keep} messages live. Everything is still visible above.`,
        timestamp: new Date(),
      };
      appendSessionMessage(targetSessionId, doneMsg);
    } catch (e: any) {
      console.error('[autoCompress] failed:', e);
      const failMsg: Message = {
        id: generateId(),
        role: 'system',
        content: `⚠️ Auto-compression failed: ${e?.message || 'unknown error'}. Try **Tools ▾ → Compress context** manually.`,
        timestamp: new Date(),
      };
      appendSessionMessage(targetSessionId, failMsg);
      // Allow another attempt after the dedupe window
      autoCompressLastAtRef.current[targetSessionId] = 0;
    } finally {
      autoCompressInFlightRef.current.delete(targetSessionId);
    }
  };

  const runCompression = async () => {
    if (!activeSessionId) return;
    const { workspace } = getConfig();

    setCompressLoading(true);
    setCompressResult(null);

    try {
      const savePath = compressMode === 'save' && workspace
        ? `${workspace}/context-summaries/chat-${activeSessionId.slice(0, 8)}-${Date.now()}.md`
        : undefined;

      // Pre-truncate messages client-side to keep payload under ~500KB
      // Each message gets capped at 3000 chars, and we send max 200 messages
      const truncatedMessages = allMessages
        .filter(m => m.role !== 'system')
        .slice(-200) // Keep most recent 200 messages
        .map(m => ({
          role: m.role,
          content: (m.content || '').slice(0, 3000) + ((m.content || '').length > 3000 ? '...[truncated]' : ''),
        }));

      const res = await fetch('/api/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: truncatedMessages,
          mode: compressMode === 'save' ? 'save' : 'compress',
          savePath,
          keyFacts: activeSession?.keyFacts || [],
        }),
      });

      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }

      setCompressResult(data);
    } catch (e: any) {
      console.error('[Compress] Error:', e);
      const errorMsg: Message = {
        id: generateId(),
        role: 'system',
        content: `❌ Compression failed: ${e.message}`,
        timestamp: new Date(),
      };
      // FIX (data loss): functional append instead of stale-closure replace.
      appendSessionMessage(activeSessionId, errorMsg);
      setShowCompressModal(false);
    } finally {
      setCompressLoading(false);
    }
  };

  const applyCompression = () => {
    if (!activeSessionId || !compressResult?.summary) return;

    if (compressMode === 'replace') {
      // Store the compressed summary on the session — messages stay untouched visually.
      // The snapshot replaces old messages in the API payload, but the UI still shows everything.
      // FIX (data loss): use the session's CURRENT message count to compute the snapshot
      // index, not a stale `allMessages.length` captured when the modal opened. If messages
      // were sent during compression, that stale length would be too small and would cause
      // both an incorrect snapshotAt AND a message-deleting overwrite below.
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSessionId) return s;
        const curLen = s.messages.length;
        const snapshotIndex = Math.max(0, curLen - compressKeepCount);
        return {
          ...s,
          contextSnapshot: compressResult.summary,
          contextSnapshotAt: snapshotIndex,
          updatedAt: new Date(),
        };
      }));

      // Add a visual marker so the user knows compression happened (but don't delete anything)
      const markerMsg: Message = {
        id: generateId(),
        role: 'system',
        content: `🗜️ **Context compressed** — ${compressResult.stats.originalMessages} messages summarized (${compressResult.stats.ratio}% reduction). All messages still visible above. The AI now uses the compressed summary + last ${compressKeepCount} messages for context.`,
        timestamp: new Date(),
      };
      // FIX (data loss, root cause of chat 11 incident): use functional append
      // so any messages the user sent during the /api/compress roundtrip (up to
      // 4 minutes long) survive. The old path used a stale `allMessages`.
      appendSessionMessage(activeSessionId, markerMsg);

      // Reset CLI session so next message starts fresh with compressed context + last N messages
      resetSession(activeSessionId);
      
      // Clear stale token usage so the UI doesn't show the old 772K number
      setTokenUsageMap(prev => ({ ...prev, [activeSessionId]: null }));
    } else {
      // Save mode — just add a note that it was saved
      const savedMsg: Message = {
        id: generateId(),
        role: 'system',
        content: `📁 **Context saved** to \`${compressResult.savedTo}\`\n\n${compressResult.stats.ratio}% compression (${compressResult.stats.originalMessages} messages → ~${compressResult.stats.compressedTokens.toLocaleString()} tokens)`,
        timestamp: new Date(),
      };
      // FIX (data loss): functional append.
      appendSessionMessage(activeSessionId, savedMsg);
    }

    setShowCompressModal(false);
    setCompressResult(null);
    setCompressPreview(null);
  };

  // Fetch directory contents for file browser
  const fetchBrowserContents = async (dirPath: string = '', search: string = '') => {
    setBrowserLoading(true);
    try {
      const params = new URLSearchParams();
      if (dirPath) params.set('path', dirPath);
      if (search) params.set('search', search);
      
      const response = await fetch(`/api/browse?${params}`);
      const data = await response.json();
      
      if (data.error) {
        console.error('[Browser]', data.error);
        return;
      }
      
      setBrowserPath(data.path || '');
      setBrowserItems(data.items || []);
      setBrowserParent(data.parent);
      setBrowserIsProject(data.isProject || false);
    } catch (error) {
      console.error('[Browser] Error:', error);
    } finally {
      setBrowserLoading(false);
    }
  };

  // Open file browser when dropdown opens
  useEffect(() => {
    if (showWorkspaceDropdown) {
      fetchBrowserContents(activeSession?.workspace || '');
    }
  }, [showWorkspaceDropdown]);

  const createNewSession = () => {
    const sessionId = generateId();
    const sessionKey = `${NS.sessionKeyPrefix}-${sessionId.slice(0, 8)}-${Date.now()}`;
    const { globalWorkspace } = getConfig();

    const newSession: ChatSession = {
      id: sessionId,
      name: `Chat ${sessions.length + 1}`,
      sessionKey,
      // Prefer props.lockedWorkspace (SEO) → global workspace → undefined
      workspace: props.lockedWorkspace || globalWorkspace || undefined,
      messages: [{
        id: generateId(),
        role: 'system',
        content: props.namespace === 'seo'
          ? 'SEO Chat started. Try `/research <topic>`, `/write <topic>`, or `/optimize <file>`. The SEO Machine agents (content-analyzer, seo-optimizer, meta-creator, internal-linker, keyword-mapper, editor, performance, headline-generator, cro-analyst, landing-page-optimizer) are loaded from the workspace.'
          : 'New conversation started. Send a message to chat with your agent.',
        timestamp: new Date(),
      }],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setSessions(prev => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
  };

  const deleteSession = (sessionId: string) => {
    if (sessions.length <= 1) {
      // Don't delete the last session, just clear it
      clearChat();
      return;
    }
    
    setSessions(prev => prev.filter(s => s.id !== sessionId));
    if (activeSessionId === sessionId) {
      const remaining = sessions.filter(s => s.id !== sessionId);
      if (remaining.length > 0) {
        setActiveSessionId(remaining[0].id);
      }
    }
  };
  
  const resetSession = (sessionId: string) => {
    const oldSession = sessions.find(s => s.id === sessionId);
    const oldSessionKey = oldSession?.sessionKey;

    // Regenerate session key → next message creates a fresh CLI session
    const newKey = `${NS.sessionKeyPrefix}-${sessionId.slice(0, 8)}-${Date.now()}`;
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, sessionKey: newKey } : s));
    localStorage.removeItem('chat_active_request');
    if (abortControllers.current[sessionId]) {
      try { abortControllers.current[sessionId].abort(); } catch {}
      abortControllers.current[sessionId] = null as any;
    }
    setLoadingMap(prev => ({...prev, [sessionId]: false}));
    setStreamingMap(prev => ({...prev, [sessionId]: ""}));

    // Kill any running CLI process and delete the session mapping
    if (oldSessionKey) {
      fetch('/api/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: oldSessionKey }),
      }).catch(() => {});
      fetch('/api/session-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: oldSessionKey }),
      }).catch(() => {});
    }

    console.log("[Chat] Session reset with new key:", newKey);
  };

  const renameSession = (sessionId: string, newName: string) => {
    setSessions(prev => prev.map(s => 
      s.id === sessionId ? { ...s, name: newName.trim() || s.name } : s
    ));
    setEditingSessionId(null);
  };

  const startEditingSession = (session: ChatSession) => {
    setEditingSessionId(session.id);
    setEditingName(session.name);
  };

  // Only scroll to bottom for new messages, not when loading history
  const prevMessageCountRef = useRef(0);
  useEffect(() => {
    // Only scroll if a new message was added (not bulk history load)
    if (messages.length > 0 && messages.length <= prevMessageCountRef.current + 2) {
      scrollToBottom();
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length, streamingContent]);

  // Track loading elapsed time
  useEffect(() => {
    if (isLoading) {
      setLoadingElapsed(0);
      const timer = setInterval(() => {
        setLoadingElapsed(prev => prev + 1);
      }, 1000);
      return () => clearInterval(timer);
    } else {
      setLoadingElapsed(0);
    }
  }, [isLoading]);

  // Close workspace dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (workspaceDropdownRef.current && !workspaceDropdownRef.current.contains(e.target as Node)) {
        setShowWorkspaceDropdown(false);
      }
    };
    
    if (showWorkspaceDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showWorkspaceDropdown]);

  // Close session dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (sessionDropdownRef.current && !sessionDropdownRef.current.contains(e.target as Node)) {
        setShowSessionDropdown(false);
      }
    };
    
    if (showSessionDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showSessionDropdown]);

  // Close link dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (linkDropdownRef.current && !linkDropdownRef.current.contains(e.target as Node)) {
        setShowLinkDropdown(false);
      }
    };
    
    if (showLinkDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showLinkDropdown]);

  // Clear linked sessions if their targets get deleted
  useEffect(() => {
    const sessionIds = new Set(sessions.map(s => s.id));
    setLinkedSessionMap(prev => {
      const next = { ...prev };
      let changed = false;
      for (const [chatId, linkedId] of Object.entries(next)) {
        if (!sessionIds.has(linkedId)) {
          delete next[chatId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  // Close agents panel when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (agentsPanelRef.current && !agentsPanelRef.current.contains(e.target as Node)) {
        setShowAgentsPanel(false);
      }
    };
    if (showAgentsPanel) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showAgentsPanel]);

  // Close report dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (reportDropdownRef.current && !reportDropdownRef.current.contains(e.target as Node)) {
        setShowReportDropdown(false);
      }
    };
    
    if (showReportDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showReportDropdown]);

  // Fetch reports when dropdown opens
  const fetchReports = async () => {
    setReportsLoading(true);
    try {
      const response = await fetch('/api/reports');
      const data = await response.json();
      if (data.reports) {
        setReports(data.reports);
      }
    } catch (error) {
      console.error('[Reports] Error fetching:', error);
    } finally {
      setReportsLoading(false);
    }
  };

  useEffect(() => {
    if (showReportDropdown) {
      fetchReports();
    }
  }, [showReportDropdown]);

  // Add report to chat input
  const addReportToChat = (report: any) => {
    const typeEmoji = report.type === 'bug' ? '🐛' : report.type === 'feature' ? '✨' : '📝';
    const priorityEmoji = report.priority === 'high' ? '🔴' : report.priority === 'medium' ? '🟡' : '🟢';
    
    // Build a complete inline report with all details the agent needs
    const consoleErrors = (report.consoleErrors || []).slice(0, 5).map((e: string) => `  - ${e}`).join('\n');
    const elementHtml = report.elementHtml || report.element?.innerHTML?.slice(0, 300) || '';
    
    let reportText = `${typeEmoji} **Report #${report.shortId || report.id.slice(0, 4)}** ${priorityEmoji} Priority: ${report.priority || 'medium'}
**Type:** ${report.type}
**Page:** ${report.pageUrl || report.page?.url || 'unknown'}
**Page Title:** ${report.pageTitle || report.page?.title || ''}
**Element:** \`${report.elementSelector || report.element?.selector || ''}\`
**Message:** ${report.message || '(no message)'}
`;

    if (consoleErrors) {
      reportText += `**Console Errors:**\n${consoleErrors}\n`;
    }
    
    if (elementHtml) {
      reportText += `**Element HTML:**\n\`\`\`html\n${elementHtml}\n\`\`\`\n`;
    }

    if (report.page?.viewport) {
      reportText += `**Viewport:** ${report.page.viewport.width}×${report.page.viewport.height}\n`;
    }
    
    if (report.userAgent) {
      reportText += `**Browser:** ${report.userAgent.slice(0, 100)}\n`;
    }

    reportText += '\n';

    // If there's a screenshot, attach it as an image
    const screenshotUrl = report.screenshot?.dataUrl || report.screenshotUrl;
    if (screenshotUrl && activeSessionId) {
      const attachment: Attachment = {
        id: generateId(),
        name: `report-${report.shortId || report.id?.slice(0, 4) || 'screenshot'}.png`,
        type: 'image/png',
        size: 0,
        url: screenshotUrl,
      };
      setAttachmentMap(prev => ({
        ...prev,
        [activeSessionId]: [...(prev[activeSessionId] || []), attachment],
      }));
    }

    setInputMap(prev => ({...prev, [activeSessionId || '']: (prev[activeSessionId || ''] || '') + reportText}));
    setShowReportDropdown(false);
    inputRef.current?.focus();
  };

  // Close message menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (messageMenuRef.current && !messageMenuRef.current.contains(e.target as Node)) {
        setActiveMessageMenu(null);
      }
    };
    
    if (activeMessageMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [activeMessageMenu]);

  // Message action handlers
  const handleCopyMessage = async (content: string) => {
    await navigator.clipboard.writeText(content);
    setActiveMessageMenu(null);
  };

  const handleResendMessage = (content: string) => {
    setInputMap(prev => ({...prev, [activeSessionId || '']: content}));
    setActiveMessageMenu(null);
    inputRef.current?.focus();
  };

  const handleQuoteMessage = (content: string, role: string) => {
    const quotedContent = content.split('\n').map(line => `> ${line}`).join('\n');
    const prefix = role === 'assistant' ? '**Agent said:**\n' : '**I said:**\n';
    setInputMap(prev => ({...prev, [activeSessionId || '']: (prev[activeSessionId || ''] || '') + (prev[activeSessionId || ''] ? '\n\n' : '') + prefix + quotedContent + '\n\n'}));
    setActiveMessageMenu(null);
    inputRef.current?.focus();
  };

  const handleDeleteMessage = (messageId: string) => {
    if (!activeSessionId) return;
    const updated = allMessages.filter(m => m.id !== messageId);
    updateSessionMessages(activeSessionId, updated);
    setActiveMessageMenu(null);
  };

  const mutateMessage = (messageId: string, patch: Partial<Message>) => {
    if (!activeSessionId) return;
    const updated = allMessages.map(m => m.id === messageId ? { ...m, ...patch } : m);
    updateSessionMessages(activeSessionId, updated);
  };

  const handleRateMessage = (messageId: string, sentiment: 'up' | 'down' | null) => {
    mutateMessage(messageId, { sentiment: sentiment ?? undefined });
    // Feed the signal to mem so retrieval can down-rank rejected approaches.
    if (sentiment === 'down' && activeSession?.sessionKey) {
      const target = allMessages.find(m => m.id === messageId);
      if (target) {
        fetch('/api/memory/tick', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionKey: activeSession.sessionKey,
            kind: 'down_rank',
            hint: (target.content || '').slice(0, 800),
          }),
        }).catch(() => { /* best-effort signal */ });
      }
    }
  };

  const handlePinMessage = (messageId: string, pinned: boolean) => {
    mutateMessage(messageId, { pinned: pinned ? true : undefined });
  };
  const handleResolveMessage = (messageId: string, resolved: boolean) => {
    mutateMessage(messageId, { resolved: resolved ? true : undefined });
  };

  // Pair-mode: approve the synthesized plan card. Sets the pendingPairExecuteRef
  // and fires sendMessage with a synthetic prompt — the body builder then
  // overrides mode to 'pair-build-execute' and includes the approved plan.
  const handlePairApprove = (messageId: string, plan: PlanCardData) => {
    if (!activeSessionId) return;
    pendingPairExecuteRef.current = { sessionId: activeSessionId, plan, messageId };
    // Stash the plan for later (e.g. answering a paused autopilot question).
    if (plan.phases && plan.phases.length > 0) {
      lastAutopilotPlanRef.current[activeSessionId] = plan;
    }
    const synthetic = plan.phases && plan.phases.length > 0
      ? `🚦 Plan approved — start autopilot through ${plan.phases.length} phase${plan.phases.length === 1 ? '' : 's'}.`
      : '✅ Plan approved — implement it now.';
    setInputMap(prev => ({ ...prev, [activeSessionId]: synthetic }));
    inputValueRefs.current[activeSessionId] = synthetic;
    // Fire on the next tick so input state is committed before sendMessage reads it.
    setTimeout(() => { sendMessage(); }, 0);
  };

  // Autopilot: user answers a paused Codex question. Resumes the run from
  // the SAME phase + attempt count Codex was blocked on (no wasted attempts),
  // with the user's answer threaded into Claude's next implementation prompt
  // and the prior audit history so Codex doesn't repeat itself.
  const handleAutopilotAnswer = (phaseIndex: number, answer: string, resumeAttempt?: number, auditHistory?: string[]) => {
    if (!activeSessionId) return;
    const plan = lastAutopilotPlanRef.current[activeSessionId];
    if (!plan) {
      setInputMap(prev => ({ ...prev, [activeSessionId]: answer }));
      inputValueRefs.current[activeSessionId] = answer;
      setTimeout(() => { sendMessage(); }, 0);
      return;
    }
    pendingAutopilotResumeRef.current = {
      sessionId: activeSessionId,
      plan,
      phaseIndex,
      answer,
      resumeAttempt,
      auditHistory,
    };
    const visible = `↪ Answer for Phase ${phaseIndex}: ${answer}`;
    setInputMap(prev => ({ ...prev, [activeSessionId]: visible }));
    inputValueRefs.current[activeSessionId] = visible;
    setTimeout(() => { sendMessage(); }, 0);
  };

  // Autopilot: phase-stuck retry — bump rework cap and resume from same
  // phase + attempt count, carrying the audit history so Codex picks up
  // its prior line of reasoning.
  const handlePhaseRetryWithBumpedCap = (
    messageId: string,
    phaseIndex: number,
    resumeAttempt: number,
    auditHistory: string[],
    additionalAttempts: number,
  ) => {
    if (!activeSessionId) return;
    const plan = lastAutopilotPlanRef.current[activeSessionId];
    if (!plan) return;
    const newCap = (plan.rework_cap ?? 5) + additionalAttempts;
    pendingAutopilotResumeRef.current = {
      sessionId: activeSessionId,
      plan,
      phaseIndex,
      answer: '', // no user answer for a retry — just bump the cap
      resumeAttempt,
      auditHistory,
      overrideReworkCap: newCap,
    };
    mutateMessage(messageId, { phaseStuckResolved: true } as any);
    const visible = `↻ Retry Phase ${phaseIndex} with cap bumped to ${newCap}.`;
    setInputMap(prev => ({ ...prev, [activeSessionId]: visible }));
    inputValueRefs.current[activeSessionId] = visible;
    setTimeout(() => { sendMessage(); }, 0);
  };

  // Autopilot: skip a stuck phase — treat as accepted, advance to next.
  const handlePhaseSkipToNext = (messageId: string, phaseIndex: number) => {
    if (!activeSessionId) return;
    const plan = lastAutopilotPlanRef.current[activeSessionId];
    if (!plan) return;
    pendingAutopilotResumeRef.current = {
      sessionId: activeSessionId,
      plan,
      phaseIndex: phaseIndex + 1,
      answer: '',
    };
    mutateMessage(messageId, { phaseStuckResolved: true } as any);
    const visible = `⤳ Skipping Phase ${phaseIndex} — continue from Phase ${phaseIndex + 1}.`;
    setInputMap(prev => ({ ...prev, [activeSessionId]: visible }));
    inputValueRefs.current[activeSessionId] = visible;
    setTimeout(() => { sendMessage(); }, 0);
  };

  // Pair-mode: send the plan back with a revision note. This is just a normal
  // user message in the active pair mode — orchestrator re-synthesizes.
  const handlePairSendBack = (note: string) => {
    if (!activeSessionId) return;
    const text = `🔁 Send back — please reconsider:\n${note}`;
    setInputMap(prev => ({ ...prev, [activeSessionId]: text }));
    inputValueRefs.current[activeSessionId] = text;
    setTimeout(() => { sendMessage(); }, 0);
  };

  // Undo last turn: drop the last assistant message and the user message that
  // elicited it. Keeps the rest of the transcript intact. Works while the
  // agent is idle; if streaming, user should Stop first.
  const canUndoLastTurn = useMemo(() => {
    if (!allMessages.length) return false;
    const lastAsst = [...allMessages].reverse().findIndex(m => m.role === 'assistant');
    return lastAsst >= 0;
  }, [allMessages]);

  const handleUndoLastTurn = () => {
    if (!activeSessionId || !canUndoLastTurn) return;
    const msgs = [...allMessages];
    // drop trailing assistant/system messages until we hit an assistant — then
    // drop that assistant AND the user message right before it.
    let idx = msgs.length - 1;
    while (idx >= 0 && msgs[idx].role !== 'assistant') idx--;
    if (idx < 0) return;
    // Remove everything from the preceding user message through the end.
    let userIdx = idx - 1;
    while (userIdx >= 0 && msgs[userIdx].role !== 'user') userIdx--;
    const keep = userIdx >= 0 ? msgs.slice(0, userIdx) : msgs.slice(0, idx);
    updateSessionMessages(activeSessionId, keep);
  };

  // Fork a new chat seeded with an abridged transcript ending at the given
  // message. Keeps topic context without dragging along 2 months of unrelated
  // history — the main unlock for Chat-11 class braided threads.
  const handleBranchFromMessage = (msg: Message) => {
    if (!activeSessionId) return;
    const msgIndex = allMessages.findIndex(m => m.id === msg.id);
    if (msgIndex < 0) return;

    // Take the last ~12 non-system messages up to and including the anchor.
    const window = allMessages
      .slice(0, msgIndex + 1)
      .filter(m => m.role !== 'system')
      .slice(-12);
    const transcript = window
      .map(m => {
        const who = m.role === 'user' ? 'User' : 'Agent';
        const txt = (m.content || '').slice(0, 1200);
        return `[${who}] ${txt}${(m.content || '').length > 1200 ? '…' : ''}`;
      })
      .join('\n\n');

    const parent = activeSession;
    const sessionId = generateId();
    const sessionKey = `${NS.sessionKeyPrefix}-${sessionId.slice(0, 8)}-${Date.now()}`;
    const seeded: ChatSession = {
      id: sessionId,
      name: `${parent?.name || 'Branch'} · branch`,
      sessionKey,
      workspace: parent?.workspace,
      keyFacts: parent?.keyFacts,
      messages: [
        {
          id: generateId(),
          role: 'system',
          content: `🌿 **Branched** from "${parent?.name || 'chat'}" at the message below. Only the relevant subthread is carried forward.`,
          timestamp: new Date(),
        },
        {
          id: generateId(),
          role: 'user',
          content: `[Branched context — recent exchanges from the parent chat, use for continuity, then follow the new instructions:]\n\n${transcript}`,
          timestamp: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setSessions(prev => [seeded, ...prev]);
    setActiveSessionId(sessionId);
    setActiveMessageMenu(null);
  };

  const handleEditMessage = (msg: Message) => {
    setEditingMessageId(msg.id);
    setEditingContent(msg.content);
    setActiveMessageMenu(null);
  };

  const handleSaveEdit = () => {
    if (!activeSessionId || !editingMessageId) return;
    const updated = allMessages.map(m => 
      m.id === editingMessageId ? { ...m, content: editingContent } : m
    );
    updateSessionMessages(activeSessionId, updated);
    setEditingMessageId(null);
    setEditingContent('');
  };

  const handleCancelEdit = () => {
    setEditingMessageId(null);
    setEditingContent('');
  };

  // Claude Code Teams Delegation Functions
  const checkClaudeInstalled = async () => {
    try {
      const response = await fetch('/api/claude-code?action=check');
      const data = await response.json();
      setClaudeInstalled(data);
    } catch {
      setClaudeInstalled({ installed: false });
    }
  };

  // Check Claude on mount
  useEffect(() => {
    checkClaudeInstalled();
  }, []);

  // Poll Claude Code session output
  const pollClaudeOutput = async (sessionId: string) => {
    try {
      const response = await fetch(`/api/claude-code?action=output&sessionId=${sessionId}`);
      const data = await response.json();
      
      if (data.output) {
        setClaudeOutput(data.output);
        setActiveClaudeSession(prev => prev ? { ...prev, status: data.status } : null);
        
        // Auto-scroll terminal
        if (claudeOutputRef.current) {
          claudeOutputRef.current.scrollTop = claudeOutputRef.current.scrollHeight;
        }
        
        // Stop polling if session ended
        if (data.status !== 'running' && claudePollRef.current) {
          clearInterval(claudePollRef.current);
          claudePollRef.current = null;
        }
      }
    } catch (error) {
      console.error('[Claude] Poll error:', error);
    }
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (claudePollRef.current) {
        clearInterval(claudePollRef.current);
      }
    };
  }, []);

  // Open delegate modal with current input as prompt
  const openDelegateModal = () => {
    setDelegatePrompt(input.trim() || '');
    setShowDelegateModal(true);
  };

  // Use a template
  const useTemplate = (template: typeof TEAM_TEMPLATES[0]) => {
    const currentTask = delegatePrompt.trim();
    if (currentTask) {
      setDelegatePrompt(`${template.prompt}\n\n---\n\nTask: ${currentTask}`);
    } else {
      setDelegatePrompt(template.prompt);
    }
  };

  // Launch Claude Code session
  const launchClaudeCode = async () => {
    const { workspace } = getConfig();
    
    if (!workspace) {
      const errorMsg: Message = {
        id: generateId(),
        role: 'system',
        content: '⚠️ No workspace configured. Click the workspace button in the header to set one.',
        timestamp: new Date(),
      };
      if (activeSessionId) {
        // FIX (data loss): functional append.
        appendSessionMessage(activeSessionId, errorMsg);
      }
      setShowDelegateModal(false);
      return;
    }

    if (!delegatePrompt.trim()) {
      return;
    }

    setDelegateLoading(true);

    try {
      const response = await fetch('/api/claude-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          workspace,
          prompt: delegatePrompt,
          teamMode: delegateTeamMode,
          name: delegateTeamMode ? 'Team Session' : 'Solo Session',
        }),
      });

      const data = await response.json();

      if (data.success) {
        // Add system message about delegation
        const delegateMsg: Message = {
          id: generateId(),
          role: 'system',
          content: `🤖 **Delegated to Claude Code ${delegateTeamMode ? 'Team' : ''}**\n\n` +
            `Session: \`${data.sessionId}\`\n` +
            `Mode: ${delegateTeamMode ? '👥 Agent Teams (collaborative)' : '👤 Solo'}\n` +
            `Workspace: \`${workspace}\`\n\n` +
            `**Task:**\n\`\`\`\n${delegatePrompt.slice(0, 500)}${delegatePrompt.length > 500 ? '...' : ''}\n\`\`\`\n\n` +
            `_Use the terminal below or switch to the **🤖 TEAMS** tab to watch progress._`,
          timestamp: new Date(),
        };
        if (activeSessionId) {
          // FIX (data loss): functional append.
          appendSessionMessage(activeSessionId, delegateMsg);
        }

        // Set active session and show terminal
        setActiveClaudeSession({
          id: data.sessionId,
          name: delegateTeamMode ? 'Team Session' : 'Solo Session',
          status: 'running'
        });
        setClaudeOutput([]);
        setShowClaudeTerminal(true);

        // Start polling for output
        claudePollRef.current = setInterval(() => {
          pollClaudeOutput(data.sessionId);
        }, 1000);

        // Close modal and clear input
        setShowDelegateModal(false);
        setInputMap(prev => ({...prev, [activeSessionId || '']: ''}));
        setDelegatePrompt('');
      } else {
        const errorMsg: Message = {
          id: generateId(),
          role: 'system',
          content: `❌ Failed to start Claude Code: ${data.error || 'Unknown error'}`,
          timestamp: new Date(),
        };
        if (activeSessionId) {
          // FIX (data loss): functional append.
          appendSessionMessage(activeSessionId, errorMsg);
        }
      }
    } catch (error: any) {
      console.error('[Claude] Launch error:', error);
      const errorMsg: Message = {
        id: generateId(),
        role: 'system',
        content: `❌ Error launching Claude Code: ${error.message}`,
        timestamp: new Date(),
      };
      if (activeSessionId) {
        // FIX (data loss): functional append.
        appendSessionMessage(activeSessionId, errorMsg);
      }
    } finally {
      setDelegateLoading(false);
    }
  };

  // Stop active Claude Code session
  const stopClaudeSession = async () => {
    if (!activeClaudeSession) return;

    try {
      const response = await fetch('/api/claude-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'stop',
          sessionId: activeClaudeSession.id,
        }),
      });

      const data = await response.json();
      if (data.success) {
        setActiveClaudeSession(prev => prev ? { ...prev, status: 'stopped' } : null);
        if (claudePollRef.current) {
          clearInterval(claudePollRef.current);
          claudePollRef.current = null;
        }
      }
    } catch (error) {
      console.error('[Claude] Stop error:', error);
    }
  };

  // Fetch session history
  const fetchGatewaySessions = async () => {
    setSessionsLoading(true);
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list' }),
      });
      
      const data = await response.json();
      if (data.sessions) {
        setGatewaySessions(data.sessions);
      }
    } catch (error) {
      console.error('[Sessions] Error fetching:', error);
    } finally {
      setSessionsLoading(false);
    }
  };

  // Fetch sessions when dropdown opens
  useEffect(() => {
    if (showSessionDropdown) {
      fetchGatewaySessions();
    }
  }, [showSessionDropdown]);

  // Get session display name
  const getSessionDisplayName = (session: any) => {
    if (session.label) return session.label;
    const key = session.sessionKey || session.key || '';
    const parts = key.split(':');
    if (parts.length >= 3) {
      return parts[2]; // e.g., "main" from "agent:main:main"
    }
    return key;
  };

  // Get session kind icon
  const getSessionKind = (session: any) => {
    const key = session.sessionKey || session.key || '';
    if (key.includes(':isolated:')) return 'isolated';
    if (key.includes(':channel:')) return 'channel';
    return 'main';
  };

  // Load history from a gateway session into a new local chat session
  const loadGatewaySessionHistory = async (gatewaySession: any) => {
    const sessionKey = gatewaySession.sessionKey || gatewaySession.filename?.replace('.jsonl', '');
    if (!sessionKey) return;

    setSessionsLoading(true);
    try {
      // Fetch the session history from the history API
      const response = await fetch(`/api/history?action=history&session=${encodeURIComponent(sessionKey)}`);
      const data = await response.json();
      
      if (data.messages && data.messages.length > 0) {
        // Create a new local chat session with the imported history
        const displayName = getSessionDisplayName(gatewaySession);
        const newSession: ChatSession = {
          id: generateId(),
          name: `📜 ${displayName}`,
          messages: [
            {
              id: generateId(),
              role: 'system',
              content: `Loaded ${data.messages.length} messages from OpenClaw session "${sessionKey}"`,
              timestamp: new Date(),
            },
            ...data.messages.map((m: any) => ({
              id: generateId(),
              role: m.role as 'user' | 'assistant' | 'system',
              content: m.content,
              timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
            })),
          ],
          createdAt: new Date(),
          updatedAt: new Date(),
          workspace: gatewaySession.workspace,
        };
        
        setSessions(prev => [newSession, ...prev]);
        setActiveSessionId(newSession.id);
        setSelectedGatewaySession(sessionKey);
        setShowSessionDropdown(false);
      } else {
        // No messages found, show error
        console.warn('[Sessions] No messages found for session:', sessionKey);
        const errorMsg: Message = {
          id: generateId(),
          role: 'system',
          content: `⚠️ No messages found in session "${sessionKey}"`,
          timestamp: new Date(),
        };
        if (activeSessionId) {
          updateSessionMessages(activeSessionId, [...messages, errorMsg]);
        }
      }
    } catch (error) {
      console.error('[Sessions] Error loading history:', error);
    } finally {
      setSessionsLoading(false);
      setShowSessionDropdown(false);
    }
  };

  const scrollToBottom = () => {
    try {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST' as any, behavior: 'auto', align: 'end' });
    } catch { /* ignore */ }
  };

  const updateSessionMessages = (sessionId: string, newMessages: Message[]) => {
    setSessions(prev => prev.map(s =>
      s.id === sessionId
        ? { ...s, messages: newMessages, updatedAt: new Date() }
        : s
    ));
  };

  // Safely append a message using current state (avoids stale closure bugs)
  const appendSessionMessage = (sessionId: string, msg: Message) => {
    setSessions(prev => prev.map(s =>
      s.id === sessionId
        ? { ...s, messages: [...s.messages, msg], updatedAt: new Date() }
        : s
    ));
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const attachment: Attachment = {
          id: generateId(),
          name: file.name,
          type: file.type,
          size: file.size,
          url: reader.result as string,
        };
        setAttachmentMap(prev => ({...prev, [activeSessionId || '']: [...(prev[activeSessionId || ''] || []), attachment]}));
      };
      reader.readAsDataURL(file);
    });

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeAttachment = (id: string) => {
    setAttachmentMap(prev => ({...prev, [activeSessionId || '']: (prev[activeSessionId || ''] || []).filter(a => a.id !== id)}));
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // === PROJECT ASSETS ===
  const fetchProjectAssets = async (workspace?: string) => {
    const ws = workspace || activeSession?.workspace || getConfig().workspace;
    if (!ws) { setProjectAssets([]); return; }
    setAssetsLoading(true);
    try {
      const res = await fetch(`/api/assets/list?workspace=${encodeURIComponent(ws)}`);
      const data = await res.json();
      setProjectAssets(data.assets || []);
    } catch (e) {
      console.error('[Assets] fetch error', e);
      setProjectAssets([]);
    } finally {
      setAssetsLoading(false);
    }
  };

  const uploadToAssets = async (file: File, workspace: string): Promise<ProjectAsset | null> => {
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('workspace', workspace);
      const res = await fetch('/api/assets/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) return data.asset;
    } catch (e) {
      console.error('[Assets] upload error', e);
    }
    return null;
  };

  const deleteAsset = async (assetId: string) => {
    try {
      await fetch('/api/assets/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId }),
      });
      setProjectAssets(prev => prev.filter(a => a.id !== assetId));
    } catch (e) {
      console.error('[Assets] delete error', e);
    }
  };

  const attachAssetToChat = async (asset: ProjectAsset) => {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    
    // For images, convert to base64 data URL so the vision API can use it
    let url = asset.url;
    if (asset.type.startsWith('image/')) {
      try {
        const res = await fetch(asset.url);
        const blob = await res.blob();
        url = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        console.error('[Assets] Failed to load image as base64', e);
      }
    }
    
    const attachment: Attachment = {
      id: asset.id,
      name: asset.name,
      type: asset.type,
      size: asset.size,
      url,
      assetPath: asset.path,
    };
    setAttachmentMap(prev => ({
      ...prev,
      [sessionId]: [...(prev[sessionId] || []), attachment],
    }));
    setShowAssets(false);
  };

  // Helper to inject system messages (e.g., sub-agent completion)
  const addSystemMessage = (content: string) => {
    if (!activeSessionId) return;
    
    const systemMessage: Message = {
      id: generateId(),
      role: 'system',
      content,
      timestamp: new Date(),
    };
    
    setSessions(prev => prev.map(s =>
      s.id === activeSessionId
        ? { ...s, messages: [...s.messages, systemMessage], updatedAt: new Date() }
        : s
    ));
  };

  const sendMessage = async () => {
    // Capture session ID at start - prevents response going to wrong session if user switches chats
    const targetSessionId = activeSessionId;
    if (!targetSessionId) return;

    // Use ref value as fallback - immune to stale closures on mobile
    const currentInput = input || inputValueRefs.current[targetSessionId] || '';
    const currentAttachments = attachmentMap[targetSessionId] || [];
    const currentLoading = loadingMap[targetSessionId] || false;

    console.log('[Chat] sendMessage called', { input: currentInput.trim().slice(0, 50), inputFromRef: inputValueRefs.current[targetSessionId]?.slice(0, 20), hasAttachments: currentAttachments.length > 0, isLoading: currentLoading, targetSessionId });

    if (!currentInput.trim() && currentAttachments.length === 0) {
      console.log('[Chat] sendMessage bailed: empty input');
      return;
    }

    // Cooldown gate: if this session is currently rate-limited, refuse to
    // send. Keeps the input intact so the user can hit send again once the
    // banner countdown finishes — without firing a doomed POST that would
    // just refresh the gate.
    const gate = activeRateLimitGate(targetSessionId);
    if (gate) {
      console.log('[Chat] sendMessage bailed: session is rate-limited', { secondsRemaining: Math.ceil((gate.until - Date.now()) / 1000) });
      return;
    }

    // If AI is currently streaming, stop it first before sending the new message
    if (currentLoading || abortControllers.current[targetSessionId]) {
      console.log('[Chat] Interrupting active generation before sending new message');
      await stopGeneration(targetSessionId);
      // Small delay to let abort propagate and avoid races
      await new Promise(r => setTimeout(r, 150));
    }

    // Slash-command preamble: model overrides + persistent modes.
    // Model: /opus (=4.7) | /opus1m (=4.7 1M ctx) | /sonnet (=4.6) | /haiku (=4.5)
    // Mode:  /quick | /work | /constellation
    {
      const trimmed = currentInput.trim();
      const m = trimmed.match(/^\/(opus1m|opus47|opus|sonnet|haiku|quick|work|constellation)\b\s*/i);
      if (m) {
        const cmd = m[1].toLowerCase();
        const rest = trimmed.slice(m[0].length);
        const modelMap: Record<string, string> = {
          opus:   'claude-opus-4-7',
          opus47: 'claude-opus-4-7',
          opus1m: 'claude-opus-4-7[1m]',
          sonnet: 'claude-sonnet-4-6',
          haiku:  'claude-haiku-4-5',
        };
        if (modelMap[cmd]) {
          oneShotModelRef.current[targetSessionId] = modelMap[cmd];
        } else {
          const mode = cmd as ComposerMode;
          setModeMap(prev => ({ ...prev, [targetSessionId]: mode }));
          modeMapRef.current[targetSessionId] = mode;
          if (mode === 'quick') oneShotModelRef.current[targetSessionId] = 'claude-haiku-4-5';
        }
        setInputMap(prev => ({ ...prev, [targetSessionId]: rest }));
        inputValueRefs.current[targetSessionId] = rest;
        if (!rest) {
          addSystemMessage(
            modelMap[cmd]
              ? `Model for next turn: ${modelMap[cmd]}.`
              : `Mode: ${cmd}.`
          );
          return;
        }
        // Fall through with the slash command stripped.
      }
    }

    // Clear the stopped flag so the NEW request's streaming loop can write messages
    stoppedSessionsRef.current.delete(targetSessionId);
    
    try {
    const { workspace } = getConfig();

    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: currentInput.trim(),
      timestamp: new Date(),
      attachments: currentAttachments.length > 0 ? [...currentAttachments] : undefined,
    };

    // Auto-upload attachments to project assets and collect saved paths
    const ws = activeSession?.workspace || getConfig().workspace;
    const savedAssetPaths: string[] = [];
    if (ws && currentAttachments.length > 0) {
      await Promise.all(currentAttachments.map(async (att) => {
        if (att.assetPath) {
          savedAssetPaths.push(att.assetPath);
          return;
        }
        try {
          const res = await fetch(att.url);
          const blob = await res.blob();
          const file = new File([blob], att.name, { type: att.type });
          const asset = await uploadToAssets(file, ws);
          if (asset) {
            savedAssetPaths.push(asset.path);
          }
          if (showAssets) fetchProjectAssets(ws);
        } catch (e) {
          console.error('[Assets] auto-upload failed', e);
        }
      }));
    }

    // Build message content for API
    let textContent = userMessage.content || '';

    // Inject saved asset paths so the agent knows where files are on disk
    if (savedAssetPaths.length > 0) {
      const pathList = savedAssetPaths.map(p => `  \u2022 ${p}`).join('\n');
      const pathNote = `\n\n[Attached files saved to project assets:\n${pathList}\n]`;
      textContent = (textContent || 'See attached file(s).') + pathNote;
    }

    let messageContent: any = textContent;

    // If we have image attachments, use vision-style message format
    if (userMessage.attachments?.some(a => a.type.startsWith('image/'))) {
      messageContent = [
        { type: 'text', text: textContent || 'What do you see in this image?' },
        ...userMessage.attachments
          .filter(a => a.type.startsWith('image/'))
          .map(a => ({ type: 'image_url', image_url: { url: a.url } }))
      ];
    }

    // Hydrate messages on-demand if session was loaded in lite mode (mobile)
    let currentMessages = allMessages;
    if (currentMessages.length === 0) {
      try {
        const hydrateRes = await fetch(`?sessionId=${targetSessionId}`);
        const hydrateData = await hydrateRes.json();
        if (hydrateData.session?.messages?.length > 0) {
          currentMessages = hydrateData.session.messages.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) }));
          setSessions(prev => prev.map(s => s.id === targetSessionId ? { ...s, messages: currentMessages } : s));
        }
      } catch (e) {
        console.warn('[Chat] On-demand hydration failed, sending with empty history:', e);
      }
    }

    // Add user message to chat.
    // FIX (data loss): use functional append so the user's message is added on
    // top of whatever is currently in React state — not a stale `currentMessages`
    // snapshot captured at the top of this async sendMessage. Under streaming
    // + abort races this is the difference between preserving and losing the msg.
    appendSessionMessage(targetSessionId, userMessage);
    const updatedMessages = [...currentMessages, userMessage];
    
    // Clear input and attachments for THIS session
    setInputMap(prev => ({...prev, [targetSessionId]: ''}));
    inputValueRefs.current[targetSessionId] = '';
    setAttachmentMap(prev => ({...prev, [targetSessionId]: []}));
    setLoadingMap(prev => ({...prev, [targetSessionId]: true}));
    setStreamingMap(prev => ({...prev, [targetSessionId]: ''}));

    // Create abort controller for this session
    abortControllers.current[targetSessionId] = new AbortController();
    
    // Set a timeout - 1 hour for complex tasks (tool calls, long operations)
    // Reset timeout whenever we receive data (see reader loop below)
    let timeoutId: NodeJS.Timeout | undefined;
    const resetTimeout = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        if (abortControllers.current[targetSessionId]) {
          console.warn('[Chat] Request timed out after 1 hour of inactivity');
          abortControllers.current[targetSessionId].abort();
        }
      }, 3600000); // 1 hour
    };
    resetTimeout();

    // Track content outside try block so we can recover partial responses
    let fullContent = '';
    let isPollingServer = false; // Set true when catch handler starts server polling
    
    try {
      // Build messages array with workspace context
      const apiMessages = [];
      
      // Model preference — one-shot override (from /opus //sonnet //haiku)
      // beats the persistent per-session selection. Clear the one-shot after use.
      const sessionModel = modelMapRef.current[targetSessionId] || 'default';
      const oneShot = oneShotModelRef.current[targetSessionId];
      if (oneShot) delete oneShotModelRef.current[targetSessionId];
      const effective = oneShot || (sessionModel !== 'default' ? sessionModel : undefined);
      const modelToSend = effective;
      const sessionMode = modeMapRef.current[targetSessionId] || 'work';
      console.log('[Chat] Model:', { sessionModel, oneShot, modelToSend, mode: sessionMode, targetSessionId });
      
      // Add environment context first - CRITICAL for deployment safety
      const env = envConfig[activeEnvironment];
      apiMessages.push({
        role: 'user',
        content: `[Environment: ${activeEnvironment.toUpperCase()}]
• SaaS URL: ${env.saasUrl}
• App URL: ${env.appUrl}
• Git Branch: ${env.branch}
• Supabase: ${env.supabaseRef}
⚠️ All deployments, database changes, and git operations should target ${activeEnvironment.toUpperCase()} environment.`,
      });
      
      // Add workspace context as a system-like user message if workspace is set
      if (workspace) {
        apiMessages.push({
          role: 'user',
          content: `[Context: Working in ${workspace}]`,
        });
      }
      
      // Add linked chat context if available — last 20 messages with generous content.
      // Only inject on early messages (first 3) to seed context without bloating every request.
      // After that, the agent already has the conversation in its session transcript.
      const currentMsgCount = updatedMessages.filter(m => m.role === 'user').length;
      if (linkedSession && linkedMessages.length > 0 && currentMsgCount <= 3) {
        const contextMessages = linkedMessages.slice(-20);
        const linkedContext = contextMessages
          .map(m => {
            const role = m.role === 'assistant' ? 'Agent' : m.role === 'user' ? 'User' : 'System';
            const content = m.content.slice(0, 2000) + (m.content.length > 2000 ? '\n...(truncated)' : '');
            return `[${role}]: ${content}`;
          })
          .join('\n\n');
        
        apiMessages.push({
          role: 'user',
          content: `[Linked Chat "${linkedSession.name}" — Last ${contextMessages.length} messages for continuity. This is context from a previous conversation. Use it to understand what was being worked on and pick up where it left off.]\n\n${linkedContext}\n\n[End of linked chat context]`,
        });
      }
      
      // Inject attached GitHub repo context with full gh CLI capabilities
      if (activeSession?.githubRepo) {
        const gh = activeSession.githubRepo;
        apiMessages.push({
          role: 'user',
          content: `[GitHub Repo attached: ${gh.fullName} | ${gh.url} | branch: ${gh.defaultBranch}

You have full access via the \`gh\` CLI (already authenticated). Use these commands:

READ:
  gh repo view ${gh.fullName}                    — repo info
  gh api repos/${gh.fullName}/contents/{path}    — read file from GitHub
  gh api repos/${gh.fullName}/git/trees/${gh.defaultBranch}?recursive=1 | head -100  — file tree
  gh pr list -R ${gh.fullName}                   — open PRs
  gh pr view {number} -R ${gh.fullName}          — PR details + diff
  gh issue list -R ${gh.fullName}                — open issues
  gh issue view {number} -R ${gh.fullName}       — issue details
  gh release list -R ${gh.fullName}              — releases

WRITE:
  gh pr create -R ${gh.fullName} --title "..." --body "..."  — create PR
  gh issue create -R ${gh.fullName} --title "..." --body "..." — create issue
  gh pr merge {number} -R ${gh.fullName}         — merge PR
  gh pr comment {number} -R ${gh.fullName} --body "..."  — comment on PR

When the user asks about this repo's code, PRs, issues, or wants to create PRs — use these gh commands directly.]`,
        });
      }

      // Inject attached docs (plans + notes) — mirrors the linked-chat pattern.
      // Cross-machine: docs hosted on a peer are fetched through the bridge proxy.
      // Skipped after the first 3 user messages so we don't bloat every request;
      // the agent already has the context in its session transcript by then.
      const attachedDocs = activeSession?.attachedDocs || [];
      if (attachedDocs.length > 0 && currentMsgCount <= 3) {
        const docFetches = await Promise.all(attachedDocs.map(async (a) => {
          const url = a.host === 'local'
            ? `/api/docs/${encodeURIComponent(a.id)}`
            : `/api/remote/docs/${encodeURIComponent(a.id)}?host=${encodeURIComponent(a.host)}`;
          try {
            const r = await fetch(url);
            if (!r.ok) return null;
            const d = await r.json();
            return d.doc;
          } catch { return null; }
        }));
        for (const doc of docFetches) {
          if (!doc) continue;
          const hostLabel = (attachedDocs.find(a => a.id === doc.id)?.host) || 'local';
          apiMessages.push({
            role: 'user',
            content: `[Attached ${doc.type}: "${doc.title}" (id: ${doc.id}, host: ${hostLabel}). This is load-bearing context for the conversation. To revise it, call \`mc_docs_write\` with the same id. To save a related new doc, call \`mc_docs_write\` with a fresh title.]\n\n${doc.content}\n\n[End attached ${doc.type}]`,
          });
        }
      }

      // Inject key facts (auto-captured credentials, URLs, names, etc.)
      const sessionKeyFacts = activeSession?.keyFacts || [];
      if (sessionKeyFacts.length > 0) {
        const factsContext = formatKeyFactsForContext(sessionKeyFacts);
        apiMessages.push({ role: 'user', content: factsContext });
      }

      // Include chat history for context - more messages = better context
      // If a context snapshot exists, use it instead of full old history
      const snapshot = activeSession?.contextSnapshot;
      const snapshotAt = activeSession?.contextSnapshotAt ?? 0;
      
      if (snapshot && snapshotAt > 0) {
        // Compressed mode: send snapshot + bounded tail.
        // Bug guard: snapshotAt is a fixed index captured at compression time.
        // If the user keeps chatting past it, slice(snapshotAt) grows unbounded
        // (Chat 11 accumulated 257 msgs post-snapshot). Cap at compressKeepCount
        // so compression stays effective without forcing a re-compress.
        apiMessages.push({
          role: 'user',
          content: `[Compressed context from earlier conversation — contains all key details, credentials, decisions, and project state:]\n\n${snapshot}\n\n[End of compressed context. Recent messages follow.]`,
        });
        const tailCap = Math.max(compressKeepCount, 10);
        const recentStart = Math.max(snapshotAt, updatedMessages.length - tailCap);
        const recentMessages = updatedMessages.slice(recentStart);
        apiMessages.push(
          ...recentMessages.map((m, i) => ({
            role: m.role === 'system' ? 'user' : m.role,
            content: (i === recentMessages.length - 1 && m.role === 'user' && messageContent) ? messageContent : m.content,
          }))
        );
      } else {
        // Normal mode: send last 50 messages
        const historySlice = updatedMessages.slice(-50);
        apiMessages.push(
          ...historySlice.map((m, i) => ({
            role: m.role === 'system' ? 'user' : m.role,
            content: (i === historySlice.length - 1 && m.role === 'user' && messageContent) ? messageContent : m.content,
          }))
        );
      }

      // Deduplicate consecutive same-role messages with identical content
      // (prevents corrupted history from creating AI response loops)
      for (let i = apiMessages.length - 1; i > 0; i--) {
        const cur = apiMessages[i];
        const prev = apiMessages[i - 1];
        if (cur.role === prev.role && typeof cur.content === 'string' && cur.content === prev.content) {
          apiMessages.splice(i, 1);
        }
      }

      // Use local proxy to avoid CORS issues
      // Pass session key for OpenClaw session isolation (each chat = separate session)
      const sessionKey = activeSession?.sessionKey;
      
      // Generate unique request ID for server-side buffering (survives tab/screen lock)
      const requestId = `req-${targetSessionId}-${Date.now()}`;
      // Store requestId so recovery handler can poll for it
      localStorage.setItem('chat_active_request', JSON.stringify({
        requestId,
        sessionId: targetSessionId,
        startedAt: Date.now(),
      }));
      
      // Resolve attached chat ids from the linked-chat dropdown so the memory retriever can search across linked chats.
      const linkedKey = (() => {
        const linkedId = activeSessionId ? linkedSessionMap[activeSessionId] : null;
        if (!linkedId) return null;
        const s = sessions.find((x: any) => x.id === linkedId);
        return s?.sessionKey || null;
      })();
      const attachedChatIds = linkedKey ? [linkedKey] : [];

      // Pair-mode routing: when the user has selected consult/debate/pair-build,
      // the request goes to /api/chat/pair instead of /api/chat. Solo stays on
      // /api/chat (untouched). Pair-mode comes from the active session.
      let pairMode: PairMode | 'pair-build-execute' | 'autopilot-execute' = (activeSession?.pairMode as PairMode) || 'solo';
      let approvedPlan: PlanCardData | undefined;
      let pendingUserAnswer: { phase_index: number; answer: string } | undefined;
      let resumeFromPhase: number | undefined;
      // Approval shortcut: if Plan Card Approve was clicked for this session,
      // override mode based on whether the plan is phased (autopilot) or
      // single-shot (pair-build).
      if (pendingPairExecuteRef.current && pendingPairExecuteRef.current.sessionId === targetSessionId) {
        const ref = pendingPairExecuteRef.current;
        approvedPlan = ref.plan;
        pairMode = (ref.plan.phases && ref.plan.phases.length > 0) ? 'autopilot-execute' : 'pair-build-execute';
        const lockedMessageId = ref.messageId;
        setSessions(prev => prev.map(s =>
          s.id === targetSessionId
            ? { ...s, messages: s.messages.map(m => m.id === lockedMessageId ? { ...m, planCardLocked: true } : m) }
            : s
        ));
        pendingPairExecuteRef.current = null;
      }
      // Codex-question reply OR phase-stuck retry/skip: resume the autopilot
      // with the answer + the phase + attempt + audit history so the
      // orchestrator picks up exactly where it stopped (no wasted attempts).
      let resumeFromAttempt: number | undefined;
      let resumeAuditHistory: string[] | undefined;
      let overrideReworkCap: number | undefined;
      if (pendingAutopilotResumeRef.current && pendingAutopilotResumeRef.current.sessionId === targetSessionId) {
        const ref = pendingAutopilotResumeRef.current;
        pairMode = 'autopilot-execute';
        approvedPlan = ref.plan;
        if (ref.answer) pendingUserAnswer = { phase_index: ref.phaseIndex, answer: ref.answer };
        resumeFromPhase = ref.phaseIndex;
        resumeFromAttempt = ref.resumeAttempt;
        resumeAuditHistory = ref.auditHistory;
        overrideReworkCap = ref.overrideReworkCap;
        pendingAutopilotResumeRef.current = null;
      }
      const endpoint = pairMode === 'solo' ? '/api/chat' : '/api/chat/pair';

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: apiMessages,
          sessionKey, // Unique per chat for isolation
          requestId, // Server buffers response under this ID
          // If the parent locks workspace (SEO → seo-workspace), prefer that.
          workspace: props.lockedWorkspace || workspace || '',
          attachedChatIds,
          mode: pairMode === 'solo' ? sessionMode : pairMode,
          ...(approvedPlan ? { approvedPlan } : {}),
          ...(pendingUserAnswer ? { pendingUserAnswer } : {}),
          ...(resumeFromPhase !== undefined ? { resume_from_phase: resumeFromPhase } : {}),
          ...(resumeFromAttempt !== undefined ? { resume_from_attempt: resumeFromAttempt } : {}),
          ...(resumeAuditHistory && resumeAuditHistory.length ? { resume_audit_history: resumeAuditHistory } : {}),
          ...(overrideReworkCap !== undefined ? { override_rework_cap: overrideReworkCap } : {}),
          // Cross-device broadcast identifiers. The server fans the reply
          // out to every other tab/device subscribed on this chatId, and
          // uses clientId to suppress echoing back to the initiator.
          chatId: targetSessionId,
          clientId: getClientId(),
          ...(modelToSend ? { model: modelToSend } : {}),
          ...((permissionModeMapRef.current[targetSessionId] && permissionModeMapRef.current[targetSessionId] !== 'default')
            ? { permissionMode: permissionModeMapRef.current[targetSessionId] } : {}),
        }),
        signal: abortControllers.current[targetSessionId].signal,
      });

      // Track that we sent this model switch so we don't repeat it
      if (modelToSend) {
        lastSentModelRef.current[targetSessionId] = modelToSend;
      }

      if (response.status === 429) {
        // Server-side cooldown gate fired (lib/claude-chat-bridge.ts marked
        // this sessionKey rate-limited). Render a calm banner instead of
        // writing an error into the chat. The send button + composer get
        // disabled by rateLimitGateMap state until the timer runs out.
        let info: any = {};
        try { info = await response.json(); } catch {}
        const secs = info.secondsRemaining ?? 60;
        setRateLimitGateMap(prev => ({
          ...prev,
          [targetSessionId]: {
            until: Date.now() + secs * 1000,
            hitCount: info.hitCount || 1,
            reason: info.message || info.reason || 'Rate-limited',
          },
        }));
        // Clear loading + streaming so the user can see the banner clearly
        setLoadingMap(prev => ({ ...prev, [targetSessionId]: false }));
        setStreamingMap(prev => ({ ...prev, [targetSessionId]: '' }));
        localStorage.removeItem('chat_active_request');
        localStorage.removeItem('chat_partial_response');
        abortControllers.current[targetSessionId] = null as any;
        return;
      }
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gateway error: ${response.status} - ${errorText}`);
      }

      // Handle streaming response
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let receivedDone = false;
      let lastSaveLength = 0;
      
      // Auto-save partial content every 30 seconds or 5000 chars
      const autoSaveInterval = setInterval(() => {
        if (fullContent.length > lastSaveLength + 1000) {
          console.log('[Chat] Auto-saving progress:', fullContent.length, 'chars');
          lastSaveLength = fullContent.length;
          // Store in sessionStorage as backup
          localStorage.setItem('chat_partial_response', JSON.stringify({
            sessionId: targetSessionId,
            content: fullContent,
            timestamp: Date.now(),
          }));
        }
      }, 10000); // Check every 10 seconds

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            receivedDone = true;
            break;
          }

          // Reset timeout on any data received - agent is still working
          resetTimeout();

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                receivedDone = true;
                continue;
              }

              try {
                const parsed = JSON.parse(data);

                // Handle tool activity status events
                if (parsed.type === 'status' && parsed.status) {
                  // Show activity in the streaming area so user sees progress
                  const statusLine = parsed.status;
                  if (fullContent) {
                    // Agent already has text output — show status below it
                    setStreamingMap(prev => ({...prev, [targetSessionId]: fullContent + '\n\n---\n*' + statusLine + '*'}));
                  } else {
                    // No text yet — show status as the streaming content
                    setStreamingMap(prev => ({...prev, [targetSessionId]: '*' + statusLine + '*'}));
                  }
                  continue;
                }

                // Heartbeat events — bridge emits these every 15s so the user
                // always knows something is happening even when the model is
                // silent between tool calls or waiting on subagents.
                if (parsed.type === 'heartbeat' && parsed.status) {
                  setActivityMap(prev => ({
                    ...prev,
                    [targetSessionId]: {
                      status: parsed.status,
                      elapsedSec: parsed.elapsedSec || 0,
                      silentSec: parsed.silentSec,
                      toolsUsed: parsed.toolsUsed,
                      subagentsRunning: parsed.subagentsRunning,
                      subagentsDone: parsed.subagentsDone,
                      lastUpdate: Date.now(),
                    },
                  }));
                  continue;
                }

                // Synthetic recap marker — the bridge built a summary because
                // the agent turn ended silently. Log so we can spot it in console.
                if (parsed.type === 'tool_approval_required' && parsed.id) {
                  setApprovalQueue(prev => (
                    prev.some(r => r.id === parsed.id)
                      ? prev
                      : [...prev, {
                          id: parsed.id,
                          toolName: parsed.toolName || 'Tool',
                          input: parsed.input || {},
                          reason: parsed.reason || 'destructive command',
                          title: parsed.title || 'Approve this command?',
                          createdAt: parsed.createdAt || Date.now(),
                        }]
                  ));
                  continue;
                }

                if (parsed.type === 'synthetic_recap') {
                  console.warn('[Chat] Agent turn ended silently — showing synthesized recap (tools=%d, subagents=%d)',
                    parsed.tools, parsed.subagents);
                  continue;
                }

                // Handle real-time subagent events (instant, no polling delay)
                if (parsed.type === 'subagent') {
                  const action = parsed.action;

                  if (action === 'start') {
                    setAllSubAgents(prev => {
                      if (prev.some(a => a.key === parsed.key)) return prev;
                      const newAgent: SubAgent = {
                        key: parsed.key,
                        label: parsed.label || 'Subagent',
                        status: 'running',
                        lastMessage: '',
                        startedAt: new Date(),
                        endedAt: null,
                        durationMs: null,
                        task: '',
                        model: 'default',
                        resultPreview: '',
                        resultFull: '',
                      };
                      subAgentChatMap.current[parsed.key] = targetSessionId;
                      return [newAgent, ...prev];
                    });
                  } else if (action === 'finish') {
                    setAllSubAgents(prev => prev.map(a =>
                      a.key === parsed.key
                        ? { ...a, status: parsed.isError ? 'failed' : 'complete', endedAt: new Date(), resultPreview: parsed.resultPreview || '' }
                        : a
                    ));
                  } else if (action === 'task_progress' || action === 'progress') {
                    // Update subagent with latest progress summary
                    const key = parsed.key || parsed.toolUseId;
                    const summary = parsed.summary || parsed.text || '';
                    if (key && summary) {
                      setAllSubAgents(prev => prev.map(a =>
                        a.key === key
                          ? { ...a, lastMessage: summary.slice(0, 200) }
                          : a
                      ));
                    }
                  } else if (action === 'heartbeat') {
                    // Keep subagent alive with elapsed time
                    if (parsed.key) {
                      setAllSubAgents(prev => prev.map(a =>
                        a.key === parsed.key
                          ? { ...a, lastMessage: `Working (${parsed.elapsed}s)...` }
                          : a
                      ));
                    }
                  } else if (action === 'task_started') {
                    // Link task_id to tool_use_id if available
                    if (parsed.toolUseId) {
                      setAllSubAgents(prev => prev.map(a =>
                        a.key === parsed.toolUseId
                          ? { ...a, lastMessage: parsed.description || 'Started...' }
                          : a
                      ));
                    }
                  } else if (action === 'task_completed' || action === 'task_notification') {
                    // Task lifecycle completion — mark via toolUseId if we can match
                    const status = parsed.status === 'failed' ? 'failed' : 'complete';
                    if (parsed.toolUseId) {
                      setAllSubAgents(prev => prev.map(a =>
                        a.key === parsed.toolUseId
                          ? { ...a, status, endedAt: new Date(), lastMessage: parsed.summary || 'Done' }
                          : a
                      ));
                    }
                  }
                  continue;
                }

                // Token meter — switched from SDK billed totals to a content-
                // length estimate. Reason: `cache_read_input_tokens` aggregates
                // across every internal LLM call in a turn, so a turn with five
                // sub-agents that each cache-hit the prompt easily reports >2M
                // tokens against a 1M window — meaningless for "is the context
                // full?". The sum of message content / 3.8 chars-per-token is
                // a far better proxy for what the agent is actually carrying.
                if (parsed.type === 'usage') {
                  const outputTokens = parsed.usage?.output_tokens || 0;
                  const modelKeys = Object.keys(parsed.modelUsage || {});
                  const modelName = (modelKeys[0] || '').toLowerCase();
                  const explicit1m = modelName.includes('1m') || modelName.includes('[1m]');
                  const contextWindow = explicit1m
                    ? 1_000_000
                    : modelName.includes('opus') ? 200_000
                    : modelName.includes('sonnet') ? 200_000
                    : modelName.includes('haiku') ? 200_000
                    : 200_000;
                  // Estimate carried context from what's actually sent per turn.
                  // After compress: snapshot replaces messages[0..snapshotAt] in
                  // the prompt, only messages.slice(snapshotAt) are sent verbatim.
                  // Without this awareness the meter sums all 225 historical msgs
                  // and reports ~77% on a chat that's actually carrying ~5k tokens
                  // — making the user think compress "didn't work".
                  const sess = sessions.find(s => s.id === targetSessionId);
                  const allMsgs = sess?.messages || [];
                  const snapshot = sess?.contextSnapshot;
                  const hasSnapshot = !!snapshot && snapshot.length > 400;
                  const snapshotAt = hasSnapshot
                    ? Math.max(0, sess?.contextSnapshotAt ?? allMsgs.length)
                    : 0;
                  let chars = hasSnapshot ? snapshot.length : 0;
                  for (let i = snapshotAt; i < allMsgs.length; i++) {
                    const c = allMsgs[i]?.content;
                    if (typeof c === 'string') chars += c.length;
                  }
                  const estimatedUsed = Math.ceil(chars / 3.8);
                  setTokenUsageMap(prev => ({
                    ...prev,
                    [targetSessionId]: {
                      used: Math.min(estimatedUsed, contextWindow),
                      max: contextWindow,
                      outputTokens,
                    },
                  }));
                  continue;
                }

                // Pair-mode events: voice marker + plan card. Inlined into
                // fullContent as sentinel tokens so a single accumulator + the
                // existing single-message commit path keep working. They're
                // split into multiple Message rows at finalize time, and
                // stripped from the live streaming preview.
                if (parsed.type === 'agent' && parsed.agent) {
                  const phase = parsed.phase || '';
                  fullContent += `\n\n[[VOICE:${parsed.agent}:${phase}]]\n\n`;
                  setStreamingMap(prev => ({...prev, [targetSessionId]: fullContent}));
                  continue;
                }
                if (parsed.type === 'plan-card' && parsed.card) {
                  try {
                    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(parsed.card))));
                    fullContent += `\n\n[[PLANCARD:${b64}]]\n\n`;
                    setStreamingMap(prev => ({...prev, [targetSessionId]: fullContent}));
                  } catch {}
                  continue;
                }
                // Autopilot: phase lifecycle event. Inlined as a marker so it
                // round-trips as a row in the transcript.
                if (parsed.type === 'autopilot-phase') {
                  try {
                    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(parsed))));
                    fullContent += `\n\n[[AUTOPHASE:${b64}]]\n\n`;
                    setStreamingMap(prev => ({...prev, [targetSessionId]: fullContent}));
                  } catch {}
                  continue;
                }
                // Autopilot: paused on a Codex question. Inlined so the
                // question card renders inline with an answer textbox.
                if (parsed.type === 'codex-question') {
                  try {
                    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(parsed))));
                    fullContent += `\n\n[[CODEXQ:${b64}]]\n\n`;
                    setStreamingMap(prev => ({...prev, [targetSessionId]: fullContent}));
                  } catch {}
                  continue;
                }
                if (parsed.type === 'autopilot-finish') {
                  try {
                    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(parsed))));
                    fullContent += `\n\n[[AUTOFIN:${b64}]]\n\n`;
                    setStreamingMap(prev => ({...prev, [targetSessionId]: fullContent}));
                  } catch {}
                  continue;
                }

                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  fullContent += delta;
                  setStreamingMap(prev => ({...prev, [targetSessionId]: fullContent}));
                  // Persist to sessionStorage on every chunk so mobile tab suspend doesn't lose content
                  try {
                    localStorage.setItem('chat_partial_response', JSON.stringify({
                      sessionId: targetSessionId,
                      content: fullContent,
                      timestamp: Date.now(),
                    }));
                  } catch {}
                }
              } catch {
                // Ignore parse errors for incomplete chunks
              }
            }
          }
        }
      } finally {
        clearInterval(autoSaveInterval);
      }

      // Clear backups on successful completion
      localStorage.removeItem('chat_partial_response');
      localStorage.removeItem('chat_active_request');

      // Add assistant response to messages
      if (fullContent) {
        // Check if response seems complete (ends with punctuation or code block)
        const seemsComplete = /[.!?}\]`"'][\s]*$/.test(fullContent.trim()) ||
                              fullContent.includes('[DONE]') ||
                              receivedDone;

        // Pair-mode split: if the response carries VOICE markers, split into
        // one Message per voice block so each renders with its own avatar/color.
        // PLANCARD markers attach as a structured field on whichever block they
        // sit in. Solo turns have no markers and produce exactly one message.
        const hasPair = fullContent.includes('[[VOICE:');
        const newMessages: Message[] = (() => {
          if (!hasPair) {
            return [{
              id: generateId(),
              role: 'assistant',
              content: seemsComplete
                ? fullContent
                : fullContent + '\n\n---\n⚠️ *Response may be incomplete - stream ended unexpectedly*',
              timestamp: new Date(),
            }];
          }
          // Split on voice markers. Pieces alternate: text, marker, text, marker, ...
          const pieces = fullContent.split(/\[\[VOICE:([^\]]+)\]\]/);
          const out: Message[] = [];
          const buildBlock = (rawText: string, voice: 'claude' | 'codex' | 'orchestrator', phase: string): Message | null => {
            const cardOut = extractPlanCardFromText(rawText);
            const evts = extractAutopilotEvents(cardOut.content);
            const finalContent = evts.content;
            if (!finalContent.trim() && !cardOut.planCard && evts.phaseEvents.length === 0 && !evts.codexQuestion && !evts.phaseStuck && !evts.autopilotFinish) return null;
            return {
              id: generateId(),
              role: 'assistant',
              content: finalContent,
              timestamp: new Date(),
              voice,
              pairPhase: phase,
              planCard: cardOut.planCard || undefined,
              autopilotEvents: evts.phaseEvents.length ? evts.phaseEvents : undefined,
              codexQuestion: evts.codexQuestion || undefined,
              phaseStuck: evts.phaseStuck || undefined,
              autopilotFinish: evts.autopilotFinish || undefined,
            };
          };
          // Initial pre-marker text (if any) belongs to the orchestrator.
          if (pieces[0]?.trim()) {
            const m = buildBlock(pieces[0], 'orchestrator', '');
            if (m) out.push(m);
          }
          for (let i = 1; i < pieces.length; i += 2) {
            const marker = pieces[i] || '';
            const body = pieces[i + 1] || '';
            const [v, p] = marker.split(':');
            const voice: 'claude' | 'codex' | 'orchestrator' = (v === 'claude' || v === 'codex' || v === 'orchestrator') ? v : 'orchestrator';
            const m = buildBlock(body, voice, p || '');
            if (m) out.push(m);
          }
          if (!seemsComplete && out.length > 0) {
            out[out.length - 1] = { ...out[out.length - 1], content: out[out.length - 1].content + '\n\n---\n⚠️ *Response may be incomplete - stream ended unexpectedly*' };
          }
          return out;
        })();

        // Use setSessions callback to get CURRENT messages — updatedMessages is stale
        // (captured before streaming started, misses any messages added during the stream)
        setSessions(prev => prev.map(s =>
          s.id === targetSessionId
            ? { ...s, messages: [...s.messages, ...newMessages], updatedAt: new Date() }
            : s
        ));

        // Auto-extract key facts from user message + assistant response
        // Uses setSessions callback to avoid stale closure on sessions
        try {
          const userText = currentInput || '';
          const combinedText = userText + '\n' + fullContent;
          setSessions(prev => {
            const session = prev.find(s => s.id === targetSessionId);
            if (!session) return prev;
            const existingFacts = session.keyFacts || [];
            const newFacts = extractKeyFacts(combinedText, existingFacts);
            if (newFacts.length > 0) {
              console.log('[KeyFacts] Auto-extracted %d new facts:', newFacts.length, newFacts.map(f => `${f.label}: ${f.value.slice(0, 30)}`));
              return prev.map(s =>
                s.id === targetSessionId
                  ? { ...s, keyFacts: [...(s.keyFacts || []), ...newFacts] }
                  : s
              );
            }
            return prev;
          });
        } catch (e) {
          console.warn('[KeyFacts] Extraction error:', e);
        }

        // Browser notification if tab is not focused
        try {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            const preview = fullContent.replace(/[#*`_~]/g, '').slice(0, 120);
            new Notification('Mission Control', { body: preview || 'Response ready', icon: '/lobster.svg', tag: 'mc-chat-' + targetSessionId });
          }
        } catch {}

        // Context-size guard. Two tiers:
        //  - ≥75%  → heads-up warning once per threshold crossing
        //  - ≥92%  → re-warn and (if the last reply was cut short)
        //    explicitly flag that the answer was truncated.
        setTimeout(() => {
          const usage = tokenUsageMap[targetSessionId];
          if (!usage || usage.max <= 0) return;
          const pct = usage.used / usage.max;
          if (pct < 0.75) return;

          const tier = pct >= 0.92 ? 'critical' : 'warn';
          const percent = Math.round(pct * 100);
          const usedK = Math.round(usage.used / 1000);
          const maxK = Math.round(usage.max / 1000);

          // CRITICAL: do dedupe + append atomically inside a functional
          // setSessions, NOT against `sessions` from the closure. The closure's
          // sessions snapshot is stale after the 500ms delay (and may also be
          // stale because new messages stream in during the delay), so reading
          // `sess.messages` and rewriting the array via updateSessionMessages
          // would silently delete any user/assistant messages added in the
          // meantime — which is the "my message disappeared and context went
          // full" symptom.
          setSessions(prev => prev.map(s => {
            if (s.id !== targetSessionId) return s;
            const live = s.messages;
            const alreadyWarned = live.some(m =>
              m.role === 'system' && m.content.includes(`⚠️ Context ${tier === 'critical' ? 'critical' : 'warning'}`)
            );
            if (alreadyWarned) return s;

            const lastAsst = [...live].reverse().find(m => m.role === 'assistant');
            const lastAsstContent = (lastAsst?.content || '').trim();
            const lastAsstCut = !!lastAsstContent && !/[.!?}\]`"'][\s]*$/.test(lastAsstContent);

            const lines: string[] = [];
            if (tier === 'critical') {
              lines.push(`⚠️ **Context critical — ${percent}% full** (${usedK}K / ${maxK}K tokens).`);
              if (lastAsstCut) {
                lines.push('');
                lines.push(`The reply above was **cut short** because the context filled up mid-answer. It's not a UI bug — the partial reply is preserved above this warning.`);
              }
              lines.push('');
              lines.push(`**Next step:** open **Tools ▾ → Compress context** to reclaim space, or branch from a relevant message to start fresh with the key bits carried over.`);
            } else {
              lines.push(`⚠️ **Context warning — ${percent}% full** (${usedK}K / ${maxK}K tokens).`);
              lines.push('');
              lines.push(`Once this hits ~95% the agent will start truncating replies. Consider **Tools ▾ → Compress context** before the next big turn.`);
            }
            const warnMsg: Message = {
              id: generateId(),
              role: 'system',
              content: lines.join('\n'),
              timestamp: new Date(),
            };
            return { ...s, messages: [...live, warnMsg], updatedAt: new Date() };
          }));

          // Auto-compress kicks in at 80%+ on the same threshold check.
          // Posts its own progress messages and applies the snapshot
          // silently in the background. The user's next turn benefits.
          if (pct >= 0.80) {
            void autoCompressIfHigh(targetSessionId);
          }
        }, 500);

        // Reset retry counter on successful completion
        sessionStorage.removeItem(`chat_retry_count_${targetSessionId}`);
        
        if (!seemsComplete) {
          console.warn('[Chat] Stream ended but response may be incomplete');
        }
      } else {
        // Stream ended but no content received - this is the silent failure case
        // Before giving up, try server-side buffer poll (the gateway may still be working)
        console.warn('[Chat] Stream ended with no content — trying server buffer poll');
        
        // Check if there's a backup (only accept fresh ones — stale backups
        // from a previous hung request would otherwise be re-played on every
        // send, making it look like the chat keeps returning the same message)
        const BACKUP_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
        const backup = localStorage.getItem('chat_partial_response');
        if (backup) {
          try {
            const parsed = JSON.parse(backup);
            const age = Date.now() - (parsed.timestamp || 0);
            if (age > BACKUP_MAX_AGE_MS) {
              console.warn('[Chat] Discarding stale chat_partial_response (age:', Math.round(age / 1000), 's)');
              localStorage.removeItem('chat_partial_response');
            } else if (parsed.sessionId === targetSessionId && parsed.content) {
              const recoveredMessage: Message = {
                id: generateId(),
                role: 'assistant',
                content: parsed.content + '\n\n---\n⚠️ *Recovered from auto-save - response was interrupted*',
                timestamp: new Date(),
              };
              appendSessionMessage(targetSessionId, recoveredMessage);
              localStorage.removeItem('chat_partial_response');
              return;
            }
          } catch {}
        }
        
        // Poll the server-side buffer — the CLI may still be working (tool calls
        // produce no text deltas). Keep polling until the server says it's done or
        // we hit a timeout. This replaces the old single-poll that gave up immediately.
        const activeReq = localStorage.getItem('chat_active_request');
        if (activeReq) {
          try {
            const { requestId: reqId } = JSON.parse(activeReq);
            if (reqId) {
              console.log('[Chat] Stream closed but CLI may still be working — polling server buffer');
              isPollingServer = true; // Prevent finally block from clearing loading state
              setStreamingMap(prev => ({...prev, [targetSessionId]: '⏳ *Agent is working (using tools)...*'}));

              const POLL_INTERVAL = 3000; // 3 seconds
              const POLL_TIMEOUT = 14_400_000; // 4 hours
              const pollStart = Date.now();
              let resolved = false;

              while (!resolved && (Date.now() - pollStart) < POLL_TIMEOUT) {
                await new Promise(r => setTimeout(r, POLL_INTERVAL));
                try {
                  const pollRes = await fetch(`/api/chat?requestId=${encodeURIComponent(reqId)}`);
                  const pollData = await pollRes.json();
                  if (pollData.found && pollData.content) {
                    // Show progress while streaming
                    setStreamingMap(prev => ({...prev, [targetSessionId]: pollData.content}));
                  }
                  if (pollData.found && pollData.done) {
                    // CLI finished — show final response
                    if (pollData.content) {
                      const recoveredMsg: Message = {
                        id: generateId(),
                        role: 'assistant',
                        content: pollData.content,
                        timestamp: new Date(),
                      };
                      appendSessionMessage(targetSessionId, recoveredMsg);
                    } else {
                      // Done but no content — turn ended without a summary.
                      // Show a system message so the user isn't left guessing.
                      const emptyMsg: Message = {
                        id: generateId(),
                        role: 'system',
                        content: `⚠️ Agent finished its turn without writing a response. This usually happens when sub-agents did all the work but the parent agent didn't summarize.\n\n**Fix:** type **"summarize what you just did"** or **"continue"** and the agent will recap for you. Nothing was lost — tool outputs are still in the session.`,
                        timestamp: new Date(),
                      };
                      appendSessionMessage(targetSessionId, emptyMsg);
                      console.warn('[Chat] Poll done with empty content — synthesized nudge message');
                    }
                    localStorage.removeItem('chat_active_request');
                    setStreamingMap(prev => ({...prev, [targetSessionId]: ''}));
                    setLoadingMap(prev => ({...prev, [targetSessionId]: false}));
                    resolved = true;
                    break;
                  }
                  if (!pollData.found) {
                    // Server lost the request — give up
                    break;
                  }
                } catch {
                  // Network error — keep trying
                }
              }

              if (resolved) return;
              setStreamingMap(prev => ({...prev, [targetSessionId]: ''}));
              setLoadingMap(prev => ({...prev, [targetSessionId]: false}));
            }
          } catch {}
        }

        setLoadingMap(prev => ({...prev, [targetSessionId]: false}));
        const warningMsg: Message = {
          id: generateId(),
          role: 'system',
          content: `⚠️ No response received after polling. The agent may have timed out.\n\n**Try:** Send your message again.`,
          timestamp: new Date(),
        };
        appendSessionMessage(targetSessionId, warningMsg);
      }

    } catch (error: any) {
      // Stream died — but the server is still buffering the response.
      // Don't show errors or retry. Poll the server for the buffered response.
      console.warn('[Chat] Client stream interrupted:', error.message, '| fullContent:', fullContent.length, 'chars');
      
      // If user explicitly cancelled (stop button), don't recover
      if (error.name === 'AbortError' && !localStorage.getItem('chat_active_request')) {
        console.log('[Chat] Request cancelled by user');
        // Only show partial content if the session wasn't explicitly stopped
        // (prevents the "message disappears then reappears" bug)
        if (fullContent.length > 0 && !stoppedSessionsRef.current.has(targetSessionId)) {
          const partialMsg: Message = {
            id: generateId(),
            role: 'assistant',
            content: fullContent,
            timestamp: new Date(),
          };
          appendSessionMessage(targetSessionId, partialMsg);
        }
      } else if (stoppedSessionsRef.current.has(targetSessionId)) {
        // Session was stopped by user (e.g. stop button before new send) — don't recover
        console.log('[Chat] Session was stopped, skipping recovery');
      } else {
        // Stream died due to tab switch / screen lock / network hiccup. The
        // SERVER agent is still running — keep loading state alive and poll
        // /api/chat?requestId=X for the final content. NO message is written
        // into the chat (no scary "Connection interrupted" banner). Once the
        // agent finishes server-side, the regular endTurn path commits the
        // message normally + chat-broadcast emits sync-done so the SSE
        // listener path also handles it.
        const activeReq = localStorage.getItem('chat_active_request');
        if (activeReq) {
          try {
            const { requestId: reqId } = JSON.parse(activeReq);
            if (reqId) {
              setLoadingMap(prev => ({ ...prev, [targetSessionId]: true }));
              // Show what we have so far in the streaming indicator (above
              // composer), not as a permanent message. Replaces the old
              // "Connection interrupted" pseudo-message UX.
              if (fullContent) {
                setStreamingMap(prev => ({ ...prev, [targetSessionId]: fullContent }));
              }
              isPollingServer = true;

              const poll = async () => {
                const startedAt = Date.now();
                const maxMs = 10 * 60_000;
                while (Date.now() - startedAt < maxMs) {
                  try {
                    const res = await fetch(`/api/chat?requestId=${encodeURIComponent(reqId)}`);
                    const data = await res.json();
                    if (data.found && typeof data.content === 'string') {
                      setStreamingMap(prev => ({ ...prev, [targetSessionId]: data.content }));
                      if (data.done) {
                        // Final content now lives in pendingResponses + the
                        // server's commitAssistantMessageIfMissing fallback
                        // will write it to the chat file. We also append
                        // here so the active tab sees it immediately.
                        if (data.content) {
                          appendSessionMessage(targetSessionId, {
                            id: generateId(),
                            role: 'assistant',
                            content: data.content,
                            timestamp: new Date(),
                          } as Message);
                        }
                        localStorage.removeItem('chat_active_request');
                        localStorage.removeItem('chat_partial_response');
                        setLoadingMap(prev => ({ ...prev, [targetSessionId]: false }));
                        setStreamingMap(prev => ({ ...prev, [targetSessionId]: '' }));
                        return;
                      }
                    } else if (data.found === false) {
                      // pendingResponses GC'd or never existed — stop quietly.
                      break;
                    }
                  } catch { /* network blip, retry */ }
                  await new Promise(r => setTimeout(r, 2000));
                }
                // Timed out — clear state without writing a panic message.
                setLoadingMap(prev => ({ ...prev, [targetSessionId]: false }));
                setStreamingMap(prev => ({ ...prev, [targetSessionId]: '' }));
              };
              poll();
              return;
            }
          } catch {}
        }
      }
    } finally {
      clearTimeout(timeoutId);
      if (!isPollingServer) {
        setLoadingMap(prev => ({...prev, [targetSessionId]: false}));
        setStreamingMap(prev => ({...prev, [targetSessionId]: ''}));
        abortControllers.current[targetSessionId] = null as any;
      }
      localStorage.removeItem('chat_partial_response');
    }
    } catch (outerError: any) {
      // Catch ANY error in sendMessage - make it visible on screen
      console.error('[Chat] sendMessage outer error:', outerError);
      console.error('[Chat] sendMessage error:', outerError);
      setLoadingMap(prev => ({...prev, [targetSessionId]: false}));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Skip if actively composing (IME) unless it's a physical keyboard Enter
      // Some tablet keyboards incorrectly report isComposing, so we allow keyCode 13
      if (e.nativeEvent.isComposing && e.keyCode !== 13) return;
      e.preventDefault();
      sendMessage();
    }
  };

  // Track which sessions have been explicitly stopped — prevents stale closures
  // from re-adding content after the user clicks stop.
  const stoppedSessionsRef = useRef<Set<string>>(new Set());

  const stopGeneration = async (sessionIdOverride?: string) => {
    const sid = sessionIdOverride || activeSessionId;
    if (!sid) return;

    // Mark as stopped FIRST — the streaming loop checks this before writing messages
    stoppedSessionsRef.current.add(sid);

    // Clear request markers BEFORE aborting
    localStorage.removeItem('chat_active_request');
    localStorage.removeItem('chat_partial_response');

    // Abort the client-side stream
    if (abortControllers.current[sid]) {
      abortControllers.current[sid].abort();
      abortControllers.current[sid] = null as any;
    }

    // Reset loading/streaming state immediately so UI is responsive
    setLoadingMap(prev => ({ ...prev, [sid]: false }));
    setStreamingMap(prev => ({ ...prev, [sid]: '' }));
    setActivityMap(prev => ({ ...prev, [sid]: null }));

    // Kill the server-side CLI process
    const sess = sessions.find(s => s.id === sid);
    const sessionKey = sess?.sessionKey;
    if (sessionKey) {
      fetch('/api/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey }),
      }).catch(() => {});
    }
  };

  // Wand button — enhance the in-progress draft via Sonnet. Sends the
  // current input + recent chat messages to /api/chat/enhance-prompt, which
  // returns a rewritten prompt that explicitly names which skills/agents
  // the main MC chat should use. The new text replaces the input so the
  // user can edit + send normally.
  const [enhancingMap, setEnhancingMap] = useState<Record<string, boolean>>({});
  const enhancePrompt = async () => {
    const targetSessionId = activeSessionId;
    if (!targetSessionId) return;
    const currentInput = inputMap[targetSessionId] || '';
    if (!currentInput.trim()) return;
    if (enhancingMap[targetSessionId]) return; // already running

    setEnhancingMap(prev => ({ ...prev, [targetSessionId]: true }));
    try {
      // Send every message in this chat — Sonnet has a 200k window and
      // should see the full context, not a truncated tail.
      const recentMessages = allMessages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : '',
      }));
      const res = await fetch('/api/chat/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: currentInput,
          recentMessages,
          chatId: activeSession?.id,
        }),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        console.error('[wand] enhance failed', res.status, err);
        alert(`Wand failed: ${res.status} ${err.slice(0, 200)}`);
        return;
      }
      const data = await res.json();
      const enhanced = (data?.enhanced || '').trim();
      if (!enhanced) {
        alert('Wand returned empty response — try again or send as-is.');
        return;
      }
      // Replace input with enhanced text. User can edit before sending.
      setInputMap(prev => ({ ...prev, [targetSessionId]: enhanced }));
      inputValueRefs.current[targetSessionId] = enhanced;
      // Refocus the textarea so the user can edit immediately + resize.
      setTimeout(() => {
        const ta = inputRef.current;
        if (ta) {
          ta.focus();
          ta.style.height = 'auto';
          const maxH = window.innerWidth < 768 ? 400 : 240;
          ta.style.height = Math.min(ta.scrollHeight, maxH) + 'px';
          // Move cursor to end so the user can keep typing.
          ta.setSelectionRange(enhanced.length, enhanced.length);
        }
      }, 50);
    } catch (e: any) {
      console.error('[wand] error', e);
      alert(`Wand error: ${e.message}`);
    } finally {
      setEnhancingMap(prev => ({ ...prev, [targetSessionId]: false }));
    }
  };

  // Spawn task - runs in background with Task Panel visualization
  const spawnTask = async () => {
    const targetSessionId = activeSessionId;
    if (!targetSessionId) return;
    
    const currentInput = inputMap[targetSessionId] || '';
    const currentLoading = loadingMap[targetSessionId] || false;
    
    if (!currentInput.trim() || currentLoading) return;

    const { workspace } = getConfig();

    const taskContent = currentInput.trim();
    const taskId = `task-${Date.now()}`;
    
    // Gather last 3 messages from current session for context
    const recentMessages = allMessages.slice(-3).map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const content = typeof m.content === 'string' ? m.content : '';
      return `**${role}:** ${content.slice(0, 500)}${content.length > 500 ? '...' : ''}`;
    }).join('\n\n');

    const messageContext = recentMessages 
      ? `## Recent Conversation Context\n\n${recentMessages}\n\n---\n\n` 
      : '';
    
    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: taskContent,
      timestamp: new Date(),
    };

    const updatedMessages = [...allMessages, userMessage];
    updateSessionMessages(targetSessionId, updatedMessages);
    
    // Clear input for this session
    setInputMap(prev => ({...prev, [targetSessionId]: ''}));
    inputValueRefs.current[targetSessionId] = '';
    
    // Check if input references an MD file
    const filePath = extractFilePath(taskContent);
    
    // Show Task Panel immediately in loading state
    const newTask: ActiveTask = {
      id: taskId,
      label: taskId,
      sessionKey: taskId,
      prompt: taskContent,
      filePath: filePath || undefined,
      status: 'loading',
      items: [],
      currentItemIndex: -1,
      output: filePath 
        ? `📂 Loading task file: ${filePath}...`
        : '⏳ Starting task...',
      startedAt: new Date(),
    };
    setActiveTask(newTask);
    setActiveView('tasks');
    
    // Show spawned message in chat
    const spawnMsg: Message = {
      id: generateId(),
      role: 'system',
      content: `🚀 **Task started** → See progress in the Task Panel →`,
      timestamp: new Date(),
    };
    appendSessionMessage(targetSessionId, spawnMsg);

    // Run task initialization
    (async () => {
      try {
        if (filePath) {
          // Parse the MD file for tasks
          const parseResponse = await fetch('/api/task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'parse',
              filePath,
            }),
          });

          const parseResult = await parseResponse.json();
          
          if (parseResult.error) {
            // Include detailed error information if available
            const errorMsg = parseResult.details 
              ? `${parseResult.error}\n\n${parseResult.details}`
              : parseResult.error;
            throw new Error(errorMsg);
          }

          // Check if user provided context/preferences in the prompt (skip questions if so)
          const hasContext = /\b(use|focus|only|critical|high|skip|start|openrouter|tiptap|indexeddb|localstorage)\b/i.test(taskContent);
          
          // Build output message
          let outputMsg = `📋 **${parseResult.title || 'Task List'}**\n\n`;
          
          // Add location notice if file was found elsewhere
          if (parseResult.foundAt && parseResult.requestedPath) {
            outputMsg += `📁 Found at: \`${parseResult.foundAt}\`\n_(Requested: ${parseResult.requestedPath})_\n\n`;
          }
          
          if (!hasContext) {
            outputMsg += `${parseResult.summary || ''}\n\n`;
          }
          
          outputMsg += `Found ${parseResult.items.length} tasks.`;
          outputMsg += hasContext 
            ? '\n\n🚀 Starting with live streaming...'
            : ' Checking for clarifying questions...';
          
          // Update with parsed tasks
          setActiveTask(prev => prev?.id === taskId ? {
            ...prev,
            filePath: parseResult.filePath,
            items: parseResult.items.map((item: any) => ({
              ...item,
              status: item.status || 'pending',
            })),
            output: outputMsg,
            status: hasContext ? 'running' : 'loading',
          } : prev);

          if (hasContext) {
            // Fast start - skip questions, go straight to SSE streaming
            startStreamingExecution(taskId, parseResult.items, messageContext + taskContent, workspace || '', filePath);
          } else {
            // Ask clarifying questions
            const clarifyResponse = await fetch('/api/task', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'clarify',
                filePath: parseResult.filePath,
                summary: parseResult.summary,
                items: parseResult.items,
                workspace,
              }),
            });

            const clarifyResult = await clarifyResponse.json();
            
            if (clarifyResult.error) {
              throw new Error(clarifyResult.error);
            }

            if (clarifyResult.ready) {
              // No questions, start execution
              setActiveTask(prev => prev?.id === taskId ? {
                ...prev,
                status: 'running',
                currentItemIndex: 0,
                output: prev.output + '\n\n✅ No questions. Starting task execution...',
              } : prev);
              
              // Trigger execution
              taskExecutionRef.current = { running: true, itemIndex: 0 };
              executeNextTaskItem(taskId, parseResult.items, 0, workspace || '', targetSessionId);
            } else {
              // Show questions
              setActiveTask(prev => prev?.id === taskId ? {
                ...prev,
                status: 'clarifying',
                questions: clarifyResult.questions,
                output: prev.output + '\n\n❓ Agent has questions before starting...',
              } : prev);
            }
          }
        } else {
          // No file - send through normal chat instead of blocking task API
          // This prevents timeouts on complex tasks and keeps the UX consistent
          setActiveTask(prev => prev?.id === taskId ? {
            ...prev,
            status: 'completed',
            output: '✅ Task sent to agent via chat',
            completedAt: new Date(),
          } : prev);

          const env = envConfig[activeEnvironment];
          let contextParts = [];
          
          contextParts.push(`[Environment: ${activeEnvironment.toUpperCase()}]
• SaaS URL: ${env.saasUrl}
• App URL: ${env.appUrl}
• Git Branch: ${env.branch}
• Supabase: ${env.supabaseRef}`);
          
          if (workspace) {
            contextParts.push(`[Working in: ${workspace}]`);
          }
          
          const fullTask = messageContext + contextParts.join('\n\n') + '\n\n---\n\n' + taskContent;

          // Send as a normal chat message by setting input and calling sendMessage
          if (activeSessionId) {
            setInputMap(prev => ({...prev, [activeSessionId]: fullTask}));
            inputValueRefs.current[activeSessionId] = fullTask;
            setTimeout(() => sendMessage(), 100); // Small delay to ensure state updates
          }
        }

      } catch (error: any) {
        console.error('[SpawnTask] Error:', error);
        
        setActiveTask(prev => prev?.id === taskId ? {
          ...prev,
          output: `❌ Task failed: ${error.message}`,
          status: 'failed',
          completedAt: new Date(),
        } : prev);
      }
    })();
  };

  // Execute task items one by one
  const executeNextTaskItem = async (
    taskId: string,
    items: TaskItem[],
    itemIndex: number,
    workspace: string,
    sessionId: string
  ) => {
    if (!taskExecutionRef.current.running || itemIndex >= items.length) {
      // All done or paused
      if (itemIndex >= items.length) {
        setActiveTask(prev => prev?.id === taskId ? {
          ...prev,
          status: 'completed',
          completedAt: new Date(),
          output: prev.output + '\n\n✅ All tasks completed!',
        } : prev);
        
        // Add completion message to chat
        const resultMsg: Message = {
          id: generateId(),
          role: 'assistant',
          content: `✅ **Task list completed!** (${items.length} items)`,
          timestamp: new Date(),
        };
        setSessions(prevSessions => prevSessions.map(s => 
          s.id === sessionId 
            ? { ...s, messages: [...s.messages, resultMsg], updatedAt: new Date() }
            : s
        ));
      }
      return;
    }

    const currentItem = items[itemIndex];
    
    // Mark current item as in-progress
    setActiveTask(prev => {
      if (!prev || prev.id !== taskId) return prev;
      const updatedItems = [...prev.items];
      if (updatedItems[itemIndex]) {
        updatedItems[itemIndex] = { ...updatedItems[itemIndex], status: 'in-progress' };
      }
      return {
        ...prev,
        items: updatedItems,
        currentItemIndex: itemIndex,
        output: prev.output + `\n\n🔄 **Task ${itemIndex + 1}/${items.length}:** ${currentItem.text}`,
      };
    });

    try {
      const response = await fetch('/api/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'execute-item',
          filePath: activeTask?.filePath,
          workspace,
          currentItem,
        }),
      });

      const result = await response.json();
      
      if (result.error) {
        throw new Error(result.error);
      }

      // Update item status
      const newStatus = result.itemFailed ? 'failed' : 'done';
      setActiveTask(prev => {
        if (!prev || prev.id !== taskId) return prev;
        const updatedItems = [...prev.items];
        if (updatedItems[itemIndex]) {
          updatedItems[itemIndex] = { ...updatedItems[itemIndex], status: newStatus };
        }
        return {
          ...prev,
          items: updatedItems,
          output: prev.output + `\n\n${result.content || '(no output)'}`,
        };
      });

      // Continue to next item
      taskExecutionRef.current.itemIndex = itemIndex + 1;
      setTimeout(() => {
        executeNextTaskItem(taskId, items, itemIndex + 1, workspace, sessionId);
      }, 500);

    } catch (error: any) {
      console.error('[ExecuteItem] Error:', error);
      
      const isNetworkError = error.message.includes('Failed to fetch') || 
                            error.message.includes('NetworkError') ||
                            error.message.includes('ECONNREFUSED');
      
      setActiveTask(prev => {
        if (!prev || prev.id !== taskId) return prev;
        const updatedItems = [...prev.items];
        if (updatedItems[itemIndex]) {
          updatedItems[itemIndex] = { ...updatedItems[itemIndex], status: 'failed' };
        }
        return {
          ...prev,
          items: updatedItems,
          output: prev.output + `\n\n❌ Error: ${error.message}` + 
            (isNetworkError ? '\n\n🛑 **Stopping task execution** — server appears to be down. Refresh the page and try again.' : ''),
          status: isNetworkError ? 'failed' : prev.status,
        };
      });
      
      // Stop on network errors, continue on other errors
      if (!isNetworkError) {
        taskExecutionRef.current.itemIndex = itemIndex + 1;
        setTimeout(() => {
          executeNextTaskItem(taskId, items, itemIndex + 1, workspace, sessionId);
        }, 500);
      } else {
        taskExecutionRef.current.running = false;
      }
    }
  };

  // Start/Resume task execution
  const startTaskExecution = () => {
    if (!activeTask || activeTask.items.length === 0) return;
    
    const { workspace } = getConfig();
    const startIndex = activeTask.currentItemIndex >= 0 ? activeTask.currentItemIndex : 0;
    
    taskExecutionRef.current = { running: true, itemIndex: startIndex };
    setActiveTask(prev => prev ? { ...prev, status: 'running' } : null);
    
    executeNextTaskItem(
      activeTask.id,
      activeTask.items,
      startIndex,
      workspace || '',
      activeSessionId || ''
    );
  };

  // Pause task execution
  const pauseTaskExecution = () => {
    taskExecutionRef.current.running = false;
    setActiveTask(prev => prev ? { ...prev, status: 'paused' } : null);
  };

  // Skip current task item
  const skipTaskItem = () => {
    if (!activeTask) return;
    
    const currentIndex = taskExecutionRef.current.itemIndex;
    
    setActiveTask(prev => {
      if (!prev) return null;
      const updatedItems = [...prev.items];
      if (updatedItems[currentIndex]) {
        updatedItems[currentIndex] = { ...updatedItems[currentIndex], status: 'done' };
      }
      return {
        ...prev,
        items: updatedItems,
        output: prev.output + '\n\n⏭️ Skipped.',
      };
    });
    
    // Move to next item
    const { workspace } = getConfig();
    taskExecutionRef.current.itemIndex = currentIndex + 1;
    setTimeout(() => {
      executeNextTaskItem(
        activeTask.id,
        activeTask.items,
        currentIndex + 1,
        workspace || '',
        activeSessionId || ''
      );
    }, 100);
  };

  // Start SSE streaming execution (fast path - skips clarifying questions)
  const startStreamingExecution = async (
    taskId: string,
    items: TaskItem[],
    userContext: string,
    workspace: string,
    filePath: string
  ) => {
    try {
      // Check if items is empty - fail fast instead of making the request
      if (!items || items.length === 0) {
        setActiveTask(prev => prev?.id === taskId ? {
          ...prev,
          status: 'failed',
          output: prev.output + '\n\n❌ No tasks found to execute',
        } : prev);
        return;
      }

      // Determine priority filter from user context
      // Default: run ALL tasks. Only filter if user explicitly says "critical only" etc.
      let priorityFilter = '';
      if (/critical\s*only/i.test(userContext)) priorityFilter = 'critical';
      else if (/high\s*only/i.test(userContext)) priorityFilter = 'critical,high';
      else if (/important\s*only|blockers?\s*only/i.test(userContext)) priorityFilter = 'critical,high';
      // Empty = all priorities (no filtering)
      
      const response = await fetch('/api/task-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath,
          items, // Pass items directly to the streaming endpoint
          answers: userContext,
          workspace,
          priorityFilter, // Empty = all tasks, or specific filter if user requested
        }),
      });

      if (!response.ok) {
        throw new Error(`Stream failed: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ') && currentEvent) {
            try {
              const data = JSON.parse(line.slice(6));
              handleStreamEvent(taskId, currentEvent, data);
            } catch (e) {
              console.error('[SSE] Parse error:', e);
            }
            currentEvent = '';
          }
        }
      }

    } catch (error: any) {
      setActiveTask(prev => prev?.id === taskId ? {
        ...prev,
        status: 'failed',
        output: prev.output + `\n\n❌ Streaming error: ${error.message}`,
      } : prev);
    }
  };

  // Handle SSE events
  const handleStreamEvent = (taskId: string, event: string, data: any) => {
    switch (event) {
      case 'status':
        setActiveTask(prev => prev?.id === taskId ? {
          ...prev,
          output: prev.output + `\n\n📋 ${data.message}`,
        } : prev);
        break;
        
      case 'parsed':
        setActiveTask(prev => prev?.id === taskId ? {
          ...prev,
          items: data.items.map((item: any) => ({
            ...item,
            status: 'pending' as const,
          })),
          output: prev.output + `\n\n📋 **${data.title}** - ${data.totalItems} tasks to execute`,
        } : prev);
        break;
        
      case 'task_start':
        setActiveTask(prev => {
          if (!prev || prev.id !== taskId) return prev;
          const updatedItems = [...prev.items];
          if (updatedItems[data.index]) {
            updatedItems[data.index] = { ...updatedItems[data.index], status: 'in-progress' };
          }
          return {
            ...prev,
            items: updatedItems,
            currentItemIndex: data.index,
            output: prev.output + `\n\n🔄 **Task ${data.index + 1}/${data.total}:** ${data.text}`,
          };
        });
        break;
        
      case 'task_output':
        setActiveTask(prev => prev?.id === taskId ? {
          ...prev,
          output: prev.output + data.chunk,
        } : prev);
        break;
        
      case 'task_complete':
        setActiveTask(prev => {
          if (!prev || prev.id !== taskId) return prev;
          const updatedItems = [...prev.items];
          if (updatedItems[data.index]) {
            updatedItems[data.index] = { ...updatedItems[data.index], status: 'done' };
          }
          return {
            ...prev,
            items: updatedItems,
            output: prev.output + `\n\n${data.content}\n\n✅ Task ${data.index + 1} complete (${data.completed} done, ${data.remaining} remaining)`,
          };
        });
        break;
        
      case 'task_failed':
        setActiveTask(prev => {
          if (!prev || prev.id !== taskId) return prev;
          const updatedItems = [...prev.items];
          if (updatedItems[data.index]) {
            updatedItems[data.index] = { ...updatedItems[data.index], status: 'failed' };
          }
          return {
            ...prev,
            items: updatedItems,
            output: prev.output + `\n\n❌ Task ${data.index + 1} failed: ${data.error}`,
          };
        });
        break;
        
      case 'complete':
        setActiveTask(prev => prev?.id === taskId ? {
          ...prev,
          status: 'completed',
          completedAt: new Date(),
          output: prev.output + `\n\n🎉 **${data.message}**`,
        } : prev);
        break;
        
      case 'error':
        setActiveTask(prev => prev?.id === taskId ? {
          ...prev,
          status: 'failed',
          output: prev.output + `\n\n❌ Error: ${data.message}`,
        } : prev);
        break;
    }
  };

  // Answer clarifying questions - starts SSE streaming execution
  const answerTaskQuestions = async (answer: string) => {
    if (!activeTask || !activeSessionId) return;
    
    const { workspace } = getConfig();
    const taskId = activeTask.id;
    
    setActiveTask(prev => prev ? {
      ...prev,
      output: prev.output + `\n\n**Your answer:** ${answer}\n\n🚀 Starting task execution with live streaming...`,
      questions: undefined,
      status: 'running',
    } : null);

    // Use the shared streaming execution
    startStreamingExecution(
      taskId,
      activeTask.items,
      answer,
      workspace || '',
      activeTask.filePath || ''
    );
  };

  // Legacy handler for old code paths - can be removed later
  const _legacyStreamHandler = async (response: Response, taskId: string) => {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7);
        } else if (line.startsWith('data: ') && currentEvent) {
          try {
            const data = JSON.parse(line.slice(6));
            handleStreamEvent(taskId, currentEvent, data);
          } catch (e) {
            console.error('[SSE] Parse error:', e);
          }
          currentEvent = '';
        }
      }
    }
  };

  // Keep the old switch for backwards compatibility but it's now unused
  const _oldEventSwitch = (currentEvent: string, data: any) => {
    switch (currentEvent) {
      case 'status':
        setActiveTask(prev => prev ? {
          ...prev,
          output: prev.output + `\n\n📋 ${data.message}`,
        } : null);
        break;
        
      case 'parsed':
        setActiveTask(prev => prev ? {
          ...prev,
          items: data.items.map((item: any) => ({
            ...item,
            status: 'pending' as const,
          })),
          output: prev.output + `\n\n📋 **${data.title}** - ${data.totalItems} tasks to execute`,
        } : null);
        break;
        
      case 'task_start':
        setActiveTask(prev => {
          if (!prev) return null;
          const updatedItems = [...prev.items];
          if (updatedItems[data.index]) {
            updatedItems[data.index] = { ...updatedItems[data.index], status: 'in-progress' };
          }
          return {
            ...prev,
            items: updatedItems,
            currentItemIndex: data.index,
            output: prev.output + `\n\n🔄 **Task ${data.index + 1}/${data.total}:** ${data.text}`,
          };
        });
        break;
        
      case 'task_complete':
        setActiveTask(prev => {
          if (!prev) return null;
          const updatedItems = [...prev.items];
          if (updatedItems[data.index]) {
            updatedItems[data.index] = { ...updatedItems[data.index], status: 'done' };
          }
          return {
            ...prev,
            items: updatedItems,
            output: prev.output + `\n\n${data.content}\n\n✅ Task ${data.index + 1} complete (${data.completed} done, ${data.remaining} remaining)`,
          };
        });
        break;
        
      case 'task_failed':
        setActiveTask(prev => {
          if (!prev) return null;
          const updatedItems = [...prev.items];
          if (updatedItems[data.index]) {
            updatedItems[data.index] = { ...updatedItems[data.index], status: 'failed' };
          }
          return {
            ...prev,
            items: updatedItems,
            output: prev.output + `\n\n❌ Task ${data.index + 1} failed: ${data.error}`,
          };
        });
        break;
        
      case 'complete':
        setActiveTask(prev => prev ? {
          ...prev,
          status: 'completed',
          completedAt: new Date(),
          output: prev.output + `\n\n🎉 **${data.message}**`,
        } : null);
        break;
        
      case 'error':
        setActiveTask(prev => prev ? {
          ...prev,
          status: 'failed',
          output: prev.output + `\n\n❌ Error: ${data.message}`,
        } : null);
        break;
    }
  };

  // Send follow-up message during task
  const sendTaskMessage = async (message: string) => {
    if (!activeTask) return;
    
    const { workspace: _ws } = getConfig();
    
    try {
      setActiveTask(prev => prev ? {
        ...prev,
        output: prev.output + `\n\n---\n\n**You:** ${message}\n\n⏳ Processing...`,
      } : null);
      
      const response = await fetch('/api/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run',
          task: `Context: Working on task from ${activeTask.filePath || 'user request'}\n\nUser says: ${message}`,
        }),
      });
      
      const result = await response.json();
      
      if (result.error) {
        throw new Error(result.error);
      }
      
      const reply = result.content || 'No response';
      setActiveTask(prev => prev ? {
        ...prev,
        output: prev.output.replace('⏳ Processing...', '') + `\n\n**Agent:** ${reply}`,
      } : null);
    } catch (error: any) {
      console.error('[TaskMessage] Error:', error);
      setActiveTask(prev => prev ? {
        ...prev,
        output: prev.output.replace('⏳ Processing...', '') + `\n\n❌ Error: ${error.message}`,
      } : null);
    }
  };

  // Close task panel
  const closeTaskPanel = () => {
    taskExecutionRef.current.running = false;
    setActiveTask(null);
    setIsTaskMinimized(false);
    // Persist the closed state so it doesn't reappear on refresh
    if (activeSessionId) {
      saveTasksToStorage(activeSessionId, taskHistory, null, false);
    }
  };

  // Minimize task panel (persists state)
  const minimizeTaskPanel = () => {
    setIsTaskMinimized(true);
    if (activeSessionId && activeTask) {
      saveTasksToStorage(activeSessionId, taskHistory, activeTask.id, true);
    }
  };

  // Maximize task panel (persists state)
  const maximizeTaskPanel = () => {
    setIsTaskMinimized(false);
    if (activeSessionId && activeTask) {
      saveTasksToStorage(activeSessionId, taskHistory, activeTask.id, false);
    }
  };

  // Retry all failed tasks - reset their status and restart from first failed
  const retryFailedTasks = () => {
    if (!activeTask || !activeSessionId) return;
    
    const { workspace } = getConfig();
    
    // Find first failed index and reset all failed items to pending
    const firstFailedIndex = activeTask.items.findIndex(i => i.status === 'failed');
    if (firstFailedIndex < 0) return;
    
    const updatedItems = activeTask.items.map((item, i) => 
      item.status === 'failed' ? { ...item, status: 'pending' as const } : item
    );
    
    setActiveTask(prev => prev ? {
      ...prev,
      items: updatedItems,
      status: 'running',
      currentItemIndex: firstFailedIndex,
      output: prev.output + '\n\n🔄 **Retrying failed tasks...**',
    } : null);
    
    taskExecutionRef.current = { running: true, itemIndex: firstFailedIndex };
    
    // Small delay to let state update
    setTimeout(() => {
      executeNextTaskItem(
        activeTask.id,
        updatedItems,
        firstFailedIndex,
        workspace || '',
        activeSessionId
      );
    }, 100);
  };

  // Resume from a specific item index
  const resumeFromItem = (itemIndex: number) => {
    if (!activeTask || !activeSessionId) return;
    
    const { workspace } = getConfig();
    
    // Reset the specific item and all after it to pending
    const updatedItems = activeTask.items.map((item, i) => 
      i >= itemIndex && (item.status === 'failed' || item.status === 'pending') 
        ? { ...item, status: 'pending' as const } 
        : item
    );
    
    setActiveTask(prev => prev ? {
      ...prev,
      items: updatedItems,
      status: 'running',
      currentItemIndex: itemIndex,
      output: prev.output + `\n\n🔄 **Resuming from task ${itemIndex + 1}...**`,
    } : null);
    
    taskExecutionRef.current = { running: true, itemIndex };
    
    setTimeout(() => {
      executeNextTaskItem(
        activeTask.id,
        updatedItems,
        itemIndex,
        workspace || '',
        activeSessionId
      );
    }, 100);
  };

  const clearChat = () => {
    if (!activeSessionId) return;
    
    const clearedMessages: Message[] = [{
      id: generateId(),
      role: 'system',
      content: 'Chat cleared. Send a message to chat with your agent.',
      timestamp: new Date(),
    }];
    updateSessionMessages(activeSessionId, clearedMessages);
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };

  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [showMobileTools, setShowMobileTools] = useState(false);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [showMobileTaskPanel, setShowMobileTaskPanel] = useState(false);

  // Recover response from server buffer when tab regains focus (mobile lock, tab switch)
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;
      
      // Check if there was an active request when we left
      const activeReq = localStorage.getItem('chat_active_request');
      if (!activeReq) return;
      
      try {
        const { requestId, sessionId: sid } = JSON.parse(activeReq);
        if (!requestId || !sid) return;
        
        // Wait a moment for stream to potentially resume
        await new Promise(r => setTimeout(r, 1500));

        // Always check the server — even if streamingMap still has content, we
        // want to know if the bridge already marked done=true. On mobile the
        // SSE connection often gets torn while backgrounded, leaving a stale
        // "working..." indicator forever if we don't re-sync.
        console.log('[Chat] Tab resumed — polling server for buffered response:', requestId);
        const res = await fetch(`/api/chat?requestId=${encodeURIComponent(requestId)}`);
        const data = await res.json();
        
        if (!data.found || !data.content) {
          // Also check sessionStorage backup — but only if it's recent.
          // A stale backup from an old hung request would otherwise be
          // replayed every time the tab becomes visible.
          const BACKUP_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
          const backup = localStorage.getItem('chat_partial_response');
          if (backup) {
            const parsed = JSON.parse(backup);
            const age = Date.now() - (parsed.timestamp || 0);
            if (age > BACKUP_MAX_AGE_MS) {
              console.warn('[Chat] Discarding stale chat_partial_response on visibility change (age:', Math.round(age / 1000), 's)');
              localStorage.removeItem('chat_partial_response');
            } else if (parsed.content && parsed.sessionId === sid) {
              data.found = true;
              data.content = parsed.content;
              data.done = false;
            }
          }
        }
        
        if (data.found && data.content) {
          const isComplete = data.done && !data.error;
          const suffix = isComplete 
            ? '' 
            : data.done && data.error
              ? '\n\n---\n⚠️ *Response ended with error: ' + data.error + '*'
              : '\n\n---\n⏳ *Agent is still working — this will update when complete. Send "continue" if it seems stuck.*';
          
          console.log('[Chat] Recovered', data.chars, 'chars from server buffer, done:', data.done);
          
          const recoveredMsg = {
            id: generateId(),
            role: 'assistant' as const,
            content: data.content + suffix,
            timestamp: new Date(),
          };
          
          setSessions(prev => prev.map(s => {
            if (s.id !== sid) return s;
            const existing = s.messages || [];
            const lastMsg = existing[existing.length - 1];
            // Don't duplicate if already committed
            if (lastMsg?.role === 'assistant' && lastMsg.content?.startsWith(data.content.slice(0, 100))) return s;
            return { ...s, messages: [...existing, recoveredMsg] };
          }));
          
          // If response is still in progress, start polling for updates
          if (!data.done) {
            const pollInterval = setInterval(async () => {
              try {
                const pollRes = await fetch(`/api/chat?requestId=${encodeURIComponent(requestId)}`);
                const pollData = await pollRes.json();
                if (pollData.found && pollData.content) {
                  // Update the recovered message with latest content
                  setSessions(prev => prev.map(s => {
                    if (s.id !== sid) return s;
                    const msgs = [...(s.messages || [])];
                    const lastIdx = msgs.length - 1;
                    if (lastIdx >= 0 && msgs[lastIdx].id === recoveredMsg.id) {
                      const newSuffix = pollData.done ? '' : '\n\n---\n⏳ *Agent still working...*';
                      msgs[lastIdx] = { ...msgs[lastIdx], content: pollData.content + newSuffix };
                    }
                    return { ...s, messages: msgs };
                  }));
                  if (pollData.done) {
                    clearInterval(pollInterval);
                    localStorage.removeItem('chat_active_request');
                    localStorage.removeItem('chat_partial_response');
                    setLoadingMap(prev => ({...prev, [sid]: false}));
                  }
                }
              } catch { clearInterval(pollInterval); }
            }, 3000);
            // Stop polling after 10 minutes max
            setTimeout(() => clearInterval(pollInterval), 600000);
          } else {
            localStorage.removeItem('chat_active_request');
            localStorage.removeItem('chat_partial_response');
          }
          
          setLoadingMap(prev => ({...prev, [sid]: false}));
          setStreamingMap(prev => ({...prev, [sid]: ''}));
          if (abortControllers.current[sid]) {
            try { abortControllers.current[sid].abort(); } catch {}
            abortControllers.current[sid] = null as any;
          }
        }
      } catch (e) {
        console.error('[Chat] Recovery error:', e);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [streamingMap]);

  return (
    <div className="flex h-full gap-2 md:gap-4 relative">
      {/* Task FAB removed — duplicate was overlapping composer. Tasks are
          reachable via the inline task button inserted into the mobile chat
          header (see below), and via gear drawer on mobile. */}

      {/* Shared Notepad Drawer — slides in from the right on desktop,
          bottom sheet on mobile. Realtime synced across every connected
          MC client via /api/notepad SSE. */}
      {showNotepad && (
        <div className="fixed inset-0 z-[85] bg-black/40 md:bg-black/30" onClick={() => setShowNotepad(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute md:right-0 md:top-0 md:bottom-0 md:w-[440px] md:max-w-[90vw]
                       inset-x-0 bottom-0 max-h-[80vh] md:max-h-none
                       bg-terminal-surface border-l border-terminal-border shadow-2xl
                       rounded-t-xl md:rounded-none flex flex-col"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border bg-terminal-bg/80">
              <div className="flex items-center gap-2 text-terminal-cyan font-bold text-sm">
                <Notebook className="w-4 h-4" /> SHARED NOTEPAD
              </div>
              <button
                onClick={() => setShowNotepad(false)}
                className="p-1.5 text-terminal-dim hover:text-terminal-text hover:bg-terminal-border/50 rounded transition"
                title="Close notepad"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <SharedNotepad padId="default" className="flex-1 min-h-0" />
          </div>
        </div>
      )}

      {/* Mobile Task History Overlay */}
      {showMobileTaskPanel && (
        <div className="md:hidden fixed inset-0 z-[80] bg-black/50" onClick={() => setShowMobileTaskPanel(false)}>
          <div className="absolute inset-x-0 bottom-0 max-h-[70vh] bg-terminal-surface border-t border-terminal-border rounded-t-xl overflow-y-auto"
               onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-terminal-border flex items-center justify-between sticky top-0 bg-terminal-surface">
              <h3 className="text-terminal-purple font-bold text-sm flex items-center gap-2">
                <Zap className="w-4 h-4" /> TASKS ({taskHistory.length})
              </h3>
              <button onClick={() => setShowMobileTaskPanel(false)} className="p-1 text-terminal-dim hover:text-terminal-text">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-3 space-y-2">
              {taskHistory.map((task) => (
                <button
                  key={task.id}
                  onClick={() => {
                    setActiveTask(task);
                    setIsTaskMinimized(false);
                    setShowMobileTaskPanel(false);
                  }}
                  className={`w-full text-left p-3 rounded-lg text-sm transition ${
                    activeTask?.id === task.id
                      ? 'bg-terminal-purple/20 border border-terminal-purple/50'
                      : 'bg-terminal-bg border border-terminal-border'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate flex-1 text-terminal-text font-medium">
                      {task.prompt.slice(0, 50)}{task.prompt.length > 50 ? '...' : ''}
                    </span>
                    <span className={`ml-2 px-2 py-0.5 rounded text-xs ${
                      task.status === 'completed' ? 'bg-terminal-green/20 text-terminal-green' :
                      task.status === 'failed' ? 'bg-terminal-red/20 text-terminal-red' :
                      task.status === 'running' ? 'bg-terminal-amber/20 text-terminal-amber' :
                      'bg-terminal-cyan/20 text-terminal-cyan'
                    }`}>
                      {task.status}
                    </span>
                  </div>
                  <div className="text-terminal-dim text-xs mt-1">
                    {task.items.filter(i => i.status === 'done').length}/{task.items.length} items • {new Date(task.startedAt).toLocaleTimeString()}
                  </div>
                </button>
              ))}
              {taskHistory.length === 0 && (
                <p className="text-terminal-dim text-sm text-center py-4">No tasks yet</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Sessions Sidebar - hidden on mobile unless toggled.
          When `hideSessionsSidebar` prop is set (Fusio shell mode), this is
          fully hidden because <FusioSessions> renders the sessions column
          in the .shell grid instead. */}
      <div className={`${props.hideSessionsSidebar ? 'hidden' : ''} ${showMobileSidebar ? 'fixed inset-0 z-[70] bg-black/50' : 'hidden'} md:relative ${props.hideSessionsSidebar ? 'md:hidden' : 'md:block'} md:bg-transparent`}
           onClick={() => setShowMobileSidebar(false)}>
        <div className={`${showMobileSidebar ? 'w-[85vw] max-w-[320px]' : 'w-64'} h-full fusio-panel flex flex-col`}
             onClick={(e) => e.stopPropagation()}>
          <div className="p-4 md:p-3 border-b border-terminal-border flex items-center justify-between">
            <h3 className="text-terminal-green font-bold text-base md:text-sm">CONVERSATIONS</h3>
            <div className="flex items-center gap-2 md:gap-1">
              <button
                onClick={createNewSession}
                className="p-2 md:p-1 text-terminal-green hover:bg-terminal-green/20 rounded-lg md:rounded transition"
                title="New Chat"
              >
                <Plus className="w-5 h-5 md:w-4 md:h-4" />
              </button>
              <button
                onClick={() => setShowMobileSidebar(false)}
                className="p-2 md:p-1 text-terminal-dim hover:text-terminal-text md:hidden"
              >
                <X className="w-5 h-5 md:w-4 md:h-4" />
              </button>
            </div>
          </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1.5 md:space-y-1">
          {sessions.map(session => (
            <div
              key={session.id}
              className={`group p-3 md:p-2 rounded-lg md:rounded cursor-pointer transition ${
                activeSessionId === session.id
                  ? 'bg-terminal-green/20 border border-terminal-green/30'
                  : 'hover:bg-terminal-bg border border-transparent'
              }`}
              onClick={() => { setActiveSessionId(session.id); setShowMobileSidebar(false); }}
            >
              {editingSessionId === session.id ? (
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') renameSession(session.id, editingName);
                      if (e.key === 'Escape') setEditingSessionId(null);
                    }}
                    className="flex-1 bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-sm text-terminal-text focus:border-terminal-green outline-none"
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      renameSession(session.id, editingName);
                    }}
                    className="p-1 text-terminal-green hover:bg-terminal-green/20 rounded"
                  >
                    <Check className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="text-terminal-text text-base md:text-sm truncate">{session.name}</span>
                      {/* Streaming indicator */}
                      {loadingMap[session.id] && (
                        <span 
                          className="w-2 h-2 rounded-full bg-terminal-green animate-pulse flex-shrink-0" 
                          title="Streaming..."
                        />
                      )}
                    </div>
                    <div className="hidden group-hover:flex items-center gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          startEditingSession(session);
                        }}
                        className="p-1 text-terminal-dim hover:text-terminal-cyan rounded"
                        title="Rename"
                      >
                        <Edit2 className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm('Delete this conversation?')) {
                            deleteSession(session.id);
                          }
                        }}
                        className="p-1 text-terminal-dim hover:text-terminal-red rounded"
                        title="Delete"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  <div className="text-xs text-terminal-dim mt-1 truncate">
                    {session.messages.length > 1
                      ? (session.messages[session.messages.length - 1]?.content || '').slice(0, 40) + '...'
                      : ((session as any)._messageCount > 0 && (session as any)._lastMessagePreview)
                        ? (session as any)._lastMessagePreview.slice(0, 40) + '...'
                        : (session as any)._messageCount > 0
                          ? `${(session as any)._messageCount} messages`
                          : 'No messages yet'}
                  </div>
                  {session.workspace && (
                    <div className="flex items-center gap-1 mt-1 text-xs text-terminal-cyan/70">
                      <FolderOpen className="w-3 h-3" />
                      <span className="truncate">{session.workspace.split(/[/\\]/).pop()}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
        </div>
      </div>

      {/* Main Chat Area + Task Panel */}
      <div className="flex-1 flex gap-0 min-w-0">
        {/* Chat */}
        <div className="flex-1 bg-terminal-surface md:border md:border-terminal-border md:rounded-lg flex flex-col min-w-0">
        {/* Header — simplified on mobile, full on desktop.
            Hidden entirely when `hideChatHeader` prop is set (Fusio shell
            renders its own <FusioChatHeader> above the panel). */}
        <div className={`${props.hideChatHeader ? 'hidden' : 'flex'} items-center justify-between p-3 md:p-3 border-b border-terminal-border`}>
          {/* Mobile: clean header with chat name + key actions */}
          <div className="flex md:hidden items-center gap-2 flex-1">
            <button
              onClick={() => setShowMobileSidebar(true)}
              className="p-2 text-terminal-dim hover:text-terminal-green rounded-lg hover:bg-terminal-green/10 transition"
              title="Conversations"
            >
              <MessageSquare className="w-5 h-5" />
            </button>
            <h2 className="text-terminal-green font-bold text-lg truncate flex-1">
              {activeSession?.name || NS.panelLabel}
            </h2>
            {isLoading && (
              <span className="w-2.5 h-2.5 rounded-full bg-terminal-green animate-pulse flex-shrink-0" />
            )}
            {taskHistory.length > 0 && (
              <button
                onClick={() => {
                  if (activeTask && isTaskMinimized) {
                    maximizeTaskPanel();
                  } else if (activeTask) {
                    setShowMobileTaskPanel(true);
                  } else {
                    setShowMobileTaskPanel(!showMobileTaskPanel);
                  }
                }}
                className="relative p-2 text-terminal-purple hover:bg-terminal-purple/10 rounded-lg transition"
                title={`Tasks (${taskHistory.length})`}
                aria-label={`Tasks (${taskHistory.length})`}
              >
                <Zap className="w-5 h-5" />
                <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 bg-terminal-amber text-terminal-bg text-[10px] font-bold rounded-full flex items-center justify-center">
                  {taskHistory.length}
                </span>
              </button>
            )}
            {/* Shared notepad — top-level header tab on mobile */}
            <button
              onClick={() => setShowNotepad(s => !s)}
              className={`p-2 rounded-lg transition ${
                showNotepad
                  ? 'text-terminal-cyan bg-terminal-cyan/10'
                  : 'text-terminal-dim hover:text-terminal-cyan hover:bg-terminal-cyan/10'
              }`}
              title="Shared notepad (realtime across devices)"
              aria-label="Shared notepad"
            >
              <Notebook className="w-5 h-5" />
            </button>
            <button
              onClick={() => activeSessionId && resetSession(activeSessionId)}
              className="p-2 text-terminal-dim hover:text-terminal-amber rounded-lg transition"
              title="Reset session"
            >
              <RefreshCw className="w-5 h-5" />
            </button>
            <button
              onClick={() => setShowMobileTools(!showMobileTools)}
              className={`p-2 rounded-lg transition ${showMobileTools ? 'text-terminal-green bg-terminal-green/10' : 'text-terminal-dim hover:text-terminal-text'}`}
              title="More tools"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
          {/* Mobile tools drawer — ALL features from desktop header */}
          {showMobileTools && (
            <div className="md:hidden border-t border-terminal-border mt-2 pt-3 pb-1 max-h-[50vh] overflow-y-auto">
              <div className="flex flex-wrap gap-2">
                {/* Workspace */}
                <button
                  onClick={() => { setShowWorkspaceDropdown(!showWorkspaceDropdown); setShowMobileTools(false); }}
                  className={`flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm border ${
                    activeSession?.workspace
                      ? 'bg-terminal-cyan/10 text-terminal-cyan border-terminal-cyan/30'
                      : 'bg-terminal-bg text-terminal-dim border-terminal-border'
                  }`}
                >
                  <FolderOpen className="w-4 h-4" />
                  {activeSession?.workspace ? activeSession.workspace.split(/[/\\]/).pop() : 'Workspace'}
                </button>
                {/* Model selector */}
                <select
                  value={modelMap[activeSessionId || ''] || 'default'}
                  onChange={(e) => {
                    if (activeSessionId) {
                      setModelMap(prev => ({ ...prev, [activeSessionId]: e.target.value }));
                    }
                  }}
                  className="px-3 py-2.5 rounded-lg text-sm bg-terminal-bg border border-terminal-border text-terminal-text"
                >
                  <option value="default">Default (Sonnet 4.6)</option>
                  <option value="claude-opus-4-7">Opus 4.7</option>
                  <option value="claude-opus-4-7[1m]">Opus 4.7 · 1M context</option>
                  <option value="claude-sonnet-4-6">Sonnet 4.6</option>
                  <option value="claude-haiku-4-5">Haiku 4.5</option>
                  <optgroup label="OpenAI Codex (CLI)">
                    <option value="codex-default">Codex (account default)</option>
                    <option value="codex-gpt-5-codex">Codex · gpt-5-codex (latest)</option>
                  </optgroup>
                </select>
                {/* Session History */}
                <button
                  onClick={() => { setShowSessionDropdown(!showSessionDropdown); setShowMobileTools(false); }}
                  className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm bg-terminal-bg border border-terminal-border text-terminal-dim hover:text-terminal-cyan"
                >
                  <History className="w-4 h-4" />
                  Sessions
                </button>
                {/* Sub-Agents */}
                <button
                  onClick={() => { setShowAgentsPanel(!showAgentsPanel); setShowMobileTools(false); }}
                  className={`flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm border ${
                    subAgents.length > 0
                      ? 'bg-terminal-green/10 text-terminal-green border-terminal-green/30'
                      : 'bg-terminal-bg text-terminal-dim border-terminal-border'
                  }`}
                >
                  <Bot className="w-4 h-4" />
                  Agents {subAgents.length > 0 && `(${subAgents.length})`}
                </button>
                {/* GitHub Repo */}
                {activeSession?.githubRepo && (
                  <div className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm bg-terminal-green/10 text-terminal-green border border-terminal-green/30">
                    <Globe className="w-4 h-4" />
                    {activeSession.githubRepo.name}
                  </div>
                )}
                {/* Key Facts */}
                {activeSession?.keyFacts && activeSession.keyFacts.length > 0 && (
                  <div className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm bg-terminal-amber/10 text-terminal-amber border border-terminal-amber/30">
                    <Key className="w-4 h-4" />
                    {activeSession.keyFacts.length} Facts
                  </div>
                )}
                {/* Memory */}
                <button
                  onClick={() => { setShowMemoryPanel(true); setShowMobileTools(false); }}
                  className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm bg-terminal-bg border border-terminal-border text-terminal-dim hover:text-terminal-green"
                >
                  <Brain className="w-4 h-4" />
                  Memory
                </button>
                {/* Reports */}
                <button
                  onClick={() => { setShowReportDropdown(!showReportDropdown); setShowMobileTools(false); }}
                  className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm bg-terminal-bg border border-terminal-border text-terminal-dim hover:text-terminal-red"
                >
                  <Bug className="w-4 h-4" />
                  Reports
                </button>
                {/* Project Assets */}
                <button
                  onClick={() => {
                    const ws = activeSession?.workspace || getConfig().workspace;
                    if (ws && !showAssets) fetchProjectAssets(ws);
                    setShowAssets(!showAssets);
                    setShowMobileTools(false);
                  }}
                  className={`flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm border ${
                    showAssets ? 'bg-terminal-cyan/10 text-terminal-cyan border-terminal-cyan/30' : 'bg-terminal-bg text-terminal-dim border-terminal-border'
                  }`}
                >
                  <ImageIcon className="w-4 h-4" />
                  Assets
                </button>
                {/* Delegate */}
                {claudeInstalled?.installed && (
                  <button
                    onClick={() => { openDelegateModal(); setShowMobileTools(false); }}
                    className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm bg-terminal-bg border border-terminal-border text-terminal-dim hover:text-terminal-cyan"
                  >
                    <Users className="w-4 h-4" />
                    Delegate
                  </button>
                )}
                {/* Spawn Task */}
                <button
                  onClick={() => { spawnTask(); setShowMobileTools(false); }}
                  disabled={!input.trim()}
                  className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm bg-terminal-bg border border-terminal-border text-terminal-purple disabled:opacity-40"
                >
                  <Zap className="w-4 h-4" />
                  Spawn Task
                </button>
                {/* Compress */}
                <button
                  onClick={() => { setShowCompressModal(true); setShowMobileTools(false); }}
                  className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm bg-terminal-bg border border-terminal-border text-terminal-dim hover:text-terminal-cyan"
                >
                  <Archive className="w-4 h-4" />
                  Compress
                </button>
                {/* Clear */}
                <button
                  onClick={() => { clearChat(); setShowMobileTools(false); }}
                  className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm bg-terminal-bg border border-terminal-border text-terminal-dim hover:text-terminal-red"
                >
                  <Trash2 className="w-4 h-4" />
                  Clear
                </button>
                {/* Reset */}
                <button
                  onClick={() => { if (activeSessionId) resetSession(activeSessionId); setShowMobileTools(false); }}
                  className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm bg-terminal-bg border border-terminal-border text-terminal-dim hover:text-terminal-amber"
                >
                  <RotateCcw className="w-4 h-4" />
                  Reset
                </button>
              </div>
            </div>
          )}
          {/* Desktop: full header with all controls */}
          <div className="hidden md:flex items-center gap-3 flex-wrap flex-1">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-5 h-5 text-terminal-green" />
              <h2 className="text-terminal-green font-bold text-base truncate max-w-none">
                {activeSession?.name || NS.panelLabel}
              </h2>
              <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-terminal-green/20 text-terminal-green border border-terminal-green/30">
                <Wifi className="w-3 h-3" />
                LIVE
              </span>
              {/* Shared notepad — top-level header tab on desktop */}
              <button
                onClick={() => setShowNotepad(s => !s)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs font-medium transition ${
                  showNotepad
                    ? 'bg-terminal-cyan/15 text-terminal-cyan border-terminal-cyan/40'
                    : 'bg-terminal-bg text-terminal-dim border-terminal-border hover:text-terminal-cyan hover:border-terminal-cyan/40'
                }`}
                title="Shared notepad — realtime across Linux, PC, mobile"
              >
                <Notebook className="w-3.5 h-3.5" />
                NOTEPAD
              </button>
              
              {/* Active Skills Display — hidden inline; surfaced via HeaderToolsMenu */}
              {false && activeSkills.length > 0 && (
                <div className="hidden sm:flex items-center gap-1 flex-wrap">
                  <span className="text-terminal-dim text-xs">📚</span>
                  {activeSkills.slice(0, 3).map((skill) => (
                    <span
                      key={skill}
                      className="px-2 py-0.5 text-xs bg-terminal-yellow/20 text-terminal-yellow rounded-full border border-terminal-yellow/30"
                      title={`Skill: ${skill}`}
                    >
                      {skill}
                    </span>
                  ))}
                  {activeSkills.length > 3 && (
                    <span className="text-xs text-terminal-dim">+{activeSkills.length - 3}</span>
                  )}
                </div>
              )}
            </div>

            {/* Pair Mode chip — hidden inline; surfaced via HeaderToolsMenu */}
            {false && activeSessionId && (
              <PairModeChip
                mode={(activeSession?.pairMode as PairMode) || 'solo'}
                onChange={(m) => {
                  setSessions(prev => prev.map(s =>
                    s.id === activeSessionId ? { ...s, pairMode: m, updatedAt: new Date() } : s
                  ));
                }}
                disabled={isLoading}
              />
            )}

            {/* Workspace Selector */}
            <div className="relative" ref={workspaceDropdownRef}>
              <button
                onClick={() => setShowWorkspaceDropdown(!showWorkspaceDropdown)}
                className={`flex items-center gap-1 md:gap-2 px-2 md:px-3 py-1.5 rounded text-xs transition border ${
                  activeSession?.workspace
                    ? 'bg-terminal-cyan/20 text-terminal-cyan border-terminal-cyan/30 hover:bg-terminal-cyan/30'
                    : 'bg-terminal-bg text-terminal-dim border-terminal-border hover:border-terminal-cyan/50'
                }`}
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span className="hidden sm:inline max-w-[150px] truncate">
                  {activeSession?.workspace 
                    ? activeSession.workspace.split(/[/\\]/).pop() 
                    : 'Workspace'}
                </span>
                <ChevronDown className="w-3 h-3" />
              </button>

              {/* Dropdown - File Browser */}
              {showWorkspaceDropdown && (
                <div className="fixed md:absolute inset-x-2 md:inset-x-auto top-24 md:top-full md:left-0 mt-1 md:w-96 fusio-panel shadow-xl z-50 max-h-[70vh] overflow-hidden flex flex-col">
                  {/* Header with path input */}
                  <div className="p-2 border-b border-terminal-border">
                    <div className="flex gap-2 mb-2">
                      <input
                        type="text"
                        value={workspaceInput || browserPath}
                        onChange={(e) => setWorkspaceInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            if (workspaceInput.trim()) {
                              fetchBrowserContents(workspaceInput.trim());
                              setWorkspaceInput('');
                            }
                          }
                          if (e.key === 'Escape') {
                            setShowWorkspaceDropdown(false);
                          }
                        }}
                        placeholder="Type path or browse below..."
                        className="flex-1 bg-terminal-bg border border-terminal-border rounded px-2 py-1.5 
                                   text-xs text-terminal-text focus:border-terminal-cyan outline-none font-mono"
                      />
                      {browserPath && (
                        <button
                          onClick={() => setSessionWorkspace(browserPath)}
                          className="px-3 py-1.5 bg-terminal-green/20 text-terminal-green rounded 
                                     hover:bg-terminal-green/30 transition border border-terminal-green/50 text-xs
                                     flex items-center gap-1"
                          title="Select this folder"
                        >
                          <FolderCheck className="w-3.5 h-3.5" />
                          Select
                        </button>
                      )}
                    </div>
                    
                    {/* Search */}
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-terminal-dim" />
                      <input
                        type="text"
                        value={browserSearch}
                        onChange={(e) => {
                          setBrowserSearch(e.target.value);
                          fetchBrowserContents(browserPath, e.target.value);
                        }}
                        placeholder="Search folders..."
                        className="w-full bg-terminal-bg border border-terminal-border rounded pl-7 pr-2 py-1 
                                   text-xs text-terminal-text focus:border-terminal-cyan outline-none"
                      />
                    </div>
                  </div>

                  {/* Navigation bar */}
                  {browserPath && (
                    <div className="px-2 py-1.5 border-b border-terminal-border flex items-center gap-1 text-xs">
                      <button
                        onClick={() => {
                          setBrowserSearch('');
                          fetchBrowserContents('');
                        }}
                        className="p-1 hover:bg-terminal-cyan/10 rounded text-terminal-dim hover:text-terminal-cyan"
                        title="Go to roots"
                      >
                        <Home className="w-3.5 h-3.5" />
                      </button>
                      {browserParent && (
                        <button
                          onClick={() => {
                            setBrowserSearch('');
                            fetchBrowserContents(browserParent);
                          }}
                          className="p-1 hover:bg-terminal-cyan/10 rounded text-terminal-dim hover:text-terminal-cyan"
                          title="Go up"
                        >
                          <ArrowLeft className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <div className="flex-1 truncate text-terminal-cyan font-mono ml-1">
                        {browserPath}
                      </div>
                      {browserIsProject && (
                        <span className="px-1.5 py-0.5 bg-terminal-green/20 text-terminal-green rounded text-[10px]">
                          PROJECT
                        </span>
                      )}
                    </div>
                  )}

                  {/* File list */}
                  <div className="max-h-64 overflow-y-auto">
                    {browserLoading ? (
                      <div className="p-4 text-center text-terminal-dim">
                        <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                        Loading...
                      </div>
                    ) : browserItems.length === 0 ? (
                      <div className="p-4 text-center text-terminal-dim text-sm">
                        {browserSearch ? 'No matching folders' : 'No subfolders'}
                      </div>
                    ) : (
                      <div className="p-1">
                        {browserItems.map((item) => (
                          <button
                            key={item.path}
                            onClick={() => {
                              setBrowserSearch('');
                              fetchBrowserContents(item.path);
                            }}
                            className="w-full text-left px-2 py-1.5 rounded text-sm hover:bg-terminal-cyan/10 
                                       text-terminal-text flex items-center gap-2 group"
                          >
                            {item.type === 'drive' ? (
                              <HardDrive className="w-4 h-4 text-terminal-yellow flex-shrink-0" />
                            ) : item.type === 'home' ? (
                              <Home className="w-4 h-4 text-terminal-cyan flex-shrink-0" />
                            ) : (
                              <FolderOpen className="w-4 h-4 text-terminal-cyan flex-shrink-0" />
                            )}
                            <span className="truncate flex-1">{item.name}</span>
                            <ChevronRight className="w-3.5 h-3.5 text-terminal-dim opacity-0 group-hover:opacity-100" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Recent Workspaces */}
                  {getRecentWorkspaces().length > 0 && (
                    <div className="p-2 border-t border-terminal-border">
                      <label className="text-xs text-terminal-dim block mb-1">RECENT WORKSPACES</label>
                      <div className="flex flex-wrap gap-1">
                        {getRecentWorkspaces().slice(0, 3).map((ws) => (
                          <button
                            key={ws}
                            onClick={() => setSessionWorkspace(ws)}
                            className="px-2 py-1 rounded text-xs bg-terminal-bg hover:bg-terminal-cyan/10 
                                       text-terminal-text border border-terminal-border truncate max-w-[120px]
                                       flex items-center gap-1"
                            title={ws}
                          >
                            <FolderOpen className="w-3 h-3 text-terminal-cyan flex-shrink-0" />
                            <span className="truncate">{ws.split(/[/\\]/).pop()}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Footer actions */}
                  <div className="p-2 border-t border-terminal-border bg-terminal-bg/50 flex justify-between items-center">
                    {activeSession?.workspace ? (
                      <button
                        onClick={() => setSessionWorkspace(undefined)}
                        className="text-xs text-terminal-dim hover:text-terminal-red flex items-center gap-1"
                      >
                        <X className="w-3 h-3" />
                        Clear
                      </button>
                    ) : (
                      <span className="text-xs text-terminal-dim">Using global default</span>
                    )}
                    <button
                      onClick={() => setShowWorkspaceDropdown(false)}
                      className="text-xs text-terminal-dim hover:text-terminal-text"
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Legacy gateway Session Selector — button hidden (opened via
                Tools); wrapper remains so the dropdown panel can anchor. */}
            <div className="relative" ref={sessionDropdownRef}>
              <button
                onClick={() => setShowSessionDropdown(!showSessionDropdown)}
                className={`hidden flex items-center gap-1 md:gap-2 px-2 md:px-3 py-1.5 rounded text-xs transition border ${
                  selectedGatewaySession
                    ? 'bg-terminal-yellow/20 text-terminal-yellow border-terminal-yellow/30 hover:bg-terminal-yellow/30'
                    : 'bg-terminal-bg text-terminal-dim border-terminal-border hover:border-terminal-yellow/50'
                }`}
              >
                <History className="w-3.5 h-3.5" />
                <span className="hidden sm:inline max-w-[120px] truncate">
                  {selectedGatewaySession || 'Session'}
                </span>
                <ChevronDown className="w-3 h-3" />
              </button>

              {/* Session Dropdown */}
              {showSessionDropdown && (
                <div className="absolute top-full right-0 md:left-0 md:right-auto mt-1 w-[calc(100vw-1rem)] md:w-80 max-w-sm fusio-panel shadow-xl z-50">
                  {/* Header */}
                  <div className="p-2 border-b border-terminal-border flex items-center justify-between">
                    <span className="text-xs text-terminal-dim">SESSION HISTORY</span>
                    <button
                      onClick={fetchGatewaySessions}
                      className={`p-1 hover:bg-terminal-yellow/10 rounded text-terminal-dim hover:text-terminal-yellow transition ${
                        sessionsLoading ? 'animate-spin' : ''
                      }`}
                      title="Refresh sessions"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Sessions list */}
                  <div className="max-h-64 overflow-y-auto">
                    {sessionsLoading && gatewaySessions.length === 0 ? (
                      <div className="p-4 text-center text-terminal-dim">
                        <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                        Loading sessions...
                      </div>
                    ) : gatewaySessions.length === 0 ? (
                      <div className="p-4 text-center text-terminal-dim text-sm">
                        No sessions found
                      </div>
                    ) : (
                      <div className="p-1">
                        {gatewaySessions.map((session) => {
                          const displayName = getSessionDisplayName(session);
                          const kind = getSessionKind(session);
                          const isActive = selectedGatewaySession === (session.sessionKey || session.key);
                          
                          return (
                            <button
                              key={session.sessionKey || session.key}
                              onClick={() => loadGatewaySessionHistory(session)}
                              disabled={sessionsLoading}
                              className={`w-full text-left px-2 py-2 rounded text-sm transition flex items-center gap-2 ${
                                isActive 
                                  ? 'bg-terminal-yellow/20 border border-terminal-yellow/30' 
                                  : 'hover:bg-terminal-yellow/10 border border-transparent'
                              } ${sessionsLoading ? 'opacity-50 cursor-wait' : ''}`}
                            >
                              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                                kind === 'main' ? 'bg-terminal-green' :
                                kind === 'isolated' ? 'bg-terminal-cyan' :
                                'bg-terminal-yellow'
                              }`} />
                              <div className="flex-1 min-w-0">
                                <div className="text-terminal-text truncate">{displayName}</div>
                                {session.lastMessage && (
                                  <div className="text-xs text-terminal-dim truncate mt-0.5">
                                    {session.lastMessage.content?.slice(0, 50)}...
                                  </div>
                                )}
                                {session.messageCount && (
                                  <div className="text-xs text-terminal-dim/60 mt-0.5">
                                    {session.messageCount} messages
                                  </div>
                                )}
                              </div>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${
                                kind === 'main' ? 'bg-terminal-green/20 text-terminal-green' :
                                kind === 'isolated' ? 'bg-terminal-cyan/20 text-terminal-cyan' :
                                'bg-terminal-yellow/20 text-terminal-yellow'
                              }`}>
                                {kind.toUpperCase()}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Footer */}
                  <div className="p-2 border-t border-terminal-border bg-terminal-bg/50 flex justify-between items-center">
                    {selectedGatewaySession ? (
                      <button
                        onClick={() => {
                          setSelectedGatewaySession(null);
                          setShowSessionDropdown(false);
                        }}
                        className="text-xs text-terminal-dim hover:text-terminal-red flex items-center gap-1"
                      >
                        <X className="w-3 h-3" />
                        Clear
                      </button>
                    ) : (
                      <span className="text-xs text-terminal-dim">{gatewaySessions.length} sessions</span>
                    )}
                    <button
                      onClick={() => setShowSessionDropdown(false)}
                      className="text-xs text-terminal-dim hover:text-terminal-text"
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Memory + vault badges — hidden by default; surface them elsewhere
                (Memory panel button in Tools, vault indicator in the composer
                status bar). Keeping them wrapped so power-users can re-enable. */}
            <div className="hidden">
              {activeSession?.sessionKey && <MemoryStatsPill chatId={activeSession.sessionKey} />}
              {activeSession?.sessionKey && <MemVaultStatusBadge chatId={activeSession.sessionKey} compact />}
            </div>

            {/* Pull Latest — hidden inline; surfaced via HeaderToolsMenu. */}
            <div className="hidden"><PullLatestButton /></div>

            {/* Constellation Deploy / Status — hidden inline; surfaced via HeaderToolsMenu. */}
            {false && !NS.hideConstellationUi && (linkedTeamId ? (
              <div className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-terminal-green/10 border border-terminal-green/30 text-terminal-green">
                <span>✦</span>
                <span className="hidden sm:inline">{linkedTeamName}</span>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  linkedTeamStatus === 'running' ? 'bg-terminal-green animate-pulse' :
                  linkedTeamStatus === 'paused' ? 'bg-terminal-amber' : 'bg-terminal-dim'
                }`} />
                <span className="text-terminal-dim">{linkedTeamProgress}</span>
              </div>
            ) : (
              <button
                onClick={() => setShowConstellationDeploy(true)}
                className="hidden items-center gap-1 px-2 py-1.5 rounded text-xs bg-terminal-bg text-terminal-dim border border-terminal-border hover:border-terminal-green/50 hover:text-terminal-green transition"
                title="Deploy a Constellation (team of parallel agents)"
              >
                <span>✦</span>
                <span className="hidden sm:inline">Deploy</span>
              </button>
            ))}

            {/* Link Chat Selector — button hidden; wrapper stays for anchor. */}
            <div className="relative" ref={linkDropdownRef}>
              <button
                onClick={() => setShowLinkDropdown(!showLinkDropdown)}
                className={`hidden flex items-center gap-1 md:gap-2 px-2 md:px-3 py-1.5 rounded text-xs transition border ${
                  linkedSessionId
                    ? 'bg-terminal-purple/20 text-terminal-purple border-terminal-purple/30 hover:bg-terminal-purple/30'
                    : 'bg-terminal-bg text-terminal-dim border-terminal-border hover:border-terminal-purple/50'
                }`}
                title="Link to another chat for cross-referencing"
              >
                <Link2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline max-w-[100px] truncate">
                  {linkedSession?.name || 'Link'}
                </span>
                <ChevronDown className="w-3 h-3" />
              </button>

              {/* Link Dropdown */}
              {showLinkDropdown && (
                <div className="absolute top-full right-0 md:left-0 md:right-auto mt-1 w-64 fusio-panel shadow-xl z-50">
                  <div className="p-2 border-b border-terminal-border">
                    <span className="text-xs text-terminal-dim">LINK TO ANOTHER CHAT</span>
                  </div>

                  <div className="max-h-48 overflow-y-auto">
                    {linkableSessions.length === 0 ? (
                      <div className="p-4 text-center text-terminal-dim text-sm">
                        No other chats available
                      </div>
                    ) : (
                      <div className="p-1">
                        {linkableSessions.map((session) => (
                          <button
                            key={session.id}
                            onClick={() => {
                              setLinkedSessionId(session.id);
                              setShowLinkDropdown(false);
                            }}
                            className={`w-full text-left px-2 py-2 rounded text-sm transition flex items-center gap-2 ${
                              linkedSessionId === session.id
                                ? 'bg-terminal-purple/20 border border-terminal-purple/30'
                                : 'hover:bg-terminal-purple/10 border border-transparent'
                            }`}
                          >
                            <MessageSquare className="w-4 h-4 text-terminal-purple flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="text-terminal-text truncate">{session.name}</div>
                              <div className="text-xs text-terminal-dim">
                                {session.messages.length} messages
                              </div>
                            </div>
                            {linkedSessionId === session.id && (
                              <Link2 className="w-3.5 h-3.5 text-terminal-purple" />
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="p-2 border-t border-terminal-border bg-terminal-bg/50 flex justify-between items-center">
                    {linkedSessionId ? (
                      <button
                        onClick={() => {
                          setLinkedSessionId(null);
                          setShowLinkDropdown(false);
                        }}
                        className="text-xs text-terminal-dim hover:text-terminal-red flex items-center gap-1"
                      >
                        <Unlink className="w-3 h-3" />
                        Unlink
                      </button>
                    ) : (
                      <span className="text-xs text-terminal-dim">Select a chat to link</span>
                    )}
                    <button
                      onClick={() => setShowLinkDropdown(false)}
                      className="text-xs text-terminal-dim hover:text-terminal-text"
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Agents Panel Button — button hidden; wrapper stays for anchor. */}
            <div className="relative" ref={agentsPanelRef}>
              <button
                onClick={() => setShowAgentsPanel(!showAgentsPanel)}
                className={`hidden flex items-center gap-1 md:gap-2 px-2 md:px-3 py-1.5 rounded text-xs transition border relative ${
                  showAgentsPanel
                    ? 'bg-terminal-cyan/20 text-terminal-cyan border-terminal-cyan/30'
                    : subAgents.filter(a => a.status === 'running').length > 0
                      ? 'bg-terminal-cyan/10 text-terminal-cyan border-terminal-cyan/30 hover:bg-terminal-cyan/20'
                      : 'bg-terminal-bg text-terminal-dim border-terminal-border hover:border-terminal-cyan/50'
                }`}
                title="View sub-agents"
              >
                <Zap className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Agents</span>
                {subAgents.filter(a => a.status === 'running').length > 0 && (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 bg-terminal-cyan/30 text-terminal-cyan text-[10px] rounded-full font-bold">
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    {subAgents.filter(a => a.status === 'running').length}
                  </span>
                )}
                {subAgents.filter(a => a.status === 'running').length === 0 && subAgents.length > 0 && (
                  <span className="px-1.5 py-0.5 bg-terminal-dim/20 text-terminal-dim text-[10px] rounded-full">
                    {subAgents.length}
                  </span>
                )}
              </button>

              {/* Agents Panel Popup */}
              {showAgentsPanel && (
                <div className="absolute top-full right-0 md:left-0 md:right-auto mt-1 w-[calc(100vw-1rem)] md:w-96 max-w-md fusio-panel shadow-xl z-50">
                  {/* Header */}
                  <div className="p-2 border-b border-terminal-border flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Zap className="w-3.5 h-3.5 text-terminal-cyan" />
                      <span className="text-xs text-terminal-dim">SUB-AGENTS</span>
                      {subAgents.filter(a => a.status === 'running').length > 0 && (
                        <span className="w-1.5 h-1.5 bg-terminal-cyan rounded-full animate-pulse" />
                      )}
                    </div>
                    <button
                      onClick={() => setShowAgentsPanel(false)}
                      className="text-xs text-terminal-dim hover:text-terminal-text"
                    >
                      Close
                    </button>
                  </div>

                  {/* Agent List */}
                  <div className="max-h-80 overflow-y-auto">
                    {subAgents.length === 0 ? (
                      <div className="p-6 text-center text-terminal-dim text-sm">
                        <Zap className="w-6 h-6 mx-auto mb-2 opacity-30" />
                        No sub-agents running
                      </div>
                    ) : (
                      <div className="p-1.5 space-y-1">
                        {/* Running agents first */}
                        {subAgents.filter(a => a.status === 'running').map(agent => (
                          <AgentPanelRow key={agent.key} agent={agent} />
                        ))}
                        {/* Completed */}
                        {subAgents.filter(a => a.status === 'complete').map(agent => (
                          <AgentPanelRow key={agent.key} agent={agent} />
                        ))}
                        {/* Failed */}
                        {subAgents.filter(a => a.status === 'failed').map(agent => (
                          <AgentPanelRow key={agent.key} agent={agent} />
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Footer summary */}
                  {subAgents.length > 0 && (
                    <div className="p-2 border-t border-terminal-border bg-terminal-bg/50 flex items-center justify-between text-[10px] text-terminal-dim">
                      <span>
                        {subAgents.filter(a => a.status === 'running').length} running · {subAgents.filter(a => a.status === 'complete').length} done · {subAgents.filter(a => a.status === 'failed').length} failed
                      </span>
                      <span>{subAgents.length} total</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* GitHub Repo Attach — hidden inline; surfaced via HeaderToolsMenu. */}
            <div className="hidden">
            {activeSession?.githubRepo ? (
              <button
                onClick={() => {
                  if (activeSessionId && confirm(`Detach ${activeSession.githubRepo!.fullName}?`)) {
                    setSessions(prev => prev.map(s =>
                      s.id === activeSessionId ? { ...s, githubRepo: undefined } : s
                    ));
                  }
                }}
                className="flex items-center gap-1 px-2 py-1.5 rounded text-xs transition border
                           bg-terminal-purple/20 text-terminal-purple border-terminal-purple/30 hover:bg-terminal-purple/30"
                title={`GitHub: ${activeSession.githubRepo.fullName} — click to detach`}
              >
                <span>🐙</span>
                <span className="hidden md:inline truncate max-w-[100px]">{activeSession.githubRepo.name}</span>
              </button>
            ) : (
              <div className="relative">
                <button
                  onClick={(e) => {
                    const dropdown = e.currentTarget.nextElementSibling as HTMLElement;
                    if (dropdown) {
                      dropdown.classList.toggle('hidden');
                      // Fetch repos when opening
                      if (!dropdown.classList.contains('hidden')) {
                        fetch('/api/github?action=repos&limit=20')
                          .then(r => r.json())
                          .then(d => {
                            const list = dropdown.querySelector('[data-repo-list]');
                            if (!list) return;
                            const repos = d.repos || [];
                            list.innerHTML = repos.length === 0
                              ? '<div class="p-3 text-center text-xs" style="color:var(--terminal-dim)">No repos found</div>'
                              : repos.map((r: any) => {
                                  const owner = typeof r.owner === 'object' ? r.owner.login : '';
                                  const full = `${owner}/${r.name}`;
                                  return `<button data-repo="${full}" data-name="${r.name}" data-url="${r.url || ''}" class="w-full text-left px-3 py-2 text-xs hover:bg-black/20 transition flex items-center gap-2" style="color:var(--terminal-text);font-family:monospace"><span style="color:var(--terminal-cyan)" class="truncate flex-1">${full}</span>${r.isPrivate ? '<span style="color:var(--terminal-amber);font-size:10px">🔒</span>' : ''}</button>`;
                                }).join('');
                          })
                          .catch(() => {});
                      }
                    }
                  }}
                  className="flex items-center gap-1 px-2 py-1.5 rounded text-xs transition border
                             bg-terminal-bg text-terminal-dim border-terminal-border hover:border-terminal-purple/50 hover:text-terminal-purple"
                  title="Attach a GitHub repo to this chat"
                >
                  <span>🐙</span>
                  <span className="hidden md:inline">GitHub</span>
                </button>
                <div
                  className="hidden absolute right-0 top-full mt-1 w-72 max-h-80 overflow-y-auto
                             fusio-panel shadow-xl z-50"
                  onClick={(e) => {
                    const btn = (e.target as HTMLElement).closest('[data-repo]');
                    if (!btn || !activeSessionId) return;
                    const fullName = btn.getAttribute('data-repo') || '';
                    const name = btn.getAttribute('data-name') || '';
                    const url = btn.getAttribute('data-url') || '';
                    setSessions(prev => prev.map(s =>
                      s.id === activeSessionId ? {
                        ...s,
                        githubRepo: { name, fullName, url, defaultBranch: 'main' },
                      } : s
                    ));
                    (e.currentTarget as HTMLElement).classList.add('hidden');
                  }}
                >
                  <div className="p-2 border-b border-terminal-border text-xs font-bold text-terminal-purple">Select Repository</div>
                  <div data-repo-list="">
                    <div className="p-3 text-center text-xs text-terminal-dim">Loading repos...</div>
                  </div>
                </div>
              </div>
            )}
            </div>

            {/* Model Selector — hidden below 2xl; duplicate lives in composer. */}
            <select
              value={activeModel}
              onChange={(e) => {
                if (activeSessionId) {
                  setModelMap(prev => ({...prev, [activeSessionId]: e.target.value}));
                }
              }}
              className={`hidden items-center gap-1 px-2 md:px-3 py-1.5 rounded text-xs transition border bg-terminal-bg ${
                activeModel !== 'default'
                  ? 'text-terminal-purple border-terminal-purple/50'
                  : 'text-terminal-dim border-terminal-border'
              } hover:border-terminal-purple/50 cursor-pointer`}
              title="Select model for this chat"
            >
              <option value="default">Default</option>
              {availableModels.length > 0
                ? Object.entries(
                    availableModels.reduce<Record<string, typeof availableModels>>((acc, m) => {
                      const p = m.provider || 'other';
                      if (!acc[p]) acc[p] = [];
                      acc[p].push(m);
                      return acc;
                    }, {})
                  ).map(([provider, models]) => (
                    <optgroup key={provider} label={provider.charAt(0).toUpperCase() + provider.slice(1)}>
                      {models.map(m => (
                        <option key={m.id} value={m.id}>
                          {m.name}{m.context_window ? ` (${m.context_window >= 1000000 ? `${(m.context_window/1000000).toFixed(0)}M` : `${(m.context_window/1000).toFixed(0)}K`})` : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))
                : (
                  <>
                    <option value="claude-opus-4-7">Opus 4.7</option>
                    <option value="claude-opus-4-7[1m]">Opus 4.7 · 1M</option>
                    <option value="claude-sonnet-4-6">Sonnet 4.6</option>
                    <option value="claude-haiku-4-5">Haiku 4.5</option>
                    <optgroup label="OpenAI Codex (CLI)">
                      <option value="codex-default">Codex (account default)</option>
                      <option value="codex-gpt-5-codex">Codex · gpt-5-codex (latest)</option>
                    </optgroup>
                  </>
                )
              }
            </select>

            {/* Permission Mode Toggle — hidden below 2xl; set via gear on narrower. */}
            <div className="hidden items-center rounded border border-terminal-border overflow-hidden text-xs">
              {[
                { value: 'default', label: 'Normal', title: 'Normal mode — agent can read, edit, and execute freely' },
                { value: 'plan', label: 'Plan', title: 'Plan mode — agent plans but does not execute edits' },
                { value: 'bypassPermissions', label: 'Auto', title: 'Auto-accept — bypass all permission prompts' },
              ].map(mode => (
                <button
                  key={mode.value}
                  onClick={() => {
                    if (activeSessionId) {
                      setPermissionModeMap(prev => ({...prev, [activeSessionId]: mode.value}));
                    }
                  }}
                  title={mode.title}
                  className={`px-2 py-1.5 transition ${
                    activePermissionMode === mode.value
                      ? mode.value === 'plan'
                        ? 'bg-terminal-purple/20 text-terminal-purple border-r border-terminal-purple/30'
                        : mode.value === 'bypassPermissions'
                          ? 'bg-terminal-amber/20 text-terminal-amber border-r border-terminal-amber/30'
                          : 'bg-terminal-green/20 text-terminal-green border-r border-terminal-border'
                      : 'bg-terminal-bg text-terminal-dim border-r border-terminal-border hover:text-terminal-text'
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>

            {/* Key Facts Badge + Dropdown — hidden inline; surfaced via HeaderToolsMenu. */}
            {false && (activeSession?.keyFacts?.length || 0) > 0 && (
              <div className="relative">
                <button
                  onClick={(e) => {
                    const dropdown = (e.currentTarget.nextElementSibling as HTMLElement);
                    if (dropdown) dropdown.classList.toggle('hidden');
                  }}
                  className="flex items-center gap-1 px-2 py-1.5 rounded text-xs transition border
                             bg-terminal-cyan/10 text-terminal-cyan border-terminal-cyan/30 hover:bg-terminal-cyan/20"
                  title={`${activeSession!.keyFacts!.length} key facts captured`}
                >
                  <Key className="w-3 h-3" />
                  <span>{activeSession!.keyFacts!.length}</span>
                </button>
                <div className="hidden absolute right-0 top-full mt-1 w-80 max-h-96 overflow-y-auto
                                fusio-panel shadow-xl z-50">
                  <div className="p-2 border-b border-terminal-border flex items-center justify-between">
                    <span className="text-xs font-bold text-terminal-cyan flex items-center gap-1">
                      <Key className="w-3 h-3" /> KEY FACTS ({activeSession!.keyFacts!.length})
                    </span>
                    <button
                      onClick={() => {
                        if (activeSessionId && confirm('Clear all key facts?')) {
                          setSessions(prev => prev.map(s =>
                            s.id === activeSessionId ? { ...s, keyFacts: [] } : s
                          ));
                        }
                      }}
                      className="text-terminal-dim hover:text-terminal-red text-xs"
                    >
                      <Trash className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="p-2 space-y-1">
                    {activeSession!.keyFacts!.map(fact => (
                      <div key={fact.id} className="flex items-start gap-2 p-1.5 rounded bg-terminal-bg border border-terminal-border/50 group">
                        <span className={`text-xs px-1 py-0.5 rounded flex-shrink-0 ${
                          fact.category === 'credential' ? 'bg-terminal-red/20 text-terminal-red' :
                          fact.category === 'url' ? 'bg-terminal-cyan/20 text-terminal-cyan' :
                          fact.category === 'person' ? 'bg-terminal-purple/20 text-terminal-purple' :
                          fact.category === 'config' ? 'bg-terminal-amber/20 text-terminal-amber' :
                          'bg-terminal-green/20 text-terminal-green'
                        }`}>{fact.label}</span>
                        <span className="text-xs text-terminal-text font-mono break-all flex-1">{fact.value}</span>
                        <button
                          onClick={() => {
                            setSessions(prev => prev.map(s =>
                              s.id === activeSessionId
                                ? { ...s, keyFacts: (s.keyFacts || []).filter(f => f.id !== fact.id) }
                                : s
                            ));
                          }}
                          className="text-terminal-dim hover:text-terminal-red opacity-0 group-hover:opacity-100 transition flex-shrink-0"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="p-2 border-t border-terminal-border space-y-2">
                    <form onSubmit={(e) => {
                      e.preventDefault();
                      const form = e.target as HTMLFormElement;
                      const label = (form.elements.namedItem('factLabel') as HTMLInputElement)?.value?.trim();
                      const value = (form.elements.namedItem('factValue') as HTMLInputElement)?.value?.trim();
                      if (label && value && activeSessionId) {
                        setSessions(prev => prev.map(s =>
                          s.id === activeSessionId
                            ? { ...s, keyFacts: [...(s.keyFacts || []), { id: `kf-${Date.now()}`, category: 'reference' as const, label, value, source: 'manual' as const, extractedAt: Date.now() }] }
                            : s
                        ));
                        form.reset();
                      }
                    }} className="flex gap-1">
                      <input name="factLabel" placeholder="Label" className="flex-1 bg-terminal-bg border border-terminal-border rounded px-1.5 py-1 text-xs text-terminal-text outline-none focus:border-terminal-cyan" />
                      <input name="factValue" placeholder="Value" className="flex-[2] bg-terminal-bg border border-terminal-border rounded px-1.5 py-1 text-xs text-terminal-text outline-none focus:border-terminal-cyan" />
                      <button type="submit" className="px-2 py-1 bg-terminal-cyan/20 text-terminal-cyan rounded text-xs hover:bg-terminal-cyan/30">+</button>
                    </form>
                    <div className="text-xs text-terminal-dim">Injected into every message so the AI never forgets them.</div>
                  </div>
                </div>
              </div>
            )}

            {/* Notification Permission */}
            <button
              onClick={() => {
                if (typeof Notification !== 'undefined') {
                  Notification.requestPermission();
                }
              }}
              className={`hidden p-2 rounded transition border ${
                typeof Notification !== 'undefined' && Notification.permission === 'granted'
                  ? 'text-terminal-green border-terminal-green/30 bg-terminal-green/10'
                  : 'text-terminal-dim border-terminal-border hover:text-terminal-text hover:border-terminal-text/30'
              }`}
              title={typeof Notification !== 'undefined' && Notification.permission === 'granted'
                ? 'Notifications enabled — you\'ll be notified when responses complete in background'
                : 'Enable browser notifications for background responses'}
            >
              <Bell className="w-3.5 h-3.5" />
            </button>

            {/* Reset Session Button — hidden below 2xl; in Tools dropdown. */}
            <button
              onClick={resetOpenClawSession}
              disabled={!activeSession?.sessionKey}
              className="hidden p-2 text-terminal-dim hover:text-terminal-amber hover:bg-terminal-amber/10
                         rounded transition border border-terminal-border hover:border-terminal-amber/50
                         disabled:opacity-30 disabled:cursor-not-allowed"
              title="Reset session context (keeps local messages)"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>

            {/* Compress Context Button — hidden below 2xl; in Tools dropdown. */}
            <button
              onClick={openCompressModal}
              disabled={allMessages.length < 6}
              className={`hidden p-2 rounded transition border
                         disabled:opacity-30 disabled:cursor-not-allowed ${
                           activeSession?.contextSnapshot
                             ? 'text-terminal-purple bg-terminal-purple/10 border-terminal-purple/30 hover:bg-terminal-purple/20'
                             : 'text-terminal-dim hover:text-terminal-purple hover:bg-terminal-purple/10 border-terminal-border hover:border-terminal-purple/50'
                         }`}
              title={activeSession?.contextSnapshot
                ? 'Context compressed — click to re-compress or view'
                : 'Compress context — AI extracts key info, credentials, and recent work'}
            >
              <Archive className="w-3.5 h-3.5" />
            </button>

            {/* Add Report to Chat — button hidden; wrapper stays for anchor. */}
            <div className="relative" ref={reportDropdownRef}>
              <button
                onClick={() => setShowReportDropdown(!showReportDropdown)}
                className={`hidden flex items-center gap-1 md:gap-2 px-2 md:px-3 py-1.5 rounded text-xs transition border ${
                  showReportDropdown
                    ? 'bg-terminal-red/20 text-terminal-red border-terminal-red/30'
                    : 'bg-terminal-bg text-terminal-dim border-terminal-border hover:border-terminal-red/50'
                }`}
                title="Add a report to this chat"
              >
                <Bug className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Report</span>
                <ChevronDown className="w-3 h-3" />
              </button>

              {/* Report Dropdown */}
              {showReportDropdown && (
                <div className="absolute top-full right-0 md:left-0 md:right-auto mt-1 w-80 fusio-panel shadow-xl z-50">
                  <div className="p-2 border-b border-terminal-border flex items-center justify-between">
                    <span className="text-xs text-terminal-dim">ADD REPORT TO CHAT</span>
                    <button
                      onClick={fetchReports}
                      className={`p-1 hover:bg-terminal-red/10 rounded text-terminal-dim hover:text-terminal-red transition ${
                        reportsLoading ? 'animate-spin' : ''
                      }`}
                      title="Refresh reports"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Quick Add Newest */}
                  {reports.length > 0 && (
                    <div className="p-2 border-b border-terminal-border">
                      <button
                        onClick={() => {
                          const newest = reports[0];
                          if (newest) addReportToChat(newest);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 bg-terminal-red/10 hover:bg-terminal-red/20 
                                   text-terminal-red rounded transition border border-terminal-red/30"
                      >
                        <Sparkles className="w-4 h-4" />
                        <span className="text-sm font-medium">Add Newest Report</span>
                        {reports[0] && (
                          <span className="text-xs opacity-70 ml-auto">#{reports[0].shortId || reports[0].id.slice(0, 4)}</span>
                        )}
                      </button>
                    </div>
                  )}

                  <div className="max-h-64 overflow-y-auto">
                    {reportsLoading && reports.length === 0 ? (
                      <div className="p-4 text-center text-terminal-dim">
                        <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                        Loading reports...
                      </div>
                    ) : reports.length === 0 ? (
                      <div className="p-4 text-center text-terminal-dim text-sm">
                        <Bug className="w-8 h-8 mx-auto mb-2 opacity-50" />
                        <p>No reports yet</p>
                        <p className="text-xs mt-1">Use the Rev Reporter extension to create reports</p>
                      </div>
                    ) : (
                      <div className="p-1">
                        {reports.map((report) => {
                          const typeIcon = report.type === 'bug' ? <Bug className="w-4 h-4 text-terminal-red" /> :
                                          report.type === 'feature' ? <Sparkles className="w-4 h-4 text-terminal-green" /> :
                                          <StickyNote className="w-4 h-4 text-terminal-yellow" />;
                          const priorityColor = report.priority === 'high' ? 'text-terminal-red' :
                                               report.priority === 'medium' ? 'text-terminal-yellow' : 'text-terminal-dim';
                          
                          return (
                            <button
                              key={report.id}
                              onClick={() => addReportToChat(report)}
                              className="w-full text-left px-2 py-2 rounded text-sm transition flex items-start gap-2 
                                        hover:bg-terminal-red/10 border border-transparent hover:border-terminal-red/20"
                            >
                              <div className="flex-shrink-0 mt-0.5">{typeIcon}</div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-terminal-text font-medium">#{report.shortId || report.id.slice(0, 4)}</span>
                                  <span className={`text-xs ${priorityColor}`}>{report.priority}</span>
                                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                                    report.status === 'new' ? 'bg-terminal-cyan/20 text-terminal-cyan' :
                                    report.status === 'resolved' ? 'bg-terminal-green/20 text-terminal-green' :
                                    'bg-terminal-yellow/20 text-terminal-yellow'
                                  }`}>
                                    {report.status}
                                  </span>
                                </div>
                                <div className="text-xs text-terminal-dim truncate mt-0.5">
                                  {report.message || 'No message'}
                                </div>
                                <div className="text-xs text-terminal-dim/70 truncate mt-0.5">
                                  {report.pageUrl?.replace(/^https?:\/\//, '').slice(0, 40)}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="p-2 border-t border-terminal-border bg-terminal-bg/50 flex justify-end">
                    <button
                      onClick={() => setShowReportDropdown(false)}
                      className="text-xs text-terminal-dim hover:text-terminal-text"
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Consolidated Tools dropdown — carries every former header
              button and shows its live data (counts, connected state, etc)
              so nothing is lost when the bar is kept minimal. */}
          {(() => {
            const runningSubagents = subAgents.filter(a => a.status === 'running').length;
            const totalSubagents = subAgents.length;
            const keyFactCount = activeSession?.keyFacts?.length || 0;
            const hasSnapshot = !!activeSession?.contextSnapshot;
            const notifGranted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
            const modelLabel =
              activeModel === 'claude-opus-4-7' ? 'Opus 4.7'
              : activeModel === 'claude-opus-4-7[1m]' ? 'Opus 4.7 · 1M'
              : activeModel === 'claude-sonnet-4-6' ? 'Sonnet 4.6'
              : activeModel === 'claude-haiku-4-5' ? 'Haiku 4.5'
              : activeModel === 'opus' ? 'Opus'
              : activeModel === 'sonnet' ? 'Sonnet'
              : activeModel === 'haiku' ? 'Haiku'
              : activeModel === 'codex-default' ? '🤖 Codex (default)'
              : activeModel === 'codex' ? '🤖 Codex'
              : (typeof activeModel === 'string' && activeModel.startsWith('codex-')) ? `🤖 Codex · ${activeModel.slice('codex-'.length)}`
              : 'Default (Sonnet 4.6)';
            const badge = (text: string, tone: 'neutral' | 'cyan' | 'amber' | 'green' | 'red' | 'purple' = 'neutral') => (
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                tone === 'cyan' ? 'bg-terminal-cyan/20 text-terminal-cyan'
                : tone === 'amber' ? 'bg-terminal-amber/20 text-terminal-amber'
                : tone === 'green' ? 'bg-terminal-green/20 text-terminal-green'
                : tone === 'red' ? 'bg-terminal-red/20 text-terminal-red'
                : tone === 'purple' ? 'bg-terminal-purple/20 text-terminal-purple'
                : 'bg-terminal-border text-terminal-dim'
              }`}>{text}</span>
            );
            return (
            <HeaderToolsMenu
              label="Tools"
              widthClass="w-80"
              sections={[
                {
                  title: 'Active',
                  items: [
                    {
                      id: 'model',
                      label: 'Model',
                      render: () => (
                        <div className="flex items-center gap-2">
                          <span className="text-terminal-dim text-[11px] w-20">Model</span>
                          <select
                            value={activeModel}
                            onChange={(e) => activeSessionId && setModelMap(prev => ({ ...prev, [activeSessionId]: e.target.value }))}
                            className="flex-1 bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-text"
                          >
                            <option value="default">Default (Sonnet 4.6)</option>
                            <option value="claude-opus-4-7">Opus 4.7</option>
                            <option value="claude-opus-4-7[1m]">Opus 4.7 · 1M context</option>
                            <option value="claude-sonnet-4-6">Sonnet 4.6</option>
                            <option value="claude-haiku-4-5">Haiku 4.5</option>
                          </select>
                        </div>
                      ),
                    },
                    {
                      id: 'permission',
                      label: 'Permission',
                      render: () => (
                        <div className="flex items-center gap-2">
                          <span className="text-terminal-dim text-[11px] w-20">Permission</span>
                          <div className="flex-1 flex rounded border border-terminal-border overflow-hidden text-[11px]">
                            {[
                              { value: 'default', label: 'Normal' },
                              { value: 'plan', label: 'Plan' },
                              { value: 'bypassPermissions', label: 'Auto' },
                            ].map(m => (
                              <button
                                key={m.value}
                                onClick={() => activeSessionId && setPermissionModeMap(prev => ({ ...prev, [activeSessionId]: m.value }))}
                                className={`flex-1 px-2 py-1 transition ${
                                  activePermissionMode === m.value
                                    ? m.value === 'plan' ? 'bg-terminal-purple/20 text-terminal-purple'
                                    : m.value === 'bypassPermissions' ? 'bg-terminal-amber/20 text-terminal-amber'
                                    : 'bg-terminal-green/20 text-terminal-green'
                                    : 'bg-terminal-bg text-terminal-dim hover:text-terminal-text'
                                }`}
                              >{m.label}</button>
                            ))}
                          </div>
                        </div>
                      ),
                    },
                  ],
                },
                {
                  title: 'Agents',
                  items: [
                    {
                      id: 'pair-mode',
                      label: 'Pair mode',
                      subLabel: `currently: ${(activeSession?.pairMode as PairMode) || 'solo'}`,
                      rightSlot: badge(((activeSession?.pairMode as PairMode) || 'solo'), ((activeSession?.pairMode as PairMode) === 'solo' || !activeSession?.pairMode) ? 'neutral' : 'green'),
                      render: () => (
                        <div className="flex items-center gap-2 px-1">
                          <span className="text-terminal-dim text-[11px] w-20">Pair</span>
                          <div className="flex-1">
                            <PairModeChip
                              mode={(activeSession?.pairMode as PairMode) || 'solo'}
                              onChange={(m) => {
                                setSessions(prev => prev.map(s =>
                                  s.id === activeSessionId ? { ...s, pairMode: m, updatedAt: new Date() } : s
                                ));
                              }}
                              disabled={isLoading}
                            />
                          </div>
                        </div>
                      ),
                    },
                    {
                      id: 'subagents', label: 'Sub-agents',
                      subLabel: runningSubagents > 0 ? `${runningSubagents} running` : totalSubagents > 0 ? `${totalSubagents} total` : 'none yet',
                      dotColor: runningSubagents > 0 ? 'bg-terminal-cyan animate-pulse' : undefined,
                      rightSlot: totalSubagents > 0 ? badge(`${totalSubagents}`, runningSubagents > 0 ? 'cyan' : 'neutral') : undefined,
                      onClick: () => setShowAgentsPanel(true),
                    },
                    {
                      id: 'delegate', label: 'Delegate to Claude Code',
                      subLabel: claudeInstalled?.installed ? `v${claudeInstalled.version || ''}` : 'not installed',
                      disabled: !claudeInstalled?.installed,
                      onClick: () => openDelegateModal(),
                    },
                    {
                      id: 'spawn', label: 'Spawn background task',
                      subLabel: input.trim() ? 'uses your current draft' : 'needs a prompt in the composer',
                      disabled: !input.trim(),
                      onClick: () => spawnTask(),
                    },
                    !NS.hideConstellationUi && {
                      id: 'constellation', label: linkedTeamId ? `Team: ${linkedTeamName || 'active'}` : 'Deploy constellation',
                      subLabel: linkedTeamId ? linkedTeamStatus || 'running' : 'team of parallel agents',
                      dotColor: linkedTeamId ? (linkedTeamStatus === 'running' ? 'bg-terminal-green animate-pulse' : 'bg-terminal-amber') : undefined,
                      onClick: () => setShowConstellationDeploy(true),
                    },
                  ].filter(Boolean) as any,
                },
                {
                  title: 'Context',
                  items: [
                    {
                      id: 'compress', label: 'Compress context',
                      subLabel: hasSnapshot ? 'snapshot active' : allMessages.length < 6 ? 'need 6+ messages' : `${allMessages.length} msgs eligible`,
                      rightSlot: hasSnapshot ? badge('✓', 'purple') : undefined,
                      disabled: allMessages.length < 6,
                      onClick: () => openCompressModal(),
                    },
                    {
                      id: 'keyfacts', label: 'Key facts',
                      subLabel: keyFactCount > 0 ? `${keyFactCount} captured` : 'none yet',
                      rightSlot: keyFactCount > 0 ? badge(`${keyFactCount}`, 'amber') : undefined,
                      disabled: keyFactCount === 0,
                      onClick: () => {
                        // Reveal/hide existing KF badge dropdown by toggling the
                        // hidden memory-stats panel class; if nothing is wired
                        // up for opening, this is a no-op click.
                      },
                    },
                    {
                      id: 'memory', label: 'Memory panel',
                      subLabel: 'turns, episodes, search',
                      onClick: () => setShowMemoryPanel(true),
                    },
                    {
                      id: 'link', label: linkedSession ? `Linked: ${linkedSession.name}` : 'Link another chat',
                      subLabel: linkedSession ? 'cross-reference in context' : 'attach a chat (same namespace)',
                      dotColor: linkedSession ? 'bg-terminal-purple' : undefined,
                      onClick: () => setShowLinkDropdown(v => !v),
                      keepOpen: true,
                    },
                    {
                      id: 'pull-cross-chat',
                      label: 'Pull chat context',
                      subLabel: 'Linux MC, PC, SEO, Luke\'s — last N msgs',
                      onClick: () => setShowCrossChatPull(true),
                    },
                    {
                      id: 'ask-codex',
                      label: '🤖 Ask Codex',
                      subLabel: 'OpenAI Codex turn with a persistent goal',
                      onClick: () => setShowCodexModal(true),
                    },
                    {
                      id: 'session', label: 'Gateway session',
                      subLabel: selectedGatewaySession || 'not attached',
                      onClick: () => setShowSessionDropdown(v => !v),
                      keepOpen: true,
                    },
                  ],
                },
                {
                  title: 'Composer',
                  items: [
                    {
                      id: 'attach-file',
                      label: 'Attach file',
                      subLabel: 'image, PDF, text — added to next message',
                      onClick: () => fileInputRef.current?.click(),
                    },
                    {
                      id: 'project-assets',
                      label: 'Project assets',
                      subLabel: showAssets ? 'panel open' : (activeSession?.workspace ? 'browse the workspace' : 'set workspace first'),
                      rightSlot: showAssets ? badge('open', 'cyan') : undefined,
                      disabled: !(activeSession?.workspace || getConfig().workspace),
                      onClick: () => {
                        const ws = activeSession?.workspace || getConfig().workspace;
                        if (!ws) { alert('Set a workspace/project for this chat to use assets.'); return; }
                        if (!showAssets) fetchProjectAssets(ws);
                        setShowAssets(!showAssets);
                      },
                    },
                    {
                      id: 'pull-latest',
                      label: 'Pull latest',
                      subLabel: 'fast-forward managed git repos',
                      render: () => (
                        <div className="flex items-center gap-2 px-1">
                          <span className="text-terminal-dim text-[11px] w-20">Pull</span>
                          <div className="flex-1"><PullLatestButton /></div>
                        </div>
                      ),
                    },
                    {
                      id: 'github-repo',
                      label: activeSession?.githubRepo ? `GitHub: ${activeSession.githubRepo.fullName}` : 'Attach GitHub repo',
                      subLabel: activeSession?.githubRepo ? 'click to detach' : 'pin a repo to this chat',
                      rightSlot: activeSession?.githubRepo ? badge('🐙', 'purple') : undefined,
                      onClick: () => {
                        if (activeSession?.githubRepo && activeSessionId) {
                          if (confirm(`Detach ${activeSession.githubRepo!.fullName}?`)) {
                            setSessions(prev => prev.map(s =>
                              s.id === activeSessionId ? { ...s, githubRepo: undefined } : s
                            ));
                          }
                        } else {
                          // Open the (now hidden) inline GitHub picker by toggling the
                          // github-attach panel state — simpler: prompt for repo name.
                          const fullName = prompt('GitHub repo (owner/name):');
                          if (fullName && activeSessionId && /^[\w.-]+\/[\w.-]+$/.test(fullName)) {
                            const name = fullName.split('/')[1];
                            setSessions(prev => prev.map(s =>
                              s.id === activeSessionId ? {
                                ...s,
                                githubRepo: { name, fullName, url: `https://github.com/${fullName}`, defaultBranch: 'main' },
                              } : s
                            ));
                          }
                        }
                      },
                    },
                  ],
                },
                {
                  title: 'History',
                  items: [
                    {
                      id: 'reports', label: 'Reports',
                      subLabel: reports.length > 0 ? `${reports.length} available` : 'attach a report',
                      rightSlot: reports.length > 0 ? badge(`${reports.length}`, 'red') : undefined,
                      onClick: () => setShowReportDropdown(true),
                    },
                    {
                      id: 'notif', label: 'Browser notifications',
                      subLabel: notifGranted ? 'on — you\'ll get pinged' : 'off — grant to get alerts',
                      rightSlot: badge(notifGranted ? 'on' : 'off', notifGranted ? 'green' : 'neutral'),
                      onClick: () => {
                        if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
                          Notification.requestPermission();
                        }
                      },
                    },
                    {
                      id: 'reset', label: 'Reset session',
                      subLabel: activeSession?.sessionKey ? 'start fresh CLI session, keep messages' : 'no session to reset',
                      disabled: !activeSession?.sessionKey,
                      onClick: () => activeSessionId && resetSession(activeSessionId),
                    },
                    {
                      id: 'clear', label: 'Clear chat',
                      subLabel: 'remove all messages',
                      danger: true,
                      onClick: clearChat,
                    },
                  ],
                },
              ]}
            />
            );
          })()}
          <button
            onClick={clearChat}
            className="hidden text-terminal-dim hover:text-terminal-text text-xs transition"
          >
            Clear
          </button>
          <button
            onClick={() => activeSessionId && resetSession(activeSessionId)}
            className="hidden text-terminal-dim hover:text-terminal-amber text-xs transition"
            title="Reset session context (starts fresh CLI session, keeps local messages)"
          >
            Reset
          </button>
        </div>

        {/* Chat/Tasks Tab Toggle - only show on desktop when tasks exist */}
        {(activeTask || taskHistory.length > 0) && (
          <div className="hidden md:flex items-center gap-0 border-b border-terminal-border bg-terminal-bg">
            <button
              onClick={() => setActiveView('chat')}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium transition ${
                activeView === 'chat'
                  ? 'text-terminal-green border-b-2 border-terminal-green bg-terminal-green/5'
                  : 'text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface'
              }`}
            >
              <MessageSquare className="w-4 h-4" />
              Chat
            </button>
            <button
              onClick={() => setActiveView('tasks')}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium transition ${
                activeView === 'tasks'
                  ? 'text-terminal-purple border-b-2 border-terminal-purple bg-terminal-purple/5'
                  : 'text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface'
              }`}
            >
              <Zap className="w-4 h-4" />
              Tasks
              {activeTask && activeTask.status === 'running' && (
                <span className="w-2 h-2 bg-terminal-amber rounded-full animate-pulse" />
              )}
              {taskHistory.length > 0 && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-terminal-surface text-terminal-dim">
                  {taskHistory.length}
                </span>
              )}
            </button>
          </div>
        )}

        {/* Chat Content - visible when chat tab is active (or always on mobile) */}
        <div className={`flex-1 flex flex-col min-h-0 ${(activeTask || taskHistory.length > 0) && activeView === 'tasks' ? 'hidden md:hidden' : ''}`}>
        {/* Linked Chat Panel */}
        {linkedSession && (
          <div className="border-b border-terminal-border bg-terminal-purple/5">
            <button
              onClick={() => setShowLinkedMessages(!showLinkedMessages)}
              className="w-full px-3 py-2 flex items-center justify-between text-sm hover:bg-terminal-purple/10 transition"
            >
              <div className="flex items-center gap-2">
                <Link2 className="w-4 h-4 text-terminal-purple" />
                <span className="text-terminal-purple font-medium">Linked: {linkedSession.name}</span>
                <span className="text-xs text-terminal-dim">({linkedSession.messages.length} messages)</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setLinkedSessionId(null);
                  }}
                  className="p-1 hover:bg-terminal-red/20 rounded text-terminal-dim hover:text-terminal-red"
                  title="Unlink"
                >
                  <Unlink className="w-3.5 h-3.5" />
                </button>
                {showLinkedMessages ? (
                  <ChevronUp className="w-4 h-4 text-terminal-dim" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-terminal-dim" />
                )}
              </div>
            </button>
            
            {showLinkedMessages && (
              <div className="max-h-48 overflow-y-auto px-3 pb-3 space-y-2">
                {linkedMessages.slice(-10).map((msg) => (
                  <div
                    key={msg.id}
                    className={`text-xs p-2 rounded ${
                      msg.role === 'user'
                        ? 'bg-terminal-cyan/10 border-l-2 border-terminal-cyan ml-4'
                        : msg.role === 'assistant'
                        ? 'bg-terminal-green/10 border-l-2 border-terminal-green mr-4'
                        : 'bg-terminal-dim/10 border-l-2 border-terminal-dim'
                    }`}
                  >
                    <div className="text-terminal-dim text-[10px] mb-1">
                      {msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Agent' : 'System'} • {formatTime(msg.timestamp)}
                    </div>
                    <div className="text-terminal-text line-clamp-3">
                      {msg.content.slice(0, 200)}{msg.content.length > 200 ? '...' : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Sub-Agent Tracker - hidden, kept for completion notices only */}
        {/* SubAgentTracker: always rendered (hidden) to keep notifiedRef stable across session switches */}
        <div className="hidden">
          <SubAgentTracker
            subAgents={subAgents}
            onCompletionNotice={(agent) => {
              // Skip if we already showed a notice for this agent (prevents duplicates on session switch)
              if (notifiedSubAgentsRef.current.has(agent.key)) return;
              notifiedSubAgentsRef.current.add(agent.key);
              
              const modelIcon = agent.model === 'opus' ? '🧠' : agent.model === 'sonnet' ? '⚡' : agent.model === 'haiku' ? '🍃' : '🤖';
              const modelName = (agent.model || 'default').toUpperCase();
              const duration = agent.durationMs ? Math.round(agent.durationMs / 1000) : null;
              const durationStr = duration ? (duration >= 60 ? `${Math.floor(duration/60)}m ${duration%60}s` : `${duration}s`) : '';
              
              if (agent.status === 'complete') {
                addSystemMessage(
                  `✅ **Sub-agent done** ${modelIcon} ${modelName} · ${durationStr} — ${agent.label}`
                );
              } else if (agent.status === 'failed') {
                addSystemMessage(
                  `❌ **Sub-agent failed** ${modelIcon} ${modelName} · ${durationStr} — ${agent.label}`
                );
              }
            }}
          />
        </div>


        <ThreadArea
          messages={messages as any}
          allMessages={allMessages as any}
          timelineEvents={timelineEvents as any}
          showTimelineRail={showTimelineRail}
          onToggleTimelineRail={() => setShowTimelineRail(s => !s)}
          hasHiddenMessages={hasHiddenMessages}
          maxDisplayed={MAX_DISPLAYED_MESSAGES}
          onShowAll={() => setShowAllMessages(true)}
          streamingContent={streamingContent}
          isLoading={isLoading}
          loadingElapsed={loadingElapsed}
          activity={session.activity}
          onStopGeneration={() => stopGeneration()}
          workspace={activeSession?.workspace}
          onSeedPrompt={(prompt) => {
            if (!activeSessionId) return;
            setInputMap(prev => ({ ...prev, [activeSessionId]: prompt }));
            inputValueRefs.current[activeSessionId] = prompt;
            inputRef.current?.focus();
          }}
          activeMessageMenu={activeMessageMenu}
          setActiveMessageMenu={setActiveMessageMenu}
          editingMessageId={editingMessageId}
          editingContent={editingContent}
          setEditingContent={setEditingContent}
          onSaveEdit={handleSaveEdit}
          onCancelEdit={handleCancelEdit}
          onCopy={handleCopyMessage}
          onQuote={handleQuoteMessage}
          onResend={handleResendMessage}
          onEdit={handleEditMessage}
          onRegenerate={(m) => {
            const msgIndex = allMessages.findIndex(mm => mm.id === m.id);
            if (msgIndex > 0) {
              const prevUserMsg = allMessages.slice(0, msgIndex).reverse().find(mm => mm.role === 'user');
              if (prevUserMsg) handleResendMessage(prevUserMsg.content);
            }
          }}
          onBranch={handleBranchFromMessage as any}
          onDelete={handleDeleteMessage}
          onRate={handleRateMessage}
          onPin={handlePinMessage}
          onResolve={handleResolveMessage}
          renderContent={(m) => {
            const anyM = m as any;
            const voice: 'claude' | 'codex' | 'orchestrator' | undefined = anyM.voice;
            const planCard: PlanCardData | undefined = anyM.planCard;
            const planLocked: boolean = !!anyM.planCardLocked;
            const autopilotEvents: any[] | undefined = anyM.autopilotEvents;
            const codexQuestion = anyM.codexQuestion;
            const codexQAnswered = !!anyM.codexQuestionAnswered;
            // phaseStuck was added in v47. Older messages stored the stuck
            // event inside autopilotEvents; pull it out here so the Retry/
            // Skip card renders retroactively on existing chats.
            const phaseStuck = anyM.phaseStuck
              || (Array.isArray(autopilotEvents) ? autopilotEvents.find((e: any) => e?.status === 'stuck') : null)
              || null;
            const phaseStuckResolved = !!anyM.phaseStuckResolved;
            const autopilotFinish = anyM.autopilotFinish;
            // Voice badge only for non-default voices (codex/orchestrator) so
            // solo + plain Claude messages render exactly as before.
            const showBadge = voice === 'codex' || voice === 'orchestrator';
            const voiceMeta = voice === 'codex'
              ? {
                  glyph: '⚡',
                  label: 'Codex',
                  style: {
                    background: 'rgba(232, 162, 59, 0.1)',
                    color: 'var(--amber, #E8A23B)',
                    borderColor: 'rgba(232, 162, 59, 0.4)',
                  } as React.CSSProperties,
                }
              : voice === 'orchestrator'
                ? {
                    glyph: '✦',
                    label: 'Pair',
                    style: {
                      background: 'var(--ink-2, #131319)',
                      color: 'var(--fog, rgba(255,255,255,0.78))',
                      borderColor: 'rgba(255, 255, 255, 0.18)',
                    } as React.CSSProperties,
                  }
                : null;
            return (
              <div className={voice === 'codex' ? 'pair-codex-msg' : voice === 'orchestrator' ? 'pair-orch-msg' : undefined}>
                {showBadge && voiceMeta && (
                  <div
                    className="inline-flex items-center gap-1.5 mb-2 px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide"
                    style={voiceMeta.style}
                  >
                    <span>{voiceMeta.glyph}</span>
                    <span>{voiceMeta.label}</span>
                    {anyM.pairPhase ? <span className="opacity-60 normal-case font-normal">· {anyM.pairPhase}</span> : null}
                  </div>
                )}
                {planCard && (
                  <PlanCard
                    card={planCard}
                    approvable={(planCard.protocol === 'pair-build' || (planCard.protocol === 'autopilot' && !!planCard.phases?.length)) && !planLocked}
                    locked={planLocked}
                    lockedLabel={planLocked ? (planCard.phases?.length ? 'Approved — autopilot running.' : 'Approved — Claude is implementing.') : undefined}
                    onApprove={() => handlePairApprove(m.id, planCard)}
                    onSendBack={(note) => handlePairSendBack(note)}
                  />
                )}
                {autopilotEvents && autopilotEvents.length > 0 && (
                  <div className="card autopilot">
                    <div className="card-head">
                      <span className="pip" />
                      <span>Autopilot events</span>
                    </div>
                    <div className="card-steps">
                      {autopilotEvents.map((e, i) => {
                        const status = e.status as string;
                        const glyph = status === 'start' ? '▶'
                          : status === 'audit' ? '⚖'
                          : status === 'rework' ? '↻'
                          : status === 'complete' ? '✓'
                          : status === 'stuck' ? '⛔'
                          : '·';
                        // Tone styling: green for complete, red for stuck,
                        // amber for rework, neutral otherwise. Use .step.done
                        // for complete events so design strike-through applies.
                        const stepCls = status === 'complete' ? 'step done' : 'step';
                        const numColor =
                          status === 'stuck' ? 'var(--red, #CC0C20)'
                          : status === 'rework' ? 'var(--amber, #E8A23B)'
                          : status === 'complete' ? 'var(--green, #4CC38A)'
                          : 'var(--violet, #8B6FE8)';
                        return (
                          <div className={stepCls} key={i}>
                            <span className="num" style={{ color: numColor }}>{glyph}</span>
                            <span className="text">
                              P{String(e.index).padStart(2, '0')}
                              {e.name ? ` · ${e.name}` : ''}
                            </span>
                            <span className="tag">
                              {status}
                              {typeof e.attempt === 'number' ? ` · attempt ${e.attempt}` : ''}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {codexQuestion && (
                  <CodexQuestionCard
                    phaseIndex={codexQuestion.index}
                    question={codexQuestion.question}
                    auditSummary={codexQuestion.audit_summary}
                    locked={codexQAnswered}
                    onAnswer={(ans) => {
                      // Mark this question as answered visually so the card locks.
                      mutateMessage(m.id, { codexQuestionAnswered: true } as any);
                      // Pass the resume hints so the orchestrator picks up at
                      // the same attempt count, not from attempt 1.
                      handleAutopilotAnswer(
                        codexQuestion.index,
                        ans,
                        codexQuestion.resume_attempt,
                        codexQuestion.audit_history,
                      );
                    }}
                  />
                )}
                {phaseStuck && (
                  <PhaseStuckCard
                    phaseIndex={phaseStuck.index}
                    phaseName={phaseStuck.name || `Phase ${phaseStuck.index}`}
                    totalPhases={phaseStuck.total || 1}
                    // For pre-v47 events, attempts_used wasn't recorded.
                    // Fall back to the cap (since "stuck" means cap exceeded).
                    attemptsUsed={phaseStuck.attempts_used ?? phaseStuck.resume_attempt ?? phaseStuck.rework_cap ?? 0}
                    reworkCap={phaseStuck.rework_cap || 3}
                    lastConcerns={phaseStuck.last_concerns || []}
                    locked={phaseStuckResolved}
                    onRetryWithBumpedCap={(bump) => handlePhaseRetryWithBumpedCap(
                      m.id,
                      phaseStuck.index,
                      // For pre-v47, resume from cap value (next attempt = cap+1).
                      phaseStuck.resume_attempt ?? phaseStuck.rework_cap ?? 3,
                      phaseStuck.audit_history || [],
                      bump,
                    )}
                    onSkipToNextPhase={() => handlePhaseSkipToNext(m.id, phaseStuck.index)}
                  />
                )}
                {autopilotFinish && (
                  <div className="card autopilot">
                    <div className="card-head">
                      <span className="pip" />
                      <span>Autopilot · mission complete</span>
                    </div>
                    <div className="card-body">{autopilotFinish.summary}</div>
                  </div>
                )}
                <MessageContent content={m.role === 'assistant' ? stripSkillsMarker(m.content) : m.content} />
              </div>
            );
          }}
          formatTime={formatTime}
          formatFileSize={formatFileSize}
          messageMenuRef={messageMenuRef}
          subAgents={allSubAgents}
          virtuosoRef={virtuosoRef}
        />

        {/* Input — hidden when Fusio shell mounts its own <FusioComposer>. */}
        <div className={`${props.hideComposer ? 'hidden' : ''} p-2 md:p-3 pb-1 md:pb-3 border-t border-terminal-border relative z-30 bg-terminal-surface`}>
          {/* Undo last turn — visible when the last exchange can be safely reverted
              (idle, has an assistant message). */}
          {activeSessionId && canUndoLastTurn && !isLoading && (
            <div className="px-1 pb-1 flex items-center justify-end">
              <button
                onClick={handleUndoLastTurn}
                className="flex items-center gap-1 px-3 md:px-2 py-1.5 md:py-0.5 text-[12px] md:text-[11px] rounded text-terminal-dim hover:text-terminal-text border border-terminal-border hover:border-terminal-amber/40 transition min-h-[36px] md:min-h-0"
                title="Remove the last user→assistant exchange"
              >
                <RotateCcw className="w-3.5 h-3.5 md:w-3 md:h-3" />
                Undo last turn
              </button>
            </div>
          )}
          {/* Retry-loop detector — trips on "still broken" / "doesn't work" phrasing.
              Uses the last assistant message as anchor context for the diagnose prompt. */}
          {activeSessionId && input && /\b(still|doesn'?t work|didn'?t work|not working|broken|same error|again)\b/i.test(input) && (() => {
            const lastAssistant = [...allMessages].reverse().find(m => m.role === 'assistant');
            if (!lastAssistant) return null;
            return (
              <div className="px-1 pb-1.5 flex items-center gap-2">
                <button
                  onClick={() => {
                    const anchor = (lastAssistant.content || '').slice(0, 900);
                    const diag = `Diagnose this loop — we're on the third+ attempt at the same problem.\n\nWhat the user just said: "${input.slice(0, 400)}"\n\nLast thing you tried:\n${anchor}\n\nDo these three things BEFORE proposing another fix:\n1. State the root hypothesis in one sentence.\n2. List two concrete signals (logs/tests/outputs) you need to confirm it.\n3. Ask the user to run those checks, or run them yourself if you can.`;
                    if (activeSessionId) {
                      setInputMap(prev => ({ ...prev, [activeSessionId]: diag }));
                      inputValueRefs.current[activeSessionId] = diag;
                      inputRef.current?.focus();
                    }
                  }}
                  className="flex items-center gap-1.5 px-3 md:px-2.5 py-1.5 md:py-1 text-[12px] md:text-[11px] rounded-full bg-terminal-amber/15 border border-terminal-amber/40 text-terminal-amber hover:bg-terminal-amber/25 transition min-h-[36px] md:min-h-0"
                >
                  <AlertTriangle className="w-3.5 h-3.5 md:w-3 md:h-3" />
                  Diagnose this loop
                </button>
                <span className="text-[10px] text-terminal-dim/70">Replaces your draft with a structured debug prompt.</span>
              </div>
            );
          })()}
          {/* MOBILE collapsible block #1 — status bar + model/mode/utility rows.
              Hidden on mobile when Tools is collapsed; transparent (md:contents)
              on desktop so layout there is unchanged. */}
          <div className={`${mobileToolsOpen ? 'block' : 'hidden'} md:contents`}>
          {/* Session status bar — model · mode · tokens · subagents · connection */}
          {activeSessionId && (
            <SessionStatusBar
              model={modelMap[activeSessionId] || 'default'}
              mode={(modeMap[activeSessionId] || 'work') as 'quick' | 'work' | 'constellation'}
              tokenUsage={tokenUsage}
              subagentsRunning={activityMap[activeSessionId]?.subagentsRunning || 0}
              subagentsDone={activityMap[activeSessionId]?.subagentsDone || 0}
              isLoading={isLoading}
              connection={
                isLoading ? 'live'
                : (activityMap[activeSessionId] && (Date.now() - activityMap[activeSessionId]!.lastUpdate) > 60_000) ? 'stale'
                : 'live'
              }
            />
          )}
          {/* Mode + utilities — mobile: three clean rows (model, modes, utils).
              Desktop: a single combined row. No wrapping ambiguity, no overlap. */}
          {activeSessionId && (
            <div className="px-1 pb-1.5 text-[12px] md:text-[11px] text-terminal-dim">
              {/* Row 0: model picker — the #1 thing users look for */}
              <div className="flex items-center gap-1 pb-1">
                <span className="mr-1 hidden md:inline">model</span>
                <select
                  value={modelMap[activeSessionId] || 'default'}
                  onChange={(e) => setModelMap(prev => ({ ...prev, [activeSessionId]: e.target.value }))}
                  className="flex-1 md:flex-none px-2 py-1.5 md:py-0.5 bg-terminal-bg border border-terminal-border rounded text-[12px] md:text-[11px] text-terminal-text hover:border-terminal-purple/50 min-h-[32px] md:min-h-0"
                  title="Model for this chat (slash commands override one turn: /opus /opus1m /sonnet /haiku)"
                >
                  <option value="default">Default (Sonnet 4.6)</option>
                  <option value="claude-opus-4-7">Opus 4.7</option>
                  <option value="claude-opus-4-7[1m]">Opus 4.7 · 1M context</option>
                  <option value="claude-sonnet-4-6">Sonnet 4.6</option>
                  <option value="claude-haiku-4-5">Haiku 4.5</option>
                  <optgroup label="OpenAI Codex (CLI)">
                    <option value="codex-default">Codex (account default)</option>
                    <option value="codex-gpt-5-codex">Codex · gpt-5-codex (latest)</option>
                  </optgroup>
                </select>
              </div>
              {/* Row 1: mode chips — equal width on mobile so they never overflow */}
              <div className="flex items-center gap-1 md:gap-1">
                <span className="mr-1 hidden md:inline">mode</span>
                {(['quick', 'work', 'constellation'] as const).map(m => {
                  const active = (modeMap[activeSessionId] || 'work') === m;
                  return (
                    <button
                      key={m}
                      onClick={() => setModeMap(prev => ({ ...prev, [activeSessionId]: m }))}
                      className={`flex-1 md:flex-none px-2 md:px-2 py-1.5 md:py-0.5 rounded border transition min-h-[32px] md:min-h-0 ${
                        active
                          ? 'bg-terminal-cyan/20 border-terminal-cyan/50 text-terminal-cyan'
                          : 'border-terminal-border hover:border-terminal-cyan/40 hover:text-terminal-text'
                      }`}
                      title={
                        m === 'quick' ? 'Haiku, no long-term recall — fast one-shots'
                        : m === 'work' ? 'Default: full context, full tools'
                        : 'Constellation team tools primed'
                      }
                    >
                      {m}
                    </button>
                  );
                })}
                <span className="ml-auto opacity-60 hidden lg:inline">
                  tip: /opus · /opus1m · /sonnet · /haiku
                </span>
                {/* Utility cluster — visible inline on desktop only */}
                <div className="hidden md:flex items-center gap-1 ml-1">
                  <select
                    value={density}
                    onChange={(e) => setDensity(e.target.value as DensityId)}
                    className="px-1 py-0.5 bg-transparent border border-terminal-border rounded text-[10px] text-terminal-dim hover:text-terminal-text"
                    title="Message density"
                  >
                    <option value="cozy">cozy</option>
                    <option value="compact">compact</option>
                    <option value="minimal">minimal</option>
                  </select>
                  <button
                    onClick={() => setActiveTheme(activeTheme === 'frost' ? 'terminal' : 'frost')}
                    className="px-1.5 py-0.5 rounded border border-terminal-border hover:border-terminal-cyan/40 hover:text-terminal-text transition"
                    title={activeTheme === 'frost' ? 'Switch to dark terminal' : 'Switch to light frost theme'}
                  >
                    {activeTheme === 'frost' ? '☀' : '☾'}
                  </button>
                  <button
                    onClick={() => setShowShortcutOverlay(true)}
                    className="px-1.5 py-0.5 rounded border border-terminal-border hover:border-terminal-cyan/40 hover:text-terminal-text transition"
                    title="Show shortcuts"
                  >
                    ?
                  </button>
                </div>
              </div>
              {/* Row 2 (mobile only): search + density + theme + help */}
              <div className="flex md:hidden items-center gap-1 mt-1">
                <button
                  onClick={() => {
                    const ev = new KeyboardEvent('keydown', { key: 'f', metaKey: true, ctrlKey: true });
                    window.dispatchEvent(ev);
                  }}
                  className="flex-1 px-2 py-1.5 min-h-[32px] rounded border border-terminal-border hover:text-terminal-text transition flex items-center justify-center gap-1"
                  title="Search in thread"
                >
                  <span className="text-sm">⌕</span>
                  <span className="text-[11px]">find</span>
                </button>
                <select
                  value={density}
                  onChange={(e) => setDensity(e.target.value as DensityId)}
                  className="flex-1 px-2 py-1.5 bg-terminal-bg border border-terminal-border rounded text-[11px] text-terminal-dim min-h-[32px]"
                  title="Density"
                >
                  <option value="cozy">cozy</option>
                  <option value="compact">compact</option>
                  <option value="minimal">minimal</option>
                </select>
                <button
                  onClick={() => setActiveTheme(activeTheme === 'frost' ? 'terminal' : 'frost')}
                  className="px-3 py-1.5 min-h-[32px] rounded border border-terminal-border hover:text-terminal-text transition"
                  title={activeTheme === 'frost' ? 'Dark' : 'Light'}
                >
                  {activeTheme === 'frost' ? '☀' : '☾'}
                </button>
                <button
                  onClick={() => setShowShortcutOverlay(true)}
                  className="px-3 py-1.5 min-h-[32px] rounded border border-terminal-border hover:text-terminal-text transition"
                  title="Shortcuts"
                >
                  ?
                </button>
              </div>
            </div>
          )}
          </div>{/* /mobile collapsible block #1 */}
          {/* Modals are fixed-overlay; render outside the collapsible so an
              ApprovalModal triggered while Tools is closed still appears. */}
          <ShortcutOverlay open={showShortcutOverlay} onClose={() => setShowShortcutOverlay(false)} />
          <ApprovalModal request={approvalQueue[0] || null} onDecision={approvalDecide} />
          <CrossChatPullModal
            open={showCrossChatPull}
            onClose={() => setShowCrossChatPull(false)}
            onInsert={(block) => {
              const sid = activeSessionId || '';
              setInputMap(prev => {
                const cur = prev[sid] || '';
                const sep = cur ? (cur.endsWith('\n') ? '' : '\n\n') : '';
                return { ...prev, [sid]: cur + sep + block + '\n\n' };
              });
            }}
          />
          <CodexChatModal
            open={showCodexModal}
            onClose={() => setShowCodexModal(false)}
            chatId={activeSessionId || 'default'}
            cwd={activeSession?.workspace || getConfig().workspace || ''}
            initialPrompt={inputMap[activeSessionId || ''] || ''}
            onInsert={(block) => {
              const sid = activeSessionId || '';
              setInputMap(prev => {
                const cur = prev[sid] || '';
                const sep = cur ? (cur.endsWith('\n') ? '' : '\n\n') : '';
                return { ...prev, [sid]: cur + sep + block + '\n\n' };
              });
            }}
          />
          {/* MOBILE collapsible block #2 — token meter. md:contents makes it a
              regular sibling on desktop. */}
          <div className={`${mobileToolsOpen ? 'block' : 'hidden'} md:contents`}>
          {/* Token Usage Meter */}
          {tokenUsage && (
            <div className="px-1 pb-2">
              <div className="flex items-center gap-2 text-xs text-terminal-dim">
                <div className="flex-1 h-1.5 bg-terminal-border rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      (tokenUsage.used / tokenUsage.max * 100) > 85 ? 'bg-terminal-red animate-pulse' :
                      (tokenUsage.used / tokenUsage.max * 100) > 60 ? 'bg-terminal-amber' :
                      'bg-terminal-green'
                    }`}
                    style={{ width: `${Math.min((tokenUsage.used / tokenUsage.max * 100), 100)}%` }}
                    title={`${tokenUsage.used.toLocaleString()} / ${tokenUsage.max.toLocaleString()} tokens`}
                  />
                </div>
                <span className="whitespace-nowrap">
                  {Math.round(tokenUsage.used / tokenUsage.max * 100)}%
                  ({tokenUsage.used >= 1000000 ? `${(tokenUsage.used/1000000).toFixed(1)}M` : `${Math.round(tokenUsage.used/1000)}K`}/{tokenUsage.max >= 1000000 ? `${(tokenUsage.max/1000000).toFixed(0)}M` : `${Math.round(tokenUsage.max/1000)}K`})
                </span>
                {(tokenUsage.used / tokenUsage.max * 100) > 80 && (
                  <button
                    onClick={openCompressModal}
                    className="text-terminal-amber hover:underline whitespace-nowrap"
                    title="Context is getting large — compress to free space"
                  >
                    Compress
                  </button>
                )}
              </div>
            </div>
          )}
          </div>{/* /mobile collapsible block #2 — token meter */}

          {/* Project Assets Panel — also collapsed on mobile; fired by the
              Assets icon in the action-button row inside collapsible block #3. */}
          <div className={`${mobileToolsOpen ? 'block' : 'hidden'} md:contents`}>
          {/* Project Assets Panel */}
          {showAssets && (
            <div className="mb-2 p-3 bg-terminal-bg rounded border border-terminal-border max-h-64 overflow-y-auto">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-terminal-cyan flex items-center gap-1.5">
                  <ImageIcon className="w-4 h-4" />
                  Project Assets
                  {activeSession?.workspace && (
                    <span className="text-terminal-dim text-xs">
                      ({activeSession.workspace.split('/').pop()})
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.multiple = true;
                      input.accept = 'image/*,.pdf,.txt,.md,.json,.csv';
                      input.onchange = async (e) => {
                        const files = (e.target as HTMLInputElement).files;
                        const ws = activeSession?.workspace || getConfig().workspace;
                        if (!files || !ws) return;
                        for (const file of Array.from(files)) {
                          await uploadToAssets(file, ws);
                        }
                        fetchProjectAssets(ws);
                      };
                      input.click();
                    }}
                    className="text-xs text-terminal-dim hover:text-terminal-cyan transition flex items-center gap-1"
                    title="Upload to project assets"
                  >
                    <Plus className="w-3 h-3" /> Upload
                  </button>
                  <button onClick={() => setShowAssets(false)} className="text-terminal-dim hover:text-terminal-text">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {assetsLoading ? (
                <div className="text-center py-4 text-terminal-dim text-sm">
                  <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Loading assets...
                </div>
              ) : projectAssets.length === 0 ? (
                <div className="text-center py-4 text-terminal-dim text-sm">
                  No assets yet. Attach files in chat or click Upload to add them.
                </div>
              ) : (
                <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
                  {projectAssets.map(asset => (
                    <div key={asset.id} className="group relative">
                      <button
                        onClick={() => attachAssetToChat(asset)}
                        className="w-full aspect-square rounded border border-terminal-border hover:border-terminal-cyan 
                                   overflow-hidden bg-terminal-surface transition flex items-center justify-center"
                        title={`${asset.name} — click to attach`}
                      >
                        {asset.type.startsWith('image/') ? (
                          <img src={asset.url} alt={asset.name} className="w-full h-full object-cover" />
                        ) : (
                          <div className="flex flex-col items-center gap-0.5 p-1">
                            <FileText className="w-5 h-5 text-terminal-cyan" />
                            <span className="text-[9px] text-terminal-dim truncate w-full text-center">
                              {asset.name.split('.').pop()}
                            </span>
                          </div>
                        )}
                      </button>
                      <div className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 flex gap-0.5 p-0.5">
                        {asset.type.startsWith('image/') && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setAssetPreview(asset); }}
                            className="w-4 h-4 bg-black/60 rounded flex items-center justify-center"
                            title="Preview"
                          >
                            <Eye className="w-2.5 h-2.5 text-white" />
                          </button>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteAsset(asset.id); }}
                          className="w-4 h-4 bg-terminal-red/80 rounded flex items-center justify-center"
                          title="Delete"
                        >
                          <X className="w-2.5 h-2.5 text-white" />
                        </button>
                      </div>
                      <div className="text-[9px] text-terminal-dim truncate mt-0.5 text-center">{asset.name}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          </div>{/* /mobile collapsible block #3 — project assets panel */}

          {/* Asset Preview Modal */}
          {assetPreview && (
            <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setAssetPreview(null)}>
              <div className="max-w-4xl max-h-[90vh] relative" onClick={e => e.stopPropagation()}>
                <img src={assetPreview.url} alt={assetPreview.name} className="max-w-full max-h-[85vh] object-contain rounded" />
                <div className="absolute top-2 right-2 flex gap-2">
                  <button
                    onClick={() => { attachAssetToChat(assetPreview); setAssetPreview(null); }}
                    className="px-3 py-1.5 bg-terminal-cyan/90 text-black rounded text-sm font-medium hover:bg-terminal-cyan transition"
                  >
                    Attach to Chat
                  </button>
                  <button onClick={() => setAssetPreview(null)} className="p-1.5 bg-black/60 rounded hover:bg-black/80 transition">
                    <X className="w-5 h-5 text-white" />
                  </button>
                </div>
                <div className="text-center mt-2 text-terminal-dim text-sm">{assetPreview.name}</div>
              </div>
            </div>
          )}

          {/* MOBILE: collapse banners + attachment preview + action-button row
              behind a "Tools" toggle so they don't crowd the chat view.
              DESKTOP: the wrapper becomes display:contents (md:contents) — its
              children render as if the wrapper isn't there, preserving the
              existing stacked flex layout. */}
          <div className={`${mobileToolsOpen ? 'block' : 'hidden'} md:contents`}>
          {/* Rate-limit cooldown banner — non-intrusive, above attachments + composer.
              Server marked this chat 429-gated; auto-clears when timer runs out. */}
          {(() => {
            const gate = activeRateLimitGate(activeSessionId);
            if (!gate) return null;
            // referenced so the 1Hz tick re-renders the countdown
            void rateLimitTick;
            const secs = Math.max(0, Math.ceil((gate.until - Date.now()) / 1000));
            return (
              <div className="mb-2 px-3 py-2 rounded border border-terminal-amber/40 bg-terminal-amber/10 text-terminal-amber text-xs flex items-center gap-2">
                <span className="font-bold">⚠ Rate-limited</span>
                <span className="opacity-80">— Anthropic's 5-hour rolling window is full.</span>
                <span className="ml-auto font-mono whitespace-nowrap">retry in {secs}s</span>
                <button
                  onClick={() => activeSessionId && setRateLimitGateMap(prev => {
                    const next = { ...prev };
                    delete next[activeSessionId];
                    return next;
                  })}
                  className="ml-2 px-2 py-0.5 text-[10px] rounded border border-terminal-amber/40 hover:bg-terminal-amber/20"
                  title="Dismiss the banner (won't actually retry until the rolling window clears)"
                >
                  dismiss
                </button>
              </div>
            );
          })()}

          {/* Heavy-chat nudge — surfaces when the LIVE tail of the chat
              (messages sent each turn) is heavy. After a real compress, the
              tail is just `messages.length - contextSnapshotAt` and the rest
              is replaced by the snapshot — so we measure tail weight, not
              raw total. Otherwise this banner kept firing right after a
              successful compress, which is exactly the wrong signal. */}
          {(() => {
            if (!activeSession) return null;
            const allMsgs = activeSession.messages || [];
            const totalCount = allMsgs.length;
            const hasSnapshot = !!activeSession.contextSnapshot && activeSession.contextSnapshot.length > 400;
            // Tail = messages actually re-sent per turn. With a snapshot,
            // only msgs after snapshotAt go in the prompt verbatim.
            const tailStart = hasSnapshot
              ? Math.max(0, activeSession.contextSnapshotAt ?? totalCount)
              : 0;
            const tailMsgs = allMsgs.slice(tailStart);
            let tailBytes = 0;
            for (const m of tailMsgs) {
              const c = m?.content;
              if (typeof c === 'string') tailBytes += c.length;
              else if (c) tailBytes += JSON.stringify(c).length;
            }
            const tailCount = tailMsgs.length;
            const HEAVY_MSGS = 50;
            const HEAVY_BYTES = 2_000_000; // 2 MB
            const isHeavy = tailCount >= HEAVY_MSGS || tailBytes >= HEAVY_BYTES;
            if (!isHeavy) return null;
            // Don't double-banner if rate-limit banner is showing
            if (activeRateLimitGate(activeSessionId)) return null;
            // Don't show if user already dismissed for this session this load
            if (heavyChatDismissedRef.current.has(activeSessionId || '')) return null;
            const sizeStr = tailBytes > 1_000_000
              ? `${(tailBytes/1_000_000).toFixed(1)} MB`
              : `${Math.round(tailBytes/1000)} KB`;
            const hint = hasSnapshot
              ? `Live tail since last compress is ${tailCount} msgs / ${sizeStr}. Compress again to lighten further.`
              : `${tailCount} msgs / ${sizeStr} re-sent each turn — main cause of 429s. Tools menu → Compress to lighten future turns.`;
            return (
              <div className="mb-2 px-3 py-1.5 rounded border border-terminal-cyan/30 bg-terminal-cyan/5 text-terminal-cyan text-[11px] flex items-center gap-2">
                <span>💡 Heavy chat — {hint}</span>
                <button
                  onClick={() => {
                    if (activeSessionId) heavyChatDismissedRef.current.add(activeSessionId);
                    setRateLimitTick(n => n + 1); // force re-render
                  }}
                  className="ml-auto px-2 py-0.5 text-[10px] rounded border border-terminal-cyan/30 hover:bg-terminal-cyan/15"
                >
                  dismiss
                </button>
              </div>
            );
          })()}

          {/* Attachment Preview */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2 p-2 bg-terminal-bg rounded border border-terminal-border">
              {attachments.map((att) => (
                <div key={att.id} className="relative group">
                  {att.type.startsWith('image/') ? (
                    <img 
                      src={att.url} 
                      alt={att.name} 
                      className="h-16 w-16 object-cover rounded"
                    />
                  ) : (
                    <div className="h-16 w-16 bg-terminal-surface rounded flex flex-col items-center justify-center p-1">
                      <FileText className="w-6 h-6 text-terminal-cyan" />
                      <span className="text-xs text-terminal-dim truncate w-full text-center">{att.name.split('.').pop()}</span>
                    </div>
                  )}
                  <button
                    onClick={() => removeAttachment(att.id)}
                    className="absolute -top-1 -right-1 w-5 h-5 bg-terminal-red rounded-full 
                               flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                  >
                    <X className="w-3 h-3 text-white" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Mobile: compact button row above the input */}
          <div className="flex md:hidden gap-1 mb-1 items-center">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
              accept="image/*,.pdf,.txt,.md,.json,.csv,.doc,.docx"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-2 text-terminal-dim hover:text-terminal-cyan rounded-lg transition flex-shrink-0"
              title="Attach file"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                const ws = activeSession?.workspace || getConfig().workspace;
                if (!ws) { alert('Set a workspace/project for this chat to use assets.'); return; }
                if (!showAssets) { fetchProjectAssets(ws); }
                setShowAssets(!showAssets);
              }}
              className={`p-2 rounded-lg transition flex-shrink-0 ${
                showAssets ? 'text-terminal-cyan' : 'text-terminal-dim hover:text-terminal-cyan'
              }`}
              title="Assets"
            >
              <ImageIcon className="w-4 h-4" />
            </button>
            {claudeInstalled?.installed && (
              <button
                onClick={openDelegateModal}
                disabled={isLoading}
                className="p-2 text-terminal-cyan rounded-lg transition flex-shrink-0 disabled:opacity-50"
                title="Delegate"
              >
                <Users className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={spawnTask}
              disabled={!input.trim()}
              className="p-2 text-terminal-purple rounded-lg transition flex-shrink-0 disabled:opacity-50"
              title="Spawn task"
            >
              <Zap className="w-4 h-4" />
            </button>
          </div>
          </div>{/* /mobile collapsible wrapper */}

          {/* Mobile-only "Tools" toggle. Always visible on mobile, hides on
              desktop (md:hidden). Pulls focus only when collapsed extras exist
              — badge dot turns amber for rate-limit, cyan for heavy-chat /
              queued attachments. Tapping toggles the collapsed wrapper above. */}
          <div className="flex md:hidden items-center gap-2 mb-1.5">
            {(() => {
              const gate = activeRateLimitGate(activeSessionId);
              const attachCount = attachments.length;
              // Heavy-chat = same threshold the banner above uses.
              let heavyActive = false;
              if (activeSession && !heavyChatDismissedRef.current.has(activeSessionId || '')) {
                const allMsgs = activeSession.messages || [];
                const hasSnap = !!activeSession.contextSnapshot && activeSession.contextSnapshot.length > 400;
                const tailStart = hasSnap ? Math.max(0, activeSession.contextSnapshotAt ?? allMsgs.length) : 0;
                const tail = allMsgs.slice(tailStart);
                let tailBytes = 0;
                for (const m of tail) {
                  const c = m?.content;
                  if (typeof c === 'string') tailBytes += c.length;
                  else if (c) tailBytes += JSON.stringify(c).length;
                }
                heavyActive = tail.length >= 50 || tailBytes >= 2_000_000;
              }
              const hasAlerts = !!gate;
              const hasInfo = !gate && (attachCount > 0 || heavyActive);
              const dotColor = hasAlerts
                ? 'bg-terminal-amber'
                : hasInfo ? 'bg-terminal-cyan' : '';
              return (
                <button
                  onClick={() => setMobileToolsOpen(o => !o)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded border border-terminal-border text-terminal-dim hover:text-terminal-cyan hover:border-terminal-cyan/40 transition"
                  aria-expanded={mobileToolsOpen}
                  aria-label={mobileToolsOpen ? 'Hide chat tools' : 'Show chat tools'}
                >
                  {mobileToolsOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
                  <span className="font-medium">Tools</span>
                  {!mobileToolsOpen && (hasAlerts || hasInfo) && (
                    <span className={`ml-1 inline-block w-1.5 h-1.5 rounded-full ${dotColor}`} aria-hidden />
                  )}
                  {!mobileToolsOpen && attachCount > 0 && (
                    <span className="ml-1 text-terminal-cyan font-mono">[{attachCount}]</span>
                  )}
                </button>
              );
            })()}
          </div>

          {/* Input row: mobile = textarea + send only, desktop = all buttons inline */}
          <div className="flex gap-2 items-end">
            {/* Desktop-only left buttons */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
              accept="image/*,.pdf,.txt,.md,.json,.csv,.doc,.docx"
            />
            {/* Desktop attach + assets buttons — moved into HeaderToolsMenu. */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="hidden p-2 text-terminal-dim hover:text-terminal-cyan hover:bg-terminal-cyan/10
                         rounded transition border border-terminal-border flex-shrink-0"
              title="Attach file"
            >
              <Paperclip className="w-5 h-5" />
            </button>
            <button
              onClick={() => {
                const ws = activeSession?.workspace || getConfig().workspace;
                if (!ws) { alert('Set a workspace/project for this chat to use assets.'); return; }
                if (!showAssets) { fetchProjectAssets(ws); }
                setShowAssets(!showAssets);
              }}
              className={`hidden p-2 rounded transition border border-terminal-border flex-shrink-0 ${
                showAssets
                  ? 'text-terminal-cyan bg-terminal-cyan/10 border-terminal-cyan/30'
                  : 'text-terminal-dim hover:text-terminal-cyan hover:bg-terminal-cyan/10'
              }`}
              title="Project assets"
            >
              <ImageIcon className="w-5 h-5" />
            </button>

            <div className="flex-1 relative">
              {/* @-mention autocomplete dropdown */}
              {(() => {
                const val = input || '';
                const atMatch = val.match(/@(\w*)$/);
                const showMentions = atMatch && linkedTeamId;
                if (!showMentions) return null;
                const filter = atMatch[1].toLowerCase();
                return (
                  <MentionDropdown
                    teamId={linkedTeamId!}
                    filter={filter}
                    onSelect={(handle) => {
                      if (activeSessionId) {
                        const newVal = val.replace(/@\w*$/, `@${handle} `);
                        setInputMap(prev => ({...prev, [activeSessionId]: newVal}));
                        inputValueRefs.current[activeSessionId] = newVal;
                        inputRef.current?.focus();
                      }
                    }}
                  />
                );
              })()}
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  if (activeSessionId) {
                    setInputMap(prev => ({...prev, [activeSessionId]: e.target.value}));
                    inputValueRefs.current[activeSessionId] = e.target.value;
                  }
                }}
                onKeyDown={handleKeyDown}
                placeholder={linkedTeamId ? "Type a message... (@ to mention an agent)" : "Type a message..."}
                rows={1}
                className="w-full bg-terminal-bg border-2 border-terminal-border rounded-2xl md:rounded-lg px-4 py-3 md:px-3 md:py-2
                           text-terminal-text text-lg md:text-sm resize-none focus:border-terminal-green outline-none
                           placeholder:text-terminal-dim/70 min-h-[52px] md:min-h-[40px] max-h-[200px] md:max-h-[120px]
                           leading-relaxed"
                style={{ height: 'auto' }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = 'auto';
                  const maxH = window.innerWidth < 768 ? 200 : 120;
                  target.style.height = Math.min(target.scrollHeight, maxH) + 'px';
                }}
              />
            </div>

            {/* Delegate button — moved into HeaderToolsMenu, hidden inline. */}
            {claudeInstalled?.installed && (
              <button
                onClick={openDelegateModal}
                disabled={isLoading}
                className="hidden p-2 text-terminal-cyan hover:text-terminal-cyan hover:bg-terminal-cyan/10
                           rounded transition border border-terminal-border hover:border-terminal-cyan/50
                           disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                title={claudeInstalled.teamsSupported ? "Delegate to Claude Code Teams" : "Delegate to Claude Code"}
              >
                <Users className="w-5 h-5" />
              </button>
            )}

            {isLoading ? (
              <div className="flex gap-2">
                <button
                  onClick={() => { sendMessage(); }}
                  disabled={!input.trim()}
                  className="px-3 py-3 md:py-2 bg-terminal-yellow/20 text-terminal-yellow rounded-lg md:rounded
                             hover:bg-terminal-yellow/30 transition border border-terminal-yellow/50
                             disabled:opacity-30 disabled:cursor-not-allowed min-w-[44px] min-h-[44px] flex items-center justify-center"
                  title="Steer agent"
                >
                  <Send className="w-5 h-5" />
                </button>
                <button
                  onClick={() => stopGeneration()}
                  className="px-3 py-3 md:py-2 bg-terminal-red/20 text-terminal-red rounded-lg md:rounded
                             hover:bg-terminal-red/30 transition border border-terminal-red/50
                             min-w-[44px] min-h-[44px] flex items-center justify-center"
                  title="Stop generation"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            ) : (
              <>
                {/* Spawn-task button — moved into HeaderToolsMenu, hidden inline. */}
                <button
                  onClick={spawnTask}
                  disabled={!input.trim()}
                  className="hidden p-2 text-terminal-purple hover:bg-terminal-purple/10
                             rounded transition border border-terminal-border hover:border-terminal-purple/50
                             disabled:opacity-50 disabled:cursor-not-allowed items-center justify-center flex-shrink-0"
                  title="Spawn as background task"
                >
                  <Zap className="w-5 h-5" />
                </button>
                {/* Wand Button — rewrite draft via Sonnet, picks skills+agents */}
                {(() => {
                  const enhancing = activeSessionId ? !!enhancingMap[activeSessionId] : false;
                  return (
                    <button
                      onClick={() => { enhancePrompt(); }}
                      disabled={!input.trim() || enhancing}
                      className={`p-4 md:px-4 md:py-3 rounded-2xl md:rounded transition border touch-manipulation
                                 cursor-pointer select-none min-w-[52px] min-h-[52px] md:min-w-[48px] md:min-h-[48px]
                                 flex items-center justify-center flex-shrink-0
                                 ${enhancing
                                   ? 'bg-terminal-purple/30 text-terminal-purple border-terminal-purple/60 cursor-wait'
                                   : 'bg-terminal-purple/20 text-terminal-purple border-terminal-purple/50 hover:bg-terminal-purple/30 active:bg-terminal-purple/40'}
                                 disabled:opacity-40 disabled:cursor-not-allowed`}
                      style={{ WebkitTapHighlightColor: 'rgba(168, 85, 247, 0.3)', touchAction: 'manipulation' }}
                      title={enhancing ? 'Sonnet is rewriting your prompt…' : 'Rewrite this draft via Sonnet — picks the right skills + agents and expands intent (Ctrl/⌘+Enter sends)'}
                      role="button"
                      tabIndex={0}
                    >
                      {enhancing
                        ? <Loader2 className="w-6 h-6 md:w-5 md:h-5 pointer-events-none animate-spin" />
                        : <Wand2 className="w-6 h-6 md:w-5 md:h-5 pointer-events-none" />}
                    </button>
                  );
                })()}
                {/* Send Button */}
                <button
                  onClick={() => { sendMessage(); }}
                  disabled={false}
                  className="p-4 md:px-4 md:py-3 bg-terminal-green/20 text-terminal-green rounded-2xl md:rounded
                             hover:bg-terminal-green/30 active:bg-terminal-green/40 transition
                             border border-terminal-green/50 touch-manipulation cursor-pointer
                             select-none min-w-[52px] min-h-[52px] md:min-w-[48px] md:min-h-[48px] flex items-center justify-center flex-shrink-0"
                  style={{ WebkitTapHighlightColor: 'rgba(74, 222, 128, 0.3)', touchAction: 'manipulation' }}
                  role="button"
                  tabIndex={0}
                >
                  <Send className="w-6 h-6 md:w-5 md:h-5 pointer-events-none" />
                </button>
              </>
            )}
          </div>
          {/* Hint text + composer tools — fully hidden; everything moved into
              HeaderToolsMenu. The DocAttachDropdown still mounts behind-the-
              scenes for state continuity but is not visible. */}
          <div className="hidden">
            <DocAttachDropdown
              attached={(activeSession?.attachedDocs || []) as AttachedDocRef[]}
              onAttach={(refs) => {
                if (!activeSessionId) return;
                setSessions(prev => prev.map(s =>
                  s.id === activeSessionId ? { ...s, attachedDocs: refs } : s,
                ));
              }}
              chatSessionKey={activeSession?.sessionKey}
            />
          </div>
        </div>

        {/* Inline Claude Code Terminal */}
        {showClaudeTerminal && activeClaudeSession && (
          <div className="border-t border-terminal-cyan/30 bg-terminal-bg">
            {/* Terminal Header */}
            <div className="flex items-center justify-between px-3 py-2 bg-terminal-cyan/10 border-b border-terminal-cyan/20">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-terminal-cyan" />
                <span className="text-terminal-cyan font-medium text-sm">{activeClaudeSession.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded ${
                  activeClaudeSession.status === 'running' 
                    ? 'bg-terminal-green/20 text-terminal-green animate-pulse' 
                    : activeClaudeSession.status === 'stopped'
                    ? 'bg-terminal-dim/20 text-terminal-dim'
                    : 'bg-terminal-red/20 text-terminal-red'
                }`}>
                  {activeClaudeSession.status}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {activeClaudeSession.status === 'running' && (
                  <button
                    onClick={stopClaudeSession}
                    className="p-1 text-terminal-red hover:bg-terminal-red/20 rounded transition"
                    title="Stop session"
                  >
                    <Square className="w-4 h-4" />
                  </button>
                )}
                <button
                  onClick={() => setShowClaudeTerminal(false)}
                  className="p-1 text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface rounded transition"
                  title="Minimize"
                >
                  <Minimize2 className="w-4 h-4" />
                </button>
              </div>
            </div>
            
            {/* Terminal Output */}
            <div 
              ref={claudeOutputRef}
              className="max-h-48 overflow-auto p-3 font-mono text-xs"
            >
              {claudeOutput.length > 0 ? (
                claudeOutput.map((line, i) => (
                  <div
                    key={i}
                    className={`${
                      line.startsWith('[stderr]')
                        ? 'text-terminal-red'
                        : line.startsWith('[')
                          ? 'text-terminal-amber'
                          : line.includes('✓') || line.includes('Success')
                            ? 'text-terminal-green'
                            : line.includes('Error') || line.includes('✗')
                              ? 'text-terminal-red'
                              : 'text-terminal-text'
                    }`}
                  >
                    {line}
                  </div>
                ))
              ) : (
                <div className="text-terminal-dim italic flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Waiting for output...
                </div>
              )}
            </div>
          </div>
        )}

        {/* Minimized Terminal Badge */}
        {!showClaudeTerminal && activeClaudeSession && (
          <button
            onClick={() => setShowClaudeTerminal(true)}
            className={`absolute bottom-24 right-4 flex items-center gap-2 px-3 py-2 rounded-full shadow-lg transition ${
              activeClaudeSession.status === 'running'
                ? 'bg-terminal-cyan text-terminal-bg animate-pulse'
                : 'bg-terminal-surface text-terminal-text border border-terminal-border'
            }`}
          >
            <Terminal className="w-4 h-4" />
            <span className="text-sm font-medium">{activeClaudeSession.name}</span>
            {activeClaudeSession.status === 'running' && (
              <span className="w-2 h-2 bg-terminal-green rounded-full" />
            )}
          </button>
        )}
        </div>
        {/* End chat content wrapper */}

        {/* Desktop Task Panel - shown as tab content inside main chat container */}
        {(activeTask || taskHistory.length > 0) && activeView === 'tasks' && (
          <div className="flex flex-1 flex-col min-h-0">
            {/* Task History Header */}
            {taskHistory.length > 0 && (
              <div className="border-b border-terminal-border bg-terminal-bg p-2">
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => setShowTaskHistory(!showTaskHistory)}
                    className="flex items-center gap-2 text-xs text-terminal-dim hover:text-terminal-text transition"
                  >
                    <History className="w-3 h-3" />
                    <span>Tasks ({taskHistory.length})</span>
                    {showTaskHistory ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                  {!activeTask && taskHistory.length > 0 && (
                    <span className="text-xs text-terminal-dim">Select a task to view</span>
                  )}
                </div>
                
                {/* Task History List */}
                {showTaskHistory && (
                  <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
                    {/* Clear History Button */}
                    {taskHistory.some(t => t.status === 'completed' || t.status === 'failed') && (
                      <button
                        onClick={clearTaskHistory}
                        className="w-full text-left p-2 text-xs text-terminal-dim hover:text-terminal-red 
                                   hover:bg-terminal-red/10 rounded transition flex items-center gap-2"
                      >
                        <Trash2 className="w-3 h-3" />
                        Clear completed tasks
                      </button>
                    )}
                    {taskHistory.map((task) => (
                      <button
                        key={task.id}
                        onClick={() => {
                          setActiveTask(task);
                          setShowTaskHistory(false);
                        }}
                        className={`w-full text-left p-2 rounded text-xs transition ${
                          activeTask?.id === task.id
                            ? 'bg-terminal-purple/20 border border-terminal-purple/50'
                            : 'bg-terminal-surface hover:bg-terminal-surface/80 border border-transparent'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="truncate flex-1 text-terminal-text">
                            {task.prompt.slice(0, 40)}{task.prompt.length > 40 ? '...' : ''}
                          </span>
                          <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] ${
                            task.status === 'completed' ? 'bg-terminal-green/20 text-terminal-green' :
                            task.status === 'failed' ? 'bg-terminal-red/20 text-terminal-red' :
                            task.status === 'running' ? 'bg-terminal-amber/20 text-terminal-amber' :
                            task.status === 'paused' ? 'bg-terminal-amber/20 text-terminal-amber' :
                            'bg-terminal-cyan/20 text-terminal-cyan'
                          }`}>
                            {task.status}
                          </span>
                        </div>
                        <div className="text-terminal-dim text-[10px] mt-1">
                          {new Date(task.startedAt).toLocaleString()}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            
            {/* Active Task Panel - only show in layout when not minimized */}
            {activeTask && !isTaskMinimized && (
              <TaskPanel
                task={activeTask}
                onClose={closeTaskPanel}
                onSendMessage={sendTaskMessage}
                onStartExecution={startTaskExecution}
                onPauseExecution={pauseTaskExecution}
                onSkipItem={skipTaskItem}
                onAnswerQuestions={answerTaskQuestions}
                onRetryFailed={retryFailedTasks}
                onResumeFromItem={resumeFromItem}
                isMinimized={false}
                onToggleMinimize={minimizeTaskPanel}
              />
            )}
          </div>
        )}
        </div>
        
        {/* Mobile Task Panel - full screen overlay when expanded */}
        {activeTask && !isTaskMinimized && (
          <div className="md:hidden fixed inset-0 z-[90]">
            <TaskPanel
              task={activeTask}
              onClose={closeTaskPanel}
              onSendMessage={sendTaskMessage}
              onStartExecution={startTaskExecution}
              onPauseExecution={pauseTaskExecution}
              onSkipItem={skipTaskItem}
              onAnswerQuestions={answerTaskQuestions}
              onRetryFailed={retryFailedTasks}
              onResumeFromItem={resumeFromItem}
              isMinimized={false}
              onToggleMinimize={minimizeTaskPanel}
              gatewayUrl=""
              token=""
            />
          </div>
        )}
        
        {/* Minimized Task Panel - floating outside the flex layout */}
        {activeTask && isTaskMinimized && (
          <TaskPanel
            task={activeTask}
            onClose={closeTaskPanel}
            onSendMessage={sendTaskMessage}
            onStartExecution={startTaskExecution}
            onPauseExecution={pauseTaskExecution}
            onSkipItem={skipTaskItem}
            onAnswerQuestions={answerTaskQuestions}
            onRetryFailed={retryFailedTasks}
            onResumeFromItem={resumeFromItem}
            isMinimized={true}
            onToggleMinimize={maximizeTaskPanel}
            gatewayUrl={getConfig().gatewayUrl}
            token={getConfig().token}
          />
        )}
      </div>

      {/* Context Compression Modal */}
      {showCompressModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-terminal-surface border border-terminal-purple/50 rounded-lg w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="p-4 border-b border-terminal-border flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-terminal-purple/20 flex items-center justify-center">
                  <Archive className="w-6 h-6 text-terminal-purple" />
                </div>
                <div>
                  <h3 className="text-terminal-purple font-bold text-lg">Compress Context</h3>
                  <p className="text-terminal-dim text-xs">
                    AI extracts credentials, build details, decisions, and recent work
                  </p>
                </div>
              </div>
              <button
                onClick={() => { setShowCompressModal(false); setCompressResult(null); setCompressPreview(null); }}
                className="p-2 text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-auto p-4 space-y-4">
              {/* Stats Preview */}
              {compressPreview && !compressResult && (
                <div className="p-4 bg-terminal-bg rounded border border-terminal-border">
                  <h4 className="text-terminal-text font-medium text-sm mb-3">Current Context</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="text-center">
                      <div className="text-xl font-bold text-terminal-text">{compressPreview.totalMessages}</div>
                      <div className="text-xs text-terminal-dim">Messages</div>
                    </div>
                    <div className="text-center">
                      <div className="text-xl font-bold text-terminal-cyan">{compressPreview.userMessages}</div>
                      <div className="text-xs text-terminal-dim">Your msgs</div>
                    </div>
                    <div className="text-center">
                      <div className="text-xl font-bold text-terminal-green">{compressPreview.assistantMessages}</div>
                      <div className="text-xs text-terminal-dim">Agent msgs</div>
                    </div>
                    <div className="text-center">
                      <div className="text-xl font-bold text-terminal-amber">~{Math.round(compressPreview.estimatedTokens / 1000)}K</div>
                      <div className="text-xs text-terminal-dim">Est. tokens</div>
                    </div>
                  </div>
                  
                  <div className="mt-3 pt-3 border-t border-terminal-border">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-terminal-dim">Estimated after compression:</span>
                      <span className="text-terminal-green font-medium">
                        ~{Math.round(compressPreview.estimatedCompressedTokens / 1000)}K tokens
                        ({Math.round((1 - compressPreview.estimatedCompressedTokens / compressPreview.estimatedTokens) * 100)}% smaller)
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Mode Selection */}
              {!compressResult && (
                <div>
                  <label className="text-terminal-dim text-xs block mb-2">COMPRESSION MODE</label>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setCompressMode('replace')}
                      className={`flex-1 p-3 rounded transition border text-left ${
                        compressMode === 'replace'
                          ? 'bg-terminal-purple/20 text-terminal-purple border-terminal-purple/50'
                          : 'bg-terminal-bg text-terminal-dim border-terminal-border hover:border-terminal-purple/30'
                      }`}
                    >
                      <div className="font-medium text-sm">🗜️ Compress Context</div>
                      <div className="text-xs mt-1 opacity-70">
                        AI gets summary + your chosen number of recent messages. Nothing is deleted.
                      </div>
                    </button>
                    <button
                      onClick={() => setCompressMode('save')}
                      className={`flex-1 p-3 rounded transition border text-left ${
                        compressMode === 'save'
                          ? 'bg-terminal-cyan/20 text-terminal-cyan border-terminal-cyan/50'
                          : 'bg-terminal-bg text-terminal-dim border-terminal-border hover:border-terminal-cyan/30'
                      }`}
                    >
                      <div className="font-medium text-sm">📁 Save to File</div>
                      <div className="text-xs mt-1 opacity-70">
                        Save summary as .md file in project. Chat stays unchanged.
                      </div>
                    </button>
                  </div>
                </div>
              )}

              {/* Keep last N messages slider */}
              {!compressResult && compressMode === 'replace' && (
                <div className="p-3 bg-terminal-bg rounded border border-terminal-border">
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-terminal-text font-medium text-xs">Messages to keep in full context</label>
                    <span className="text-terminal-purple font-bold text-lg">{compressKeepCount}</span>
                  </div>
                  <input
                    type="range"
                    min={4}
                    max={Math.min(50, allMessages.length)}
                    value={compressKeepCount}
                    onChange={(e) => setCompressKeepCount(Number(e.target.value))}
                    className="w-full accent-terminal-purple"
                  />
                  <div className="flex justify-between text-xs text-terminal-dim mt-1">
                    <span>4 (aggressive)</span>
                    <span>{Math.min(50, allMessages.length)} (light)</span>
                  </div>
                  <p className="text-xs text-terminal-dim mt-2">
                    These messages are sent in full to the AI. Everything older gets replaced by the compressed summary.
                  </p>
                </div>
              )}

              {/* What gets preserved */}
              {!compressResult && (
                <div className="p-3 bg-terminal-bg rounded border border-terminal-border">
                  <h4 className="text-terminal-text font-medium text-xs mb-2">ALWAYS PRESERVED</h4>
                  <div className="grid grid-cols-2 gap-1 text-xs text-terminal-dim">
                    <span>🔐 API keys & passwords</span>
                    <span>🔗 URLs & endpoints</span>
                    <span>🏗️ Build details & stack</span>
                    <span>📂 File paths & structure</span>
                    <span>✅ Decisions & preferences</span>
                    <span>🐛 Known issues & errors</span>
                    <span>📋 Pending TODOs</span>
                    <span>💡 Recent work context</span>
                  </div>
                </div>
              )}

              {/* Compression Result */}
              {compressResult && (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-3 bg-terminal-green/10 rounded border border-terminal-green/30">
                    <CheckCircle className="w-5 h-5 text-terminal-green flex-shrink-0" />
                    <div>
                      <div className="text-terminal-green font-medium text-sm">Compression Complete</div>
                      <div className="text-xs text-terminal-dim">
                        {compressResult.stats.originalMessages} messages → ~{compressResult.stats.compressedTokens.toLocaleString()} tokens 
                        ({compressResult.stats.ratio}% reduction)
                        {compressResult.savedTo && ` • Saved to ${compressResult.savedTo}`}
                      </div>
                    </div>
                  </div>
                  
                  <div className="p-3 bg-terminal-bg rounded border border-terminal-border max-h-80 overflow-y-auto">
                    <h4 className="text-terminal-text font-medium text-xs mb-2 sticky top-0 bg-terminal-bg pb-1">
                      COMPRESSED SUMMARY
                    </h4>
                    <div className="text-xs text-terminal-text whitespace-pre-wrap font-mono leading-relaxed">
                      {compressResult.summary}
                    </div>
                  </div>
                </div>
              )}

              {/* Loading */}
              {compressLoading && !compressPreview && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-terminal-purple" />
                  <span className="ml-2 text-terminal-dim">Analyzing context...</span>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-terminal-border flex items-center justify-between">
              <div className="text-xs text-terminal-dim">
                {compressMode === 'replace' 
                  ? '💡 Messages stay visible — only the AI\'s context window changes'
                  : '💡 Chat stays unchanged — summary saved as a file'
                }
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setShowCompressModal(false); setCompressResult(null); setCompressPreview(null); }}
                  className="px-4 py-2 text-terminal-dim hover:text-terminal-text transition"
                >
                  {compressResult ? 'Close' : 'Cancel'}
                </button>

                {!compressResult ? (
                  <button
                    onClick={runCompression}
                    disabled={compressLoading || !compressPreview}
                    className="flex items-center gap-2 px-6 py-2 bg-terminal-purple/20 text-terminal-purple 
                               border border-terminal-purple/50 rounded hover:bg-terminal-purple/30 transition
                               disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {compressLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Compressing...
                      </>
                    ) : (
                      <>
                        <Archive className="w-4 h-4" />
                        {compressMode === 'replace' ? 'Compress' : 'Save Summary'}
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    onClick={applyCompression}
                    className="flex items-center gap-2 px-6 py-2 bg-terminal-green/20 text-terminal-green 
                               border border-terminal-green/50 rounded hover:bg-terminal-green/30 transition"
                  >
                    <Check className="w-4 h-4" />
                    {compressMode === 'replace' ? 'Apply Compression' : 'Done'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delegate to Claude Code Modal */}
      {showDelegateModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-terminal-surface border border-terminal-cyan/50 rounded-lg w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="p-4 border-b border-terminal-border flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-terminal-cyan/20 flex items-center justify-center">
                  <Users className="w-6 h-6 text-terminal-cyan" />
                </div>
                <div>
                  <h3 className="text-terminal-cyan font-bold text-lg">Delegate to Claude Code</h3>
                  <p className="text-terminal-dim text-xs">
                    {claudeInstalled?.teamsSupported 
                      ? 'Launch agent teams to collaborate on your task'
                      : 'Launch Claude Code to work on your task'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowDelegateModal(false)}
                className="p-2 text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-auto p-4 space-y-4">
              {/* Mode Toggle */}
              <div className="flex items-center gap-4">
                <span className="text-terminal-dim text-sm">Mode:</span>
                <button
                  onClick={() => setDelegateTeamMode(false)}
                  className={`flex items-center gap-2 px-4 py-2 rounded transition border ${
                    !delegateTeamMode
                      ? 'bg-terminal-green/20 text-terminal-green border-terminal-green/50'
                      : 'bg-terminal-bg text-terminal-dim border-terminal-border hover:border-terminal-green/30'
                  }`}
                >
                  <User className="w-4 h-4" />
                  Solo
                </button>
                <button
                  onClick={() => setDelegateTeamMode(true)}
                  disabled={!claudeInstalled?.teamsSupported}
                  className={`flex items-center gap-2 px-4 py-2 rounded transition border ${
                    delegateTeamMode
                      ? 'bg-terminal-cyan/20 text-terminal-cyan border-terminal-cyan/50'
                      : 'bg-terminal-bg text-terminal-dim border-terminal-border hover:border-terminal-cyan/30'
                  } ${!claudeInstalled?.teamsSupported ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <Users className="w-4 h-4" />
                  Team Mode
                  {!claudeInstalled?.teamsSupported && (
                    <span className="text-xs">(v2.1.34+)</span>
                  )}
                </button>
              </div>

              {/* Team Templates */}
              {delegateTeamMode && (
                <div>
                  <label className="text-terminal-dim text-xs block mb-2">TEAM TEMPLATES</label>
                  <div className="grid grid-cols-2 gap-2">
                    {TEAM_TEMPLATES.map((template, i) => (
                      <button
                        key={i}
                        onClick={() => useTemplate(template)}
                        className="text-left p-3 rounded bg-terminal-bg border border-terminal-border 
                                   hover:border-terminal-cyan/50 hover:bg-terminal-cyan/5 transition"
                      >
                        <div className="font-medium text-terminal-text">{template.title}</div>
                        <div className="text-xs text-terminal-dim mt-1">{template.description}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Prompt Input */}
              <div>
                <label className="text-terminal-dim text-xs block mb-2">TASK / PROMPT</label>
                <textarea
                  value={delegatePrompt}
                  onChange={(e) => setDelegatePrompt(e.target.value)}
                  placeholder={delegateTeamMode 
                    ? "Describe the task for the agent team..."
                    : "Describe what you want Claude Code to do..."
                  }
                  className="w-full h-40 bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                             text-terminal-text text-sm resize-none focus:border-terminal-cyan outline-none"
                />
              </div>

              {/* Workspace Info */}
              <div className="text-xs text-terminal-dim flex items-center gap-2">
                <FolderOpen className="w-4 h-4" />
                <span>Workspace: {getConfig().workspace || 'Not set (required)'}</span>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-terminal-border flex items-center justify-between">
              <div className="text-xs text-terminal-dim">
                {claudeInstalled?.version && (
                  <span className="flex items-center gap-1">
                    <Check className="w-3 h-3 text-terminal-green" />
                    Claude Code v{claudeInstalled.version}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowDelegateModal(false)}
                  className="px-4 py-2 text-terminal-dim hover:text-terminal-text transition"
                >
                  Cancel
                </button>
                <button
                  onClick={launchClaudeCode}
                  disabled={!delegatePrompt.trim() || !getConfig().workspace || delegateLoading}
                  className="flex items-center gap-2 px-6 py-2 bg-terminal-cyan/20 text-terminal-cyan 
                             border border-terminal-cyan/50 rounded hover:bg-terminal-cyan/30 transition
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {delegateLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Launching...
                    </>
                  ) : (
                    <>
                      <Zap className="w-4 h-4" />
                      Launch {delegateTeamMode ? 'Team' : 'Claude Code'}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Constellation Deploy Quick-Modal */}
      {showConstellationDeploy && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowConstellationDeploy(false)}>
          <div className="w-full max-w-md bg-terminal-bg border border-terminal-border rounded-lg shadow-2xl p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-terminal-green font-bold text-sm mb-4 flex items-center gap-2">
              <span>✦</span> Deploy Constellation
            </h3>
            <p className="text-xs text-terminal-dim mb-4">
              Opens the Constellation tab where you can pick a preset, configure agents, and deploy a team.
              Or just tell Claude in this chat: <span className="text-terminal-cyan">"deploy a Feature constellation to fix the auth bug"</span> — Claude now has team tools built in.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowConstellationDeploy(false)}
                className="px-3 py-1.5 text-xs rounded border border-terminal-border text-terminal-dim hover:text-terminal-text transition"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowConstellationDeploy(false);
                  // Navigate to the Constellation tab AND pass this chat's full context
                  const chatCtx = {
                    sessionKey: activeSession?.sessionKey,
                    workspace: activeSession?.workspace || getConfig().workspace,
                    contextSnapshot: activeSession?.contextSnapshot,
                    keyFacts: activeSession?.keyFacts,
                    environment: (() => {
                      try {
                        const env = (window as any).__mcEnvConfig?.[activeEnvironment];
                        return env ? { name: activeEnvironment, ...env } : undefined;
                      } catch { return undefined; }
                    })(),
                    githubRepo: (activeSession as any)?.githubRepo,
                    recentMessages: allMessages.slice(-10).map(m => ({
                      role: m.role,
                      content: typeof m.content === 'string' ? m.content.slice(0, 500) : '',
                    })),
                  };
                  window.dispatchEvent(new CustomEvent('mc-constellation', {
                    detail: { action: 'deploy-constellation', chatContext: chatCtx },
                  }));
                  window.dispatchEvent(new CustomEvent('mc-navigate', { detail: { tab: 'teams' } }));
                }}
                className="flex-1 px-3 py-1.5 text-xs rounded bg-terminal-green/20 text-terminal-green border border-terminal-green/30 hover:bg-terminal-green/30 transition font-bold"
              >
                Open ✦ Constellation Tab
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Memory slide-over panel */}
      {showMemoryPanel && activeSession?.sessionKey && (
        <div
          className="fixed inset-0 z-[55] bg-black/60 backdrop-blur-sm flex items-stretch justify-end"
          onClick={() => setShowMemoryPanel(false)}
        >
          <div
            className="w-full max-w-md h-full bg-terminal-bg border-l border-terminal-border shadow-2xl flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border bg-terminal-surface/50">
              <div className="flex items-center gap-2 text-sm font-bold text-terminal-green">
                <Brain className="w-4 h-4" /> Memory — {activeSession?.name || 'this chat'}
              </div>
              <button
                onClick={() => setShowMemoryPanel(false)}
                className="text-terminal-dim hover:text-terminal-text text-lg leading-none"
              >×</button>
            </div>
            <div className="flex-1 min-h-0">
              <MemoryPanel chatSessionKey={activeSession.sessionKey} title="" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Compact agent row for the Agents popup panel
function AgentPanelRow({ agent }: { agent: SubAgent }) {
  const statusConfig = {
    running: { icon: <Loader2 className="w-3.5 h-3.5 animate-spin text-terminal-cyan" />, bg: 'bg-terminal-cyan/10', border: 'border-terminal-cyan/20', label: 'Running', labelColor: 'text-terminal-cyan' },
    complete: { icon: <CheckCircle className="w-3.5 h-3.5 text-terminal-green" />, bg: 'bg-terminal-green/5', border: 'border-terminal-green/10', label: 'Done', labelColor: 'text-terminal-green' },
    failed: { icon: <AlertTriangle className="w-3.5 h-3.5 text-terminal-red" />, bg: 'bg-terminal-red/5', border: 'border-terminal-red/10', label: 'Failed', labelColor: 'text-terminal-red' },
  };
  const cfg = statusConfig[agent.status];
  
  const modelIcons: Record<string, string> = { opus: '🧠', sonnet: '⚡', haiku: '🍃', default: '🤖' };
  const modelIcon = modelIcons[agent.model || 'default'] || '🤖';

  // Duration display
  let durationStr = '';
  if (agent.status === 'running') {
    const elapsed = Math.floor((Date.now() - agent.startedAt.getTime()) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    durationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  } else if (agent.durationMs) {
    const secs = Math.floor(agent.durationMs / 1000);
    if (secs < 60) durationStr = `${secs}s`;
    else { const mins = Math.floor(secs / 60); durationStr = `${mins}m ${secs % 60}s`; }
  }

  // Task summary: first line, trimmed
  const taskSummary = (agent.task || agent.label || agent.key).split('\n')[0].slice(0, 80);

  return (
    <div className={`flex items-start gap-2.5 px-2.5 py-2 rounded ${cfg.bg} border ${cfg.border} transition`}>
      <div className="mt-0.5 flex-shrink-0">{cfg.icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-terminal-text font-medium truncate max-w-[220px]">
            {taskSummary}
          </span>
          <span className="text-[10px] opacity-60">{modelIcon}</span>
        </div>
        <div className="flex items-center gap-2 mt-1 text-[10px]">
          <span className={cfg.labelColor}>{cfg.label}</span>
          {durationStr && (
            <>
              <span className="text-terminal-dim">·</span>
              <span className="text-terminal-dim font-mono">{durationStr}</span>
            </>
          )}
          {agent.model && agent.model !== 'default' && (
            <>
              <span className="text-terminal-dim">·</span>
              <span className="text-terminal-dim">{(agent.model).toUpperCase()}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
