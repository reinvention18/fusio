'use client';

import { useState, useEffect } from 'react';
import { Brain, RefreshCw, FileText, ChevronRight } from 'lucide-react';

interface MemoryFile {
  name: string;
  path: string;
  size: string;
  modified: Date;
  preview?: string;
}

export default function MemoryViewer() {
  const [files, setFiles] = useState<MemoryFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<MemoryFile | null>(null);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Mock memory files - in production, would read from workspace
    const mockFiles: MemoryFile[] = [
      { name: 'MEMORY.md', path: '/MEMORY.md', size: '2.4 KB', modified: new Date(Date.now() - 3600000), preview: 'Persistent context and decisions...' },
      { name: 'SOUL.md', path: '/SOUL.md', size: '1.1 KB', modified: new Date(Date.now() - 86400000), preview: 'Core identity and personality...' },
      { name: 'BOOTSTRAP.md', path: '/BOOTSTRAP.md', size: '8.2 KB', modified: new Date(Date.now() - 172800000), preview: 'Project context and setup...' },
      { name: 'TOOLS.md', path: '/TOOLS.md', size: '1.8 KB', modified: new Date(Date.now() - 259200000), preview: 'Development tools and commands...' },
    ];
    setFiles(mockFiles);
  }, []);

  const loadFile = (file: MemoryFile) => {
    setSelectedFile(file);
    setLoading(true);
    // Simulate loading file content
    setTimeout(() => {
      const mockContent = `# ${file.name}\n\nThis is the content of ${file.name}.\n\n${file.preview || ''}\n\n---\n\nFile loaded from workspace at ${file.path}`;
      setContent(mockContent);
      setLoading(false);
    }, 500);
  };

  const formatDate = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / 3600000);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  return (
    <div className="fusio-panel p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 5, background: 'rgba(139, 111, 232, 0.12)', border: '1px solid rgba(139, 111, 232, 0.35)' }}>
            <Brain style={{ width: 11, height: 11, color: 'var(--violet, #8B6FE8)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Knowledge · Files
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--white, #fff)', marginTop: 1 }}>
              Memory
            </div>
          </div>
        </div>
        <button
          onClick={() => setFiles([...files])}
          className="p-1 text-terminal-dim hover:text-terminal-green rounded transition"
          title="Refresh"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>

      {/* File List */}
      <div className="space-y-1 mb-2">
        {files.map((file) => (
          <button
            key={file.path}
            onClick={() => loadFile(file)}
            className={`w-full flex items-center gap-2 p-2 rounded text-left transition ${
              selectedFile?.path === file.path 
                ? 'bg-terminal-green/20 border border-terminal-green/50' 
                : 'bg-terminal-bg border border-terminal-border hover:border-terminal-green/30'
            }`}
          >
            <FileText className="w-3 h-3 text-terminal-cyan flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-terminal-text text-xs font-medium truncate">{file.name}</div>
              <div className="text-terminal-dim text-xs truncate">{file.preview}</div>
            </div>
            <div className="text-terminal-dim text-xs flex-shrink-0">{formatDate(file.modified)}</div>
            <ChevronRight className="w-3 h-3 text-terminal-dim flex-shrink-0" />
          </button>
        ))}
      </div>

      {/* Content Preview */}
      {selectedFile && (
        <div className="bg-terminal-bg rounded p-2 max-h-48 overflow-y-auto">
          {loading ? (
            <div className="text-terminal-dim text-xs text-center py-4">Loading...</div>
          ) : (
            <pre className="text-terminal-text text-xs whitespace-pre-wrap">{content}</pre>
          )}
        </div>
      )}
    </div>
  );
}
