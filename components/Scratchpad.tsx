'use client';

import { useState, useEffect } from 'react';
import { StickyNote, Save, Trash2 } from 'lucide-react';

export default function Scratchpad() {
  const [notes, setNotes] = useState('');
  const [saved, setSaved] = useState(true);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);

  useEffect(() => {
    const savedNotes = localStorage.getItem('scratchpadNotes');
    const savedTime = localStorage.getItem('scratchpadTime');
    if (savedNotes) {
      setNotes(savedNotes);
    }
    if (savedTime) {
      setLastSaved(new Date(savedTime));
    }
  }, []);

  useEffect(() => {
    // Auto-save after 2 seconds of inactivity
    const timer = setTimeout(() => {
      if (!saved && notes) {
        saveNotes();
      }
    }, 2000);

    return () => clearTimeout(timer);
  }, [notes, saved]);

  const saveNotes = () => {
    localStorage.setItem('scratchpadNotes', notes);
    localStorage.setItem('scratchpadTime', new Date().toISOString());
    setLastSaved(new Date());
    setSaved(true);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setNotes(e.target.value);
    setSaved(false);
  };

  const clearNotes = () => {
    if (confirm('Clear all notes?')) {
      setNotes('');
      localStorage.removeItem('scratchpadNotes');
      localStorage.removeItem('scratchpadTime');
      setLastSaved(null);
      setSaved(true);
    }
  };

  const formatTime = (date: Date | null) => {
    if (!date) return '';
    const mins = Math.floor((Date.now() - date.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="fusio-panel p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2.5">
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 5, background: 'rgba(232, 162, 59, 0.12)', border: '1px solid rgba(232, 162, 59, 0.35)' }}>
            <StickyNote style={{ width: 11, height: 11, color: 'var(--amber, #E8A23B)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Knowledge · Local
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--white, #fff)', marginTop: 1 }}>
              Notes
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {lastSaved && (
            <span className="text-terminal-dim text-xs">
              {saved ? `Saved ${formatTime(lastSaved)}` : 'Unsaved'}
            </span>
          )}
          <button
            onClick={saveNotes}
            disabled={saved}
            className={`p-1 rounded transition ${saved ? 'text-terminal-dim' : 'text-terminal-green hover:bg-terminal-green/20'}`}
          >
            <Save className="w-3 h-3" />
          </button>
          <button
            onClick={clearNotes}
            className="p-1 text-terminal-dim hover:text-terminal-red rounded transition"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      <textarea
        value={notes}
        onChange={handleChange}
        placeholder="Quick notes, ideas, reminders..."
        className="w-full h-32 bg-terminal-bg border border-terminal-border rounded p-2 
                   text-terminal-text text-xs resize-none focus:border-terminal-green outline-none
                   placeholder:text-terminal-dim"
      />
    </div>
  );
}
