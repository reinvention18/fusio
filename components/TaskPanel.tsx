'use client';

import { useState, useEffect, useRef } from 'react';
import { 
  Zap, CheckCircle, Circle, Loader2, X, Send, ChevronDown, 
  ChevronUp, Clock, AlertTriangle, RefreshCw, MessageSquare,
  FileText, Play, Pause, SkipForward, HelpCircle, Minimize2,
  Maximize2, RotateCcw
} from 'lucide-react';

export interface TaskItem {
  id: string;
  text: string;
  priority: string;
  status: 'pending' | 'in-progress' | 'done' | 'failed';
}

export interface ActiveTask {
  id: string;
  label: string;
  sessionKey: string;
  prompt: string;
  filePath?: string;
  status: 'loading' | 'clarifying' | 'running' | 'paused' | 'completed' | 'failed';
  items: TaskItem[];
  currentItemIndex: number;
  output: string;
  questions?: string;
  startedAt: Date;
  completedAt?: Date;
}

interface TaskPanelProps {
  task: ActiveTask;
  onClose: () => void;
  onSendMessage: (message: string) => void;
  onStartExecution: () => void;
  onPauseExecution: () => void;
  onSkipItem: () => void;
  onAnswerQuestions: (answer: string) => void;
  onRetryFailed: () => void;
  onResumeFromItem: (itemIndex: number) => void;
  isMinimized: boolean;
  onToggleMinimize: () => void;
  gatewayUrl?: string;
  token?: string;
}

// Simple markdown-like formatting for output
function formatOutput(text: string): React.ReactNode {
  if (!text) return 'Waiting for output...';
  
  // Split into lines and process
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  
  lines.forEach((line, i) => {
    // Headers
    if (line.startsWith('## ')) {
      elements.push(
        <div key={i} className="text-terminal-cyan font-bold mt-3 mb-1 text-sm">
          {line.replace('## ', '')}
        </div>
      );
    } else if (line.startsWith('# ')) {
      elements.push(
        <div key={i} className="text-terminal-purple font-bold mt-4 mb-2 text-base">
          {line.replace('# ', '')}
        </div>
      );
    }
    // Task status lines
    else if (line.startsWith('🔄 **Task')) {
      elements.push(
        <div key={i} className="text-terminal-amber font-medium mt-2">
          {line.replace(/\*\*/g, '')}
        </div>
      );
    } else if (line.startsWith('✅')) {
      elements.push(
        <div key={i} className="text-terminal-green mt-1">
          {line}
        </div>
      );
    } else if (line.startsWith('❌')) {
      elements.push(
        <div key={i} className="text-terminal-red mt-1">
          {line}
        </div>
      );
    } else if (line.startsWith('🛑')) {
      elements.push(
        <div key={i} className="text-terminal-red font-bold mt-2 p-2 bg-terminal-red/10 rounded">
          {line}
        </div>
      );
    }
    // Bold text
    else if (line.includes('**')) {
      const parts = line.split(/(\*\*[^*]+\*\*)/);
      elements.push(
        <div key={i} className="text-terminal-text">
          {parts.map((part, j) => 
            part.startsWith('**') && part.endsWith('**') 
              ? <span key={j} className="font-bold text-terminal-cyan">{part.slice(2, -2)}</span>
              : part
          )}
        </div>
      );
    }
    // Code blocks
    else if (line.startsWith('```')) {
      elements.push(<div key={i} className="text-terminal-dim text-[10px]">{line}</div>);
    }
    // Regular lines
    else if (line.trim()) {
      elements.push(
        <div key={i} className="text-terminal-text">{line}</div>
      );
    } else {
      elements.push(<div key={i} className="h-2" />);
    }
  });
  
  return elements;
}

