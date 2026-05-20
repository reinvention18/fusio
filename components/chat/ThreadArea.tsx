/**
 * ThreadArea — the virtualized message list, search overlay, date scrubber,
 * streaming bubble with activity strip, loading indicator, and tool-timeline
 * rail. Extracted from ChatPanel so render-side concerns live in one place.
 *
 * State still lives in ChatPanel — this is a pure view with callbacks. Keeps
 * the parent's streaming + activity machinery untouched.
 */

'use client';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Bot, ChevronDown, ChevronUp, Loader2, MessageSquare, Terminal } from 'lucide-react';
import type { SubAgent } from '../SubAgentTracker';
import { ActivityStrip } from './ActivityStrip';
import { ThreadSearch } from './ThreadSearch';
import { DateScrubber } from './DateScrubber';
import { MessageBubble, type BubbleMessage } from './MessageBubble';
import { OnboardingStrip } from './OnboardingStrip';
import { ToolCitations } from './ToolCitations';

export interface ThreadAreaProps {
  messages: BubbleMessage[];
  allMessages: BubbleMessage[];
  timelineEvents: BubbleMessage[];
  showTimelineRail: boolean;
  onToggleTimelineRail: () => void;
  hasHiddenMessages: boolean;
  maxDisplayed: number;
  onShowAll: () => void;
  streamingContent: string;
  isLoading: boolean;
  loadingElapsed: number;
  activity: {
    status: string;
    elapsedSec: number;
    toolsUsed?: number;
    subagentsRunning?: number;
    subagentsDone?: number;
    silentSec?: number;
  } | null;
  onStopGeneration: () => void;
  workspace?: string;
  onSeedPrompt: (prompt: string) => void;

