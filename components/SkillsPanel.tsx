/**
 * SkillsPanel — list installed ClawHub skills, search the hub, install/uninstall
 * and toggle individual skills. Re-skinned for the AI Fusio design language:
 * tokens come from /fusio/mc.css (palette + fonts), uppercase mono eyebrows,
 * compact cards with thin lines. Functional API + endpoints unchanged.
 */
'use client';

import { useState, useEffect } from 'react';
import {
  Sparkles, Search, Download, Trash2, ToggleLeft, ToggleRight,
  RefreshCw, Loader2, Check, X, Package, FolderOpen,
} from 'lucide-react';

interface Skill {
  name: string;
  description: string;
  enabled: boolean;
  path: string;
  version?: string;
}

interface SearchResult {
  slug: string;
  version: string;
  description: string;
  score: number;
}

// ---- tokens shared across this panel (pulled from /fusio/mc.css palette) ----
const VOID  = 'var(--bg-primary, #050507)';
const INK   = 'var(--bg-surface, #0A0A0E)';
const INK_2 = 'var(--bg-elevated, #131319)';
const INK_3 = 'var(--ink-3, #1B1B23)';
const LINE  = 'var(--border, rgba(255,255,255,0.08))';
const WHITE = 'var(--text-primary, #FFFFFF)';
const FOG   = 'var(--fog, rgba(255,255,255,0.78))';
const MIST  = 'var(--mist, rgba(255,255,255,0.5))';
const DIM   = 'var(--dim, rgba(255,255,255,0.32))';
const RED   = 'var(--red, #CC0C20)';
const GREEN = 'var(--green, #4CC38A)';
const CYAN  = 'var(--cyan, #5EC4D9)';
const AMBER = 'var(--amber, #E8A23B)';

const FONT_MONO = 'var(--font-mono, ui-monospace, monospace)';
const FONT_SANS = 'var(--font-sans, system-ui)';

// Common mono uppercase eyebrow style
const eyebrow = (color: string = MIST): React.CSSProperties => ({
  fontFamily: FONT_MONO,
  fontSize: 10,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color,
});

