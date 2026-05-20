'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Save, X, FileText, AlertTriangle } from 'lucide-react';

// CodeMirror imports (dynamic to avoid SSR issues)
let cmLoaded = false;
let EditorView: any;
let EditorState: any;
let basicSetup: any;
let keymap: any;
let oneDark: any;
let langJS: any;
let langPython: any;
let langJSON: any;
let langMarkdown: any;
let langHTML: any;
let langCSS: any;

async function loadCodeMirror() {
  if (cmLoaded) return;
  const [viewMod, stateMod, cmMod, jsMod, pyMod, jsonMod, mdMod, htmlMod, cssMod, themeMod] = await Promise.all([
    import('@codemirror/view'),
    import('@codemirror/state'),
    import('codemirror'),
    import('@codemirror/lang-javascript'),
    import('@codemirror/lang-python'),
    import('@codemirror/lang-json'),
    import('@codemirror/lang-markdown'),
    import('@codemirror/lang-html'),
    import('@codemirror/lang-css'),
    import('@codemirror/theme-one-dark'),
  ]);
  EditorView = viewMod.EditorView;
  EditorState = stateMod.EditorState;
  keymap = viewMod.keymap;
  basicSetup = cmMod.basicSetup;
  langJS = jsMod;
  langPython = pyMod;
  langJSON = jsonMod;
  langMarkdown = mdMod;
  langHTML = htmlMod;
  langCSS = cssMod;
  oneDark = themeMod.oneDark;
  cmLoaded = true;
}

function getLanguageExtension(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'js': case 'jsx': case 'mjs': return langJS.javascript({ jsx: true });
    case 'ts': case 'tsx': return langJS.javascript({ jsx: true, typescript: true });
    case 'py': return langPython.python();
    case 'json': return langJSON.json();
    case 'md': case 'mdx': return langMarkdown.markdown();
    case 'html': case 'htm': return langHTML.html();
    case 'css': case 'scss': return langCSS.css();
    default: return [];
  }
}

interface CodeEditorProps {
  filePath: string;
  onClose: () => void;
}

export default function CodeEditor({ filePath, onClose }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modified, setModified] = useState(false);
  const originalContent = useRef('');

  const saveFile = useCallback(async () => {
    if (!viewRef.current) return;
    setSaving(true);
    setError(null);
    try {
      const content = viewRef.current.state.doc.toString();
      const res = await fetch('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Save failed: ${res.status}`);
      }
      originalContent.current = content;
      setModified(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }, [filePath]);

  useEffect(() => {
    let destroyed = false;

    async function init() {
      await loadCodeMirror();
      if (destroyed || !containerRef.current) return;

      // Fetch file content
      try {
        const res = await fetch(`/api/files?path=${encodeURIComponent(filePath)}`);
        if (!res.ok) throw new Error(`Failed to load file: ${res.status}`);
        const data = await res.json();
        const content = data.content || '';
        originalContent.current = content;

        if (destroyed || !containerRef.current) return;

        const state = EditorState.create({
          doc: content,
          extensions: [
            basicSetup,
            oneDark,
            getLanguageExtension(filePath),
            EditorView.updateListener.of((update: any) => {
              if (update.docChanged) {
                setModified(update.state.doc.toString() !== originalContent.current);
              }
            }),
            keymap.of([{
              key: 'Mod-s',
              run: () => { saveFile(); return true; },
            }]),
            EditorView.theme({
              '&': { height: '100%', fontSize: '13px' },
              '.cm-scroller': { overflow: 'auto' },
            }),
          ],
        });

        viewRef.current = new EditorView({
          state,
          parent: containerRef.current,
        });
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    init();

    return () => {
      destroyed = true;
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [filePath, saveFile]);

  const fileName = filePath.split('/').pop() || filePath;

  return (
    <div className="flex flex-col h-full bg-terminal-bg border border-terminal-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border bg-terminal-surface">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-4 h-4 text-terminal-cyan flex-shrink-0" />
          <span className="text-sm text-terminal-text font-mono truncate" title={filePath}>
            {fileName}
          </span>
          {modified && <span className="text-xs text-terminal-amber">(modified)</span>}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={saveFile}
            disabled={saving || !modified}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded transition
                       bg-terminal-green/20 text-terminal-green border border-terminal-green/30
                       hover:bg-terminal-green/30 disabled:opacity-30"
            title="Save (Ctrl+S)"
          >
            <Save className="w-3 h-3" />
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={onClose}
            className="p-1 text-terminal-dim hover:text-terminal-text rounded transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-2 bg-terminal-red/10 border-b border-terminal-red/30 text-terminal-red text-xs flex items-center gap-2">
          <AlertTriangle className="w-3 h-3" />
          {error}
        </div>
      )}

      {/* Editor */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-terminal-dim">
          Loading editor...
        </div>
      ) : (
        <div ref={containerRef} className="flex-1 overflow-hidden" />
      )}

      {/* Footer */}
      <div className="px-3 py-1 border-t border-terminal-border text-xs text-terminal-dim flex items-center justify-between">
        <span className="font-mono truncate">{filePath}</span>
        <span>Ctrl+S to save</span>
      </div>
    </div>
  );
}
