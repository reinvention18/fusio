'use client';

import { useState, useEffect, useCallback } from 'react';
import { 
  FlaskConical, Play, Pause, Square, RotateCcw, RefreshCw, 
  CheckCircle2, XCircle, Circle, AlertTriangle, Bug, 
  ChevronDown, ChevronRight, ExternalLink, Settings,
  FileText, Plus, Trash2, Edit2, Save, X, FolderOpen
} from 'lucide-react';

interface QAConfig {
  targetUrl: string;
  credentials?: { email?: string; password?: string };
}

interface QAState {
  status: 'idle' | 'running' | 'paused' | 'completed';
  targetUrl: string;
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  currentSection: string | null;
  currentItem: string | null;
  sections: {
    [key: string]: {
      status: 'pending' | 'running' | 'completed' | 'skipped';
      items: { [key: string]: 'pending' | 'passed' | 'failed' | 'skipped' };
    };
  };
  sampleData: Record<string, any>;
  issueCount: number;
}

interface QAIssue {
  id: string;
  timestamp: string;
  section: string;
  item: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
}

interface QAStatus {
  hasQA: boolean;
  config: QAConfig | null;
  state: QAState | null;
  plan: string | null;
  issues: QAIssue[];
  progress: { total: number; completed: number; percent: number };
}

const DEFAULT_PLAN = `# Test Plan

## Target
- URL: [Your staging URL here]

## Auth
- [ ] Login with valid credentials
- [ ] Login with invalid credentials (error handling)
- [ ] Session persistence (refresh page)
- [ ] Logout functionality

## Navigation
- [ ] All menu items accessible
- [ ] Back button works correctly
- [ ] Deep linking works

## Core Features
- [ ] Feature 1
- [ ] Feature 2
- [ ] Feature 3

## Data Entry
- [ ] Create new record
- [ ] Edit existing record
- [ ] Delete record
- [ ] Form validation

## Error Handling
- [ ] Network error handling
- [ ] Invalid input handling
- [ ] Empty state displays
`;