export default function SkillsPanel() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsDir, setSkillsDir] = useState('');
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [showSearch, setShowSearch] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Fetch installed skills
  const fetchSkills = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/skills?action=list');
      const data = await res.json();
      if (data.skills) {
        setSkills(data.skills);
        setSkillsDir(data.skillsDir);
      }
    } catch (e) {
      console.error('[Skills] Fetch error:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSkills();
  }, []);

  // Search ClawHub
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchResults([]);
    try {
      const res = await fetch(`/api/skills?action=search&query=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      if (data.results) {
        const installedSlugs = new Set(skills.map(s => s.name.toLowerCase()));
        const filtered = data.results.filter((r: SearchResult) =>
          !installedSlugs.has(r.slug.toLowerCase())
        );
        setSearchResults(filtered);
      }
    } catch (e) {
      console.error('[Skills] Search error:', e);
    } finally {
      setSearching(false);
    }
  };

  // Toggle skill enabled/disabled
  const toggleSkill = async (skill: Skill) => {
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'toggle',
          skill: skill.path.split(/[/\\]/).pop(),
          enabled: !skill.enabled,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSkills(prev => prev.map(s =>
          s.path === skill.path ? { ...s, enabled: !s.enabled } : s
        ));
        showMessage('success', `${skill.name} ${!skill.enabled ? 'enabled' : 'disabled'}`);
      }
    } catch (e) {
      showMessage('error', 'Failed to toggle skill');
    }
  };

  // Install a skill
  const installSkill = async (slug: string) => {
    setInstalling(slug);
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'install', slug }),
      });
      const data = await res.json();
      if (data.success) {
        showMessage('success', `Installed ${slug}`);
        setSearchResults(prev => prev.filter(r => r.slug !== slug));
        fetchSkills();
      } else {
        showMessage('error', data.message || 'Install failed');
      }
    } catch (e) {
      showMessage('error', 'Install failed');
    } finally {
      setInstalling(null);
    }
  };

  // Uninstall a skill
  const uninstallSkill = async (skill: Skill) => {
    if (!confirm(`Uninstall "${skill.name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'uninstall',
          skill: skill.path.split(/[/\\]/).pop(),
        }),
      });
      const data = await res.json();
      if (data.success) {
        showMessage('success', `Uninstalled ${skill.name}`);
        fetchSkills();
      } else {
        showMessage('error', data.message || 'Uninstall failed');
      }
    } catch (e) {
      showMessage('error', 'Uninstall failed');
    }
  };

  const showMessage = (type: 'success' | 'error', text: string) => {
    setActionMessage({ type, text });
    setTimeout(() => setActionMessage(null), 3000);
  };

  const filteredSkills = skills.filter(s => {
    if (filter === 'enabled') return s.enabled;
    if (filter === 'disabled') return !s.enabled;
    return true;
  });

  const enabledCount = skills.filter(s => s.enabled).length;
  const disabledCount = skills.filter(s => !s.enabled).length;

  // Tiny icon-button used in the header row
  const IconBtn = ({ active, onClick, title, children }: {
    active?: boolean; onClick: () => void; title: string; children: React.ReactNode;
  }) => (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: 6,
        background: active ? `${CYAN}20` : 'transparent',
        color: active ? CYAN : MIST,
        border: `1px solid ${active ? `${CYAN}40` : 'transparent'}`,
        cursor: 'pointer', transition: 'all 120ms ease-out',
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.color = WHITE; }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.color = MIST; }}
    >
      {children}
    </button>
  );

  // Filter pill
  const FilterPill = ({ value, label, count, color = GREEN }: {
    value: 'all' | 'enabled' | 'disabled'; label: string; count: number; color?: string;
  }) => {
    const active = filter === value;
    return (
      <button
        type="button"
        onClick={() => setFilter(value)}
        style={{
          ...eyebrow(active ? color : MIST),
          padding: '4px 10px',
          borderRadius: 6,
          background: active ? `${color}1A` : 'transparent',
          border: `1px solid ${active ? `${color}40` : 'transparent'}`,
          cursor: 'pointer',
          transition: 'all 120ms ease-out',
        }}
      >
        {label} <span style={{ opacity: 0.65, marginLeft: 4 }}>· {count}</span>
      </button>
    );
  };

  return (
    <div
      style={{
        background: INK,
        border: `1px solid ${LINE}`,
        borderRadius: 12,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: FONT_SANS,
        color: WHITE,
        overflow: 'hidden',
      }}
    >
      {/* HEAD */}
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${LINE}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 24, height: 24, borderRadius: 6,
                background: `${AMBER}1A`, border: `1px solid ${AMBER}40`,
              }}
            >
              <Sparkles style={{ width: 12, height: 12, color: AMBER }} />
            </span>
            <div>
              <div style={eyebrow(MIST)}>Knowledge · Library</div>
              <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', color: WHITE, marginTop: 1 }}>
                Skills
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <IconBtn active={showSearch} onClick={() => setShowSearch(s => !s)} title="Search & install">
              <Download style={{ width: 14, height: 14 }} />
            </IconBtn>
            <IconBtn onClick={fetchSkills} title="Refresh">
              <RefreshCw style={{ width: 14, height: 14, animation: loading ? 'spin 1s linear infinite' : undefined }} />
            </IconBtn>
          </div>
        </div>

        {/* Filter pills */}
        <div style={{ display: 'flex', gap: 4 }}>
          <FilterPill value="all" label="All" count={skills.length} color={WHITE} />
          <FilterPill value="enabled" label="Enabled" count={enabledCount} color={GREEN} />
          <FilterPill value="disabled" label="Disabled" count={disabledCount} color={RED} />
        </div>
      </div>

      {/* Inline action message */}
      {actionMessage && (
        <div
          style={{
            margin: '10px 16px 0',
            padding: '8px 12px',
            borderRadius: 8,
            display: 'flex', alignItems: 'center', gap: 8,
            background: actionMessage.type === 'success' ? `${GREEN}1A` : `${RED}1A`,
            border: `1px solid ${actionMessage.type === 'success' ? `${GREEN}40` : `${RED}40`}`,
            color: actionMessage.type === 'success' ? GREEN : RED,
            fontSize: 12,
            fontFamily: FONT_MONO,
          }}
        >
          {actionMessage.type === 'success' ? <Check style={{ width: 14, height: 14 }} /> : <X style={{ width: 14, height: 14 }} />}
          {actionMessage.text}
        </div>
      )}

      {/* Search panel */}
      {showSearch && (
        <div style={{ padding: 16, borderBottom: `1px solid ${LINE}`, background: VOID }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: searchResults.length > 0 || searching ? 12 : 0 }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <Search style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, color: MIST }} />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="Search ClawHub for skills…"
                style={{
                  width: '100%',
                  background: INK_3,
                  border: `1px solid ${LINE}`,
                  borderRadius: 8,
                  padding: '8px 12px 8px 32px',
                  fontSize: 13,
                  fontFamily: FONT_SANS,
                  color: WHITE,
                  outline: 'none',
                }}
              />
            </div>
            <button
              type="button"
              onClick={handleSearch}
              disabled={searching || !searchQuery.trim()}
              className="card-btn primary"
              style={{
                opacity: (searching || !searchQuery.trim()) ? 0.5 : 1,
                background: CYAN,
                borderColor: CYAN,
                color: '#06181d',
                minWidth: 88,
              }}
            >
              {searching ? <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} /> : 'Search'}
            </button>
          </div>

          {/* Search results */}
          {searchResults.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
              {searchResults.map(result => (
                <div
                  key={result.slug}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 10px',
                    background: INK_2,
                    border: `1px solid ${LINE}`,
                    borderRadius: 8,
                    gap: 10,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: WHITE }}>{result.slug}</span>
                      <span style={{ ...eyebrow(MIST), fontSize: 9 }}>v{result.version}</span>
                    </div>
                    <div style={{ fontSize: 11, color: FOG, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {result.description}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => installSkill(result.slug)}
                    disabled={installing === result.slug}
                    className="card-btn primary"
                    style={{
                      opacity: installing === result.slug ? 0.5 : 1,
                      background: GREEN,
                      borderColor: GREEN,
                      color: '#0a1612',
                      fontSize: 11,
                      padding: '4px 10px',
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                    }}
                  >
                    {installing === result.slug ? (
                      <Loader2 style={{ width: 11, height: 11, animation: 'spin 1s linear infinite' }} />
                    ) : (
                      <Download style={{ width: 11, height: 11 }} />
                    )}
                    Install
                  </button>
                </div>
              ))}
            </div>
          )}

          {searching && (
            <div style={{ textAlign: 'center', padding: '12px 0', color: MIST, fontSize: 12, fontFamily: FONT_MONO }}>
              <Loader2 style={{ width: 16, height: 16, margin: '0 auto 6px', display: 'block', animation: 'spin 1s linear infinite' }} />
              Searching ClawHub…
            </div>
          )}
        </div>
      )}

      {/* SKILLS LIST */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: MIST, fontSize: 12, fontFamily: FONT_MONO }}>
            <Loader2 style={{ width: 18, height: 18, margin: '0 auto 8px', display: 'block', animation: 'spin 1s linear infinite' }} />
            Loading skills…
          </div>
        ) : filteredSkills.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: MIST }}>
            <Package style={{ width: 28, height: 28, margin: '0 auto 8px', display: 'block', opacity: 0.5 }} />
            <p style={{ fontSize: 13, margin: 0 }}>No skills found</p>
            {filter !== 'all' && (
              <button
                type="button"
                onClick={() => setFilter('all')}
                style={{
                  ...eyebrow(CYAN),
                  marginTop: 8,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                Show all skills
              </button>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {filteredSkills.map(skill => (
              <div
                key={skill.path}
                className="group"
                style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: `1px solid ${LINE}`,
                  background: skill.enabled ? INK_2 : 'transparent',
                  opacity: skill.enabled ? 1 : 0.6,
                  transition: 'all 120ms ease-out',
                  position: 'relative',
                }}
                onMouseEnter={e => {
                  const el = e.currentTarget as HTMLElement;
                  el.style.opacity = '1';
                  el.style.borderColor = skill.enabled ? `${GREEN}40` : `${MIST}40`;
                  const actions = el.querySelector<HTMLElement>('[data-actions]');
                  if (actions) actions.style.opacity = '1';
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget as HTMLElement;
                  el.style.opacity = skill.enabled ? '1' : '0.6';
                  el.style.borderColor = LINE;
                  const actions = el.querySelector<HTMLElement>('[data-actions]');
                  if (actions) actions.style.opacity = '0';
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: skill.enabled ? WHITE : MIST }}>
                        {skill.name}
                      </span>
                      {skill.version && (
                        <span style={{ ...eyebrow(DIM), fontSize: 9 }}>v{skill.version}</span>
                      )}
                      {!skill.enabled && (
                        <span style={{
                          ...eyebrow(RED),
                          fontSize: 9,
                          padding: '1px 6px',
                          background: `${RED}1A`,
                          border: `1px solid ${RED}40`,
                          borderRadius: 4,
                        }}>
                          Off
                        </span>
                      )}
                    </div>
                    {skill.description && (
                      <p style={{
                        fontSize: 11.5,
                        color: FOG,
                        margin: '3px 0 0',
                        lineHeight: 1.45,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}>
                        {skill.description}
                      </p>
                    )}
                  </div>

                  <div data-actions style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: 0, transition: 'opacity 120ms ease-out', flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => toggleSkill(skill)}
                      title={skill.enabled ? 'Disable' : 'Enable'}
                      style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 26, height: 26, borderRadius: 6,
                        background: 'transparent',
                        color: skill.enabled ? GREEN : MIST,
                        border: 'none',
                        cursor: 'pointer',
                        transition: 'background 120ms ease-out',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = skill.enabled ? `${GREEN}20` : `${MIST}20`; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                    >
                      {skill.enabled
                        ? <ToggleRight style={{ width: 18, height: 18 }} />
                        : <ToggleLeft style={{ width: 18, height: 18 }} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => uninstallSkill(skill)}
                      title="Uninstall"
                      style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 26, height: 26, borderRadius: 6,
                        background: 'transparent', color: MIST, border: 'none', cursor: 'pointer',
                        transition: 'all 120ms ease-out',
                      }}
                      onMouseEnter={e => {
                        const el = e.currentTarget as HTMLElement;
                        el.style.background = `${RED}20`;
                        el.style.color = RED;
                      }}
                      onMouseLeave={e => {
                        const el = e.currentTarget as HTMLElement;
                        el.style.background = 'transparent';
                        el.style.color = MIST;
                      }}
                    >
                      <Trash2 style={{ width: 14, height: 14 }} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* FOOT — skills dir hint */}
      <div
        style={{
          padding: '8px 12px',
          borderTop: `1px solid ${LINE}`,
          display: 'flex', alignItems: 'center', gap: 6,
          color: DIM,
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: '0.04em',
        }}
      >
        <FolderOpen style={{ width: 11, height: 11 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{skillsDir}</span>
      </div>
    </div>
  );
}
