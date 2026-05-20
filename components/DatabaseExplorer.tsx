'use client';

import { useState, useEffect } from 'react';
import { Database, Play, RefreshCw, Copy, Check, Table, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

interface TableInfo {
  name: string;
  rowCount: number;
  schema: string;
}

interface QueryResult {
  data: any[] | null;
  error: string | null;
  rowCount: number;
  duration: number;
}

const QUICK_QUERIES = [
  { name: 'Count Customers', query: "SELECT COUNT(*) as count FROM customers" },
  { name: 'Recent Invoices', query: "SELECT id, customer_id, total, status FROM invoices ORDER BY created_at DESC LIMIT 10" },
  { name: 'Active Companies', query: "SELECT id, name, subscription_tier FROM companies WHERE status = 'active'" },
  { name: 'User Profiles', query: "SELECT id, email, role, company_id FROM profiles LIMIT 20" },
  { name: 'Photo Stats', query: "SELECT company_id, COUNT(*) as photos FROM photo_uploads GROUP BY company_id" },
];

export default function DatabaseExplorer() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [query, setQuery] = useState('SELECT * FROM customers LIMIT 10');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingTables, setLoadingTables] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showTables, setShowTables] = useState(true);
  const [showQuickQueries, setShowQuickQueries] = useState(false);
  const [recentQueries, setRecentQueries] = useState<string[]>([]);

  useEffect(() => {
    fetchTables();
    
    // Load recent queries from localStorage
    const saved = localStorage.getItem('db-recent-queries');
    if (saved) {
      setRecentQueries(JSON.parse(saved));
    }
  }, []);

  const fetchTables = async () => {
    setLoadingTables(true);
    try {
      const response = await fetch('/api/database/tables');
      if (response.ok) {
        const data = await response.json();
        setTables(data.tables || []);
      }
    } catch (e) {
      console.error('Failed to fetch tables:', e);
    }
    setLoadingTables(false);
  };

  const executeQuery = async () => {
    if (!query.trim()) return;
    
    setLoading(true);
    setResult(null);

    try {
      const response = await fetch('/api/database/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });

      const data = await response.json();
      setResult(data);

      // Save to recent queries
      if (!data.error) {
        const updated = [query, ...recentQueries.filter(q => q !== query)].slice(0, 10);
        setRecentQueries(updated);
        localStorage.setItem('db-recent-queries', JSON.stringify(updated));
      }
    } catch (e: any) {
      setResult({
        data: null,
        error: e.message,
        rowCount: 0,
        duration: 0
      });
    }

    setLoading(false);
  };

  const copyResults = () => {
    if (!result?.data) return;
    navigator.clipboard.writeText(JSON.stringify(result.data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const selectTable = (tableName: string) => {
    setQuery(`SELECT * FROM ${tableName} LIMIT 20`);
  };

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
              background: 'rgba(76, 195, 138, 0.12)',
              border: '1px solid rgba(76, 195, 138, 0.35)',
            }}
          >
            <Database style={{ width: 12, height: 12, color: 'var(--green, #4CC38A)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Dev · Data
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 1 }}>
              Database explorer
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => setShowQuickQueries(!showQuickQueries)}
            data-fusio
            style={{
              padding: '4px 10px',
              fontFamily: 'var(--font-mono, ui-monospace)',
              fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
              borderRadius: 5,
              background: showQuickQueries ? 'rgba(94, 196, 217, 0.14)' : 'transparent',
              color: showQuickQueries ? 'var(--cyan, #5EC4D9)' : 'var(--mist, rgba(255,255,255,0.5))',
              border: `1px solid ${showQuickQueries ? 'rgba(94, 196, 217, 0.35)' : 'var(--line, rgba(255,255,255,0.08))'}`,
              cursor: 'pointer',
              transition: 'all 120ms ease-out',
            }}
          >
            Quick queries
          </button>
          <button
            onClick={fetchTables}
            disabled={loadingTables}
            data-fusio
            title="Refresh tables"
            style={{
              padding: 6, borderRadius: 5, background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--mist, rgba(255,255,255,0.5))',
              opacity: loadingTables ? 0.5 : 1,
              transition: 'all 120ms ease-out',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(76, 195, 138, 0.12)'; (e.currentTarget as HTMLElement).style.color = 'var(--green, #4CC38A)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
          >
            <RefreshCw style={{ width: 13, height: 13, animation: loadingTables ? 'spin 1s linear infinite' : undefined }} />
          </button>
        </div>
      </div>

      {/* Quick Queries */}
      {showQuickQueries && (
        <div className="mb-3 bg-terminal-bg rounded p-2">
          <div className="text-terminal-dim text-xs mb-2">Quick Queries</div>
          <div className="flex flex-wrap gap-2">
            {QUICK_QUERIES.map((q, i) => (
              <button
                key={i}
                onClick={() => { setQuery(q.query); setShowQuickQueries(false); }}
                className="px-2 py-1 text-xs bg-terminal-surface text-terminal-cyan 
                           border border-terminal-border rounded hover:border-terminal-cyan transition"
              >
                {q.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-12 gap-4">
        {/* Tables List */}
        <div className="col-span-4">
          <div 
            className="flex items-center gap-1 text-terminal-dim text-xs mb-2 cursor-pointer"
            onClick={() => setShowTables(!showTables)}
          >
            {showTables ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Tables ({tables.length})
          </div>
          
          {showTables && (
            <div className="bg-terminal-bg rounded p-2 max-h-60 overflow-y-auto space-y-0.5">
              {loadingTables ? (
                <div className="flex items-center justify-center py-4 text-terminal-dim">
                  <Loader2 className="w-4 h-4 animate-spin" />
                </div>
              ) : tables.length > 0 ? (
                tables.map((table) => (
                  <button
                    key={table.name}
                    onClick={() => selectTable(table.name)}
                    className="w-full text-left px-2 py-1 hover:bg-terminal-surface/50 rounded 
                               flex items-center justify-between group"
                  >
                    <div className="flex items-center gap-2">
                      <Table className="w-3 h-3 text-terminal-dim" />
                      <span className="text-terminal-text text-xs font-mono truncate max-w-[100px]">
                        {table.name}
                      </span>
                    </div>
                    <span className="text-terminal-dim text-xs opacity-0 group-hover:opacity-100">
                      {table.rowCount}
                    </span>
                  </button>
                ))
              ) : (
                <div className="text-terminal-dim text-xs text-center py-4">
                  No tables found
                </div>
              )}
            </div>
          )}
        </div>

        {/* Query Editor */}
        <div className="col-span-8">
          <div className="text-terminal-dim text-xs mb-1">SQL Query</div>
          <div className="relative">
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  executeQuery();
                }
              }}
              placeholder="SELECT * FROM table LIMIT 10"
              className="w-full h-24 bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                         text-terminal-text text-sm focus:border-terminal-green outline-none font-mono resize-none"
            />
            <button
              onClick={executeQuery}
              disabled={loading || !query.trim()}
              className="absolute bottom-2 right-2 px-3 py-1 bg-terminal-green/20 text-terminal-green 
                         border border-terminal-green/50 rounded hover:bg-terminal-green/30 transition
                         disabled:opacity-50 text-sm flex items-center gap-1"
            >
              {loading ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <>
                  <Play className="w-3 h-3" />
                  Run
                </>
              )}
            </button>
          </div>
          <div className="text-terminal-dim text-xs mt-1">
            Ctrl+Enter to execute
          </div>
        </div>
      </div>

      {/* Results */}
      {result && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3 text-sm">
              {result.error ? (
                <span className="text-terminal-red">Error</span>
              ) : (
                <>
                  <span className="text-terminal-green">{result.rowCount} rows</span>
                  <span className="text-terminal-dim">{result.duration}ms</span>
                </>
              )}
            </div>
            {!result.error && result.data && (
              <button
                onClick={copyResults}
                className="p-1 text-terminal-dim hover:text-terminal-text transition"
                title="Copy as JSON"
              >
                {copied ? <Check className="w-4 h-4 text-terminal-green" /> : <Copy className="w-4 h-4" />}
              </button>
            )}
          </div>

          {result.error ? (
            <div className="bg-terminal-red/10 border border-terminal-red/30 rounded p-3 text-terminal-red text-sm font-mono">
              {result.error}
            </div>
          ) : result.data && result.data.length > 0 ? (
            <div className="bg-terminal-bg rounded overflow-x-auto max-h-60 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-terminal-surface sticky top-0">
                  <tr>
                    {Object.keys(result.data[0]).map((key) => (
                      <th key={key} className="text-left px-3 py-2 text-terminal-cyan font-mono font-normal">
                        {key}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.data.map((row, i) => (
                    <tr key={i} className="border-t border-terminal-border/30 hover:bg-terminal-surface/30">
                      {Object.values(row).map((val: any, j) => (
                        <td key={j} className="px-3 py-1.5 text-terminal-text font-mono truncate max-w-[150px]">
                          {val === null ? (
                            <span className="text-terminal-dim italic">null</span>
                          ) : typeof val === 'object' ? (
                            JSON.stringify(val)
                          ) : (
                            String(val)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="bg-terminal-bg rounded p-4 text-terminal-dim text-sm text-center">
              No results
            </div>
          )}
        </div>
      )}
    </div>
  );
}
