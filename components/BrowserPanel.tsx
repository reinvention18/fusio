'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Globe,
  Camera,
  Eye,
  Play,
  Square,
  RefreshCw,
  ExternalLink,
  Monitor,
} from 'lucide-react';

type ViewMode = 'screenshot' | 'snapshot' | 'tabs';

interface BrowserTab {
  title: string;
  url: string;
  active?: boolean;
}

interface ScreenshotData {
  imageData: string;
  timestamp: string;
}

export default function BrowserPanel() {
  const [status, setStatus] = useState<'running' | 'stopped' | 'unknown'>('unknown');
  const [viewMode, setViewMode] = useState<ViewMode>('screenshot');
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState<ScreenshotData | null>(null);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [actionLabel, setActionLabel] = useState<string | null>(null);

  const callBrowserApi = useCallback(
    async (action: string, params: Record<string, string> = {}) => {
      setLoading(true);
      setError(null);
      setActionLabel(action.toUpperCase());
      try {
        const res = await fetch('/api/browser', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, params }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        return data;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setError(msg);
        return null;
      } finally {
        setLoading(false);
        setTimeout(() => setActionLabel(null), 1500);
      }
    },
    []
  );

  // Parse status from response content
  const parseStatus = useCallback((content: string): 'running' | 'stopped' => {
    const lower = content.toLowerCase();
    if (
      lower.includes('running') ||
      lower.includes('started') ||
      lower.includes('connected') ||
      lower.includes('active')
    ) {
      return 'running';
    }
    return 'stopped';
  }, []);

  // Parse tabs from response content
  const parseTabs = useCallback((content: string): BrowserTab[] => {
    const tabList: BrowserTab[] = [];
    // Try to find URLs and titles in the response
    const lines = content.split('\n');
    for (const line of lines) {
      const urlMatch = line.match(/(https?:\/\/[^\s"'<>]+)/);
      if (urlMatch) {
        // Extract title: text before URL or use URL
        const titlePart = line.replace(urlMatch[0], '').replace(/[-–—|:•*#\[\]()]/g, '').trim();
        tabList.push({
          title: titlePart || urlMatch[0],
          url: urlMatch[0],
          active: line.toLowerCase().includes('active') || line.includes('*'),
        });
      }
    }
    return tabList;
  }, []);

  // Check status on mount
  useEffect(() => {
    const checkStatus = async () => {
      const data = await callBrowserApi('status');
      if (data?.content) {
        setStatus(parseStatus(data.content));
      }
    };
    checkStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStart = async () => {
    const data = await callBrowserApi('start');
    if (data) setStatus('running');
  };

  const handleStop = async () => {
    const data = await callBrowserApi('stop');
    if (data) setStatus('stopped');
  };

  const handleNavigate = async () => {
    if (!url.trim()) return;
    const target = url.startsWith('http') ? url : `https://${url}`;
    const data = await callBrowserApi('navigate', { url: target });
    if (data) {
      setStatus('running');
    }
  };

  const handleScreenshot = async () => {
    const data = await callBrowserApi('screenshot');
    if (data) {
      setStatus('running');
      if (data.imageData) {
        setScreenshot({ imageData: data.imageData, timestamp: data.timestamp });
      } else {
        // No image data returned, show content
        setSnapshot(data.content);
        setViewMode('snapshot');
      }
      setViewMode('screenshot');
    }
  };

  const handleSnapshot = async () => {
    const data = await callBrowserApi('snapshot');
    if (data) {
      setStatus('running');
      setSnapshot(data.content);
      setViewMode('snapshot');
    }
  };

  const handleTabs = async () => {
    const data = await callBrowserApi('tabs');
    if (data) {
      setStatus('running');
      setTabs(parseTabs(data.content));
      if (tabs.length === 0 && data.content) {
        // If no tabs parsed, store raw content as snapshot fallback
        setSnapshot(data.content);
      }
      setViewMode('tabs');
    }
  };

  const handleRefresh = async () => {
    const data = await callBrowserApi('status');
    if (data?.content) {
      setStatus(parseStatus(data.content));
    }
  };

  // Syntax-highlight the snapshot tree
  const renderSnapshot = (text: string) => {
    return text.split('\n').map((line, i) => {
      // Highlight role names (e.g., "heading", "link", "button", etc.)
      const highlighted = line
        .replace(
          /\b(heading|link|button|textbox|img|navigation|main|banner|contentinfo|complementary|list|listitem|group|region|dialog|alert|tab|tabpanel|tablist|menuitem|menu|menubar|checkbox|radio|slider|switch|separator|toolbar|tree|treeitem|row|cell|columnheader|rowheader|grid|gridcell|article|figure|form|search|status|timer|tooltip|generic|paragraph|text|document|application|log|marquee|math|note|progressbar|scrollbar|spinbutton|table)\b/gi,
          '<span class="text-terminal-cyan font-bold">$1</span>'
        )
        .replace(
          /"([^"]+)"/g,
          '"<span class="text-terminal-green">$1</span>"'
        );
      return (
        <div
          key={i}
          className="hover:bg-terminal-border/20 px-1"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      );
    });
  };

  const statusColor =
    status === 'running'
      ? 'text-terminal-green'
      : status === 'stopped'
        ? 'text-terminal-red'
        : 'text-terminal-amber';

  const statusDot =
    status === 'running'
      ? 'bg-terminal-green'
      : status === 'stopped'
        ? 'bg-terminal-red'
        : 'bg-terminal-amber';

  // Fusio status tokens
  const statusHex = status === 'running' ? '#4CC38A' :
                    status === 'stopped' ? '#7d7d8a' :
                    '#E8A23B'; // unknown (or any other)

  return (
    <div
      style={{
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 12,
        padding: 14,
        display: 'flex', flexDirection: 'column',
        height: '100%',
        fontFamily: 'var(--font-sans, system-ui)',
        color: 'var(--white, #fff)',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 22, borderRadius: 5,
              background: 'rgba(94, 196, 217, 0.12)',
              border: '1px solid rgba(94, 196, 217, 0.35)',
            }}
          >
            <Monitor style={{ width: 11, height: 11, color: 'var(--cyan, #5EC4D9)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Tools · Headless
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 1 }}>
              Browser
            </div>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 6 }}>
            <span
              style={{
                width: 7, height: 7, borderRadius: '50%',
                background: statusHex,
                boxShadow: `0 0 8px ${statusHex}`,
                animation: status === 'running' ? 'fusio-pulse 1.6s ease-in-out infinite' : undefined,
              }}
            />
            <span style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: statusHex }}>
              {status}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={handleRefresh}
            disabled={loading}
            data-fusio
            title="Refresh status"
            style={{
              padding: 6, borderRadius: 5, background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--mist, rgba(255,255,255,0.5))',
              opacity: loading ? 0.5 : 1,
              transition: 'all 120ms ease-out',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(94, 196, 217, 0.12)'; (e.currentTarget as HTMLElement).style.color = 'var(--cyan, #5EC4D9)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
          >
            <RefreshCw style={{ width: 12, height: 12, animation: loading ? 'spin 1s linear infinite' : undefined }} />
          </button>
          {status === 'running' ? (
            <button
              onClick={handleStop}
              disabled={loading}
              data-fusio
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '4px 10px',
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
                borderRadius: 5,
                background: 'rgba(204, 12, 32, 0.1)',
                color: 'var(--red, #CC0C20)',
                border: '1px solid rgba(204, 12, 32, 0.35)',
                cursor: 'pointer',
                opacity: loading ? 0.5 : 1,
                transition: 'background 120ms ease-out',
              }}
            >
              <Square style={{ width: 10, height: 10 }} />
              Stop
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={loading}
              data-fusio
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '4px 10px',
                fontFamily: 'var(--font-mono, ui-monospace)',
                fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
                borderRadius: 5,
                background: 'rgba(76, 195, 138, 0.1)',
                color: 'var(--green, #4CC38A)',
                border: '1px solid rgba(76, 195, 138, 0.35)',
                cursor: 'pointer',
                opacity: loading ? 0.5 : 1,
                transition: 'background 120ms ease-out',
              }}
            >
              <Play style={{ width: 10, height: 10 }} />
              Start
            </button>
          )}
        </div>
      </div>

      {/* URL Bar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <div
          style={{
            flex: 1,
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'var(--ink-3, #1B1B23)',
            border: '1px solid var(--line, rgba(255,255,255,0.08))',
            borderRadius: 6, padding: '0 10px',
          }}
        >
          <Globe style={{ width: 12, height: 12, color: 'var(--mist, rgba(255,255,255,0.5))', flexShrink: 0 }} />
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleNavigate()}
            placeholder="Enter URL…"
            data-fusio
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none', outline: 'none',
              padding: '6px 0',
              fontSize: 12.5,
              color: 'var(--white, #fff)',
              fontFamily: 'var(--font-mono, ui-monospace)',
            }}
          />
        </div>
        <button
          onClick={handleNavigate}
          disabled={loading || !url.trim()}
          className="card-btn primary"
          data-fusio
          style={{
            fontSize: 11,
            padding: '6px 14px',
            background: 'var(--cyan, #5EC4D9)',
            borderColor: 'var(--cyan, #5EC4D9)',
            color: '#06181d',
            opacity: (loading || !url.trim()) ? 0.5 : 1,
            cursor: (loading || !url.trim()) ? 'not-allowed' : 'pointer',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            fontFamily: 'var(--font-mono, ui-monospace)',
          }}
        >
          Go
        </button>
      </div>

      {/* Action Toolbar */}
      <div className="flex gap-1.5 mb-3">
        <button
          onClick={handleScreenshot}
          disabled={loading}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition disabled:opacity-50 ${
            viewMode === 'screenshot'
              ? 'bg-terminal-cyan/20 text-terminal-cyan border border-terminal-cyan/40'
              : 'text-terminal-dim border border-terminal-border hover:text-terminal-text hover:border-terminal-dim'
          }`}
        >
          <Camera className="w-3 h-3" />
          Screenshot
        </button>
        <button
          onClick={handleSnapshot}
          disabled={loading}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition disabled:opacity-50 ${
            viewMode === 'snapshot'
              ? 'bg-terminal-cyan/20 text-terminal-cyan border border-terminal-cyan/40'
              : 'text-terminal-dim border border-terminal-border hover:text-terminal-text hover:border-terminal-dim'
          }`}
        >
          <Eye className="w-3 h-3" />
          Snapshot
        </button>
        <button
          onClick={handleTabs}
          disabled={loading}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition disabled:opacity-50 ${
            viewMode === 'tabs'
              ? 'bg-terminal-cyan/20 text-terminal-cyan border border-terminal-cyan/40'
              : 'text-terminal-dim border border-terminal-border hover:text-terminal-text hover:border-terminal-dim'
          }`}
        >
          <ExternalLink className="w-3 h-3" />
          Tabs
        </button>
      </div>

      {/* Error Display */}
      {error && (
        <div className="mb-3 px-3 py-2 bg-terminal-red/10 border border-terminal-red/30 rounded text-terminal-red text-xs font-mono">
          ✗ {error}
        </div>
      )}

      {/* Loading Indicator */}
      {loading && (
        <div className="mb-3 flex items-center gap-2 text-terminal-amber text-xs">
          <RefreshCw className="w-3 h-3 animate-spin" />
          <span>{actionLabel ? `Running ${actionLabel}...` : 'Loading...'}</span>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-h-0 bg-terminal-bg border border-terminal-border rounded overflow-hidden">
        {viewMode === 'screenshot' && (
          <div className="h-full flex flex-col">
            {screenshot ? (
              <>
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-terminal-border">
                  <span className="text-xs text-terminal-dim">
                    Captured: {new Date(screenshot.timestamp).toLocaleTimeString()}
                  </span>
                  <button
                    onClick={handleScreenshot}
                    disabled={loading}
                    className="text-xs text-terminal-cyan hover:underline disabled:opacity-50"
                  >
                    Retake
                  </button>
                </div>
                <div className="flex-1 overflow-auto p-2 flex items-center justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={screenshot.imageData}
                    alt="Browser screenshot"
                    className="max-w-full max-h-full object-contain rounded border border-terminal-border/50"
                  />
                </div>
              </>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-terminal-dim gap-3 p-8">
                <Camera className="w-8 h-8 opacity-30" />
                <p className="text-sm text-center">No screenshot yet</p>
                <p className="text-xs text-center opacity-60">
                  Click &quot;Screenshot&quot; to capture the browser view
                </p>
              </div>
            )}
          </div>
        )}

        {viewMode === 'snapshot' && (
          <div className="h-full flex flex-col">
            {snapshot ? (
              <>
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-terminal-border">
                  <span className="text-xs text-terminal-dim">Accessibility Tree</span>
                  <button
                    onClick={handleSnapshot}
                    disabled={loading}
                    className="text-xs text-terminal-cyan hover:underline disabled:opacity-50"
                  >
                    Refresh
                  </button>
                </div>
                <div className="flex-1 overflow-auto p-2">
                  <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap text-terminal-text">
                    {renderSnapshot(snapshot)}
                  </pre>
                </div>
              </>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-terminal-dim gap-3 p-8">
                <Eye className="w-8 h-8 opacity-30" />
                <p className="text-sm text-center">No snapshot yet</p>
                <p className="text-xs text-center opacity-60">
                  Click &quot;Snapshot&quot; to capture the accessibility tree
                </p>
              </div>
            )}
          </div>
        )}

        {viewMode === 'tabs' && (
          <div className="h-full flex flex-col">
            {tabs.length > 0 ? (
              <>
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-terminal-border">
                  <span className="text-xs text-terminal-dim">{tabs.length} tab{tabs.length !== 1 ? 's' : ''} open</span>
                  <button
                    onClick={handleTabs}
                    disabled={loading}
                    className="text-xs text-terminal-cyan hover:underline disabled:opacity-50"
                  >
                    Refresh
                  </button>
                </div>
                <div className="flex-1 overflow-auto">
                  {tabs.map((tab, i) => (
                    <div
                      key={i}
                      className={`flex items-center gap-2 px-3 py-2 border-b border-terminal-border/50 
                                  hover:bg-terminal-surface/50 transition ${
                        tab.active ? 'bg-terminal-cyan/5' : ''
                      }`}
                    >
                      <Globe className="w-3.5 h-3.5 text-terminal-dim flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-terminal-text truncate">
                          {tab.active && <span className="text-terminal-cyan mr-1">●</span>}
                          {tab.title}
                        </div>
                        <div className="text-[10px] text-terminal-dim truncate">{tab.url}</div>
                      </div>
                      <button
                        onClick={() => {
                          setUrl(tab.url);
                        }}
                        className="text-terminal-dim hover:text-terminal-cyan transition p-1"
                        title="Load URL"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-terminal-dim gap-3 p-8">
                <ExternalLink className="w-8 h-8 opacity-30" />
                <p className="text-sm text-center">No tabs loaded</p>
                <p className="text-xs text-center opacity-60">
                  Click &quot;Tabs&quot; to list open browser tabs
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
