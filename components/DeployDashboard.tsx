'use client';

import { useState, useEffect } from 'react';
import { Rocket, RefreshCw, CheckCircle, XCircle, Clock, Loader2, ExternalLink, Smartphone, Globe, AlertTriangle } from 'lucide-react';

interface Deployment {
  id: string;
  name: string;
  url: string;
  state: 'READY' | 'BUILDING' | 'ERROR' | 'QUEUED' | 'CANCELED' | string;
  createdAt: string;
  target: 'production' | 'preview';
  branch?: string;
}

interface DeployData {
  saas: {
    production: Deployment[];
    staging: Deployment[];
  };
  app: {
    production: Deployment[];
    staging: Deployment[];
  };
  eas: any[];
  needsToken?: boolean;
  message?: string;
}

export default function DeployDashboard() {
  const [data, setData] = useState<DeployData | null>(null);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchDeployments = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/deploy/status');
      if (response.ok) {
        const result = await response.json();
        setData(result);
      }
    } catch (e) {
      console.error('Failed to fetch deployments:', e);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchDeployments();
    const interval = setInterval(fetchDeployments, 30000);
    return () => clearInterval(interval);
  }, []);

  const triggerDeploy = async (target: 'saas-prod' | 'saas-staging' | 'app-prod' | 'app-ota') => {
    setDeploying(target);
    setError(null);
    try {
      const response = await fetch('/api/deploy/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target })
      });
      if (!response.ok) {
        const data = await response.json();
        setError(data.error || 'Deploy failed');
      } else {
        setTimeout(fetchDeployments, 2000);
      }
    } catch (e) {
      setError('Network error');
    }
    setDeploying(null);
  };

  const getStateIcon = (state: string) => {
    const s = state?.toUpperCase();
    switch (s) {
      case 'READY':
        return <CheckCircle className="w-4 h-4 text-terminal-green" />;
      case 'BUILDING':
        return <Loader2 className="w-4 h-4 text-terminal-amber animate-spin" />;
      case 'ERROR':
        return <XCircle className="w-4 h-4 text-terminal-red" />;
      case 'QUEUED':
        return <Clock className="w-4 h-4 text-terminal-dim" />;
      default:
        return <Clock className="w-4 h-4 text-terminal-dim" />;
    }
  };

  const getStateColor = (state: string) => {
    const s = state?.toUpperCase();
    switch (s) {
      case 'READY':
        return 'text-terminal-green';
      case 'BUILDING':
        return 'text-terminal-amber';
      case 'ERROR':
        return 'text-terminal-red';
      default:
        return 'text-terminal-dim';
    }
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return `${Math.floor(diffMins / 1440)}d ago`;
  };

  const DeploymentRow = ({ deployment, label, color }: { deployment?: Deployment; label: string; color: string }) => (
    <div className="flex items-center justify-between py-1">
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${color}`} />
        <span className="text-terminal-dim text-xs">{label}</span>
      </div>
      {deployment ? (
        <div className="flex items-center gap-2">
          {getStateIcon(deployment.state)}
          <span className={`text-xs ${getStateColor(deployment.state)}`}>
            {deployment.state}
          </span>
          <span className="text-terminal-dim text-xs">
            {formatTime(deployment.createdAt)}
          </span>
          {deployment.url && (
            <a 
              href={deployment.url} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-terminal-cyan hover:underline"
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      ) : (
        <span className="text-terminal-dim text-xs">No data</span>
      )}
    </div>
  );

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
            <Rocket style={{ width: 12, height: 12, color: 'var(--cyan, #5EC4D9)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Dev · Deploys
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 1 }}>
              Deploy dashboard
            </div>
          </div>
        </div>
        <button
          onClick={fetchDeployments}
          disabled={loading}
          data-fusio
          title="Refresh"
          style={{
            padding: 6, borderRadius: 5, background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--mist, rgba(255,255,255,0.5))',
            opacity: loading ? 0.5 : 1,
            transition: 'all 120ms ease-out',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(94, 196, 217, 0.12)'; (e.currentTarget as HTMLElement).style.color = 'var(--cyan, #5EC4D9)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
        >
          <RefreshCw style={{ width: 14, height: 14, animation: loading ? 'spin 1s linear infinite' : undefined }} />
        </button>
      </div>

      {data?.needsToken && (
        <div className="mb-4 p-3 bg-terminal-amber/20 border border-terminal-amber/50 rounded text-terminal-amber text-xs">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="w-4 h-4" />
            <span className="font-bold">Vercel Token Missing</span>
          </div>
          <p>Add VERCEL_TOKEN to .env.local for real deployment status.</p>
          <p className="mt-1 text-terminal-dim">Get token: Settings → Tokens → Create</p>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-terminal-red/20 border border-terminal-red/50 rounded text-terminal-red text-sm">
          {error}
        </div>
      )}

      {/* SaaS Platform - example.com */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <Globe className="w-4 h-4 text-terminal-green" />
          <span className="text-terminal-text font-bold text-sm">example.com</span>
          <span className="text-terminal-dim text-xs">(SaaS Platform)</span>
        </div>
        
        <div className="bg-terminal-bg rounded p-3 mb-2">
          <DeploymentRow 
            deployment={data?.saas?.production?.[0]} 
            label="Production" 
            color="bg-terminal-green" 
          />
          <DeploymentRow 
            deployment={data?.saas?.staging?.[0]} 
            label="Staging" 
            color="bg-terminal-amber" 
          />
          
          <div className="flex gap-2 mt-3 pt-2 border-t border-terminal-border">
            <button
              onClick={() => triggerDeploy('saas-prod')}
              disabled={deploying !== null}
              className="flex-1 px-3 py-2 bg-terminal-green/20 text-terminal-green border 
                         border-terminal-green/50 rounded hover:bg-terminal-green/30 transition
                         disabled:opacity-50 text-sm flex items-center justify-center gap-2"
            >
              {deploying === 'saas-prod' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>Deploy Prod</>
              )}
            </button>
            <button
              onClick={() => triggerDeploy('saas-staging')}
              disabled={deploying !== null}
              className="flex-1 px-3 py-2 bg-terminal-amber/20 text-terminal-amber border 
                         border-terminal-amber/50 rounded hover:bg-terminal-amber/30 transition
                         disabled:opacity-50 text-sm flex items-center justify-center gap-2"
            >
              {deploying === 'saas-staging' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>Deploy Staging</>
              )}
            </button>
          </div>
        </div>

        {/* Staging URLs Reference */}
        <div className="text-xs text-terminal-dim pl-2 space-y-0.5">
          <div>→ <a href="https://example.com" target="_blank" className="text-terminal-green hover:underline">example.com</a> (prod)</div>
          <div>→ <a href="https://staging.example.com" target="_blank" className="text-terminal-amber hover:underline">staging.example.com</a> (staging)</div>
        </div>
      </div>

      {/* Field App - app.example.com */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <Smartphone className="w-4 h-4 text-terminal-cyan" />
          <span className="text-terminal-text font-bold text-sm">app.example.com</span>
          <span className="text-terminal-dim text-xs">(Field App)</span>
        </div>
        
        <div className="bg-terminal-bg rounded p-3 mb-2">
          <DeploymentRow 
            deployment={data?.app?.production?.[0]} 
            label="Production" 
            color="bg-terminal-cyan" 
          />
          <DeploymentRow 
            deployment={data?.app?.staging?.[0]} 
            label="Staging" 
            color="bg-terminal-purple" 
          />
          
          <div className="flex gap-2 mt-3 pt-2 border-t border-terminal-border">
            <button
              onClick={() => triggerDeploy('app-prod')}
              disabled={deploying !== null}
              className="flex-1 px-3 py-2 bg-terminal-cyan/20 text-terminal-cyan border 
                         border-terminal-cyan/50 rounded hover:bg-terminal-cyan/30 transition
                         disabled:opacity-50 text-sm flex items-center justify-center gap-2"
            >
              {deploying === 'app-prod' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>Deploy</>
              )}
            </button>
            <button
              onClick={() => triggerDeploy('app-ota')}
              disabled={deploying !== null}
              className="flex-1 px-3 py-2 bg-terminal-purple/20 text-terminal-purple border 
                         border-terminal-purple/50 rounded hover:bg-terminal-purple/30 transition
                         disabled:opacity-50 text-sm flex items-center justify-center gap-2"
            >
              {deploying === 'app-ota' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>OTA Update</>
              )}
            </button>
          </div>
        </div>

        {/* Staging URLs Reference */}
        <div className="text-xs text-terminal-dim pl-2 space-y-0.5">
          <div>→ <a href="https://app.example.com" target="_blank" className="text-terminal-cyan hover:underline">app.example.com</a> (prod)</div>
          <div>→ <a href="https://staging-app.example.com" target="_blank" className="text-terminal-purple hover:underline">staging-app.example.com</a> (staging)</div>
        </div>
      </div>

      {/* Supabase Environment Reference */}
      <div className="mb-4 p-3 bg-terminal-bg rounded">
        <div className="text-terminal-dim text-xs font-bold mb-2">📊 SUPABASE REFS</div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-terminal-green">● Production:</span>
            <code className="text-terminal-text ml-1">nqzhoplyamubcbqjuvxh</code>
          </div>
          <div>
            <span className="text-terminal-amber">● Staging:</span>
            <code className="text-terminal-text ml-1">zbshprhsogdnawuviqgq</code>
          </div>
        </div>
      </div>

      {/* Quick Links */}
      <div className="flex gap-2 pt-3 border-t border-terminal-border">
        <a
          href="https://vercel.com/<your-github-user>/fieldrepapp"
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs 
                     text-terminal-dim hover:text-terminal-text transition"
        >
          <ExternalLink className="w-3 h-3" />
          Vercel SaaS
        </a>
        <a
          href="https://vercel.com/<your-github-user>/dist"
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs 
                     text-terminal-dim hover:text-terminal-text transition"
        >
          <ExternalLink className="w-3 h-3" />
          Vercel App
        </a>
        <a
          href="https://supabase.com/dashboard/project/nqzhoplyamubcbqjuvxh"
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs 
                     text-terminal-dim hover:text-terminal-text transition"
        >
          <ExternalLink className="w-3 h-3" />
          Supabase
        </a>
        <a
          href="https://expo.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs 
                     text-terminal-dim hover:text-terminal-text transition"
        >
          <ExternalLink className="w-3 h-3" />
          Expo
        </a>
      </div>
    </div>
  );
}
