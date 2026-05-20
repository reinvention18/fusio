'use client';
import { generateId } from '../lib/generateId';

import { useState, useEffect, useCallback } from 'react';
import { getGatewayConfig } from '@/lib/openclaw';
import {
  Lightbulb,
  Plus,
  RefreshCw,
  Clock,
  Folder,
  Globe,
  MessageSquare,
  Package,
  ChevronRight,
  ChevronDown,
  Play,
  ThumbsUp,
  ThumbsDown,
  Check,
  X,
  Settings,
  Trash2,
  Edit2,
  Zap,
  TrendingUp,
  AlertCircle,
  BookOpen,
  Code,
  ExternalLink,
  Calendar,
  Filter,
  Search,
  Sparkles,
  Target,
  Rocket,
  History,
  Eye,
  EyeOff,
  FolderTree,
  FileCode,
  Brain,
  Newspaper,
  Shuffle,
  Dice6,
  MessageSquarePlus,
  Send,
  Save
} from 'lucide-react';

// Types
interface WatchSubject {
  id: string;
  title: string;
  description: string;
  folders: string[];
  frequency: '15min' | '30min' | 'hourly' | 'daily' | 'weekly';
  lastRun?: string;
  nextRun?: string;
  enabled: boolean;
  createdAt: string;
  suggestionCount: number;
  researchFocus?: string[]; // e.g., ['features', 'performance', 'ux', 'security']
}

interface Suggestion {
  id: string;
  subjectId: string;
  subjectTitle: string;
  title: string;
  type: 'feature' | 'improvement' | 'fix' | 'refactor' | 'security' | 'performance';
  problem: string;
  solution: string;
  reasoning: string;
  difficulty: 'easy' | 'medium' | 'hard';
  estimatedHours: number;
  sources: { type: 'code' | 'web' | 'chat' | 'dependency'; title: string; url?: string }[];
  implementationSteps: string[];
  status: 'new' | 'interested' | 'not-now' | 'implementing' | 'implemented' | 'dismissed';
  createdAt: string;
  implementedAt?: string;
  comments?: string; // User notes/modifications before implementing
}

interface ChatInsight {
  topic: string;
  frequency: number;
  lastMentioned: string;
  relatedFiles: string[];
}

const TYPE_COLORS = {
  feature: 'terminal-cyan',
  improvement: 'terminal-green',
  fix: 'terminal-red',
  refactor: 'terminal-amber',
  security: 'terminal-red',
  performance: 'terminal-purple',
};

const TYPE_ICONS = {
  feature: Sparkles,
  improvement: TrendingUp,
  fix: AlertCircle,
  refactor: Code,
  security: AlertCircle,
  performance: Zap,
};

const DIFFICULTY_COLORS = {
  easy: 'bg-terminal-green/20 text-terminal-green border-terminal-green/50',
  medium: 'bg-terminal-amber/20 text-terminal-amber border-terminal-amber/50',
  hard: 'bg-terminal-red/20 text-terminal-red border-terminal-red/50',
};

const FREQUENCY_OPTIONS = [
  { value: '15min', label: 'Every 15 min', ms: 15 * 60 * 1000 },
  { value: '30min', label: 'Every 30 min', ms: 30 * 60 * 1000 },
  { value: 'hourly', label: 'Every Hour', ms: 60 * 60 * 1000 },
  { value: 'daily', label: 'Daily', ms: 24 * 60 * 60 * 1000 },
  { value: 'weekly', label: 'Weekly', ms: 7 * 24 * 60 * 60 * 1000 },
];

const RESEARCH_FOCUS_OPTIONS = [
  { value: 'features', label: 'New Features', icon: Sparkles },
  { value: 'ux', label: 'UX/UI', icon: Eye },
  { value: 'performance', label: 'Performance', icon: Zap },
  { value: 'security', label: 'Security', icon: AlertCircle },
  { value: 'architecture', label: 'Architecture', icon: FolderTree },
  { value: 'testing', label: 'Testing', icon: Check },
  { value: 'dx', label: 'Developer Experience', icon: Code },
  { value: 'industry', label: 'Industry Trends', icon: TrendingUp },
];

