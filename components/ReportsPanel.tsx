'use client';

import { useState, useEffect, useRef } from 'react';
import { 
  Bug, Sparkles, StickyNote, AlertTriangle, Clock, CheckCircle, 
  XCircle, Eye, ExternalLink, Trash2, ChevronDown, ChevronRight,
  RefreshCw, Filter, Inbox, Copy, MessageSquare, Check, Send
} from 'lucide-react';

interface Report {
  id: string;
  type: 'bug' | 'feature' | 'note';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  message: string;
  status: 'new' | 'reviewed' | 'in-progress' | 'resolved' | 'wont-fix';
  element: {
    selector: string;
    tagName: string;
    id: string | null;
    className: string | null;
    textContent: string | null;
    position: {
      top: number;
      left: number;
      width: number;
      height: number;
    };
  };
  page: {
    url: string;
    title: string;
    viewport: {
      width: number;
      height: number;
    };
  };
  timestamp: string;
  notes?: string[];
}

export default function ReportsPanel() {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  const [filter, setFilter] = useState<{
    type: string | null;
    status: string | null;
    priority: string | null;
  }>({ type: null, status: null, priority: null });
  const [showFilters, setShowFilters] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showAddToChat, setShowAddToChat] = useState(false);
  const [addedToChat, setAddedToChat] = useState(false);
  const addToChatRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (addToChatRef.current && !addToChatRef.current.contains(event.target as Node)) {
        setShowAddToChat(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Generate short numeric ID from report index
  const getShortId = (reportId: string): number => {
    const index = reports.findIndex(r => r.id === reportId);
    return index >= 0 ? reports.length - index : 0;
  };

  const formatReportForChat = (report: Report): string => {
    const shortId = getShortId(report.id);
    const typeEmoji = report.type === 'bug' ? '🐛' : report.type === 'feature' ? '✨' : '📝';
    const priorityLabel = report.priority.charAt(0).toUpperCase() + report.priority.slice(1);
    
    return `${typeEmoji} **Report #${shortId}** (${report.type} - ${priorityLabel} priority)

**Issue:** ${report.message || 'No message provided'}

**Page:** ${report.page.title}
**URL:** ${report.page.url}

**Element:** \`${report.element.selector}\`
- Tag: \`<${report.element.tagName}>\`${report.element.id ? `\n- ID: \`${report.element.id}\`` : ''}${report.element.className ? `\n- Class: \`${report.element.className}\`` : ''}${report.element.textContent ? `\n- Text: "${report.element.textContent.slice(0, 100)}"` : ''}

**Position:** ${Math.round(report.element.position.left)}x${Math.round(report.element.position.top)} (${Math.round(report.element.position.width)}×${Math.round(report.element.position.height)})
**Viewport:** ${report.page.viewport.width}×${report.page.viewport.height}
**Reported:** ${new Date(report.timestamp).toLocaleString()}`;
  };

  const copyReportForChat = async (report: Report) => {
    const formatted = formatReportForChat(report);
    await navigator.clipboard.writeText(formatted);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const addReportToChat = async (report: Report | 'newest') => {
    const targetReport = report === 'newest' ? reports[0] : report;
    if (!targetReport) return;
    
    const formatted = formatReportForChat(targetReport);
    await navigator.clipboard.writeText(formatted);
    setShowAddToChat(false);
    setAddedToChat(true);
    setTimeout(() => setAddedToChat(false), 2000);
  };

  const fetchReports = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter.type) params.set('type', filter.type);
      if (filter.status) params.set('status', filter.status);
      if (filter.priority) params.set('priority', filter.priority);
      
      const response = await fetch(`/api/reports?${params}`);
      const data = await response.json();
      
      if (data.reports) {
        setReports(data.reports);
      }
      setError(null);
    } catch (err) {
      setError('Failed to load reports');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports();
  }, [filter]);

  const updateStatus = async (id: string, status: Report['status']) => {
    try {
      const response = await fetch('/api/reports', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status })
      });
      
      if (response.ok) {
        setReports(reports.map(r => r.id === id ? { ...r, status } : r));
        if (selectedReport?.id === id) {
          setSelectedReport({ ...selectedReport, status });
        }
      }
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  };

  const deleteReport = async (id: string) => {
    if (!confirm('Delete this report?')) return;
    
    try {
      const response = await fetch(`/api/reports?id=${id}`, {
        method: 'DELETE'
      });
      
      if (response.ok) {
        setReports(reports.filter(r => r.id !== id));
        if (selectedReport?.id === id) {
          setSelectedReport(null);
        }
      }
    } catch (err) {
      console.error('Failed to delete report:', err);
    }
  };

  const getTypeIcon = (type: Report['type']) => {
    switch (type) {
      case 'bug': return <Bug className="w-4 h-4 text-terminal-red" />;
      case 'feature': return <Sparkles className="w-4 h-4 text-terminal-purple" />;
      case 'note': return <StickyNote className="w-4 h-4 text-terminal-amber" />;
    }
  };

  const getPriorityColor = (priority: Report['priority']) => {
    switch (priority) {
      case 'urgent': return 'text-terminal-red bg-terminal-red/10 border-terminal-red/30';
      case 'high': return 'text-terminal-amber bg-terminal-amber/10 border-terminal-amber/30';
      case 'medium': return 'text-terminal-amber bg-terminal-amber/10 border-terminal-amber/30';
      case 'low': return 'text-gray-400 bg-gray-400/10 border-gray-400/30';
    }
  };

  const getStatusIcon = (status: Report['status']) => {
    switch (status) {
      case 'new': return <Inbox className="w-3 h-3" />;
      case 'reviewed': return <Eye className="w-3 h-3" />;
      case 'in-progress': return <Clock className="w-3 h-3" />;
      case 'resolved': return <CheckCircle className="w-3 h-3" />;
      case 'wont-fix': return <XCircle className="w-3 h-3" />;
    }
  };

  const getStatusColor = (status: Report['status']) => {
    switch (status) {
      case 'new': return 'text-terminal-cyan';
      case 'reviewed': return 'text-cyan-400';
      case 'in-progress': return 'text-terminal-amber';
      case 'resolved': return 'text-terminal-green';
      case 'wont-fix': return 'text-gray-400';
    }
  };

  const formatDate = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    
    return date.toLocaleDateString();
  };

  const extractDomain = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };

  return (
    <div
      style={{
        height: '100%',
        display: 'flex', flexDirection: 'column',
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 12,
        overflow: 'hidden',
        fontFamily: 'var(--font-sans, system-ui)',
        color: 'var(--white, #fff)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 14,
          borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 24, height: 24, borderRadius: 6,
              background: 'rgba(204, 12, 32, 0.12)',
              border: '1px solid rgba(204, 12, 32, 0.35)',
            }}
          >
            <Bug style={{ width: 12, height: 12, color: 'var(--red, #CC0C20)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Monitor · Issues
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>
              UI reports
            </div>
          </div>
          <span
            style={{
              marginLeft: 6,
              padding: '2px 7px',
              borderRadius: 4,
              fontFamily: 'var(--font-mono, ui-monospace)',
              fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase',
              color: 'var(--mist, rgba(255,255,255,0.5))',
              background: 'var(--ink-2, #131319)',
              border: '1px solid var(--line, rgba(255,255,255,0.08))',
            }}
          >
            {reports.length} total
          </span>
        </div>
        
        <div className="flex items-center gap-2">
          {/* Add to Chat dropdown */}
          <div className="relative" ref={addToChatRef}>
            <button
              onClick={() => setShowAddToChat(!showAddToChat)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition ${
                addedToChat 
                  ? 'bg-terminal-green/20 text-terminal-green' 
                  : 'bg-terminal-cyan/10 text-terminal-cyan hover:bg-terminal-cyan/20 border border-terminal-cyan/30'
              }`}
            >
              {addedToChat ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Copied!
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  Add to Chat
                  <ChevronDown className="w-3 h-3" />
                </>
              )}
            </button>
            
            {showAddToChat && (
              <div className="absolute right-0 top-full mt-1 w-72 fusio-panel shadow-xl z-50 overflow-hidden">
                <div className="p-2 border-b border-terminal-border">
                  <div className="text-xs text-terminal-dim">Select a report to copy for chat</div>
                </div>
                
                {/* Newest option */}
                {reports.length > 0 && (
                  <button
                    onClick={() => addReportToChat('newest')}
                    className="w-full p-3 flex items-center gap-3 hover:bg-terminal-green/10 transition border-b border-terminal-border"
                  >
                    <div className="w-8 h-8 rounded-full bg-terminal-green/20 flex items-center justify-center">
                      <Sparkles className="w-4 h-4 text-terminal-green" />
                    </div>
                    <div className="text-left">
                      <div className="text-sm text-terminal-green font-medium">Add Newest</div>
                      <div className="text-xs text-terminal-dim">
                        #{getShortId(reports[0].id)} - {reports[0].message?.slice(0, 30) || 'No message'}...
                      </div>
                    </div>
                  </button>
                )}
                
                {/* Recent reports list */}
                <div className="max-h-64 overflow-y-auto">
                  {reports.length === 0 ? (
                    <div className="p-4 text-center text-terminal-dim text-sm">
                      No reports yet
                    </div>
                  ) : (
                    reports.slice(0, 10).map((report) => (
                      <button
                        key={report.id}
                        onClick={() => addReportToChat(report)}
                        className="w-full p-2.5 flex items-center gap-2.5 hover:bg-terminal-bg/50 transition text-left border-b border-terminal-border/50 last:border-0"
                      >
                        <div className="flex-shrink-0">
                          {getTypeIcon(report.type)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono text-terminal-cyan">#{getShortId(report.id)}</span>
                            <span className={`text-xs px-1 rounded ${getPriorityColor(report.priority)}`}>
                              {report.priority}
                            </span>
                          </div>
                          <div className="text-xs text-terminal-text truncate">
                            {report.message || 'No message'}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`p-2 rounded transition ${showFilters ? 'bg-terminal-green/20 text-terminal-green' : 'text-terminal-dim hover:text-terminal-text'}`}
          >
            <Filter className="w-4 h-4" />
          </button>
          <button
            onClick={fetchReports}
            className="p-2 text-terminal-dim hover:text-terminal-green transition"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="p-3 border-b border-terminal-border bg-terminal-bg/50 flex flex-wrap gap-2">
          <select
            value={filter.type || ''}
            onChange={(e) => setFilter({ ...filter, type: e.target.value || null })}
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-text"
          >
            <option value="">All Types</option>
            <option value="bug">🐛 Bugs</option>
            <option value="feature">✨ Features</option>
            <option value="note">📝 Notes</option>
          </select>
          
          <select
            value={filter.status || ''}
            onChange={(e) => setFilter({ ...filter, status: e.target.value || null })}
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-text"
          >
            <option value="">All Status</option>
            <option value="new">New</option>
            <option value="reviewed">Reviewed</option>
            <option value="in-progress">In Progress</option>
            <option value="resolved">Resolved</option>
            <option value="wont-fix">Won't Fix</option>
          </select>
          
          <select
            value={filter.priority || ''}
            onChange={(e) => setFilter({ ...filter, priority: e.target.value || null })}
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-text"
          >
            <option value="">All Priority</option>
            <option value="urgent">🔴 Urgent</option>
            <option value="high">🟠 High</option>
            <option value="medium">🟡 Medium</option>
            <option value="low">⚪ Low</option>
          </select>
          
          {(filter.type || filter.status || filter.priority) && (
            <button
              onClick={() => setFilter({ type: null, status: null, priority: null })}
              className="text-xs text-terminal-dim hover:text-terminal-text"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Reports List */}
        <div className={`${selectedReport ? 'w-1/2' : 'w-full'} overflow-y-auto border-r border-terminal-border`}>
          {loading && reports.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-terminal-dim">
              Loading reports...
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-32 text-terminal-red">
              {error}
            </div>
          ) : reports.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-terminal-dim">
              <Inbox className="w-8 h-8 mb-2 opacity-50" />
              <p>No reports yet</p>
              <p className="text-xs mt-1">Use the Rev Reporter extension to submit issues</p>
            </div>
          ) : (
            <div className="divide-y divide-terminal-border">
              {reports.map((report) => (
                <div
                  key={report.id}
                  onClick={() => setSelectedReport(report)}
                  className={`p-3 cursor-pointer hover:bg-terminal-bg/50 transition ${
                    selectedReport?.id === report.id ? 'bg-terminal-green/10 border-l-2 border-terminal-green' : ''
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-1">{getTypeIcon(report.type)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-mono text-terminal-cyan">
                          #{getShortId(report.id)}
                        </span>
                        <span className={`text-xs px-1.5 py-0.5 rounded border ${getPriorityColor(report.priority)}`}>
                          {report.priority}
                        </span>
                        <span className={`flex items-center gap-1 text-xs ${getStatusColor(report.status)}`}>
                          {getStatusIcon(report.status)}
                          {report.status}
                        </span>
                      </div>
                      <p className="text-sm text-terminal-text truncate">
                        {report.message || <span className="text-terminal-dim italic">No message</span>}
                      </p>
                      <div className="flex items-center gap-2 mt-1 text-xs text-terminal-dim">
                        <span>{extractDomain(report.page.url)}</span>
                        <span>•</span>
                        <span>{formatDate(report.timestamp)}</span>
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-terminal-dim" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Report Detail */}
        {selectedReport && (
          <div className="w-1/2 overflow-y-auto p-4">
            <div className="space-y-4">
              {/* Header */}
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  {getTypeIcon(selectedReport.type)}
                  <span className="text-terminal-cyan font-mono">
                    #{getShortId(selectedReport.id)}
                  </span>
                  <span className="text-terminal-green font-bold uppercase">
                    {selectedReport.type} Report
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => copyReportForChat(selectedReport)}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition ${
                      copied 
                        ? 'bg-terminal-green/20 text-terminal-green' 
                        : 'bg-terminal-bg text-terminal-dim hover:text-terminal-cyan border border-terminal-border'
                    }`}
                    title="Copy formatted report for chat"
                  >
                    {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {copied ? 'Copied!' : 'Copy for Rev'}
                  </button>
                  <button
                    onClick={() => deleteReport(selectedReport.id)}
                    className="p-1 text-terminal-dim hover:text-terminal-red transition"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Status & Priority */}
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={selectedReport.status}
                  onChange={(e) => updateStatus(selectedReport.id, e.target.value as Report['status'])}
                  className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-sm text-terminal-text"
                >
                  <option value="new">📥 New</option>
                  <option value="reviewed">👁 Reviewed</option>
                  <option value="in-progress">⏳ In Progress</option>
                  <option value="resolved">✅ Resolved</option>
                  <option value="wont-fix">❌ Won't Fix</option>
                </select>
                
                <span className={`text-xs px-2 py-1 rounded border ${getPriorityColor(selectedReport.priority)}`}>
                  {selectedReport.priority} priority
                </span>
              </div>

              {/* Message */}
              <div className="bg-terminal-bg rounded p-3 border border-terminal-border">
                <div className="text-xs text-terminal-dim mb-1">Message</div>
                <p className="text-terminal-text whitespace-pre-wrap">
                  {selectedReport.message || <span className="text-terminal-dim italic">No message provided</span>}
                </p>
              </div>

              {/* Page Info */}
              <div className="bg-terminal-bg rounded p-3 border border-terminal-border">
                <div className="text-xs text-terminal-dim mb-1">Page</div>
                <p className="text-terminal-cyan text-sm mb-1">{selectedReport.page.title}</p>
                <a
                  href={selectedReport.page.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-terminal-dim hover:text-terminal-cyan flex items-center gap-1 truncate"
                >
                  {selectedReport.page.url}
                  <ExternalLink className="w-3 h-3 flex-shrink-0" />
                </a>
              </div>

              {/* Element Info */}
              <div className="bg-terminal-bg rounded p-3 border border-terminal-border">
                <div className="text-xs text-terminal-dim mb-2">Selected Element</div>
                <code className="text-xs text-terminal-cyan bg-terminal-surface px-2 py-1 rounded block mb-2 overflow-x-auto">
                  {selectedReport.element.selector}
                </code>
                <div className="text-xs text-terminal-dim">
                  <span className="font-mono text-terminal-text">
                    &lt;{selectedReport.element.tagName}
                    {selectedReport.element.id && ` id="${selectedReport.element.id}"`}
                    {selectedReport.element.className && ` class="${selectedReport.element.className}"`}
                    &gt;
                  </span>
                </div>
                {selectedReport.element.textContent && (
                  <p className="text-xs text-terminal-dim mt-2 truncate">
                    Text: "{selectedReport.element.textContent.slice(0, 100)}"
                  </p>
                )}
              </div>

              {/* Metadata */}
              <div className="text-xs text-terminal-dim space-y-1">
                <p>Reported: {new Date(selectedReport.timestamp).toLocaleString()}</p>
                <p>Viewport: {selectedReport.page.viewport.width}x{selectedReport.page.viewport.height}</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
