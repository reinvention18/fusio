'use client';
import { generateId } from '../lib/generateId';

import { useState, useEffect } from 'react';
import { Link2, Plus, X, ExternalLink, Edit2 } from 'lucide-react';

interface QuickLink {
  id: string;
  name: string;
  url: string;
  icon?: string;
}

export default function QuickLinks() {
  const [links, setLinks] = useState<QuickLink[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newLink, setNewLink] = useState({ name: '', url: '' });
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('quickLinks');
    if (saved) {
      setLinks(JSON.parse(saved));
    } else {
      const defaults: QuickLink[] = [
        { id: '1', name: 'GitHub', url: 'https://github.com', icon: '🐙' },
        { id: '2', name: 'Supabase', url: 'https://supabase.com/dashboard', icon: '⚡' },
        { id: '3', name: 'Vercel', url: 'https://vercel.com/dashboard', icon: '▲' },
        { id: '4', name: 'OpenClaw Docs', url: 'https://docs.openclaw.ai', icon: '📚' },
      ];
      setLinks(defaults);
      localStorage.setItem('quickLinks', JSON.stringify(defaults));
    }
  }, []);

  const saveLinks = (updated: QuickLink[]) => {
    setLinks(updated);
    localStorage.setItem('quickLinks', JSON.stringify(updated));
  };

  const addLink = () => {
    if (!newLink.name || !newLink.url) return;
    
    const link: QuickLink = {
      id: generateId(),
      name: newLink.name,
      url: newLink.url.startsWith('http') ? newLink.url : `https://${newLink.url}`,
      icon: '🔗',
    };
    
    saveLinks([...links, link]);
    setNewLink({ name: '', url: '' });
    setShowAdd(false);
  };

  const deleteLink = (id: string) => {
    saveLinks(links.filter(l => l.id !== id));
  };

  const openLink = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="fusio-panel p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2.5">
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 5, background: 'rgba(94, 196, 217, 0.12)', border: '1px solid rgba(94, 196, 217, 0.35)' }}>
            <Link2 style={{ width: 11, height: 11, color: 'var(--cyan, #5EC4D9)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Tools · Bookmarks
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--white, #fff)', marginTop: 1 }}>
              Links
            </div>
          </div>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="p-1 text-terminal-dim hover:text-terminal-green rounded transition"
        >
          <Plus className="w-3 h-3" />
        </button>
      </div>

      {/* Add Link Form */}
      {showAdd && (
        <div className="bg-terminal-bg rounded p-2 mb-2 border border-terminal-border">
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              value={newLink.name}
              onChange={(e) => setNewLink({ ...newLink, name: e.target.value })}
              placeholder="Name"
              className="flex-1 bg-terminal-surface border border-terminal-border rounded px-2 py-1 
                         text-terminal-text text-xs focus:border-terminal-green outline-none"
            />
            <input
              type="text"
              value={newLink.url}
              onChange={(e) => setNewLink({ ...newLink, url: e.target.value })}
              placeholder="URL"
              className="flex-1 bg-terminal-surface border border-terminal-border rounded px-2 py-1 
                         text-terminal-text text-xs focus:border-terminal-green outline-none"
            />
          </div>
          <div className="flex justify-end gap-1">
            <button
              onClick={() => setShowAdd(false)}
              className="px-2 py-0.5 text-xs text-terminal-dim hover:text-terminal-text"
            >
              Cancel
            </button>
            <button
              onClick={addLink}
              className="px-2 py-0.5 text-xs bg-terminal-green/20 text-terminal-green rounded hover:bg-terminal-green/30"
            >
              Add
            </button>
          </div>
        </div>
      )}

      {/* Links Grid */}
      <div className="grid grid-cols-2 gap-1">
        {links.map((link) => (
          <div
            key={link.id}
            className="group relative bg-terminal-bg rounded p-2 border border-terminal-border 
                       hover:border-terminal-green/50 transition cursor-pointer"
            onClick={() => openLink(link.url)}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm">{link.icon}</span>
              <span className="text-terminal-text text-xs truncate">{link.name}</span>
            </div>
            
            {/* Delete button on hover */}
            <button
              onClick={(e) => { e.stopPropagation(); deleteLink(link.id); }}
              className="absolute top-1 right-1 p-0.5 text-terminal-dim hover:text-terminal-red 
                         opacity-0 group-hover:opacity-100 transition"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>

      {links.length === 0 && (
        <div className="text-terminal-dim text-xs text-center py-2 italic">No links saved</div>
      )}
    </div>
  );
}


