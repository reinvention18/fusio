'use client';

import { useState, useEffect } from 'react';
import { Zap, Send, Clock, Copy, Check, ChevronDown, Star, StarOff } from 'lucide-react';

interface ApiRoute {
  path: string;
  method: string;
  description?: string;
}

interface SavedRequest {
  id: string;
  name: string;
  method: string;
  path: string;
  body?: string;
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-terminal-green',
  POST: 'text-terminal-cyan',
  PUT: 'text-terminal-amber',
  DELETE: 'text-terminal-red',
  PATCH: 'text-terminal-purple'
};

export default function ApiTester() {
  const [routes, setRoutes] = useState<ApiRoute[]>([]);
  const [savedRequests, setSavedRequests] = useState<SavedRequest[]>([]);
  const [method, setMethod] = useState('GET');
  const [path, setPath] = useState('/api/');
  const [body, setBody] = useState('');
  const [response, setResponse] = useState<any>(null);
  const [responseTime, setResponseTime] = useState<number | null>(null);
  const [responseStatus, setResponseStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showRoutes, setShowRoutes] = useState(false);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    // Load saved requests from localStorage
    const saved = localStorage.getItem('api-tester-saved');
    if (saved) {
      setSavedRequests(JSON.parse(saved));
    }

    // Load API routes
    fetch('/api/routes')
      .then(r => r.json())
      .then(data => setRoutes(data.routes || []))
      .catch(() => {});
  }, []);

  const sendRequest = async () => {
    setLoading(true);
    setResponse(null);
    setResponseTime(null);
    setResponseStatus(null);

    const startTime = Date.now();

    try {
      const options: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' }
      };

      if (['POST', 'PUT', 'PATCH'].includes(method) && body) {
        options.body = body;
      }

      const res = await fetch(path.startsWith('http') ? path : path, options);
      const endTime = Date.now();
      
      setResponseTime(endTime - startTime);
      setResponseStatus(res.status);

      const contentType = res.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        const data = await res.json();
        setResponse(data);
      } else {
        const text = await res.text();
        setResponse(text);
      }
    } catch (e: any) {
      setResponse({ error: e.message });
      setResponseStatus(0);
    }

    setLoading(false);
  };

  const saveRequest = () => {
    const name = prompt('Name this request:');
    if (!name) return;

    const newRequest: SavedRequest = {
      id: Date.now().toString(),
      name,
      method,
      path,
      body: body || undefined
    };

    const updated = [...savedRequests, newRequest];
    setSavedRequests(updated);
    localStorage.setItem('api-tester-saved', JSON.stringify(updated));
  };

  const loadRequest = (req: SavedRequest) => {
    setMethod(req.method);
    setPath(req.path);
    setBody(req.body || '');
    setShowSaved(false);
  };

  const deleteRequest = (id: string) => {
    const updated = savedRequests.filter(r => r.id !== id);
    setSavedRequests(updated);
    localStorage.setItem('api-tester-saved', JSON.stringify(updated));
  };

  const copyResponse = () => {
    navigator.clipboard.writeText(JSON.stringify(response, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const selectRoute = (route: ApiRoute) => {
    setPath(route.path);
    setMethod(route.method);
    setShowRoutes(false);
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
              background: 'rgba(94, 196, 217, 0.12)',
              border: '1px solid rgba(94, 196, 217, 0.35)',
            }}
          >
            <Zap style={{ width: 12, height: 12, color: 'var(--cyan, #5EC4D9)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Dev · Endpoints
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 1 }}>
              API tester
            </div>
          </div>
        </div>
        <button
          onClick={() => setShowSaved(!showSaved)}
          data-fusio
          title="Saved requests"
          style={{
            padding: 6, borderRadius: 5, background: showSaved ? 'rgba(232, 162, 59, 0.14)' : 'transparent',
            color: showSaved ? 'var(--amber, #E8A23B)' : 'var(--mist, rgba(255,255,255,0.5))',
            border: 'none', cursor: 'pointer',
            transition: 'all 120ms ease-out',
          }}
          onMouseEnter={e => { if (!showSaved) { (e.currentTarget as HTMLElement).style.background = 'rgba(232, 162, 59, 0.12)'; (e.currentTarget as HTMLElement).style.color = 'var(--amber, #E8A23B)'; } }}
          onMouseLeave={e => { if (!showSaved) { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; } }}
        >
          <Star style={{ width: 14, height: 14 }} />
        </button>
      </div>

      {/* Saved Requests Dropdown */}
      {showSaved && savedRequests.length > 0 && (
        <div className="mb-3 bg-terminal-bg rounded p-2 max-h-40 overflow-y-auto">
          {savedRequests.map(req => (
            <div 
              key={req.id}
              className="flex items-center justify-between py-1 px-2 hover:bg-terminal-surface/50 rounded cursor-pointer"
              onClick={() => loadRequest(req)}
            >
              <div className="flex items-center gap-2">
                <span className={`text-xs font-mono ${METHOD_COLORS[req.method]}`}>{req.method}</span>
                <span className="text-terminal-text text-sm">{req.name}</span>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); deleteRequest(req.id); }}
                className="text-terminal-red/50 hover:text-terminal-red"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Request Builder */}
      <div className="space-y-3">
        <div className="flex gap-2">
          {/* Method Selector */}
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className={`bg-terminal-bg border border-terminal-border rounded px-2 py-2 
                       text-sm font-mono font-bold ${METHOD_COLORS[method]} focus:outline-none`}
          >
            {METHODS.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>

          {/* Path Input */}
          <div className="flex-1 relative">
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendRequest()}
              placeholder="/api/endpoint"
              className="w-full bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                         text-terminal-text text-sm focus:border-terminal-cyan outline-none font-mono"
            />
            <button
              onClick={() => setShowRoutes(!showRoutes)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-terminal-dim hover:text-terminal-text"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>

          {/* Send Button */}
          <button
            onClick={sendRequest}
            disabled={loading}
            className="px-4 py-2 bg-terminal-cyan/20 text-terminal-cyan border 
                       border-terminal-cyan/50 rounded hover:bg-terminal-cyan/30 transition
                       disabled:opacity-50"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>

        {/* Routes Dropdown */}
        {showRoutes && routes.length > 0 && (
          <div className="bg-terminal-bg rounded p-2 max-h-40 overflow-y-auto">
            {routes.map((route, i) => (
              <button
                key={i}
                onClick={() => selectRoute(route)}
                className="w-full text-left px-2 py-1 hover:bg-terminal-surface/50 rounded flex items-center gap-2"
              >
                <span className={`text-xs font-mono ${METHOD_COLORS[route.method]}`}>{route.method}</span>
                <span className="text-terminal-text text-sm font-mono">{route.path}</span>
              </button>
            ))}
          </div>
        )}

        {/* Body Editor (for POST/PUT/PATCH) */}
        {['POST', 'PUT', 'PATCH'].includes(method) && (
          <div>
            <div className="text-terminal-dim text-xs mb-1">Request Body (JSON)</div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder='{"key": "value"}'
              className="w-full h-24 bg-terminal-bg border border-terminal-border rounded px-3 py-2 
                         text-terminal-text text-sm focus:border-terminal-cyan outline-none font-mono resize-none"
            />
          </div>
        )}
      </div>

      {/* Response */}
      {response !== null && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3 text-sm">
              <span className={`font-bold ${
                responseStatus && responseStatus < 300 ? 'text-terminal-green' : 
                responseStatus && responseStatus < 400 ? 'text-terminal-amber' : 'text-terminal-red'
              }`}>
                {responseStatus}
              </span>
              {responseTime && (
                <span className="text-terminal-dim flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {responseTime}ms
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={saveRequest}
                className="p-1 text-terminal-dim hover:text-terminal-amber transition"
                title="Save request"
              >
                <Star className="w-4 h-4" />
              </button>
              <button
                onClick={copyResponse}
                className="p-1 text-terminal-dim hover:text-terminal-text transition"
                title="Copy response"
              >
                {copied ? <Check className="w-4 h-4 text-terminal-green" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <pre className="bg-terminal-bg rounded p-3 text-xs text-terminal-text font-mono 
                          overflow-x-auto max-h-60 overflow-y-auto">
            {typeof response === 'string' ? response : JSON.stringify(response, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
