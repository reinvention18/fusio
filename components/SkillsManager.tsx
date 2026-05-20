'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Wand2, Check, X, RefreshCw, ChevronDown, ChevronUp,
  Download, AlertTriangle, CheckCircle
} from 'lucide-react';

interface SkillRequires {
  bins?: string[];
  anyBins?: string[];
  npm?: string[];
  anyNpm?: string[];
}

interface InstallRecipeItem {
  id: string;
  kind: string;
  package?: string;
  bins?: string[];
  label?: string;
}

interface Skill {
  name: string;
  description: string;
  enabled: boolean;
  path: string;
  version?: string;
  category: 'bundled' | 'workspace';
  requirements: SkillRequires | null;
  installRecipe: InstallRecipeItem[] | null;
  requirementsMet: boolean;
}

type StatusFilter = 'all' | 'ready' | 'needs-setup' | 'disabled';

function getSkillStatus(skill: Skill): 'ready' | 'needs-setup' | 'disabled' {
  if (!skill.enabled) return 'disabled';
  if (!skill.requirementsMet) return 'needs-setup';
  return 'ready';
}

export default function SkillsManager() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/skills?action=list');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSkills(data.skills || []);
    } catch (e: any) {
      setError(e.message || 'Failed to load skills');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const toggleSkill = async (skill: Skill) => {
    const dirName = skill.path.split('/').pop() || skill.name;
    setToggling(skill.name);
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', skill: dirName, enabled: !skill.enabled }),
      });
      if (res.ok) {
        setSkills(prev => prev.map(s =>
          s.name === skill.name ? { ...s, enabled: !s.enabled } : s
        ));
      }
    } catch { /* ignore */ } finally {
      setToggling(null);
    }
  };

  const installRequirements = async (skill: Skill) => {
    if (!skill.installRecipe?.length) return;
    const recipe = skill.installRecipe[0];
    setInstalling(skill.name);
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'install', slug: recipe.package || recipe.id }),
      });
      const data = await res.json();
      if (data.success) await fetchSkills();
    } catch { /* ignore */ } finally {
      setInstalling(null);
    }
  };

  const counts = {
    all: skills.length,
    ready: skills.filter(s => getSkillStatus(s) === 'ready').length,
    'needs-setup': skills.filter(s => getSkillStatus(s) === 'needs-setup').length,
    disabled: skills.filter(s => getSkillStatus(s) === 'disabled').length,
  };

  const filteredSkills = skills.filter(s => {
    if (filter === 'all') return true;
    return getSkillStatus(s) === filter;
  });

  const getCategoryColor = (category: Skill['category']) => {
    switch (category) {
      case 'bundled': return 'text-terminal-green border-terminal-green/30 bg-terminal-green/10';
      case 'workspace': return 'text-terminal-amber border-terminal-amber/30 bg-terminal-amber/10';
    }
  };

  const getStatusDot = (skill: Skill) => {
    const status = getSkillStatus(skill);
    switch (status) {
      case 'ready': return <span className="w-2 h-2 rounded-full bg-terminal-green inline-block shrink-0" title="Ready" />;
      case 'needs-setup': return <span className="w-2 h-2 rounded-full bg-terminal-amber inline-block shrink-0" title="Needs Setup" />;
      case 'disabled': return <span className="w-2 h-2 rounded-full bg-terminal-dim inline-block shrink-0" title="Disabled" />;
    }
  };

  const filterTabs: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'ready', label: 'Ready' },
    { key: 'needs-setup', label: 'Needs Setup' },
    { key: 'disabled', label: 'Disabled' },
  ];

  return (
    <div className="fusio-panel p-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 5, background: 'rgba(232, 162, 59, 0.12)', border: '1px solid rgba(232, 162, 59, 0.35)' }}>
            <Wand2 style={{ width: 11, height: 11, color: 'var(--amber, #E8A23B)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Knowledge · Library
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--white, #fff)', marginTop: 1, display: 'flex', alignItems: 'baseline', gap: 6 }}>
              Skills
              <span style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--dim, rgba(255,255,255,0.32))' }}>· {counts.all}</span>
            </div>
          </div>
        </div>
        <button
          onClick={fetchSkills}
          disabled={loading || false}
          className="p-1 rounded text-terminal-dim hover:text-terminal-green transition"
          title="Refresh"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin text-terminal-green' : ''}`} />
        </button>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 mb-2 overflow-x-auto">
        {filterTabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`px-2 py-0.5 rounded text-xs font-mono whitespace-nowrap transition border ${
              filter === tab.key
                ? 'bg-terminal-green/10 border-terminal-green text-terminal-green'
                : 'border-terminal-border text-terminal-dim hover:text-terminal-text hover:border-terminal-text/30'
            }`}
          >
            {tab.label}
            <span className="ml-1 opacity-60">
              ({tab.key === 'all' ? counts.all : counts[tab.key]})
            </span>
          </button>
        ))}
      </div>

      {/* Content */}
      {error ? (
        <div className="text-terminal-red text-xs font-mono py-3 text-center">
          <AlertTriangle className="w-3 h-3 inline mr-1" />
          {error}
        </div>
      ) : loading && skills.length === 0 ? (
        <div className="text-terminal-dim text-xs font-mono py-3 text-center animate-pulse">
          loading skills...
        </div>
      ) : filteredSkills.length === 0 ? (
        <div className="text-terminal-dim text-xs font-mono py-3 text-center">
          no skills in this category
        </div>
      ) : (
        <div className="space-y-1 max-h-80 overflow-y-auto pr-0.5">
          {filteredSkills.map((skill) => {
            const isExpanded = expandedSkill === skill.name;
            const status = getSkillStatus(skill);
            const dirName = skill.path.split('/').pop() || skill.name;

            return (
              <div
                key={skill.name}
                className={`bg-terminal-bg rounded border transition ${
                  skill.enabled ? 'border-terminal-border' : 'border-terminal-border/40 opacity-60'
                }`}
              >
                {/* Skill row */}
                <div className="flex items-center gap-2 p-2">
                  {/* Status dot */}
                  {getStatusDot(skill)}

                  {/* Name + meta (clickable to expand) */}
                  <button
                    onClick={() => setExpandedSkill(isExpanded ? null : skill.name)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-terminal-text text-xs font-mono font-medium">{skill.name}</span>
                      <span className={`text-xs font-mono px-1 rounded border ${getCategoryColor(skill.category)}`}>
                        {skill.category}
                      </span>
                      {skill.version && (
                        <span className="text-terminal-dim text-xs font-mono">v{skill.version}</span>
                      )}
                      {status === 'needs-setup' && (
                        <AlertTriangle className="w-3 h-3 text-terminal-amber" />
                      )}
                    </div>
                    <div className="text-terminal-dim text-xs font-mono truncate mt-0.5">
                      {skill.description}
                    </div>
                  </button>

                  {/* Expand chevron */}
                  <button
                    onClick={() => setExpandedSkill(isExpanded ? null : skill.name)}
                    className="text-terminal-dim hover:text-terminal-text transition shrink-0"
                  >
                    {isExpanded
                      ? <ChevronUp className="w-3 h-3" />
                      : <ChevronDown className="w-3 h-3" />}
                  </button>

                  {/* Enable/disable toggle */}
                  <button
                    onClick={() => toggleSkill(skill)}
                    disabled={toggling === skill.name}
                    className={`p-1 rounded transition shrink-0 ${
                      toggling === skill.name
                        ? 'opacity-50'
                        : skill.enabled
                          ? 'text-terminal-green bg-terminal-green/10 hover:bg-terminal-green/20'
                          : 'text-terminal-dim bg-terminal-bg hover:bg-terminal-border/30'
                    }`}
                    title={skill.enabled ? 'Disable' : 'Enable'}
                  >
                    {skill.enabled
                      ? <Check className="w-3 h-3" />
                      : <X className="w-3 h-3" />}
                  </button>
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="border-t border-terminal-border/50 px-3 py-2 space-y-2">
                    {/* Description */}
                    {skill.description && (
                      <p className="text-terminal-text text-xs font-mono leading-relaxed">
                        {skill.description}
                      </p>
                    )}

                    {/* Path */}
                    <div>
                      <span className="text-terminal-dim text-xs font-mono">path: </span>
                      <span className="text-terminal-cyan text-xs font-mono break-all">{skill.path}</span>
                    </div>

                    {/* Status */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-terminal-dim text-xs font-mono">status: </span>
                      {status === 'ready' && (
                        <span className="flex items-center gap-1 text-terminal-green text-xs font-mono">
                          <CheckCircle className="w-3 h-3" /> ready
                        </span>
                      )}
                      {status === 'needs-setup' && (
                        <span className="flex items-center gap-1 text-terminal-amber text-xs font-mono">
                          <AlertTriangle className="w-3 h-3" /> needs setup
                        </span>
                      )}
                      {status === 'disabled' && (
                        <span className="text-terminal-dim text-xs font-mono">disabled</span>
                      )}
                    </div>

                    {/* Requirements */}
                    {skill.requirements && (
                      <div>
                        <div className="text-terminal-dim text-xs font-mono mb-1">requires:</div>
                        <div className="pl-2 space-y-0.5">
                          {skill.requirements.bins?.map(b => (
                            <div key={b} className="text-xs font-mono text-terminal-text">
                              <span className="text-terminal-dim">• bin: </span>{b}
                            </div>
                          ))}
                          {skill.requirements.anyBins?.map(b => (
                            <div key={b} className="text-xs font-mono text-terminal-text">
                              <span className="text-terminal-dim">• anyBin: </span>{b}
                            </div>
                          ))}
                          {skill.requirements.npm?.map(p => (
                            <div key={p} className="text-xs font-mono text-terminal-text">
                              <span className="text-terminal-dim">• npm: </span>{p}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Install button if needs setup */}
                    {status === 'needs-setup' && skill.installRecipe?.length ? (
                      <button
                        onClick={() => installRequirements(skill)}
                        disabled={installing === skill.name}
                        className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono border transition ${
                          installing === skill.name
                            ? 'opacity-50 border-terminal-border text-terminal-dim'
                            : 'border-terminal-amber/50 text-terminal-amber hover:bg-terminal-amber/10'
                        }`}
                      >
                        <Download className="w-3 h-3" />
                        {installing === skill.name ? 'installing...' : `install ${skill.installRecipe[0].label || skill.installRecipe[0].id}`}
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