  // Per-message callbacks
  activeMessageMenu: string | null;
  setActiveMessageMenu: (id: string | null) => void;
  editingMessageId: string | null;
  editingContent: string;
  setEditingContent: (s: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onCopy: (content: string) => void;
  onQuote: (content: string, role: BubbleMessage['role']) => void;
  onResend: (content: string) => void;
  onEdit: (msg: BubbleMessage) => void;
  onRegenerate: (msg: BubbleMessage) => void;
  onBranch: (msg: BubbleMessage) => void;
  onDelete: (id: string) => void;
  onRate?: (id: string, sentiment: 'up' | 'down' | null) => void;
  onPin?: (id: string, pinned: boolean) => void;
  onResolve?: (id: string, resolved: boolean) => void;
  renderContent: (msg: BubbleMessage) => React.ReactNode;
  formatTime: (ts: Date) => string;
  formatFileSize: (bytes: number) => string;
  messageMenuRef: React.RefObject<HTMLDivElement | null>;

  subAgents: SubAgent[];
  /** Parent-owned so ChatPanel can imperatively scroll when switching chats. */
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
}

export function ThreadArea(props: ThreadAreaProps) {
  const { messages, allMessages, timelineEvents, virtuosoRef } = props;

  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col px-2 py-3 md:p-4 relative">
        <ThreadSearch
          messages={messages as any}
          onJump={(i) => {
            try { virtuosoRef.current?.scrollToIndex({ index: i, align: 'center', behavior: 'smooth' }); } catch { /* ignore */ }
          }}
        />
        <DateScrubber
          messages={messages as any}
          onJump={(i) => {
            try { virtuosoRef.current?.scrollToIndex({ index: i, align: 'start', behavior: 'smooth' }); } catch { /* ignore */ }
          }}
        />

        {messages.length === 0 && !props.streamingContent && !props.isLoading && (
          <div className="text-center text-terminal-dim py-8">
            <MessageSquare className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No messages yet.</p>
            <p className="text-sm mt-2">Send a message to chat with your OpenClaw agent!</p>
            <OnboardingStrip workspace={props.workspace} onPick={props.onSeedPrompt} />
          </div>
        )}

        {props.hasHiddenMessages && (
          <div className="text-center py-1 flex-shrink-0">
            <button
              onClick={props.onShowAll}
              className="px-3 py-1 text-[11px] bg-terminal-bg/60 border border-terminal-border/60 rounded
                         hover:border-terminal-cyan text-terminal-dim hover:text-terminal-cyan transition"
            >
              ↑ {allMessages.length - props.maxDisplayed} older
            </button>
          </div>
        )}

        {messages.length > 0 && (
          <Virtuoso
            ref={virtuosoRef as any}
            style={{ flex: 1 }}
            data={messages}
            followOutput="smooth"
            initialTopMostItemIndex={messages.length - 1}
            increaseViewportBy={{ top: 600, bottom: 1200 }}
            // Streaming + loading bubbles live inside the Virtuoso scrollable
            // area as a Footer so they render in the thread flow (right under
            // the last message) rather than being pushed below the flex-1
            // Virtuoso viewport and off-screen.
            components={{
              Footer: () => {
                if (props.streamingContent) {
                  return (
                    <div className="flex gap-3 mb-4">
                      <div className="w-8 h-8 rounded bg-terminal-green/20 flex items-center justify-center flex-shrink-0">
                        <Bot className="w-4 h-4 text-terminal-green" />
                      </div>
                      <div className="max-w-[80%]">
                        {props.activity && (
                          <div className="mb-1">
                            <ActivityStrip {...props.activity} />
                          </div>
                        )}
                        <div className="relative rounded-lg px-4 py-2 bg-terminal-bg border border-terminal-border text-terminal-text overflow-visible">
                          <div className="whitespace-pre-wrap text-[17px] md:text-sm leading-relaxed md:leading-normal">
                            {props.streamingContent}
                            <span className="mc-stream-caret text-terminal-green" aria-hidden />
                          </div>
                          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-terminal-border/50">
                            <span className="text-xs text-terminal-dim/50 font-mono">
                              {props.streamingContent.length.toLocaleString()} chars
                            </span>
                            <span className="text-xs text-terminal-dim/50">
                              {Math.floor(props.loadingElapsed / 60)}:{(props.loadingElapsed % 60).toString().padStart(2, '0')}
                            </span>
                            <button
                              onClick={props.onStopGeneration}
                              className="px-2 py-0.5 text-xs text-terminal-red/70 hover:text-terminal-red transition"
                            >
                              Stop
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }
                if (props.isLoading) {
                  return (
                    <div className="flex gap-3 mb-4">
                      <div className="w-8 h-8 rounded bg-terminal-green/20 flex items-center justify-center flex-shrink-0">
                        <Bot className="w-4 h-4 text-terminal-green" />
                      </div>
                      <div className="max-w-[80%]">
                        <div className="rounded-lg px-4 py-2 bg-terminal-bg border border-terminal-border flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin text-terminal-green" />
                          <span className="text-terminal-dim text-sm">
                            {props.loadingElapsed < 5 ? 'Connecting…'
                              : props.loadingElapsed < 15 ? 'Thinking…'
                              : props.loadingElapsed < 60 ? 'Working on it…'
                              : 'Deep work in progress…'}
                          </span>
                          <button
                            onClick={props.onStopGeneration}
                            className="ml-auto px-2 py-0.5 text-xs text-terminal-red/70 hover:text-terminal-red transition"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                }
                return null;
              },
            }}
            itemContent={(_i, msg) => (
              <MessageBubble
                msg={msg}
                isMenuOpen={props.activeMessageMenu === msg.id}
                isEditing={props.editingMessageId === msg.id}
                editingContent={props.editingContent}
                onToggleMenu={props.setActiveMessageMenu}
                onContentEdit={props.setEditingContent}
                onSaveEdit={props.onSaveEdit}
                onCancelEdit={props.onCancelEdit}
                onCopy={props.onCopy}
                onQuote={props.onQuote}
                onResend={props.onResend}
                onEdit={props.onEdit}
                onRegenerate={props.onRegenerate}
                onBranch={props.onBranch}
                onDelete={props.onDelete}
                onRate={props.onRate}
                onPin={props.onPin}
                onResolve={props.onResolve}
                renderContent={props.renderContent}
                footer={msg.role === 'assistant' ? (() => {
                  const thisTs = (msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp as any)).getTime();
                  let prev: number | null = null;
                  for (let j = _i - 1; j >= 0; j--) {
                    const m = messages[j];
                    if (m?.role === 'assistant' && m.id !== msg.id) {
                      prev = (m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp as any)).getTime();
                      break;
                    }
                  }
                  const dangerous = /\b(rm\s+-rf|DROP\s+TABLE|DROP\s+DATABASE|git\s+push\s+(--force|-f)(\s|$)|git\s+reset\s+--hard\s+origin|force-push|sudo\s+rm)\b/i.test(msg.content || '');
                  return (
                    <>
                      {dangerous && (
                        <div className="mb-1 flex items-start gap-2 px-2.5 py-1.5 bg-terminal-amber/10 border border-terminal-amber/40 rounded-md text-[11px] text-terminal-amber">
                          <Terminal className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                          <span>This reply references a potentially destructive command. Review before you apply — rm/drop/force-push/reset-hard can't be undone.</span>
                        </div>
                      )}
                      <ToolCitations
                        subAgents={props.subAgents}
                        prevAssistantAt={prev}
                        thisAssistantAt={thisTs}
                      />
                    </>
                  );
                })() : undefined}
                formatTime={props.formatTime}
                formatFileSize={props.formatFileSize}
                menuRef={props.messageMenuRef}
              />
            )}
          />
        )}

        {/* Streaming / loading for a brand-new chat with no messages yet —
            Virtuoso doesn't render when messages is empty, so fall back to
            inline rendering for the very first reply. */}
        {messages.length === 0 && (props.streamingContent || props.isLoading) && (
          <div className="flex gap-3 mb-4">
            <div className="w-8 h-8 rounded bg-terminal-green/20 flex items-center justify-center flex-shrink-0">
              <Bot className="w-4 h-4 text-terminal-green" />
            </div>
            <div className="max-w-[80%]">
              {props.activity && (
                <div className="mb-1"><ActivityStrip {...props.activity} /></div>
              )}
              <div className="relative rounded-lg px-4 py-2 bg-terminal-bg border border-terminal-border text-terminal-text overflow-visible">
                {props.streamingContent ? (
                  <>
                    <div className="whitespace-pre-wrap text-[17px] md:text-sm leading-relaxed md:leading-normal">
                      {props.streamingContent}
                      <span className="mc-stream-caret text-terminal-green" aria-hidden />
                    </div>
                    <div className="flex items-center gap-2 mt-2 pt-2 border-t border-terminal-border/50">
                      <span className="text-xs text-terminal-dim/50 font-mono">{props.streamingContent.length.toLocaleString()} chars</span>
                      <span className="text-xs text-terminal-dim/50">{Math.floor(props.loadingElapsed / 60)}:{(props.loadingElapsed % 60).toString().padStart(2, '0')}</span>
                      <button onClick={props.onStopGeneration} className="px-2 py-0.5 text-xs text-terminal-red/70 hover:text-terminal-red transition">Stop</button>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-terminal-green" />
                    <span className="text-terminal-dim text-sm">
                      {props.loadingElapsed < 5 ? 'Connecting…'
                        : props.loadingElapsed < 15 ? 'Thinking…'
                        : props.loadingElapsed < 60 ? 'Working on it…'
                        : 'Deep work in progress…'}
                    </span>
                    <button onClick={props.onStopGeneration} className="ml-auto px-2 py-0.5 text-xs text-terminal-red/70 hover:text-terminal-red transition">Cancel</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Tool timeline — collapsed summary of filtered system events */}
      {timelineEvents.length > 0 && (
        <div className="px-2 md:px-3 border-t border-terminal-border bg-terminal-bg/40">
          <button
            onClick={props.onToggleTimelineRail}
            className="w-full flex items-center justify-between py-1.5 text-xs text-terminal-dim hover:text-terminal-text transition"
          >
            <span className="flex items-center gap-2">
              <Terminal className="w-3 h-3" />
              {timelineEvents.length} tool event{timelineEvents.length === 1 ? '' : 's'}
              {' '}<span className="text-terminal-dim/70">(hidden from thread)</span>
            </span>
            {props.showTimelineRail ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
          </button>
          {props.showTimelineRail && (
            <div className="max-h-64 overflow-y-auto pb-2 space-y-1">
              {timelineEvents.slice(-200).map(ev => {
                const t = typeof ev.content === 'string' ? ev.content : '';
                return (
                  <div key={ev.id} className="text-[11px] font-mono text-terminal-dim px-2 py-1 bg-terminal-bg/50 border border-terminal-border/40 rounded">
                    <span className="text-terminal-dim/60 mr-2">{props.formatTime(ev.timestamp)}</span>
                    <span className="whitespace-pre-wrap">{t.slice(0, 240)}{t.length > 240 ? '…' : ''}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}