export default function QAPanel() {
  const [workspace, setWorkspace] = useState<string>('');
  const [status, setStatus] = useState<QAStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [showSetup, setShowSetup] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [editingPlan, setEditingPlan] = useState(false);
  const [planText, setPlanText] = useState('');
  const [targetUrl, setTargetUrl] = useState('');

  // Load workspace from localStorage
  useEffect(() => {
    const config = JSON.parse(localStorage.getItem('gatewayConfig') || '{}');
    if (config.workspace) {
      setWorkspace(config.workspace);
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    if (!workspace) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`/api/qa?workspace=${encodeURIComponent(workspace)}&action=status`);
      const data = await response.json();
      
      if (data.error) {
        setError(data.error);
        return;
      }
      
      setStatus(data);
      
      if (data.plan) {
        setPlanText(data.plan);
      }
      if (data.config?.targetUrl) {
        setTargetUrl(data.config.targetUrl);
      }
      
      // Auto-expand running section
      if (data.state?.currentSection) {
        setExpandedSections(prev => new Set([...prev, data.state.currentSection]));
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Poll for updates when running
  useEffect(() => {
    if (status?.state?.status === 'running') {
      const interval = setInterval(fetchStatus, 5000);
      return () => clearInterval(interval);
    }
  }, [status?.state?.status, fetchStatus]);

  const qaAction = async (action: string, params: any = {}) => {
    try {
      const response = await fetch('/api/qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace, action, ...params }),
      });
      const data = await response.json();
      if (data.error) {
        setError(data.error);
        return null;
      }
      await fetchStatus();
      return data;
    } catch (err: any) {
      setError(err.message);
      return null;
    }
  };

  const handleInit = async () => {
    if (!targetUrl || !planText) {
      setError('Please provide a target URL and test plan');
      return;
    }
    await qaAction('init', { targetUrl, plan: planText });
    setShowSetup(false);
  };

  const handleStart = () => qaAction('start');
  const handlePause = () => qaAction('pause');
  const handleResume = () => {
    // Get gateway config to notify the agent
    const config = JSON.parse(localStorage.getItem('gatewayConfig') || '{}');
    qaAction('resume', {
      notify: true,
      gatewayUrl: config.url,
      gatewayToken: config.token,
    });
  };
  const handleReset = () => {
    if (confirm('Reset all test progress? This cannot be undone.')) {
      qaAction('reset');
    }
  };

  const handleSavePlan = async () => {
    await qaAction('updatePlan', { plan: planText });
    if (targetUrl !== status?.config?.targetUrl) {
      await qaAction('updateConfig', { config: { targetUrl } });
    }
    setEditingPlan(false);
  };

  const toggleSection = (section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  const getStatusIcon = (itemStatus: string) => {
    switch (itemStatus) {
      case 'passed':
        return <CheckCircle2 className="w-4 h-4 text-terminal-green" />;
      case 'failed':
        return <XCircle className="w-4 h-4 text-terminal-red" />;
      case 'skipped':
        return <Circle className="w-4 h-4 text-terminal-dim" />;
      default:
        return <Circle className="w-4 h-4 text-terminal-dim" />;
    }
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical': return 'text-terminal-red bg-terminal-red/20';
      case 'high': return 'text-terminal-amber bg-terminal-amber/20';
      case 'medium': return 'text-terminal-amber bg-terminal-amber/20';
      case 'low': return 'text-terminal-cyan bg-terminal-cyan/20';
      default: return 'text-terminal-dim bg-terminal-dim/20';
    }
  };

  if (!workspace) {
    return (
      <div className="h-full flex items-center justify-center text-terminal-dim">
        <div className="text-center">
          <FolderOpen className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No workspace selected</p>
          <p className="text-sm mt-2">Set a workspace in Settings to use QA Runner</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', gap: 16, fontFamily: 'var(--font-sans, system-ui)' }}>
      {/* Main Panel */}
      <div
        style={{
          flex: 1,
          background: 'var(--ink, #0A0A0E)',
          border: '1px solid var(--line, rgba(255,255,255,0.08))',
          borderRadius: 12,
          display: 'flex', flexDirection: 'column',
          color: 'var(--white, #fff)',
        }}
      >
        {/* Header */}
        <div style={{ padding: 14, borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 24, height: 24, borderRadius: 6,
                  background: 'rgba(76, 195, 138, 0.12)',
                  border: '1px solid rgba(76, 195, 138, 0.35)',
                }}
              >
                <FlaskConical style={{ width: 12, height: 12, color: 'var(--green, #4CC38A)' }} />
              </span>
              <div>
                <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
                  Build · Verification
                </div>
                <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>
                  QA runner
                </div>
              </div>
              {status?.state?.status && (
                <span
                  style={{
                    marginLeft: 6,
                    padding: '3px 8px',
                    borderRadius: 5,
                    fontFamily: 'var(--font-mono, ui-monospace)',
                    fontSize: 9.5, letterSpacing: '0.16em', textTransform: 'uppercase',
                    background: status.state.status === 'running' ? 'rgba(76,195,138,0.14)' :
                                status.state.status === 'paused' ? 'rgba(232,162,59,0.14)' :
                                status.state.status === 'completed' ? 'rgba(94,196,217,0.14)' :
                                'rgba(255,255,255,0.05)',
                    border: `1px solid ${
                      status.state.status === 'running' ? 'rgba(76,195,138,0.35)' :
                      status.state.status === 'paused' ? 'rgba(232,162,59,0.35)' :
                      status.state.status === 'completed' ? 'rgba(94,196,217,0.35)' :
                      'var(--line, rgba(255,255,255,0.08))'
                    }`,
                    color: status.state.status === 'running' ? 'var(--green, #4CC38A)' :
                           status.state.status === 'paused' ? 'var(--amber, #E8A23B)' :
                           status.state.status === 'completed' ? 'var(--cyan, #5EC4D9)' :
                           'var(--mist, rgba(255,255,255,0.5))',
                  }}
                >
                  {status.state.status}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                onClick={fetchStatus}
                data-fusio
                title="Refresh"
                style={{
                  padding: 6, borderRadius: 5, background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--mist, rgba(255,255,255,0.5))',
                  transition: 'all 120ms ease-out',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
              >
                <RefreshCw style={{ width: 14, height: 14, animation: loading ? 'spin 1s linear infinite' : undefined }} />
              </button>
              <button
                onClick={() => setShowSetup(true)}
                data-fusio
                title="Setup"
                style={{
                  padding: 6, borderRadius: 5, background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--mist, rgba(255,255,255,0.5))',
                  transition: 'all 120ms ease-out',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; (e.currentTarget as HTMLElement).style.color = 'var(--cyan, #5EC4D9)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
              >
                <Settings style={{ width: 14, height: 14 }} />
              </button>
            </div>
          </div>

          {/* Target URL */}
          {status?.config?.targetUrl && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-terminal-dim">Target:</span>
              <a 
                href={status.config.targetUrl} 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-terminal-cyan hover:underline flex items-center gap-1"
              >
                {status.config.targetUrl}
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}

          {/* Progress Bar */}
          {status?.progress && status.progress.total > 0 && (
            <div className="mt-3">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-terminal-dim">Progress</span>
                <span className="text-terminal-text">
                  {status.progress.completed}/{status.progress.total} ({status.progress.percent}%)
                </span>
              </div>
              <div className="h-2 bg-terminal-bg rounded overflow-hidden">
                <div 
                  className="h-full bg-terminal-green transition-all duration-300"
                  style={{ width: `${status.progress.percent}%` }}
                />
              </div>
            </div>
          )}

          {/* Controls */}
          <div className="flex items-center gap-2 mt-3">
            {!status?.hasQA ? (
              <button
                onClick={() => setShowSetup(true)}
                className="px-3 py-1.5 bg-terminal-green/20 text-terminal-green border border-terminal-green/50 
                           rounded hover:bg-terminal-green/30 transition flex items-center gap-2 text-sm"
              >
                <Plus className="w-4 h-4" />
                Initialize QA
              </button>
            ) : status?.state?.status === 'running' ? (
              <button
                onClick={handlePause}
                className="px-3 py-1.5 bg-terminal-yellow/20 text-terminal-yellow border border-terminal-yellow/50 
                           rounded hover:bg-terminal-yellow/30 transition flex items-center gap-2 text-sm"
              >
                <Pause className="w-4 h-4" />
                Pause
              </button>
            ) : status?.state?.status === 'paused' ? (
              <button
                onClick={handleResume}
                className="px-3 py-1.5 bg-terminal-green/20 text-terminal-green border border-terminal-green/50 
                           rounded hover:bg-terminal-green/30 transition flex items-center gap-2 text-sm"
                title="Resume testing and notify the agent to continue"
              >
                <Play className="w-4 h-4" />
                Resume & Notify Agent
              </button>
            ) : (
              <button
                onClick={handleStart}
                className="px-3 py-1.5 bg-terminal-green/20 text-terminal-green border border-terminal-green/50 
                           rounded hover:bg-terminal-green/30 transition flex items-center gap-2 text-sm"
              >
                <Play className="w-4 h-4" />
                Start Testing
              </button>
            )}
            
            {status?.hasQA && (
              <>
                <button
                  onClick={handleReset}
                  className="px-3 py-1.5 bg-terminal-bg text-terminal-dim border border-terminal-border 
                             rounded hover:text-terminal-text transition flex items-center gap-2 text-sm"
                >
                  <RotateCcw className="w-4 h-4" />
                  Reset
                </button>
                <button
                  onClick={() => setEditingPlan(true)}
                  className="px-3 py-1.5 bg-terminal-bg text-terminal-dim border border-terminal-border 
                             rounded hover:text-terminal-text transition flex items-center gap-2 text-sm"
                >
                  <Edit2 className="w-4 h-4" />
                  Edit Plan
                </button>
              </>
            )}
          </div>
        </div>

        {/* Test Plan */}
        <div className="flex-1 overflow-y-auto p-3">
          {error && (
            <div className="p-3 bg-terminal-red/20 border border-terminal-red/50 rounded text-terminal-red text-sm mb-3">
              {error}
            </div>
          )}

          {!status?.hasQA ? (
            <div className="h-full flex items-center justify-center text-terminal-dim">
              <div className="text-center">
                <FlaskConical className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>QA not initialized for this workspace</p>
                <p className="text-sm mt-2">Click "Initialize QA" to set up testing</p>
              </div>
            </div>
          ) : status?.state?.sections ? (
            <div className="space-y-2">
              {Object.entries(status.state.sections).map(([sectionName, section]) => (
                <div 
                  key={sectionName}
                  className={`border rounded ${
                    section.status === 'running' ? 'border-terminal-green/50 bg-terminal-green/5' :
                    section.status === 'completed' ? 'border-terminal-border' :
                    'border-terminal-border'
                  }`}
                >
                  <button
                    onClick={() => toggleSection(sectionName)}
                    className="w-full p-2 flex items-center justify-between hover:bg-terminal-bg/50"
                  >
                    <div className="flex items-center gap-2">
                      {expandedSections.has(sectionName) ? (
                        <ChevronDown className="w-4 h-4 text-terminal-dim" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-terminal-dim" />
                      )}
                      <span className={`font-medium ${
                        section.status === 'running' ? 'text-terminal-green' :
                        section.status === 'completed' ? 'text-terminal-text' :
                        'text-terminal-dim'
                      }`}>
                        {sectionName}
                      </span>
                      {section.status === 'running' && (
                        <span className="text-xs text-terminal-green">● Testing</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-terminal-dim">
                      {Object.values(section.items).filter(s => s === 'passed').length}/
                      {Object.keys(section.items).length}
                    </div>
                  </button>
                  
                  {expandedSections.has(sectionName) && (
                    <div className="px-3 pb-2 space-y-1">
                      {Object.entries(section.items).map(([itemName, itemStatus]) => (
                        <div 
                          key={itemName}
                          className={`flex items-center gap-2 py-1 px-2 rounded text-sm ${
                            status.state?.currentItem === itemName && status.state?.currentSection === sectionName
                              ? 'bg-terminal-green/10'
                              : ''
                          }`}
                        >
                          {getStatusIcon(itemStatus)}
                          <span className={
                            itemStatus === 'passed' ? 'text-terminal-text' :
                            itemStatus === 'failed' ? 'text-terminal-red' :
                            'text-terminal-dim'
                          }>
                            {itemName}
                          </span>
                          {status.state?.currentItem === itemName && status.state?.currentSection === sectionName && (
                            <span className="text-xs text-terminal-green ml-auto">← Current</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center text-terminal-dim py-8">
              Loading test plan...
            </div>
          )}
        </div>

        {/* Footer Stats */}
        {status?.state && (
          <div className="p-3 border-t border-terminal-border flex items-center justify-between text-xs text-terminal-dim">
            <div className="flex items-center gap-4">
              {status.state.startedAt && (
                <span>Started: {new Date(status.state.startedAt).toLocaleTimeString()}</span>
              )}
              {status.state.completedAt && (
                <span>Completed: {new Date(status.state.completedAt).toLocaleTimeString()}</span>
              )}
            </div>
            <span>Workspace: {workspace.split(/[/\\]/).pop()}</span>
          </div>
        )}
      </div>

      {/* Sidebar - Issues & Sample Data */}
      <div className="w-80 space-y-4">
        {/* Issues Panel */}
        <div className="fusio-panel">
          <div className="p-3 border-b border-terminal-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bug className="w-4 h-4 text-terminal-red" />
              <h3 className="text-terminal-red font-bold text-sm">ISSUES</h3>
              {status?.issues && status.issues.length > 0 && (
                <span className="px-1.5 py-0.5 bg-terminal-red/20 text-terminal-red text-xs rounded">
                  {status.issues.length}
                </span>
              )}
            </div>
          </div>
          <div className="p-2 max-h-64 overflow-y-auto">
            {status?.issues && status.issues.length > 0 ? (
              <div className="space-y-2">
                {status.issues.map((issue) => (
                  <div key={issue.id} className="p-2 bg-terminal-bg rounded border border-terminal-border">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`px-1.5 py-0.5 text-xs rounded ${getSeverityColor(issue.severity)}`}>
                        {issue.severity}
                      </span>
                      <span className="text-xs text-terminal-dim">{issue.section}</span>
                    </div>
                    <div className="text-sm text-terminal-text">{issue.title}</div>
                    <div className="text-xs text-terminal-dim mt-1">{issue.description}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center text-terminal-dim text-sm py-4">
                No issues found yet
              </div>
            )}
          </div>
        </div>

        {/* Sample Data Panel */}
        {status?.state?.sampleData && Object.keys(status.state.sampleData).length > 0 && (
          <div className="fusio-panel">
            <div className="p-3 border-b border-terminal-border">
              <h3 className="text-terminal-cyan font-bold text-sm flex items-center gap-2">
                <FileText className="w-4 h-4" />
                SAMPLE DATA
              </h3>
            </div>
            <div className="p-2 max-h-48 overflow-y-auto">
              <div className="space-y-1 text-xs font-mono">
                {Object.entries(status.state.sampleData).map(([key, value]) => (
                  <div key={key} className="flex justify-between">
                    <span className="text-terminal-dim">{key}:</span>
                    <span className="text-terminal-text truncate ml-2">{String(value)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Instructions */}
        <div className="fusio-panel p-3">
          <h3 className="text-terminal-yellow font-bold text-sm mb-2">HOW TO USE</h3>
          <div className="text-xs text-terminal-dim space-y-1">
            <p>1. Click "Start Testing" to begin</p>
            <p>2. Tell the agent: <span className="text-terminal-cyan">/qa start</span></p>
            <p>3. Agent will test each item systematically</p>
            <p>4. Progress updates automatically</p>
            <p>5. Issues are logged as found</p>
          </div>
        </div>
      </div>

      {/* Setup Modal */}
      {(showSetup || editingPlan) && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="fusio-panel w-full max-w-3xl max-h-[90vh] flex flex-col">
            <div className="p-4 border-b border-terminal-border flex items-center justify-between">
              <h3 className="text-terminal-green font-bold">
                {editingPlan ? 'Edit Test Plan' : 'Initialize QA'}
              </h3>
              <button
                onClick={() => { setShowSetup(false); setEditingPlan(false); }}
                className="p-1 text-terminal-dim hover:text-terminal-text"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-4 flex-1 overflow-y-auto space-y-4">
              <div>
                <label className="text-terminal-dim text-xs block mb-1">TARGET URL</label>
                <input
                  type="text"
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  placeholder="https://staging-app.example.com"
                  className="w-full bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                             text-terminal-text focus:border-terminal-green outline-none"
                />
              </div>
              
              <div className="flex-1">
                <label className="text-terminal-dim text-xs block mb-1">TEST PLAN (Markdown)</label>
                <textarea
                  value={planText || DEFAULT_PLAN}
                  onChange={(e) => setPlanText(e.target.value)}
                  className="w-full h-96 bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                             text-terminal-text focus:border-terminal-green outline-none font-mono text-sm
                             resize-none"
                  placeholder="# Test Plan..."
                />
                <p className="text-xs text-terminal-dim mt-1">
                  Use ## for sections and - [ ] for test items
                </p>
              </div>
            </div>

            <div className="p-4 border-t border-terminal-border flex justify-end gap-2">
              <button
                onClick={() => { setShowSetup(false); setEditingPlan(false); }}
                className="px-4 py-2 text-terminal-dim hover:text-terminal-text"
              >
                Cancel
              </button>
              <button
                onClick={editingPlan ? handleSavePlan : handleInit}
                className="px-4 py-2 bg-terminal-green/20 text-terminal-green border border-terminal-green/50 
                           rounded hover:bg-terminal-green/30 transition flex items-center gap-2"
              >
                <Save className="w-4 h-4" />
                {editingPlan ? 'Save Changes' : 'Initialize'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
