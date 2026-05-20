'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as TerminalIcon, Plus, X, Play, Square, Trash2 } from 'lucide-react';

// Dynamic xterm imports
let xtermLoaded = false;
let XTerminal: any;
let FitAddon: any;
let WebLinksAddon: any;

async function loadXterm() {
  if (xtermLoaded) return;
  const [xtermMod, fitMod, linksMod] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-web-links'),
  ]);
  XTerminal = xtermMod.Terminal;
  FitAddon = fitMod.FitAddon;
  WebLinksAddon = linksMod.WebLinksAddon;
  xtermLoaded = true;

  // Load xterm CSS
  if (typeof document !== 'undefined' && !document.getElementById('xterm-css')) {
    const link = document.createElement('link');
    link.id = 'xterm-css';
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css';
    document.head.appendChild(link);
  }
}

interface TermSession {
  id: string;
  name: string;
  history: string[];
  running: boolean;
  termId?: string;
}

export default function XTerminalPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const [sessions, setSessions] = useState<TermSession[]>([
    { id: 'term-1', name: 'Terminal 1', history: [], running: false },
  ]);
  const [activeSession, setActiveSession] = useState('term-1');
  const [commandInput, setCommandInput] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [ready, setReady] = useState(false);

  // Initialize xterm
  useEffect(() => {
    let destroyed = false;

    async function init() {
      await loadXterm();
      if (destroyed || !containerRef.current) return;

      const term = new XTerminal({
        theme: {
          background: '#0a0a0a',
          foreground: '#e0e0e0',
          cursor: '#00ff88',
          cursorAccent: '#0a0a0a',
          selectionBackground: '#00ff8833',
          black: '#1a1a2e',
          red: '#ff6b6b',
          green: '#00ff88',
          yellow: '#ffd93d',
          blue: '#6c5ce7',
          magenta: '#a855f7',
          cyan: '#00d4ff',
          white: '#e0e0e0',
          brightBlack: '#666666',
          brightRed: '#ff8888',
          brightGreen: '#88ffaa',
          brightYellow: '#ffee88',
          brightBlue: '#8888ff',
          brightMagenta: '#cc88ff',
          brightCyan: '#88eeff',
          brightWhite: '#ffffff',
        },
        fontFamily: 'JetBrains Mono, Fira Code, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: 5000,
        convertEol: true,
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());

      term.open(containerRef.current);
      fit.fit();

      termRef.current = term;
      fitAddonRef.current = fit;
      setReady(true);

      term.writeln('\x1b[32m╔══════════════════════════════════════╗\x1b[0m');
      term.writeln('\x1b[32m║\x1b[0m  \x1b[1;36mMission Control Terminal\x1b[0m            \x1b[32m║\x1b[0m');
      term.writeln('\x1b[32m║\x1b[0m  Type commands below, press Enter     \x1b[32m║\x1b[0m');
      term.writeln('\x1b[32m╚══════════════════════════════════════╝\x1b[0m');
      term.writeln('');

      // Handle resize
      const obs = new ResizeObserver(() => {
        try { fit.fit(); } catch {}
      });
      obs.observe(containerRef.current);

      return () => {
        obs.disconnect();
        term.dispose();
      };
    }

    init();
    return () => { destroyed = true; };
  }, []);

  const runCommand = useCallback(async (cmd: string) => {
    if (!cmd.trim() || !termRef.current) return;

    const term = termRef.current;
    term.writeln(`\x1b[1;32m$ \x1b[0m${cmd}`);

    setCommandHistory(prev => [...prev.slice(-50), cmd]);
    setHistoryIndex(-1);

    // Mark session as running
    setSessions(prev => prev.map(s =>
      s.id === activeSession ? { ...s, running: true } : s
    ));

    try {
      const ws = typeof localStorage !== 'undefined'
        ? JSON.parse(localStorage.getItem('gatewayConfig') || '{}').workspace || ''
        : '';

      const response = await fetch('/api/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, cwd: ws || undefined }),
      });

      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const msg = JSON.parse(data);
            if (msg.type === 'stdout' || msg.type === 'stderr') {
              const color = msg.type === 'stderr' ? '\x1b[31m' : '';
              const reset = msg.type === 'stderr' ? '\x1b[0m' : '';
              // Write each line separately for proper terminal rendering
              const lines = msg.data.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (i > 0) term.writeln('');
                if (lines[i]) term.write(`${color}${lines[i]}${reset}`);
              }
            } else if (msg.type === 'exit') {
              if (msg.code !== 0) {
                term.writeln(`\x1b[31m[exit code: ${msg.code}]\x1b[0m`);
              }
              term.writeln('');
            } else if (msg.type === 'error') {
              term.writeln(`\x1b[31mError: ${msg.message}\x1b[0m`);
            }
          } catch {}
        }
      }
    } catch (err: any) {
      term.writeln(`\x1b[31mError: ${err.message}\x1b[0m`);
    } finally {
      setSessions(prev => prev.map(s =>
        s.id === activeSession ? { ...s, running: false } : s
      ));
    }
  }, [activeSession]);

  const addSession = () => {
    const id = `term-${Date.now()}`;
    setSessions(prev => [...prev, { id, name: `Terminal ${prev.length + 1}`, history: [], running: false }]);
    setActiveSession(id);
  };

  const removeSession = (id: string) => {
    if (sessions.length <= 1) return;
    setSessions(prev => prev.filter(s => s.id !== id));
    if (activeSession === id) {
      const remaining = sessions.filter(s => s.id !== id);
      setActiveSession(remaining[0]?.id || '');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runCommand(commandInput);
      setCommandInput('');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const newIndex = historyIndex < commandHistory.length - 1 ? historyIndex + 1 : historyIndex;
        setHistoryIndex(newIndex);
        setCommandInput(commandHistory[commandHistory.length - 1 - newIndex] || '');
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setCommandInput(commandHistory[commandHistory.length - 1 - newIndex] || '');
      } else {
        setHistoryIndex(-1);
        setCommandInput('');
      }
    }
  };

  const currentSession = sessions.find(s => s.id === activeSession);

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', height: '100%',
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 12,
        overflow: 'hidden',
        fontFamily: 'var(--font-sans, system-ui)',
        color: 'var(--white, #fff)',
      }}
    >
      {/* Tab Bar */}
      <div
        style={{
          display: 'flex', alignItems: 'center',
          borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
          background: 'var(--ink-2, #131319)',
        }}
      >
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', overflowX: 'auto' }}>
          {sessions.map(session => {
            const active = activeSession === session.id;
            return (
              <button
                key={session.id}
                onClick={() => setActiveSession(session.id)}
                data-fusio
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '8px 14px',
                  fontFamily: 'var(--font-mono, ui-monospace)',
                  fontSize: 10.5,
                  letterSpacing: '0.1em',
                  borderRight: '1px solid var(--line, rgba(255,255,255,0.08))',
                  background: active ? 'var(--ink, #0A0A0E)' : 'transparent',
                  color: active ? 'var(--red, #CC0C20)' : 'var(--mist, rgba(255,255,255,0.5))',
                  border: 'none',
                  borderBottom: active ? '2px solid var(--red, #CC0C20)' : '2px solid transparent',
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                  transition: 'all 120ms ease-out',
                }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)'; }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
              >
                <TerminalIcon style={{ width: 11, height: 11 }} />
                {session.name}
                {session.running && (
                  <span
                    style={{
                      width: 6, height: 6,
                      borderRadius: '50%',
                      background: 'var(--green, #4CC38A)',
                      boxShadow: '0 0 6px rgba(76, 195, 138, 0.6)',
                      animation: 'fusio-pulse 1.6s ease-in-out infinite',
                    }}
                  />
                )}
                {sessions.length > 1 && (
                  <span
                    onClick={(e) => { e.stopPropagation(); removeSession(session.id); }}
                    style={{
                      marginLeft: 4,
                      display: 'inline-flex',
                      cursor: 'pointer',
                      transition: 'color 120ms ease-out',
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--red, #CC0C20)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'inherit'; }}
                  >
                    <X style={{ width: 10, height: 10 }} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <button
          onClick={addSession}
          title="New terminal"
          data-fusio
          style={{
            padding: '8px 12px',
            background: 'transparent',
            border: 'none',
            color: 'var(--mist, rgba(255,255,255,0.5))',
            cursor: 'pointer',
            transition: 'all 120ms ease-out',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--green, #4CC38A)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
        >
          <Plus style={{ width: 13, height: 13 }} />
        </button>
      </div>

      {/* Terminal Output */}
      <div ref={containerRef} className="flex-1 min-h-0" style={{ padding: '4px' }} />

      {/* Command Input */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 14px',
          borderTop: '1px solid var(--line, rgba(255,255,255,0.08))',
          background: 'var(--ink-2, #131319)',
        }}
      >
        <span
          style={{
            color: 'var(--red, #CC0C20)',
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: '0.04em',
          }}
        >
          $
        </span>
        <input
          type="text"
          value={commandInput}
          onChange={(e) => setCommandInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={currentSession?.running}
          placeholder={currentSession?.running ? 'Command running…' : 'Type command and press Enter'}
          data-fusio
          style={{
            flex: 1,
            background: 'transparent',
            color: 'var(--white, #fff)',
            fontSize: 13,
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            outline: 'none',
            border: 'none',
            opacity: currentSession?.running ? 0.5 : 1,
          }}
          autoFocus
        />
        {currentSession?.running ? (
          <button
            onClick={() => {
              // Could implement kill via API
              termRef.current?.writeln('\x1b[31m^C\x1b[0m');
            }}
            className="text-terminal-red hover:text-terminal-red transition"
            title="Stop"
          >
            <Square className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={() => { runCommand(commandInput); setCommandInput(''); }}
            disabled={!commandInput.trim()}
            className="text-terminal-green hover:text-terminal-green transition disabled:opacity-30"
            title="Run"
          >
            <Play className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