export default function TaskPanel({ 
  task, 
  onClose, 
  onSendMessage, 
  onStartExecution,
  onPauseExecution,
  onSkipItem,
  onAnswerQuestions,
  onRetryFailed,
  onResumeFromItem,
  isMinimized,
  onToggleMinimize,
  gatewayUrl, 
  token 
}: TaskPanelProps) {
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState(true);
  const outputRef = useRef<HTMLDivElement>(null);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [task.output]);

  const handleSend = () => {
    if (!input.trim()) return;
    
    if (task.status === 'clarifying') {
      onAnswerQuestions(input.trim());
    } else {
      onSendMessage(input.trim());
    }
    setInput('');
  };

  const getStatusIcon = (status: TaskItem['status']) => {
    switch (status) {
      case 'done':
        return <CheckCircle className="w-4 h-4 text-terminal-green" />;
      case 'in-progress':
        return <Loader2 className="w-4 h-4 text-terminal-amber animate-spin" />;
      case 'failed':
        return <AlertTriangle className="w-4 h-4 text-terminal-red" />;
      default:
        return <Circle className="w-4 h-4 text-terminal-dim" />;
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'critical': return 'text-terminal-red bg-terminal-red/10';
      case 'high': return 'text-terminal-amber bg-terminal-amber/10';
      case 'medium': return 'text-terminal-green bg-terminal-green/10';
      case 'low': return 'text-terminal-cyan bg-terminal-cyan/10';
      default: return 'text-terminal-dim bg-terminal-dim/10';
    }
  };

  const completedCount = task.items.filter(i => i.status === 'done').length;
  const failedCount = task.items.filter(i => i.status === 'failed').length;
  const progress = task.items.length > 0 ? (completedCount / task.items.length) * 100 : 0;
  
  // Find first failed item index for retry
  const firstFailedIndex = task.items.findIndex(i => i.status === 'failed');

  const formatDuration = (start: Date, end?: Date) => {
    const ms = (end || new Date()).getTime() - new Date(start).getTime();
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  };

  const getStatusBadge = () => {
    switch (task.status) {
      case 'loading':
        return (
          <span className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-terminal-cyan/20 text-terminal-cyan">
            <Loader2 className="w-3 h-3 animate-spin" />
            Loading...
          </span>
        );
      case 'clarifying':
        return (
          <span className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-terminal-purple/20 text-terminal-purple">
            <HelpCircle className="w-3 h-3" />
            Questions
          </span>
        );
      case 'running':
        return (
          <span className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-terminal-amber/20 text-terminal-amber">
            <Loader2 className="w-3 h-3 animate-spin" />
            Running
          </span>
        );
      case 'paused':
        return (
          <span className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-terminal-amber/20 text-terminal-amber">
            <Pause className="w-3 h-3" />
            Paused
          </span>
        );
      case 'completed':
        return (
          <span className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-terminal-green/20 text-terminal-green">
            <CheckCircle className="w-3 h-3" />
            Completed
          </span>
        );
      case 'failed':
        return (
          <span className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-terminal-red/20 text-terminal-red">
            <AlertTriangle className="w-3 h-3" />
            Failed
          </span>
        );
    }
  };

  // Minimized view - floating bar at bottom right
  if (isMinimized) {
    return (
      <div className="fixed bottom-20 md:bottom-6 right-4 md:right-6 z-[100]">
        <button
          onClick={onToggleMinimize}
          className="flex items-center gap-3 px-4 py-3 bg-terminal-surface border-2 border-terminal-purple/50 
                     rounded-lg shadow-2xl hover:border-terminal-purple hover:bg-terminal-purple/10 
                     transition-all duration-200 cursor-pointer group"
        >
          <Zap className="w-5 h-5 text-terminal-purple" />
          <div className="flex flex-col items-start">
            <span className="text-sm font-bold text-terminal-text">
              Tasks ({completedCount}/{task.items.length})
            </span>
            <span className="text-xs text-terminal-dim">
              {task.status === 'failed' ? `${failedCount} failed` : task.status}
            </span>
          </div>
          {getStatusBadge()}
          <Maximize2 className="w-5 h-5 text-terminal-purple group-hover:scale-110 transition-transform" />
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[90] md:relative md:inset-auto md:z-auto w-full border-l border-terminal-border bg-terminal-surface flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-terminal-border bg-terminal-purple/10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-terminal-purple" />
            <span className="font-bold text-terminal-purple text-sm">TASK PANEL</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onToggleMinimize}
              className="p-1 text-terminal-dim hover:text-terminal-cyan transition"
              title="Minimize panel"
            >
              <Minimize2 className="w-4 h-4" />
            </button>
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-1 text-terminal-dim hover:text-terminal-text transition"
            >
              {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
            </button>
            <button
              onClick={onClose}
              className="p-1 text-terminal-dim hover:text-terminal-red transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        
        {/* Status & Controls */}
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2">
            {getStatusBadge()}
            <span className="text-xs text-terminal-dim flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDuration(task.startedAt, task.completedAt)}
            </span>
          </div>
          
          {/* Control Buttons */}
          {task.status === 'running' && (
            <div className="flex items-center gap-1">
              <button
                onClick={onPauseExecution}
                className="p-1 text-terminal-dim hover:text-terminal-amber transition"
                title="Pause"
              >
                <Pause className="w-4 h-4" />
              </button>
              <button
                onClick={onSkipItem}
                className="p-1 text-terminal-dim hover:text-terminal-cyan transition"
                title="Skip current item"
              >
                <SkipForward className="w-4 h-4" />
              </button>
            </div>
          )}
          
          {task.status === 'paused' && (
            <button
              onClick={onStartExecution}
              className="flex items-center gap-1 px-2 py-1 bg-terminal-green/20 text-terminal-green 
                         rounded text-xs hover:bg-terminal-green/30 transition"
            >
              <Play className="w-3 h-3" />
              Resume
            </button>
          )}
          
          {/* Retry/Resume buttons for failed tasks */}
          {task.status === 'failed' && (
            <div className="flex items-center gap-1">
              {firstFailedIndex >= 0 && (
                <button
                  onClick={() => onResumeFromItem(firstFailedIndex)}
                  className="flex items-center gap-1 px-2 py-1 bg-terminal-amber/20 text-terminal-amber 
                             rounded text-xs hover:bg-terminal-amber/30 transition"
                  title={`Resume from task ${firstFailedIndex + 1}`}
                >
                  <Play className="w-3 h-3" />
                  Resume
                </button>
              )}
              <button
                onClick={onRetryFailed}
                className="flex items-center gap-1 px-2 py-1 bg-terminal-red/20 text-terminal-red 
                           rounded text-xs hover:bg-terminal-red/30 transition"
                title="Retry all failed tasks"
              >
                <RotateCcw className="w-3 h-3" />
                Retry Failed
              </button>
            </div>
          )}
        </div>
        
        {/* Failed count warning */}
        {failedCount > 0 && task.status !== 'running' && (
          <div className="mt-2 text-xs text-terminal-red flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            {failedCount} task{failedCount > 1 ? 's' : ''} failed
          </div>
        )}
        
        {/* File Path */}
        {task.filePath && (
          <div className="flex items-center gap-1 mt-2 text-xs text-terminal-dim">
            <FileText className="w-3 h-3" />
            <span className="truncate">{task.filePath}</span>
          </div>
        )}
      </div>

      {expanded && (
        <>
          {/* Clarifying Questions */}
          {task.status === 'clarifying' && task.questions && (
            <div className="flex flex-col border-b border-terminal-border bg-terminal-purple/5 flex-shrink min-h-0" style={{ maxHeight: 'min(60vh, calc(100% - 120px))' }}>
              <div className="p-3 pb-0 flex-shrink-0">
                <div className="flex items-center gap-2 mb-2">
                  <HelpCircle className="w-4 h-4 text-terminal-purple" />
                  <span className="text-xs font-bold text-terminal-purple">QUESTIONS BEFORE STARTING</span>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-3 pt-0 min-h-0">
                <div className="text-sm text-terminal-text whitespace-pre-wrap">
                  {task.questions}
                </div>
              </div>
              <div className="p-3 pt-2 flex-shrink-0 sticky bottom-0 bg-terminal-purple/5">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                    placeholder="Type your answers..."
                    className="flex-1 bg-terminal-bg border border-terminal-purple/30 rounded px-2 py-1.5 
                               text-terminal-text text-xs focus:border-terminal-purple outline-none"
                  />
                  <button
                    onClick={handleSend}
                    disabled={!input.trim()}
                    className="px-3 py-1.5 bg-terminal-purple/20 text-terminal-purple rounded 
                               hover:bg-terminal-purple/30 transition disabled:opacity-50"
                  >
                    <Send className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Progress Bar */}
          {task.items.length > 0 && (
            <div className="px-3 py-2 border-b border-terminal-border">
              <div className="flex items-center justify-between text-xs text-terminal-dim mb-1">
                <span>Progress</span>
                <span>
                  {completedCount}/{task.items.length} tasks
                  {failedCount > 0 && <span className="text-terminal-red ml-1">({failedCount} failed)</span>}
                </span>
              </div>
              <div className="h-2 bg-terminal-bg rounded-full overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-terminal-purple to-terminal-cyan transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Task Items - Collapsible */}
          {task.items.length > 0 && (
            <details className="border-b border-terminal-border" open={task.items.length <= 10}>
              <summary className="px-3 py-2 cursor-pointer text-xs text-terminal-dim font-bold flex items-center justify-between hover:bg-terminal-surface/50">
                <span>TASK LIST ({task.items.length} items)</span>
                {task.currentItemIndex >= 0 && task.currentItemIndex < task.items.length && (
                  <span className="text-terminal-amber">
                    Current: {task.currentItemIndex + 1}
                  </span>
                )}
              </summary>
              <div className="max-h-48 overflow-y-auto px-3 pb-2">
                <div className="space-y-1.5">
                  {task.items.map((item, index) => (
                    <div 
                      key={item.id} 
                      className={`flex items-start gap-2 p-1.5 rounded transition ${
                        index === task.currentItemIndex ? 'bg-terminal-amber/10 border border-terminal-amber/30' : ''
                      } ${item.status === 'failed' ? 'bg-terminal-red/5' : ''}`}
                    >
                      {getStatusIcon(item.status)}
                      <div className="flex-1 min-w-0">
                        <span className={`text-xs block ${
                          item.status === 'done' ? 'text-terminal-dim line-through' :
                          item.status === 'in-progress' ? 'text-terminal-amber' :
                          item.status === 'failed' ? 'text-terminal-red' :
                          'text-terminal-text'
                        }`}>
                          {item.text}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        {item.status === 'failed' && task.status !== 'running' && (
                          <button
                            onClick={() => onResumeFromItem(index)}
                            className="p-0.5 text-terminal-amber hover:text-terminal-amber/80 transition"
                            title="Retry from here"
                          >
                            <RotateCcw className="w-3 h-3" />
                          </button>
                        )}
                        <span className={`text-[10px] px-1 py-0.5 rounded ${getPriorityColor(item.priority)}`}>
                          {item.priority.charAt(0).toUpperCase()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          )}

          {/* Live Output - styled like chat */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-3 py-2 border-b border-terminal-border flex items-center justify-between">
              <span className="text-xs text-terminal-dim font-bold">LIVE OUTPUT</span>
              {task.status === 'running' && (
                <Loader2 className="w-3 h-3 text-terminal-cyan animate-spin" />
              )}
            </div>
            <div 
              ref={outputRef}
              className="flex-1 p-3 overflow-y-auto text-sm leading-relaxed bg-terminal-bg"
            >
              {formatOutput(task.output)}
            </div>
          </div>

          {/* Chat Input (when not in clarifying mode) */}
          {task.status !== 'clarifying' && (
            <div className="p-3 border-t border-terminal-border flex-shrink-0">
              <div className="text-xs text-terminal-dim mb-2 flex items-center gap-1">
                <MessageSquare className="w-3 h-3" />
                Send follow-up message
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                  placeholder="Ask about this task..."
                  className="flex-1 bg-terminal-bg border border-terminal-border rounded px-2 py-1.5 
                             text-terminal-text text-sm focus:border-terminal-purple outline-none"
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  className="px-3 py-1.5 bg-terminal-purple/20 text-terminal-purple rounded 
                             hover:bg-terminal-purple/30 transition disabled:opacity-50"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Helper to extract file path from user input
export function extractFilePath(input: string): string | null {
  // Match common file path patterns (order matters - more specific first)
  const patterns = [
    /`([^`]+\.md)`/i,                          // `path/to/file.md`
    /"([^"]+\.md)"/i,                          // "path/to/file.md" (quoted)
    /'([^']+\.md)'/i,                          // 'path/to/file.md' (single quoted)
    /([A-Z]:\\[^`"'\n]+\.md)/i,                // C:\path\file.md (Windows - allow spaces, stop at quotes/newlines)
    /(\/[^`"'\n]+\.md)/i,                      // /path/file.md (Unix - allow spaces)
    /(?:from|in|at|file:?)\s*[`"']?([^\s`"']+\.md)/i, // from path/file.md
    /([.\w/-]+\.md)/i,                         // relative/path.md
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) {
      // Trim any trailing whitespace that might have been captured
      return match[1].trim();
    }
  }

  return null;
}

// Legacy helper - parse from agent output
export function parseTaskItems(output: string): TaskItem[] {
  const items: TaskItem[] = [];
  let index = 0;
  
  // Pattern 1: Standard markdown checkboxes: - [ ] task or - [x] task
  const checkboxRegex = /^[\s-]*\[([x ])\]\s*(.+)$/gm;
  let match;
  
  while ((match = checkboxRegex.exec(output)) !== null) {
    items.push({
      id: `item-${index++}`,
      text: match[2].trim(),
      priority: 'medium',
      status: match[1] === 'x' ? 'done' : 'pending',
    });
  }
  
  // Pattern 2: Numbered task headings like ### T-001: Title with Status: [ ] or Status: [x]
  if (items.length === 0) {
    const headingRegex = /^#{1,4}\s*(T-\d+):\s*(.+)$/gm;
    const statusRegex = /\*?\*?Status:?\*?\*?\s*\[([x ]?)\]/i;
    const lines = output.split('\n');
    let currentTask: { id: string; title: string } | null = null;
    let currentBlock = '';
    
    for (const line of lines) {
      const headingMatch = line.match(/^#{1,4}\s*(T-\d+):\s*(.+)$/);
      if (headingMatch) {
        // Save previous task
        if (currentTask) {
          const statusMatch = currentBlock.match(statusRegex);
          const isDone = statusMatch ? statusMatch[1] === 'x' : false;
          items.push({
            id: `item-${index++}`,
            text: `${currentTask.id}: ${currentTask.title}`,
            priority: 'medium',
            status: isDone ? 'done' : 'pending',
          });
        }
        currentTask = { id: headingMatch[1], title: headingMatch[2].trim() };
        currentBlock = '';
      } else if (currentTask) {
        currentBlock += line + '\n';
      }
    }
    // Don't forget the last task
    if (currentTask) {
      const statusMatch = currentBlock.match(statusRegex);
      const isDone = statusMatch ? statusMatch[1] === 'x' : false;
      items.push({
        id: `item-${index++}`,
        text: `${currentTask.id}: ${currentTask.title}`,
        priority: 'medium',
        status: isDone ? 'done' : 'pending',
      });
    }
  }
  
  // Pattern 3: Numbered headings like ### 1. Title or ## 1) Title
  if (items.length === 0) {
    const numberedRegex = /^#{1,4}\s*(\d+)[.)]\s*(.+)$/gm;
    while ((match = numberedRegex.exec(output)) !== null) {
      items.push({
        id: `item-${index++}`,
        text: match[2].trim(),
        priority: 'medium',
        status: 'pending',
      });
    }
  }
  
  return items;
}
