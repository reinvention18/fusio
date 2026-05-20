'use client';

import { useState, useEffect } from 'react';
import { FlaskConical, Play, RefreshCw, CheckCircle, XCircle, Clock, Loader2, Eye } from 'lucide-react';

interface TestResult {
  name: string;
  status: 'pass' | 'fail' | 'pending' | 'running';
  duration?: number;
  error?: string;
}

interface TestSuite {
  file: string;
  tests: TestResult[];
  totalTime?: number;
}

export default function TestRunner() {
  const [suites, setSuites] = useState<TestSuite[]>([]);
  const [running, setRunning] = useState(false);
  const [watchMode, setWatchMode] = useState(false);
  const [expandedSuite, setExpandedSuite] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'failed'>('all');

  const runTests = async (type: 'all' | 'changed' = 'all') => {
    setRunning(true);
    setSuites([]);
    
    try {
      const response = await fetch('/api/test/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, watch: watchMode })
      });
      
      if (response.ok) {
        const data = await response.json();
        setSuites(data.suites || []);
      }
    } catch (e) {
      console.error('Test run failed:', e);
    }
    
    setRunning(false);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pass':
        return <CheckCircle className="w-4 h-4 text-terminal-green" />;
      case 'fail':
        return <XCircle className="w-4 h-4 text-terminal-red" />;
      case 'running':
        return <Loader2 className="w-4 h-4 text-terminal-amber animate-spin" />;
      default:
        return <Clock className="w-4 h-4 text-terminal-dim" />;
    }
  };

  const getSuiteStatus = (suite: TestSuite) => {
    if (suite.tests.some(t => t.status === 'running')) return 'running';
    if (suite.tests.some(t => t.status === 'fail')) return 'fail';
    if (suite.tests.every(t => t.status === 'pass')) return 'pass';
    return 'pending';
  };

  const totalTests = suites.reduce((acc, s) => acc + s.tests.length, 0);
  const passedTests = suites.reduce((acc, s) => acc + s.tests.filter(t => t.status === 'pass').length, 0);
  const failedTests = suites.reduce((acc, s) => acc + s.tests.filter(t => t.status === 'fail').length, 0);

  const filteredSuites = filter === 'failed' 
    ? suites.filter(s => s.tests.some(t => t.status === 'fail'))
    : suites;

  return (
    <div
      style={{
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 12,
        padding: 16,
        fontFamily: 'var(--font-sans, system-ui)',
        color: 'var(--white, #fff)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 24, height: 24, borderRadius: 6,
              background: 'rgba(232, 162, 59, 0.12)',
              border: '1px solid rgba(232, 162, 59, 0.35)',
            }}
          >
            <FlaskConical style={{ width: 12, height: 12, color: 'var(--amber, #E8A23B)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Dev · Verification
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 1 }}>
              Test runner
            </div>
          </div>
        </div>
        <button
          onClick={() => setWatchMode(!watchMode)}
          data-fusio
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '4px 10px',
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
            borderRadius: 5,
            background: watchMode ? 'rgba(76, 195, 138, 0.14)' : 'transparent',
            color: watchMode ? 'var(--green, #4CC38A)' : 'var(--mist, rgba(255,255,255,0.5))',
            border: `1px solid ${watchMode ? 'rgba(76, 195, 138, 0.35)' : 'var(--line, rgba(255,255,255,0.08))'}`,
            cursor: 'pointer',
            transition: 'all 120ms ease-out',
          }}
        >
          <Eye style={{ width: 10, height: 10 }} />
          Watch
        </button>
      </div>

      {/* Actions */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => runTests('all')}
          disabled={running}
          className="flex-1 px-3 py-2 bg-terminal-amber/20 text-terminal-amber border 
                     border-terminal-amber/50 rounded hover:bg-terminal-amber/30 transition
                     disabled:opacity-50 text-sm flex items-center justify-center gap-2"
        >
          {running ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <>
              <Play className="w-4 h-4" />
              Run All
            </>
          )}
        </button>
        <button
          onClick={() => runTests('changed')}
          disabled={running}
          className="flex-1 px-3 py-2 bg-terminal-cyan/20 text-terminal-cyan border 
                     border-terminal-cyan/50 rounded hover:bg-terminal-cyan/30 transition
                     disabled:opacity-50 text-sm flex items-center justify-center gap-2"
        >
          {running ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <>
              <RefreshCw className="w-4 h-4" />
              Changed
            </>
          )}
        </button>
      </div>

      {/* Summary */}
      {suites.length > 0 && (
        <div className="bg-terminal-bg rounded p-3 mb-4">
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-4">
              <span className="text-terminal-text">{totalTests} tests</span>
              <span className="text-terminal-green">✓ {passedTests}</span>
              {failedTests > 0 && (
                <span className="text-terminal-red">✗ {failedTests}</span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setFilter('all')}
                className={`px-2 py-0.5 text-xs rounded ${
                  filter === 'all' 
                    ? 'bg-terminal-text/20 text-terminal-text' 
                    : 'text-terminal-dim hover:text-terminal-text'
                }`}
              >
                All
              </button>
              <button
                onClick={() => setFilter('failed')}
                className={`px-2 py-0.5 text-xs rounded ${
                  filter === 'failed' 
                    ? 'bg-terminal-red/20 text-terminal-red' 
                    : 'text-terminal-dim hover:text-terminal-text'
                }`}
              >
                Failed
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Test Suites */}
      <div className="space-y-2 max-h-[400px] overflow-y-auto">
        {filteredSuites.map((suite) => (
          <div key={suite.file} className="bg-terminal-bg rounded overflow-hidden">
            <button
              onClick={() => setExpandedSuite(expandedSuite === suite.file ? null : suite.file)}
              className="w-full px-3 py-2 flex items-center justify-between hover:bg-terminal-surface/50 transition"
            >
              <div className="flex items-center gap-2">
                {getStatusIcon(getSuiteStatus(suite))}
                <span className="text-terminal-text text-sm font-mono truncate max-w-[200px]">
                  {suite.file.split('/').pop()}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-terminal-green">{suite.tests.filter(t => t.status === 'pass').length}</span>
                <span className="text-terminal-dim">/</span>
                <span className="text-terminal-text">{suite.tests.length}</span>
                {suite.totalTime && (
                  <span className="text-terminal-dim">({suite.totalTime}ms)</span>
                )}
              </div>
            </button>
            
            {expandedSuite === suite.file && (
              <div className="px-3 pb-3 border-t border-terminal-border/50">
                {suite.tests.map((test, i) => (
                  <div key={i} className="py-2 border-b border-terminal-border/30 last:border-0">
                    <div className="flex items-center gap-2">
                      {getStatusIcon(test.status)}
                      <span className={`text-xs ${
                        test.status === 'fail' ? 'text-terminal-red' : 'text-terminal-text'
                      }`}>
                        {test.name}
                      </span>
                      {test.duration && (
                        <span className="text-terminal-dim text-xs ml-auto">
                          {test.duration}ms
                        </span>
                      )}
                    </div>
                    {test.error && (
                      <div className="mt-2 p-2 bg-terminal-red/10 rounded text-terminal-red text-xs font-mono overflow-x-auto">
                        {test.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        
        {suites.length === 0 && !running && (
          <div className="text-center py-8 text-terminal-dim text-sm">
            Click "Run All" to execute tests
          </div>
        )}
        
        {running && suites.length === 0 && (
          <div className="flex items-center justify-center py-8 text-terminal-amber">
            <Loader2 className="w-6 h-6 animate-spin mr-2" />
            Running tests...
          </div>
        )}
      </div>
    </div>
  );
}
