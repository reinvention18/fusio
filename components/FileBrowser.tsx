/**
 * FileBrowser — sidebar file browser. Lists entries via /api/browse and emits
 * onFileOpen when a file is clicked. Re-skinned for the AI Fusio design.
 */
'use client';

import { useState, useEffect, useCallback } from 'react';
import { Folder, File, FolderOpen, ChevronRight, RefreshCw, Home, ArrowLeft } from 'lucide-react';

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size?: number;
}

interface FileBrowserProps {
  onFileOpen?: (path: string) => void;
}

const FONT_MONO = 'var(--font-mono, ui-monospace, monospace)';
const FONT_SANS = 'var(--font-sans, system-ui)';

export default function FileBrowser({ onFileOpen }: FileBrowserProps) {
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const fetchDir = useCallback(async (dirPath: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/browse?path=${encodeURIComponent(dirPath)}`);
      const data = await res.json();
      if (data.entries) {
        setEntries(data.entries);
        setCurrentPath(data.path || dirPath);
      } else if (data.items) {
        setEntries(data.items.map((item: any) => ({
          name: item.name,
          type: item.isDirectory ? 'directory' : 'file',
          path: item.path || `${dirPath}/${item.name}`,
          size: item.size,
        })));
        setCurrentPath(dirPath);
      }
    } catch (err) {
      console.error('[FileBrowser] fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ws = typeof localStorage !== 'undefined'
      ? JSON.parse(localStorage.getItem('gatewayConfig') || '{}').workspace || ''
      : '';
    fetchDir(ws || '');
  }, [fetchDir]);

  const goUp = () => {
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
    fetchDir(parent);
  };

  const formatSize = (bytes?: number) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  const sorted = [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Icon-button used in the header
  const IconBtn = ({ onClick, title, disabled, children, hoverColor }: {
    onClick: () => void;
    title: string;
    disabled?: boolean;
    children: React.ReactNode;
    hoverColor?: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-fusio
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 24, height: 24, borderRadius: 5,
        background: 'transparent', color: 'var(--mist, rgba(255,255,255,0.5))', border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'all 120ms ease-out',
      }}
      onMouseEnter={e => {
        if (!disabled) {
          (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)';
          (e.currentTarget as HTMLElement).style.color = hoverColor || 'var(--white, #fff)';
        }
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.background = 'transparent';
        (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))';
      }}
    >
      {children}
    </button>
  );

  return (
    <div
      style={{
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 12,
        overflow: 'hidden',
        fontFamily: FONT_SANS,
        color: 'var(--white, #fff)',
      }}
    >
      {/* Header */}
      <div style={{ padding: 12, borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 22, height: 22, borderRadius: 5,
                background: 'rgba(232, 162, 59, 0.12)',
                border: '1px solid rgba(232, 162, 59, 0.35)',
              }}
            >
              <FolderOpen style={{ width: 11, height: 11, color: 'var(--amber, #E8A23B)' }} />
            </span>
            <div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
                Build · Filesystem
              </div>
              <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>
                Files
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <IconBtn onClick={goUp} title="Go up">
              <ArrowLeft style={{ width: 12, height: 12 }} />
            </IconBtn>
            <IconBtn onClick={() => fetchDir('')} title="Go home">
              <Home style={{ width: 12, height: 12 }} />
            </IconBtn>
            <IconBtn onClick={() => fetchDir(currentPath)} disabled={loading} title="Refresh" hoverColor="var(--green, #4CC38A)">
              <RefreshCw style={{ width: 12, height: 12, animation: loading ? 'spin 1s linear infinite' : undefined }} />
            </IconBtn>
          </div>
        </div>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: '0.04em',
            color: 'var(--mist, rgba(255,255,255,0.5))',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
          title={currentPath}
        >
          {currentPath || '~'}
        </div>
      </div>

      {/* File list */}
      <div style={{ maxHeight: 500, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ padding: 16, textAlign: 'center', color: 'var(--mist, rgba(255,255,255,0.5))', fontSize: 12 }}>
            <RefreshCw style={{ width: 14, height: 14, margin: '0 auto 6px', display: 'block', animation: 'spin 1s linear infinite' }} />
            Loading…
          </div>
        ) : sorted.length === 0 ? (
          <div style={{ padding: 16, textAlign: 'center', color: 'var(--mist, rgba(255,255,255,0.5))', fontSize: 12, fontStyle: 'italic' }}>
            Empty directory
          </div>
        ) : (
          <div>
            {sorted.map(entry => {
              const isSelected = selectedFile === entry.path;
              return (
                <button
                  key={entry.path || entry.name}
                  type="button"
                  onClick={() => {
                    if (entry.type === 'directory') {
                      fetchDir(entry.path);
                    } else {
                      setSelectedFile(entry.path);
                      onFileOpen?.(entry.path);
                    }
                  }}
                  data-fusio
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 12px',
                    display: 'flex', alignItems: 'center', gap: 8,
                    fontSize: 12.5,
                    fontFamily: FONT_MONO,
                    background: isSelected ? 'rgba(94, 196, 217, 0.1)' : 'transparent',
                    color: isSelected ? 'var(--cyan, #5EC4D9)' : 'var(--white, #fff)',
                    border: 'none',
                    borderLeft: isSelected ? '2px solid var(--cyan, #5EC4D9)' : '2px solid transparent',
                    cursor: 'pointer',
                    transition: 'background 120ms ease-out',
                  }}
                  onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--ink-2, #131319)'; }}
                  onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  {entry.type === 'directory' ? (
                    <Folder style={{ width: 12, height: 12, color: 'var(--amber, #E8A23B)', flexShrink: 0 }} />
                  ) : (
                    <File style={{ width: 12, height: 12, color: 'var(--mist, rgba(255,255,255,0.5))', flexShrink: 0 }} />
                  )}
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.name}
                  </span>
                  {entry.type === 'file' && entry.size && (
                    <span style={{ fontSize: 10, color: 'var(--dim, rgba(255,255,255,0.32))', flexShrink: 0, letterSpacing: '0.04em' }}>
                      {formatSize(entry.size)}
                    </span>
                  )}
                  {entry.type === 'directory' && (
                    <ChevronRight style={{ width: 10, height: 10, color: 'var(--dim, rgba(255,255,255,0.32))', flexShrink: 0 }} />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Foot */}
      <div
        style={{
          padding: '6px 12px',
          borderTop: '1px solid var(--line, rgba(255,255,255,0.08))',
          fontFamily: FONT_MONO,
          fontSize: 9.5,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--dim, rgba(255,255,255,0.32))',
        }}
      >
        {entries.length} items
      </div>
    </div>
  );
}
