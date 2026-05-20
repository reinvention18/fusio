'use client';

import { useState, useEffect } from 'react';
import { Globe, Database, GitBranch, AlertTriangle, CheckCircle, RefreshCw, ExternalLink } from 'lucide-react';

interface EnvironmentConfig {
  supabaseRef: string;
  saasUrl: string;
  appUrl: string;
  branch: string;
}

interface EnvironmentInfo {
  name: 'production' | 'staging' | 'development';
  supabaseRef: string;
  supabaseUrl: string;
  branch: string;
  isDirty: boolean;
  workspace: string;
  environments: {
    production: EnvironmentConfig;
    staging: EnvironmentConfig;
  };
}

export default function EnvironmentBar() {
  const [env, setEnv] = useState<EnvironmentInfo | null>(null);
  const [switching, setSwitching] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetchEnv();
  }, []);

  const fetchEnv = async () => {
    try {
      const response = await fetch('/api/environment');
      if (response.ok) {
        const data = await response.json();
        setEnv(data);
      }
    } catch (e) {
      // Default to unknown if can't determine
      setEnv({
        name: 'development',
        supabaseRef: 'unknown',
        supabaseUrl: '',
        branch: 'unknown',
        isDirty: false,
        workspace: 'C:\\DevApps\\MyMobileApp',
        environments: {
          production: {
            supabaseRef: 'nqzhoplyamubcbqjuvxh',
            saasUrl: 'https://example.com',
            appUrl: 'https://app.example.com',
            branch: 'main'
          },
          staging: {
            supabaseRef: 'zbshprhsogdnawuviqgq',
            saasUrl: 'https://staging.example.com',
            appUrl: 'https://staging-app.example.com',
            branch: 'staging'
          }
        }
      });
    }
  };

  const switchEnvironment = async (target: 'production' | 'staging') => {
    if (env?.name === target) return;
    
    const confirm = window.confirm(
      `Switch MyMobileApp to ${target.toUpperCase()}?\n\nThis will:\n` +
      `• Checkout the ${target === 'production' ? 'main' : 'staging'} branch\n` +
      `• Update .env.local to use ${target} Supabase\n\n` +
      `Make sure you've committed your changes first!`
    );
    
    if (!confirm) return;

    setSwitching(true);
    
    try {
      const response = await fetch('/api/environment/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target })
      });
      
      if (response.ok) {
        await fetchEnv();
      } else {
        const data = await response.json();
        alert(`Failed to switch: ${data.error}`);
      }
    } catch (e) {
      console.error('Failed to switch environment:', e);
      alert('Failed to switch environment');
    }
    
    setSwitching(false);
  };

  if (!env) return null;

  const getEnvColor = () => {
    switch (env.name) {
      case 'production':
        return 'bg-terminal-green/20 border-terminal-green/50 text-terminal-green';
      case 'staging':
        return 'bg-terminal-amber/20 border-terminal-amber/50 text-terminal-amber';
      default:
        return 'bg-terminal-cyan/20 border-terminal-cyan/50 text-terminal-cyan';
    }
  };

  const getEnvIcon = () => {
    switch (env.name) {
      case 'production':
        return <CheckCircle className="w-4 h-4" />;
      case 'staging':
        return <AlertTriangle className="w-4 h-4" />;
      default:
        return <Globe className="w-4 h-4" />;
    }
  };

  const currentConfig = env.name === 'staging' ? env.environments.staging : env.environments.production;

  return (
    <div className={`border rounded-lg ${getEnvColor()}`}>
      {/* Main Bar */}
      <div 
        className="p-3 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* Environment Badge */}
            <div className="flex items-center gap-2">
              {getEnvIcon()}
              <span className="font-bold uppercase text-sm tracking-wider">
                {env.name}
              </span>
              {env.isDirty && (
                <span className="text-xs bg-terminal-red/30 text-terminal-red px-1 rounded">
                  dirty
                </span>
              )}
            </div>

            {/* Supabase Ref */}
            <div className="hidden md:flex items-center gap-1.5 text-xs opacity-80">
              <Database className="w-3 h-3" />
              <span className="font-mono">{env.supabaseRef.slice(0, 8)}...</span>
            </div>

            {/* Branch */}
            <div className="hidden md:flex items-center gap-1.5 text-xs opacity-80">
              <GitBranch className="w-3 h-3" />
              <span className="font-mono">{env.branch}</span>
            </div>
          </div>

          {/* Quick Switch */}
          <div className="flex items-center gap-2">
            <span className="text-xs opacity-60">{expanded ? '▲' : '▼'}</span>
            {env.name === 'staging' && (
              <button
                onClick={(e) => { e.stopPropagation(); switchEnvironment('production'); }}
                disabled={switching}
                className="px-2 py-1 text-xs bg-terminal-green/20 text-terminal-green 
                           border border-terminal-green/50 rounded hover:bg-terminal-green/30 
                           transition disabled:opacity-50 flex items-center gap-1"
              >
                {switching ? <RefreshCw className="w-3 h-3 animate-spin" /> : '→ Production'}
              </button>
            )}
            {env.name === 'production' && (
              <button
                onClick={(e) => { e.stopPropagation(); switchEnvironment('staging'); }}
                disabled={switching}
                className="px-2 py-1 text-xs bg-terminal-amber/20 text-terminal-amber 
                           border border-terminal-amber/50 rounded hover:bg-terminal-amber/30 
                           transition disabled:opacity-50 flex items-center gap-1"
              >
                {switching ? <RefreshCw className="w-3 h-3 animate-spin" /> : '→ Staging'}
              </button>
            )}
          </div>
        </div>

        {/* Warning for production */}
        {env.name === 'production' && (
          <div className="mt-2 text-xs opacity-70 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            You are working with PRODUCTION data. Deploy carefully!
          </div>
        )}
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="border-t border-current/20 p-3 text-xs">
          <div className="grid grid-cols-2 gap-4">
            {/* Production Column */}
            <div className={env.name === 'production' ? 'opacity-100' : 'opacity-50'}>
              <div className="font-bold text-terminal-green mb-2 flex items-center gap-1">
                <CheckCircle className="w-3 h-3" />
                Production
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-terminal-dim">SaaS:</span>
                  <a 
                    href="https://example.com" 
                    target="_blank" 
                    className="text-terminal-green hover:underline flex items-center gap-1"
                    onClick={e => e.stopPropagation()}
                  >
                    example.com <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-terminal-dim">App:</span>
                  <a 
                    href="https://app.example.com" 
                    target="_blank" 
                    className="text-terminal-green hover:underline flex items-center gap-1"
                    onClick={e => e.stopPropagation()}
                  >
                    app.example.com <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-terminal-dim">Branch:</span>
                  <code className="text-terminal-text">main</code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-terminal-dim">Supabase:</span>
                  <code className="text-terminal-text font-mono">nqzho...</code>
                </div>
              </div>
            </div>

            {/* Staging Column */}
            <div className={env.name === 'staging' ? 'opacity-100' : 'opacity-50'}>
              <div className="font-bold text-terminal-amber mb-2 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                Staging
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-terminal-dim">SaaS:</span>
                  <a 
                    href="https://staging.example.com" 
                    target="_blank" 
                    className="text-terminal-amber hover:underline flex items-center gap-1"
                    onClick={e => e.stopPropagation()}
                  >
                    staging.example.com <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-terminal-dim">App:</span>
                  <a 
                    href="https://staging-app.example.com" 
                    target="_blank" 
                    className="text-terminal-amber hover:underline flex items-center gap-1"
                    onClick={e => e.stopPropagation()}
                  >
                    staging-app.example.com <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-terminal-dim">Branch:</span>
                  <code className="text-terminal-text">staging</code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-terminal-dim">Supabase:</span>
                  <code className="text-terminal-text font-mono">zbshp...</code>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
