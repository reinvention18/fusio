'use client';
import { generateId } from '../lib/generateId';

import { useState, useRef } from 'react';
import { FileText, Upload, Trash2, Eye, Clock, CheckCircle, AlertCircle } from 'lucide-react';

interface DigestedDoc {
  id: string;
  name: string;
  pages: number;
  size: string;
  status: 'processing' | 'completed' | 'error';
  summary?: string;
  processedAt: Date;
  processingTime?: number; // ms
}

export default function PdfDigester() {
  const [documents, setDocuments] = useState<DigestedDoc[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<DigestedDoc | null>(null);
  const [processing, setProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (const file of Array.from(files)) {
      if (!file.name.endsWith('.pdf')) {
        alert('Only PDF files are supported');
        continue;
      }

      const doc: DigestedDoc = {
        id: generateId(),
        name: file.name,
        pages: 0,
        size: formatFileSize(file.size),
        status: 'processing',
        processedAt: new Date(),
      };

      setDocuments(prev => [...prev, doc]);
      setProcessing(true);

      // Simulate processing - in production, this would send to OpenClaw for actual processing
      const startTime = Date.now();
      
      // Simulate reading and processing
      await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
      
      const pages = Math.floor(Math.random() * 50) + 5;
      const processingTime = Date.now() - startTime;
      
      // Generate mock summary
      const summary = generateMockSummary(file.name, pages);

      setDocuments(prev => prev.map(d => 
        d.id === doc.id 
          ? { 
              ...d, 
              status: 'completed' as const, 
              pages, 
              processingTime,
              summary 
            }
          : d
      ));
    }

    setProcessing(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const generateMockSummary = (filename: string, pages: number) => {
    const summaries = [
      `Document contains ${pages} pages of technical documentation covering system architecture, API specifications, and implementation details.`,
      `${pages}-page report including financial data, quarterly analysis, and projections for upcoming fiscal periods.`,
      `Comprehensive guide spanning ${pages} pages with step-by-step instructions, diagrams, and troubleshooting sections.`,
      `Legal document with ${pages} pages covering terms, conditions, liability clauses, and compliance requirements.`,
    ];
    return summaries[Math.floor(Math.random() * summaries.length)];
  };

  const deleteDocument = (id: string) => {
    setDocuments(prev => prev.filter(d => d.id !== id));
    if (selectedDoc?.id === id) {
      setSelectedDoc(null);
    }
  };

  const getStatusIcon = (status: DigestedDoc['status']) => {
    switch (status) {
      case 'processing':
        return <Clock className="w-4 h-4 text-terminal-amber animate-pulse" />;
      case 'completed':
        return <CheckCircle className="w-4 h-4 text-terminal-green" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-terminal-red" />;
    }
  };

  const totalPages = documents.reduce((sum, d) => sum + d.pages, 0);
  const avgSpeed = documents.filter(d => d.processingTime).length > 0
    ? Math.round(totalPages / (documents.reduce((sum, d) => sum + (d.processingTime || 0), 0) / 1000))
    : 0;

  return (
    <div
      style={{
        background: 'var(--ink, #0A0A0E)',
        border: '1px solid var(--line, rgba(255,255,255,0.08))',
        borderRadius: 12,
        padding: 16,
        fontFamily: 'var(--font-sans, system-ui)',
        color: 'var(--white, #fff)',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 24, height: 24, borderRadius: 6,
              background: 'rgba(94, 196, 217, 0.12)',
              border: '1px solid rgba(94, 196, 217, 0.35)',
            }}
          >
            <FileText style={{ width: 12, height: 12, color: 'var(--cyan, #5EC4D9)' }} />
          </span>
          <div>
            <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))' }}>
              Knowledge · Ingest
            </div>
            <div style={{ fontFamily: 'var(--font-display, "Space Grotesk")', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 1 }}>
              PDF digester
            </div>
          </div>
        </div>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 14,
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
            color: 'var(--mist, rgba(255,255,255,0.5))',
          }}
        >
          <span><span style={{ color: 'var(--white, #fff)' }}>{documents.length}</span> docs</span>
          <span><span style={{ color: 'var(--white, #fff)' }}>{totalPages}</span> pages</span>
          {avgSpeed > 0 && <span><span style={{ color: 'var(--green, #4CC38A)' }}>{avgSpeed}</span> p/s</span>}
        </div>
      </div>

      {/* Upload Area — Fusio dropzone */}
      <div
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: '2px dashed var(--line, rgba(255,255,255,0.08))',
          borderRadius: 12,
          padding: 28,
          textAlign: 'center',
          cursor: 'pointer',
          marginBottom: 16,
          background: 'var(--ink-2, #131319)',
          transition: 'all 120ms ease-out',
        }}
        onMouseEnter={e => {
          const el = e.currentTarget as HTMLElement;
          el.style.borderColor = 'rgba(94, 196, 217, 0.4)';
          el.style.background = 'rgba(94, 196, 217, 0.04)';
        }}
        onMouseLeave={e => {
          const el = e.currentTarget as HTMLElement;
          el.style.borderColor = 'var(--line, rgba(255,255,255,0.08))';
          el.style.background = 'var(--ink-2, #131319)';
        }}
      >
        <Upload style={{ width: 28, height: 28, color: 'var(--mist, rgba(255,255,255,0.5))', margin: '0 auto 8px', display: 'block' }} />
        <div style={{ fontSize: 13, color: 'var(--white, #fff)', fontWeight: 500 }}>
          Drop PDFs here or click to upload
        </div>
        <div style={{ fontFamily: 'var(--font-mono, ui-monospace)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--mist, rgba(255,255,255,0.5))', marginTop: 6 }}>
          Documents process at ~50 pages/sec
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf"
          multiple
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
      </div>

      {/* Documents List */}
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {documents.map((doc) => (
          <div
            key={doc.id}
            onClick={() => setSelectedDoc(doc)}
            className={`bg-terminal-bg rounded p-3 cursor-pointer transition border ${
              selectedDoc?.id === doc.id 
                ? 'border-terminal-green' 
                : 'border-terminal-border hover:border-terminal-green/50'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {getStatusIcon(doc.status)}
                <span className="text-terminal-text truncate">{doc.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-terminal-dim text-xs">{doc.pages} pages</span>
                <span className="text-terminal-dim text-xs">{doc.size}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteDocument(doc.id); }}
                  className="p-1 text-terminal-red/50 hover:text-terminal-red transition"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
            
            {doc.status === 'completed' && doc.processingTime && (
              <div className="text-terminal-dim text-xs mt-1">
                Processed in {(doc.processingTime / 1000).toFixed(1)}s 
                ({Math.round(doc.pages / (doc.processingTime / 1000))} pages/sec)
              </div>
            )}
          </div>
        ))}

        {documents.length === 0 && (
          <div className="text-terminal-dim text-center py-8 italic">
            No documents uploaded
          </div>
        )}
      </div>

      {/* Document Detail Modal */}
      {selectedDoc && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="fusio-panel p-6 w-full max-w-lg">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-terminal-green font-bold flex items-center gap-2">
                <FileText className="w-5 h-5" />
                DOCUMENT DIGEST
              </h3>
              {getStatusIcon(selectedDoc.status)}
            </div>

            <div className="space-y-4">
              <div>
                <div className="text-terminal-dim text-xs mb-1">FILENAME</div>
                <div className="text-terminal-text">{selectedDoc.name}</div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="bg-terminal-bg rounded p-3">
                  <div className="text-terminal-dim text-xs mb-1">PAGES</div>
                  <div className="text-terminal-cyan text-lg">{selectedDoc.pages}</div>
                </div>
                <div className="bg-terminal-bg rounded p-3">
                  <div className="text-terminal-dim text-xs mb-1">SIZE</div>
                  <div className="text-terminal-text">{selectedDoc.size}</div>
                </div>
                <div className="bg-terminal-bg rounded p-3">
                  <div className="text-terminal-dim text-xs mb-1">SPEED</div>
                  <div className="text-terminal-amber">
                    {selectedDoc.processingTime 
                      ? `${Math.round(selectedDoc.pages / (selectedDoc.processingTime / 1000))} p/s`
                      : '--'
                    }
                  </div>
                </div>
              </div>

              {selectedDoc.summary && (
                <div>
                  <div className="text-terminal-dim text-xs mb-1">AI SUMMARY</div>
                  <div className="bg-terminal-bg rounded p-3 text-terminal-text text-sm">
                    {selectedDoc.summary}
                  </div>
                </div>
              )}

              <div>
                <div className="text-terminal-dim text-xs mb-1">PROCESSED</div>
                <div className="text-terminal-text text-sm">
                  {selectedDoc.processedAt.toLocaleString()}
                </div>
              </div>
            </div>

            <div className="flex justify-between mt-6">
              <button
                onClick={() => deleteDocument(selectedDoc.id)}
                className="px-4 py-2 text-terminal-red hover:bg-terminal-red/20 rounded transition"
              >
                Delete
              </button>
              <button
                onClick={() => setSelectedDoc(null)}
                className="px-4 py-2 text-terminal-dim hover:text-terminal-text transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


