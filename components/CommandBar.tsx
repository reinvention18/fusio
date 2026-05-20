'use client';
import { generateId } from '../lib/generateId';

import { useState, useRef, useEffect } from 'react';
import { Terminal, Send, Loader2 } from 'lucide-react';

interface CommandHistory {
  id: string;
  command: string;
  response?: string;
  timestamp: Date;
  status: 'pending' | 'success' | 'error';
}

export default function CommandBar() {
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<CommandHistory[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Load history from localStorage
    const saved = localStorage.getItem('commandHistory');
    if (saved) {
      const parsed = JSON.parse(saved);
      setHistory(parsed.map((h: any) => ({ ...h, timestamp: new Date(h.timestamp) })));
    }
  }, []);

  useEffect(() => {
    // Scroll to bottom when history updates
    if (historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [history]);

  const saveHistory = (newHistory: CommandHistory[]) => {
    const trimmed = newHistory.slice(-50); // Keep last 50
    localStorage.setItem('commandHistory', JSON.stringify(trimmed));
    setHistory(trimmed);
  };

  const sendCommand = async () => {
    if (!command.trim() || isLoading) return;

    const newCmd: CommandHistory = {
      id: generateId(),
      command: command.trim(),
      timestamp: new Date(),
      status: 'pending',
    };

    saveHistory([...history, newCmd]);
    setCommand('');
    setIsLoading(true);

    // Simulate sending to agent (in production, this would use OpenClaw API)
    setTimeout(() => {
      const updatedHistory = [...history, newCmd].map(h => 
        h.id === newCmd.id 
          ? { ...h, status: 'success' as const, response: 'Command queued for processing. Check Activity feed for updates.' }
          : h
      );
      saveHistory(updatedHistory);
      setIsLoading(false);
    }, 1000);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCommand();
    }
  };

  return (
    <div className="fusio-panel p-3">
      <div className="flex items-center gap-2.5 mb-3">
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 5, background: 'rgba(204, 12, 32, 0.12)', border: '1px solid rgba(204, 12, 32, 0.35)' }}>
          <Terminal style={{ width: 11, height: 11, color: 'var(--red, #CC0C20)' }} />
        </span>
        <div>
          <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
            Tools · Shell
          </div>
          <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--white, #fff)', marginTop: 1 }}>
            Command
          </div>
        </div>
      </div>

      {/* History */}
      <div 
        ref={historyRef}
        className="bg-terminal-bg rounded p-2 h-32 overflow-y-auto mb-2 space-y-2"
      >
        {history.length === 0 ? (
          <div className="text-terminal-dim text-xs italic text-center py-4">
            Send commands to your agent
          </div>
        ) : (
          history.slice(-10).map((h) => (
            <div key={h.id} className="text-xs">
              <div className="flex items-start gap-1">
                <span className="text-terminal-cyan">→</span>
                <span className="text-terminal-text">{h.command}</span>
              </div>
              {h.response && (
                <div className="text-terminal-dim pl-3 mt-0.5">{h.response}</div>
              )}
            </div>
          ))
        )}
        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-terminal-amber">
            <Loader2 className="w-3 h-3 animate-spin" />
            Processing...
          </div>
        )}
      </div>

      {/* Input */}
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a command..."
          className="flex-1 bg-terminal-bg border border-terminal-border rounded px-3 py-1.5 
                     text-terminal-text text-sm focus:border-terminal-green outline-none"
        />
        <button
          onClick={sendCommand}
          disabled={isLoading || !command.trim()}
          className="p-1.5 bg-terminal-green/20 text-terminal-green rounded 
                     hover:bg-terminal-green/30 transition disabled:opacity-50"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}