export default function InnovationRadar() {
  // State
  const [subjects, setSubjects] = useState<WatchSubject[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [chatInsights, setChatInsights] = useState<ChatInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState<string | null>(null);
  
  // UI State
  const [activeTab, setActiveTab] = useState<'feed' | 'subjects' | 'insights'>('feed');
  const [showAddSubject, setShowAddSubject] = useState(false);
  const [editingSubject, setEditingSubject] = useState<WatchSubject | null>(null);
  const [expandedSuggestion, setExpandedSuggestion] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('new');
  const [filterSubject, setFilterSubject] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  
  // Form state for adding/editing subjects
  const [formTitle, setFormTitle] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formFolders, setFormFolders] = useState<string[]>([]);
  const [formFrequency, setFormFrequency] = useState<'15min' | '30min' | 'hourly' | 'daily' | 'weekly'>('daily');
  const [formFocus, setFormFocus] = useState<string[]>(['features', 'improvement']);
  const [folderInput, setFolderInput] = useState('');
  
  // Folder browser state
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [browserPath, setBrowserPath] = useState('');
  const [browserItems, setBrowserItems] = useState<any[]>([]);
  const [browserLoading, setBrowserLoading] = useState(false);

  // Comments editing state
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState('');

  // Load data on mount
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/innovation');
      const data = await response.json();
      setSubjects(data.subjects || []);
      setSuggestions(data.suggestions || []);
      setChatInsights(data.insights || []);
    } catch (error) {
      console.error('Failed to load innovation data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Save subject
  const saveSubject = async () => {
    if (!formTitle.trim()) return;

    const subject: WatchSubject = {
      id: editingSubject?.id || generateId(),
      title: formTitle.trim(),
      description: formDescription.trim(),
      folders: formFolders,
      frequency: formFrequency,
      researchFocus: formFocus,
      enabled: true,
      createdAt: editingSubject?.createdAt || new Date().toISOString(),
      suggestionCount: editingSubject?.suggestionCount || 0,
    };

    try {
      await fetch('/api/innovation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save-subject', subject }),
      });
      
      setSubjects(prev => {
        const existing = prev.findIndex(s => s.id === subject.id);
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = subject;
          return updated;
        }
        return [...prev, subject];
      });
      
      resetForm();
    } catch (error) {
      console.error('Failed to save subject:', error);
    }
  };

  const deleteSubject = async (id: string) => {
    if (!confirm('Delete this watch subject and all its suggestions?')) return;
    
    try {
      await fetch('/api/innovation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete-subject', subjectId: id }),
      });
      
      setSubjects(prev => prev.filter(s => s.id !== id));
      setSuggestions(prev => prev.filter(s => s.subjectId !== id));
    } catch (error) {
      console.error('Failed to delete subject:', error);
    }
  };

  const resetForm = () => {
    setFormTitle('');
    setFormDescription('');
    setFormFolders([]);
    setFormFrequency('daily');
    setFormFocus(['features', 'improvement']);
    setShowAddSubject(false);
    setEditingSubject(null);
  };

  const editSubject = (subject: WatchSubject) => {
    setFormTitle(subject.title);
    setFormDescription(subject.description);
    setFormFolders(subject.folders);
    setFormFrequency(subject.frequency);
    setFormFocus(subject.researchFocus || ['features']);
    setEditingSubject(subject);
    setShowAddSubject(true);
  };

  // Generate suggestions for a subject
  const generateSuggestions = async (subjectId: string) => {
    setGenerating(subjectId);
    try {
      // Get gateway config from localStorage
      const config = getGatewayConfig();
      const gatewayUrl = (config.url || 'ws://localhost:18789')
        .replace('ws://', 'http://')
        .replace('wss://', 'https://');
      
      const response = await fetch('/api/innovation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'generate', 
          subjectId,
          gatewayUrl,
          token: config.token,
        }),
      });
      
      const data = await response.json();
      if (data.error) {
        console.error('Generation error:', data.error);
        alert(`Failed to generate suggestion: ${data.error}`);
        return;
      }
      if (data.suggestion) {
        setSuggestions(prev => [data.suggestion, ...prev]);
        setSubjects(prev => prev.map(s => 
          s.id === subjectId 
            ? { ...s, lastRun: new Date().toISOString(), suggestionCount: s.suggestionCount + 1 }
            : s
        ));
      }
    } catch (error) {
      console.error('Failed to generate suggestions:', error);
      alert('Failed to connect to server. Check console for details.');
    } finally {
      setGenerating(null);
    }
  };

  // Update suggestion status
  const updateSuggestionStatus = async (suggestionId: string, status: Suggestion['status']) => {
    try {
      await fetch('/api/innovation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update-status', suggestionId, status }),
      });
      
      setSuggestions(prev => prev.map(s =>
        s.id === suggestionId ? { ...s, status } : s
      ));
    } catch (error) {
      console.error('Failed to update status:', error);
    }
  };

  // Save comment to a suggestion
  const saveComment = async (suggestionId: string, comment: string) => {
    try {
      await fetch('/api/innovation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save-comment', suggestionId, comment }),
      });
      
      setSuggestions(prev => prev.map(s =>
        s.id === suggestionId ? { ...s, comments: comment } : s
      ));
      setEditingCommentId(null);
      setCommentDraft('');
    } catch (error) {
      console.error('Failed to save comment:', error);
    }
  };

  // Start editing a comment
  const startEditingComment = (suggestion: Suggestion) => {
    setEditingCommentId(suggestion.id);
    setCommentDraft(suggestion.comments || '');
  };

  // Implement suggestion - create a new chat with full context
  const implementSuggestion = async (suggestion: Suggestion) => {
    // Build comprehensive implementation prompt
    const implementationPrompt = `# Implementation Request: ${suggestion.title}

## Overview
**Type:** ${suggestion.type.toUpperCase()}
**Difficulty:** ${suggestion.difficulty}
**Estimated Time:** ${suggestion.estimatedHours} hours
**Subject:** ${suggestion.subjectTitle}

## Problem Statement
${suggestion.problem}

## Proposed Solution
${suggestion.solution}

## Reasoning & Research
${suggestion.reasoning}

## Implementation Steps
${suggestion.implementationSteps.map((step, i) => `${i + 1}. ${step}`).join('\n')}

## Research Sources
${suggestion.sources.map(s => `- [${s.type.toUpperCase()}] ${s.title}${s.url ? ` (${s.url})` : ''}`).join('\n')}

${suggestion.comments ? `## My Notes & Requirements
${suggestion.comments}

` : ''}## Your Task
Please implement this feature/improvement following these guidelines:
1. First, analyze the current codebase to understand the existing patterns
2. Create a detailed implementation plan with file changes
3. Implement the changes step by step
4. Add appropriate tests
5. Update documentation if needed

Start by examining the relevant files and confirming your approach.`;

    // Create a new chat session via the chats API
    const newSession = {
      id: generateId(),
      name: `🚀 ${suggestion.title.slice(0, 30)}...`,
      messages: [
        {
          id: generateId(),
          role: 'system',
          content: `Implementation session started for: ${suggestion.title}`,
          timestamp: new Date().toISOString(),
        },
        {
          id: generateId(),
          role: 'user',
          content: implementationPrompt,
          timestamp: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      // Save the new session
      const response = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create-session', session: newSession }),
      });
      
      if (response.ok) {
        // Mark as implementing
        updateSuggestionStatus(suggestion.id, 'implementing');
        
        // Redirect to chat tab with new session
        // Store the session ID to switch to
        localStorage.setItem('pendingChatSession', newSession.id);
        
        // Navigate to chat tab (trigger via URL or custom event)
        window.dispatchEvent(new CustomEvent('switchTab', { detail: { tab: 'chat', sessionId: newSession.id } }));
        
        // Also try direct navigation as fallback
        alert(`Implementation session created!\n\nGo to the CHAT tab to continue.\nSession: "${newSession.name}"`);
      }
    } catch (error) {
      console.error('Failed to create implementation session:', error);
      alert('Failed to create chat session. Check console for details.');
    }
  };

  // Folder browser
  const browseFolders = async (path: string = '') => {
    setBrowserLoading(true);
    try {
      const response = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
      const data = await response.json();
      setBrowserPath(data.path || '');
      setBrowserItems(data.items?.filter((i: any) => i.type === 'directory' || i.type === 'drive') || []);
    } catch (error) {
      console.error('Failed to browse folders:', error);
    } finally {
      setBrowserLoading(false);
    }
  };

  const selectFolder = (path: string) => {
    if (!formFolders.includes(path)) {
      setFormFolders([...formFolders, path]);
    }
    setShowFolderBrowser(false);
  };

  const removeFolder = (path: string) => {
    setFormFolders(formFolders.filter(f => f !== path));
  };

  // Filter suggestions
  const filteredSuggestions = suggestions.filter(s => {
    if (filterType !== 'all' && s.type !== filterType) return false;
    if (filterStatus !== 'all' && s.status !== filterStatus) return false;
    if (filterSubject !== 'all' && s.subjectId !== filterSubject) return false;
    if (searchQuery && !s.title.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !s.problem.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const formatRelativeTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div
      className="h-full flex flex-col"
      style={{
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 12,
        fontFamily: 'var(--font-sans, system-ui)',
        color: 'var(--white, #FFFFFF)',
        overflow: 'hidden',
      }}
    >
      {/* Header — Fusio eyebrow + display title */}
      <div style={{ padding: 16, borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 24, height: 24, borderRadius: 6,
                background: 'rgba(232, 162, 59, 0.12)',
                border: '1px solid rgba(232, 162, 59, 0.35)',
              }}
            >
              <Newspaper style={{ width: 12, height: 12, color: 'var(--amber, #E8A23B)' }} />
            </span>
            <div>
              <div
                style={{
                  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                  fontSize: 10,
                  letterSpacing: '0.16em',
                  textTransform: 'uppercase',
                  color: 'var(--mist, rgba(255,255,255,0.5))',
                }}
              >
                Knowledge · Watcher
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-display, "Space Grotesk")',
                  fontSize: 16,
                  fontWeight: 600,
                  letterSpacing: '-0.01em',
                  color: 'var(--white, #FFFFFF)',
                  marginTop: 1,
                }}
              >
                Innovation radar
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              onClick={loadData}
              data-fusio
              title="Refresh"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, borderRadius: 6,
                background: 'transparent',
                color: 'var(--mist, rgba(255,255,255,0.5))',
                border: 'none',
                cursor: 'pointer',
                transition: 'all 120ms ease-out',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--white, #FFFFFF)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
            >
              <RefreshCw style={{ width: 14, height: 14, animation: loading ? 'spin 1s linear infinite' : undefined }} />
            </button>
            <button
              onClick={() => {
                const enabledSubjects = subjects.filter(s => s.enabled);
                if (enabledSubjects.length === 0) return;
                const randomSubject = enabledSubjects[Math.floor(Math.random() * enabledSubjects.length)];
                generateSuggestions(randomSubject.id);
                setActiveTab('feed');
              }}
              disabled={generating !== null || subjects.filter(s => s.enabled).length === 0}
              data-fusio
              className="card-btn"
              title="Generate a random suggestion"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 11,
                padding: '5px 12px',
                background: 'rgba(232, 162, 59, 0.12)',
                borderColor: 'rgba(232, 162, 59, 0.4)',
                color: 'var(--amber, #E8A23B)',
                opacity: (generating !== null || subjects.filter(s => s.enabled).length === 0) ? 0.5 : 1,
                cursor: (generating !== null || subjects.filter(s => s.enabled).length === 0) ? 'not-allowed' : 'pointer',
              }}
            >
              {generating
                ? <RefreshCw style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} />
                : <Shuffle style={{ width: 12, height: 12 }} />}
              I'm feeling lucky
            </button>
            <button
              onClick={() => setShowAddSubject(true)}
              data-fusio
              className="card-btn primary"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 11,
                padding: '5px 12px',
                background: 'var(--red, #CC0C20)',
                borderColor: 'var(--red, #CC0C20)',
                color: '#fff',
                boxShadow: '0 0 14px rgba(204,12,32,0.35)',
              }}
            >
              <Plus style={{ width: 12, height: 12 }} />
              Add watch
            </button>
          </div>
        </div>

        {/* Stats — mono eyebrows with colored values */}
        <div
          style={{
            display: 'flex',
            gap: 18,
            marginBottom: 12,
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
          }}
        >
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Target style={{ width: 11, height: 11, color: 'var(--cyan, #5EC4D9)' }} />
            <span style={{ color: 'var(--mist, rgba(255,255,255,0.5))' }}>Watching</span>
            <span style={{ color: 'var(--cyan, #5EC4D9)' }}>· {subjects.filter(s => s.enabled).length}</span>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Lightbulb style={{ width: 11, height: 11, color: 'var(--amber, #E8A23B)' }} />
            <span style={{ color: 'var(--mist, rgba(255,255,255,0.5))' }}>New</span>
            <span style={{ color: 'var(--amber, #E8A23B)' }}>· {suggestions.filter(s => s.status === 'new').length}</span>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Rocket style={{ width: 11, height: 11, color: 'var(--green, #4CC38A)' }} />
            <span style={{ color: 'var(--mist, rgba(255,255,255,0.5))' }}>Shipped</span>
            <span style={{ color: 'var(--green, #4CC38A)' }}>· {suggestions.filter(s => s.status === 'implemented').length}</span>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4 }}>
          {(['feed', 'subjects', 'insights'] as const).map(tab => {
            const active = activeTab === tab;
            const newCount = tab === 'feed' ? suggestions.filter(s => s.status === 'new').length : 0;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                data-fusio
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                  fontSize: 10,
                  letterSpacing: '0.16em',
                  textTransform: 'uppercase',
                  padding: '5px 12px',
                  borderRadius: 6,
                  background: active ? 'rgba(204, 12, 32, 0.12)' : 'transparent',
                  color: active ? 'var(--red, #CC0C20)' : 'var(--mist, rgba(255,255,255,0.5))',
                  border: `1px solid ${active ? 'rgba(204, 12, 32, 0.4)' : 'transparent'}`,
                  cursor: 'pointer',
                  transition: 'all 120ms ease-out',
                }}
              >
                {tab === 'feed' && <Lightbulb style={{ width: 11, height: 11 }} />}
                {tab === 'subjects' && <Target style={{ width: 11, height: 11 }} />}
                {tab === 'insights' && <Brain style={{ width: 11, height: 11 }} />}
                {tab}
                {newCount > 0 && (
                  <span
                    style={{
                      marginLeft: 4,
                      padding: '1px 5px',
                      background: 'rgba(232, 162, 59, 0.3)',
                      color: 'var(--amber, #E8A23B)',
                      borderRadius: 99,
                      fontSize: 9,
                    }}
                  >
                    {newCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-full text-terminal-dim">
            <RefreshCw className="w-5 h-5 animate-spin mr-2" />
            Loading...
          </div>
        ) : activeTab === 'feed' ? (
          <div className="space-y-4">
            {/* Filters */}
            <div className="flex flex-wrap gap-2 items-center">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-terminal-dim" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search suggestions..."
                  className="w-full bg-terminal-bg border border-terminal-border rounded pl-8 pr-3 py-1.5 
                             text-sm text-terminal-text focus:border-terminal-green outline-none"
                />
              </div>
              
              <select
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value)}
                className="bg-terminal-bg border border-terminal-border rounded px-2 py-1.5 text-sm 
                           text-terminal-text focus:border-terminal-green outline-none"
              >
                <option value="all">All Status</option>
                <option value="new">New</option>
                <option value="interested">Interested</option>
                <option value="implementing">Implementing</option>
                <option value="implemented">Implemented</option>
                <option value="not-now">Not Now</option>
              </select>
              
              <select
                value={filterType}
                onChange={e => setFilterType(e.target.value)}
                className="bg-terminal-bg border border-terminal-border rounded px-2 py-1.5 text-sm 
                           text-terminal-text focus:border-terminal-green outline-none"
              >
                <option value="all">All Types</option>
                <option value="feature">Features</option>
                <option value="improvement">Improvements</option>
                <option value="fix">Fixes</option>
                <option value="performance">Performance</option>
                <option value="security">Security</option>
              </select>
              
              <select
                value={filterSubject}
                onChange={e => setFilterSubject(e.target.value)}
                className="bg-terminal-bg border border-terminal-border rounded px-2 py-1.5 text-sm 
                           text-terminal-text focus:border-terminal-green outline-none"
              >
                <option value="all">All Subjects</option>
                {subjects.map(s => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
              </select>
            </div>

            {/* Suggestions List */}
            {filteredSuggestions.length === 0 ? (
              <div className="text-center py-12 text-terminal-dim">
                <Lightbulb className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-lg">No suggestions yet</p>
                <p className="text-sm mt-2">
                  Add a watch subject and generate your first suggestion
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredSuggestions.map(suggestion => {
                  const TypeIcon = TYPE_ICONS[suggestion.type] || Lightbulb;
                  const isExpanded = expandedSuggestion === suggestion.id;
                  
                  return (
                    <div
                      key={suggestion.id}
                      className={`group bg-terminal-bg rounded-lg border overflow-hidden transition ${
                        suggestion.status === 'new' 
                          ? 'border-terminal-amber/50' 
                          : 'border-terminal-border'
                      }`}
                    >
                      {/* Header */}
                      <div
                        onClick={() => setExpandedSuggestion(isExpanded ? null : suggestion.id)}
                        className="p-4 cursor-pointer hover:bg-terminal-surface/50 transition"
                      >
                        <div className="flex items-start gap-3">
                          <div className={`p-2 rounded bg-${TYPE_COLORS[suggestion.type]}/20`}>
                            <TypeIcon className={`w-5 h-5 text-${TYPE_COLORS[suggestion.type]}`} />
                          </div>
                          
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`text-xs px-2 py-0.5 rounded border ${DIFFICULTY_COLORS[suggestion.difficulty]}`}>
                                {suggestion.difficulty}
                              </span>
                              <span className="text-xs text-terminal-dim">
                                ~{suggestion.estimatedHours}h
                              </span>
                              <span className="text-xs text-terminal-dim">•</span>
                              <span className="text-xs text-terminal-cyan">
                                {suggestion.subjectTitle}
                              </span>
                              <span className="text-xs text-terminal-dim ml-auto">
                                {formatRelativeTime(suggestion.createdAt)}
                              </span>
                            </div>
                            
                            <h4 className="text-terminal-text font-medium mb-1">
                              {suggestion.title}
                            </h4>
                            
                            <p className="text-terminal-dim text-sm line-clamp-2">
                              {suggestion.problem}
                            </p>
                          </div>
                          
                          <div className="flex items-center gap-1">
                            {/* Quick dismiss button */}
                            {suggestion.status === 'new' && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  updateSuggestionStatus(suggestion.id, 'dismissed');
                                }}
                                className="p-1.5 text-terminal-dim hover:text-terminal-red hover:bg-terminal-red/10 
                                           rounded transition opacity-0 group-hover:opacity-100"
                                title="Dismiss"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            )}
                            {isExpanded ? (
                              <ChevronDown className="w-5 h-5 text-terminal-dim" />
                            ) : (
                              <ChevronRight className="w-5 h-5 text-terminal-dim" />
                            )}
                          </div>
                        </div>
                      </div>
                      
                      {/* Expanded Content */}
                      {isExpanded && (
                        <div className="border-t border-terminal-border p-4 space-y-4">
                          {/* Problem & Solution */}
                          <div className="grid md:grid-cols-2 gap-4">
                            <div>
                              <h5 className="text-terminal-red text-xs font-bold mb-2 flex items-center gap-1">
                                <AlertCircle className="w-3 h-3" />
                                PROBLEM
                              </h5>
                              <p className="text-terminal-text text-sm">{suggestion.problem}</p>
                            </div>
                            <div>
                              <h5 className="text-terminal-green text-xs font-bold mb-2 flex items-center gap-1">
                                <Lightbulb className="w-3 h-3" />
                                SOLUTION
                              </h5>
                              <p className="text-terminal-text text-sm">{suggestion.solution}</p>
                            </div>
                          </div>
                          
                          {/* Reasoning */}
                          <div>
                            <h5 className="text-terminal-cyan text-xs font-bold mb-2 flex items-center gap-1">
                              <Brain className="w-3 h-3" />
                              REASONING
                            </h5>
                            <p className="text-terminal-dim text-sm">{suggestion.reasoning}</p>
                          </div>
                          
                          {/* Implementation Steps */}
                          <div>
                            <h5 className="text-terminal-amber text-xs font-bold mb-2 flex items-center gap-1">
                              <Code className="w-3 h-3" />
                              IMPLEMENTATION STEPS
                            </h5>
                            <ol className="space-y-1 text-sm">
                              {suggestion.implementationSteps.map((step, i) => (
                                <li key={i} className="flex items-start gap-2 text-terminal-text">
                                  <span className="text-terminal-dim">{i + 1}.</span>
                                  {step}
                                </li>
                              ))}
                            </ol>
                          </div>
                          
                          {/* Sources */}
                          {suggestion.sources.length > 0 && (
                            <div>
                              <h5 className="text-terminal-dim text-xs font-bold mb-2 flex items-center gap-1">
                                <BookOpen className="w-3 h-3" />
                                RESEARCH SOURCES
                              </h5>
                              <div className="flex flex-wrap gap-2">
                                {suggestion.sources.map((source, i) => (
                                  <span
                                    key={i}
                                    className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${
                                      source.type === 'web' 
                                        ? 'bg-terminal-cyan/20 text-terminal-cyan'
                                        : source.type === 'code'
                                          ? 'bg-terminal-green/20 text-terminal-green'
                                          : 'bg-terminal-dim/20 text-terminal-dim'
                                    }`}
                                  >
                                    {source.type === 'web' && <Globe className="w-3 h-3" />}
                                    {source.type === 'code' && <FileCode className="w-3 h-3" />}
                                    {source.type === 'chat' && <MessageSquare className="w-3 h-3" />}
                                    {source.type === 'dependency' && <Package className="w-3 h-3" />}
                                    {source.title}
                                    {source.url && (
                                      <a href={source.url} target="_blank" rel="noopener" className="hover:opacity-70">
                                        <ExternalLink className="w-3 h-3" />
                                      </a>
                                    )}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          
                          {/* Comments Section */}
                          <div className="pt-2 border-t border-terminal-border">
                            <div className="flex items-center justify-between mb-2">
                              <h5 className="text-terminal-purple text-xs font-bold flex items-center gap-1">
                                <MessageSquarePlus className="w-3 h-3" />
                                MY NOTES
                              </h5>
                              {editingCommentId !== suggestion.id && (
                                <button
                                  onClick={() => startEditingComment(suggestion)}
                                  className="text-xs text-terminal-cyan hover:text-terminal-cyan/80 transition"
                                >
                                  {suggestion.comments ? 'Edit' : '+ Add notes'}
                                </button>
                              )}
                            </div>
                            
                            {editingCommentId === suggestion.id ? (
                              <div className="space-y-2">
                                <textarea
                                  value={commentDraft}
                                  onChange={(e) => setCommentDraft(e.target.value)}
                                  placeholder="Add your notes, modifications, or requirements before implementing...&#10;&#10;Examples:&#10;- Only implement the core feature, skip the extras&#10;- Use React Query instead of SWR&#10;- Add dark mode support"
                                  rows={4}
                                  className="w-full bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                                             text-terminal-text text-sm focus:border-terminal-cyan outline-none resize-none"
                                />
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => saveComment(suggestion.id, commentDraft)}
                                    className="flex items-center gap-1 px-3 py-1.5 bg-terminal-green/20 text-terminal-green
                                               rounded hover:bg-terminal-green/30 transition text-sm"
                                  >
                                    <Save className="w-3 h-3" />
                                    Save
                                  </button>
                                  <button
                                    onClick={() => { setEditingCommentId(null); setCommentDraft(''); }}
                                    className="px-3 py-1.5 text-terminal-dim hover:text-terminal-text transition text-sm"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : suggestion.comments ? (
                              <p className="text-terminal-text text-sm bg-terminal-surface/50 rounded p-2 whitespace-pre-wrap">
                                {suggestion.comments}
                              </p>
                            ) : (
                              <p className="text-terminal-dim text-xs italic">
                                No notes yet. Add notes to customize this suggestion before implementing.
                              </p>
                            )}
                          </div>

                          {/* Actions */}
                          <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-terminal-border">
                            {/* Implement button - always available for new/interested */}
                            {(suggestion.status === 'new' || suggestion.status === 'interested') && (
                              <button
                                onClick={() => implementSuggestion(suggestion)}
                                className="flex items-center gap-2 px-4 py-2 bg-terminal-cyan/20 text-terminal-cyan
                                           rounded hover:bg-terminal-cyan/30 transition font-medium border border-terminal-cyan/50"
                              >
                                <Rocket className="w-4 h-4" />
                                Implement Now
                              </button>
                            )}
                            
                            {suggestion.status === 'new' && (
                              <>
                                <button
                                  onClick={() => updateSuggestionStatus(suggestion.id, 'interested')}
                                  className="flex items-center gap-1 px-3 py-1.5 bg-terminal-green/20 text-terminal-green
                                             rounded hover:bg-terminal-green/30 transition text-sm"
                                >
                                  <ThumbsUp className="w-4 h-4" />
                                  Save for Later
                                </button>
                                <button
                                  onClick={() => updateSuggestionStatus(suggestion.id, 'not-now')}
                                  className="flex items-center gap-1 px-3 py-1.5 bg-terminal-dim/20 text-terminal-dim
                                             rounded hover:bg-terminal-dim/30 transition text-sm"
                                >
                                  <Clock className="w-4 h-4" />
                                  Not Now
                                </button>
                                <button
                                  onClick={() => updateSuggestionStatus(suggestion.id, 'dismissed')}
                                  className="flex items-center gap-1 px-3 py-1.5 text-terminal-red/70
                                             rounded hover:bg-terminal-red/10 transition text-sm"
                                >
                                  <ThumbsDown className="w-4 h-4" />
                                  Dismiss
                                </button>
                              </>
                            )}
                            
                            {suggestion.status === 'implementing' && (
                              <span className="flex items-center gap-2 text-terminal-amber">
                                <RefreshCw className="w-4 h-4 animate-spin" />
                                Implementation in progress...
                              </span>
                            )}
                            
                            {suggestion.status === 'implemented' && (
                              <span className="flex items-center gap-2 text-terminal-green">
                                <Check className="w-4 h-4" />
                                Implemented {suggestion.implementedAt && formatRelativeTime(suggestion.implementedAt)}
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : activeTab === 'subjects' ? (
          <div className="space-y-4">
            {subjects.length === 0 ? (
              <div className="text-center py-12 text-terminal-dim">
                <Target className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-lg">No watch subjects yet</p>
                <p className="text-sm mt-2">
                  Add a subject to start receiving AI-powered suggestions
                </p>
                <button
                  onClick={() => setShowAddSubject(true)}
                  className="mt-4 flex items-center gap-1 px-4 py-2 bg-terminal-green/20 text-terminal-green 
                             rounded hover:bg-terminal-green/30 transition mx-auto"
                >
                  <Plus className="w-4 h-4" />
                  Add Your First Watch
                </button>
              </div>
            ) : (
              <div className="grid gap-4">
                {subjects.map(subject => (
                  <div
                    key={subject.id}
                    className={`bg-terminal-bg rounded-lg border p-4 ${
                      subject.enabled ? 'border-terminal-border' : 'border-terminal-dim/30 opacity-60'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h4 className="text-terminal-text font-medium flex items-center gap-2">
                          {subject.title}
                          {!subject.enabled && (
                            <span className="text-xs text-terminal-dim">(paused)</span>
                          )}
                        </h4>
                        <p className="text-terminal-dim text-sm mt-1">{subject.description}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => generateSuggestions(subject.id)}
                          disabled={generating === subject.id}
                          className="p-2 text-terminal-cyan hover:bg-terminal-cyan/20 rounded transition disabled:opacity-50"
                          title="Generate suggestion now"
                        >
                          {generating === subject.id ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : (
                            <Zap className="w-4 h-4" />
                          )}
                        </button>
                        <button
                          onClick={() => editSubject(subject)}
                          className="p-2 text-terminal-dim hover:text-terminal-text rounded transition"
                          title="Edit"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => deleteSubject(subject.id)}
                          className="p-2 text-terminal-dim hover:text-terminal-red rounded transition"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    
                    {/* Folders */}
                    <div className="mb-3">
                      <div className="text-xs text-terminal-dim mb-1 flex items-center gap-1">
                        <Folder className="w-3 h-3" />
                        Watching:
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {subject.folders.map(folder => (
                          <span
                            key={folder}
                            className="text-xs px-2 py-0.5 bg-terminal-surface rounded text-terminal-cyan font-mono"
                          >
                            {folder.split(/[/\\]/).slice(-2).join('/')}
                          </span>
                        ))}
                      </div>
                    </div>
                    
                    {/* Focus areas */}
                    {subject.researchFocus && subject.researchFocus.length > 0 && (
                      <div className="mb-3">
                        <div className="text-xs text-terminal-dim mb-1">Focus:</div>
                        <div className="flex flex-wrap gap-1">
                          {subject.researchFocus.map(focus => (
                            <span
                              key={focus}
                              className="text-xs px-2 py-0.5 bg-terminal-amber/20 text-terminal-amber rounded"
                            >
                              {focus}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Stats */}
                    <div className="flex items-center gap-4 text-xs text-terminal-dim">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {subject.frequency}
                      </span>
                      <span className="flex items-center gap-1">
                        <Lightbulb className="w-3 h-3" />
                        {subject.suggestionCount} suggestions
                      </span>
                      {subject.lastRun && (
                        <span className="flex items-center gap-1">
                          <History className="w-3 h-3" />
                          Last: {formatRelativeTime(subject.lastRun)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : activeTab === 'insights' ? (
          <div className="space-y-4">
            <div className="text-terminal-dim text-sm mb-4">
              Patterns detected from your chat history and coding sessions:
            </div>
            
            {chatInsights.length === 0 ? (
              <div className="text-center py-12 text-terminal-dim">
                <Brain className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-lg">No insights yet</p>
                <p className="text-sm mt-2">
                  Chat more in the Chat panel to build up patterns
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {chatInsights.map((insight, i) => (
                  <div key={i} className="bg-terminal-bg rounded p-3 flex items-center justify-between">
                    <div>
                      <span className="text-terminal-text">{insight.topic}</span>
                      <div className="text-xs text-terminal-dim mt-1">
                        Mentioned {insight.frequency}x • Last: {formatRelativeTime(insight.lastMentioned)}
                      </div>
                    </div>
                    <span className="text-terminal-amber font-bold">{insight.frequency}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Add/Edit Subject Modal */}
      {showAddSubject && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="fusio-panel w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="p-4 border-b border-terminal-border flex items-center justify-between">
              <h3 className="text-terminal-green font-bold">
                {editingSubject ? 'Edit Watch Subject' : 'Add Watch Subject'}
              </h3>
              <button onClick={resetForm} className="text-terminal-dim hover:text-terminal-text">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-4 space-y-4">
              {/* Title */}
              <div>
                <label className="block text-terminal-dim text-xs mb-1">Title *</label>
                <input
                  type="text"
                  value={formTitle}
                  onChange={e => setFormTitle(e.target.value)}
                  placeholder="e.g., Revolve Core CRM"
                  className="w-full bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                             text-terminal-text focus:border-terminal-green outline-none"
                />
              </div>
              
              {/* Description */}
              <div>
                <label className="block text-terminal-dim text-xs mb-1">Description</label>
                <textarea
                  value={formDescription}
                  onChange={e => setFormDescription(e.target.value)}
                  placeholder="What kind of suggestions are you looking for? e.g., New features for construction field workers, performance improvements, UX enhancements..."
                  rows={3}
                  className="w-full bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                             text-terminal-text focus:border-terminal-green outline-none resize-none"
                />
              </div>
              
              {/* Folders */}
              <div>
                <label className="block text-terminal-dim text-xs mb-1">Folders to Watch *</label>
                <div className="space-y-2">
                  {formFolders.map(folder => (
                    <div key={folder} className="flex items-center gap-2">
                      <span className="flex-1 bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                                       text-terminal-cyan text-sm font-mono truncate">
                        {folder}
                      </span>
                      <button
                        onClick={() => removeFolder(folder)}
                        className="p-2 text-terminal-red hover:bg-terminal-red/20 rounded"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                  
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={folderInput}
                      onChange={e => setFolderInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && folderInput.trim()) {
                          setFormFolders([...formFolders, folderInput.trim()]);
                          setFolderInput('');
                        }
                      }}
                      placeholder="Type path or browse..."
                      className="flex-1 bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                                 text-terminal-text focus:border-terminal-green outline-none text-sm"
                    />
                    <button
                      onClick={() => {
                        setShowFolderBrowser(true);
                        browseFolders('');
                      }}
                      className="px-3 py-2 bg-terminal-cyan/20 text-terminal-cyan rounded 
                                 hover:bg-terminal-cyan/30 transition"
                    >
                      <Folder className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
              
              {/* Folder Browser Modal */}
              {showFolderBrowser && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
                  <div className="fusio-panel w-full max-w-md">
                    <div className="p-3 border-b border-terminal-border flex items-center justify-between">
                      <span className="text-terminal-cyan font-mono text-sm truncate">
                        {browserPath || 'Select a folder'}
                      </span>
                      <button onClick={() => setShowFolderBrowser(false)} className="text-terminal-dim hover:text-terminal-text">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      {browserLoading ? (
                        <div className="p-4 text-center text-terminal-dim">
                          <RefreshCw className="w-5 h-5 animate-spin mx-auto" />
                        </div>
                      ) : (
                        <div className="p-2">
                          {browserPath && (
                            <button
                              onClick={() => browseFolders(browserPath.split(/[/\\]/).slice(0, -1).join('/'))}
                              className="w-full text-left px-3 py-2 rounded hover:bg-terminal-cyan/10 
                                         text-terminal-dim flex items-center gap-2"
                            >
                              <ChevronRight className="w-4 h-4 rotate-180" />
                              ..
                            </button>
                          )}
                          {browserItems.map(item => (
                            <button
                              key={item.path}
                              onClick={() => browseFolders(item.path)}
                              onDoubleClick={() => selectFolder(item.path)}
                              className="w-full text-left px-3 py-2 rounded hover:bg-terminal-cyan/10 
                                         text-terminal-text flex items-center gap-2"
                            >
                              <Folder className="w-4 h-4 text-terminal-cyan" />
                              {item.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {browserPath && (
                      <div className="p-3 border-t border-terminal-border">
                        <button
                          onClick={() => selectFolder(browserPath)}
                          className="w-full py-2 bg-terminal-green/20 text-terminal-green rounded 
                                     hover:bg-terminal-green/30 transition font-medium"
                        >
                          Select This Folder
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
              
              {/* Frequency */}
              <div>
                <label className="block text-terminal-dim text-xs mb-1">Suggestion Frequency</label>
                <div className="flex gap-2">
                  {FREQUENCY_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setFormFrequency(opt.value as any)}
                      className={`px-3 py-2 rounded text-sm transition ${
                        formFrequency === opt.value
                          ? 'bg-terminal-green/20 text-terminal-green border border-terminal-green/50'
                          : 'bg-terminal-bg text-terminal-dim border border-terminal-border hover:border-terminal-green/50'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              
              {/* Research Focus */}
              <div>
                <label className="block text-terminal-dim text-xs mb-1">Research Focus</label>
                <div className="flex flex-wrap gap-2">
                  {RESEARCH_FOCUS_OPTIONS.map(opt => {
                    const Icon = opt.icon;
                    const isSelected = formFocus.includes(opt.value);
                    return (
                      <button
                        key={opt.value}
                        onClick={() => {
                          setFormFocus(
                            isSelected
                              ? formFocus.filter(f => f !== opt.value)
                              : [...formFocus, opt.value]
                          );
                        }}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition ${
                          isSelected
                            ? 'bg-terminal-amber/20 text-terminal-amber border border-terminal-amber/50'
                            : 'bg-terminal-bg text-terminal-dim border border-terminal-border hover:border-terminal-amber/50'
                        }`}
                      >
                        <Icon className="w-3 h-3" />
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            
            <div className="p-4 border-t border-terminal-border flex justify-end gap-2">
              <button
                onClick={resetForm}
                className="px-4 py-2 text-terminal-dim hover:text-terminal-text transition"
              >
                Cancel
              </button>
              <button
                onClick={saveSubject}
                disabled={!formTitle.trim() || formFolders.length === 0}
                className="px-4 py-2 bg-terminal-green/20 text-terminal-green rounded 
                           hover:bg-terminal-green/30 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {editingSubject ? 'Save Changes' : 'Add Watch'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


