/**
 * MessageBubble — one row in the virtualized message list.
 *
 * Extracted from ChatPanel.tsx so Virtuoso can React.memo it and skip
 * per-item re-renders when an unrelated piece of state (input value,
 * loading flag, streaming deltas) changes on the parent.
 *
 * All interactive callbacks are passed in so the component stays pure
 * w.r.t. parent state — safe to memoize.
 */

'use client';

import { memo, useRef, useState } from 'react';
import {
  MessageSquare,
  Bot,
  User,
  FileText,
  Copy,
  Quote,
  RotateCcw,
  Pencil,
  GitBranch,
  Trash2,
  MoreHorizontal,
  ThumbsUp,
  ThumbsDown,
  Pin,
  Check,
} from 'lucide-react';

export interface BubbleAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  url: string;
}

export interface BubbleMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  attachments?: BubbleAttachment[];
  /** User feedback on an assistant message — optional, ephemeral. */
  sentiment?: 'up' | 'down';
  /** Pinned messages stay in the API payload even after compression. */
  pinned?: boolean;
  /** Resolved messages are excluded from memory retrieval. */
  resolved?: boolean;
  /** Pair-mode: which voice authored this assistant message. */
  voice?: 'claude' | 'codex' | 'orchestrator';
  /** Pair-mode: synthesized plan card to render above the content. */
  planCard?: any;
  /** Pair-mode: locked state for the plan card. */
  planCardLocked?: boolean;
  /** Pair-mode: phase label. */
  pairPhase?: string;
}

export interface MessageBubbleProps {
  msg: BubbleMessage;
  isMenuOpen: boolean;
  isEditing: boolean;
  editingContent: string;
  onToggleMenu: (id: string | null) => void;
  onContentEdit: (value: string) => void;
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
  /** Optional slot rendered below the assistant reply — used for tool citations. */
  footer?: React.ReactNode;
  renderContent: (msg: BubbleMessage) => React.ReactNode;
  formatTime: (ts: Date) => string;
  formatFileSize: (bytes: number) => string;
  menuRef?: React.RefObject<HTMLDivElement | null>;
}

function MessageBubbleImpl(props: MessageBubbleProps) {
  const {
    msg, isMenuOpen, isEditing, editingContent,
    onToggleMenu, onContentEdit, onSaveEdit, onCancelEdit,
    onCopy, onQuote, onResend, onEdit, onRegenerate, onBranch, onDelete,
    onRate, onPin, onResolve, footer,
    renderContent, formatTime, formatFileSize, menuRef,
  } = props;

  // Swipe gestures DISABLED (Phase 76): the swipe-left-to-branch was firing
  // on accidental finger jitter during normal tap/scroll on mobile, causing
  // every touch to create a new chat branch. Also conflicted with the new
  // two-finger pinch-zoom in ChatZoomController.
  // Branch / copy are still available via the message action menu (3-dot).
  // To re-enable later: restore the dragStart/swipeX state + onTouch
  // handlers and bind them on the .msg wrapper below.

  // Map role/voice to Fusio `.msg.{user|ai|sub|codex}` modifier.
  // The static /fusio/mc.css styles each variant with the right avatar
  // gradient and body color so we don't have to inline those styles here.
  const fusioRoleClass =
    msg.role === 'user' ? 'user'
    : msg.role === 'system' ? 'sub'
    : (msg as any).voice === 'codex' ? 'codex'
    : (msg as any).voice === 'orchestrator' ? 'sub'
    : 'ai';

  return (
    <div className="msg-wrap">
    <div
      className={`msg ${fusioRoleClass} group relative`}
    >
      {/* Avatar (Fusio left column, always present, 32 px square) */}
      {(() => {
        if (msg.role === 'user') {
          return (
            <div className="avatar" aria-label="You">
              <User className="w-4 h-4" />
            </div>
          );
        }
        const v = (msg as any).voice as 'claude' | 'codex' | 'orchestrator' | undefined;
        if (msg.role === 'system') {
          return (
            <div className="avatar" aria-label="System">
              <MessageSquare className="w-4 h-4" />
            </div>
          );
        }
        if (v === 'codex') {
          return <div className="avatar" aria-label="Codex">⚡</div>;
        }
        if (v === 'orchestrator') {
          return <div className="avatar" aria-label="Orchestrator">✦</div>;
        }
        return (
          <div className="avatar" aria-label="Fusio">
            <Bot className="w-4 h-4" />
          </div>
        );
      })()}

      {/* Swipe affordance + transform stripped along with the swipe gesture
          itself (see Phase 76 comment above). Re-add by reintroducing
          swipeEnabled + dragStart and restoring this block. */}
      <div className="body-col relative">
        {/* .head — who + role + time row, matches design's chat.jsx
            MessageView header row. Visible on every non-system message. */}
        {msg.role !== 'system' && (() => {
          const who = msg.role === 'user' ? 'You'
            : (msg as any).voice === 'codex' ? 'Codex'
            : (msg as any).voice === 'orchestrator' ? 'Pair'
            : 'Fusio';
          const roleTag = (msg as any).voice === 'codex' ? 'Sub-agent'
            : (msg as any).voice === 'orchestrator' ? 'Orchestrator'
            : null;
          return (
            <div className="head">
              <span className="who">{who}</span>
              {roleTag && <span className="role">{roleTag}</span>}
              <span className="time">{formatTime(msg.timestamp)}</span>
            </div>
          );
        })()}

        {/* .body — clean content area, no background/border/rounded.
            The design's .msg .body CSS handles typography (.font-size,
            .line-height, code/pre/list styles, color: var(--fog)).
            Pair-mode voice tinting moved to .msg.codex / .msg.orchestrator
            modifiers on the outer .msg.role wrapper (handled via
            fusioRoleClass above — codex maps to role=codex, orchestrator
            to role=sub which the design tints). */}
        <div
          onClick={() => msg.role !== 'system' && onToggleMenu(isMenuOpen ? null : msg.id)}
          className={`body ${msg.role === 'system' ? 'italic cursor-default' : 'cursor-pointer'} ${isMenuOpen ? 'menu-open' : ''}`}
        >
          {isEditing ? (
            <div className="space-y-2">
              <textarea
                value={editingContent}
                onChange={(e) => onContentEdit(e.target.value)}
                className="w-full bg-terminal-surface border border-terminal-border rounded p-2
                           text-sm text-terminal-text focus:border-terminal-green outline-none resize-none"
                rows={4}
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={(e) => { e.stopPropagation(); onCancelEdit(); }}
                  className="px-2 py-1 text-xs text-terminal-dim hover:text-terminal-text"
                >
                  Cancel
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onSaveEdit(); }}
                  className="px-2 py-1 text-xs bg-terminal-green/20 text-terminal-green rounded
                             hover:bg-terminal-green/30"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Render content when there's text OR when a pair/autopilot
                  payload (plan card, codex question, autopilot events,
                  phase-stuck card, finish banner) needs to display even on
                  an empty-text msg. */}
              {(msg.content
                || (msg as any).planCard
                || (msg as any).codexQuestion
                || (msg as any).phaseStuck
                || ((msg as any).autopilotEvents && (msg as any).autopilotEvents.length)
                || (msg as any).autopilotFinish) && renderContent(msg)}
              {msg.attachments && msg.attachments.length > 0 && (
                <div className="mt-2 space-y-2">
                  {msg.attachments.map((att) => (
                    <div key={att.id} className="rounded overflow-hidden">
                      {att.type.startsWith('image/') ? (
                        <img
                          src={att.url}
                          alt={att.name}
                          className="max-w-full max-h-64 rounded"
                        />
                      ) : (
                        <div className="flex items-center gap-2 bg-terminal-bg/50 p-2 rounded text-xs">
                          <FileText className="w-4 h-4 text-terminal-cyan" />
                          <span className="text-terminal-text">{att.name}</span>
                          <span className="text-terminal-dim">({formatFileSize(att.size)})</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {isMenuOpen && msg.role !== 'system' && (
          <div
            ref={menuRef}
            className={`absolute z-50 mt-1 w-44 md:w-40 bg-terminal-surface border border-terminal-border
                        rounded-lg shadow-xl overflow-hidden ${
                          msg.role === 'user' ? 'right-0' : 'left-0'
                        }`}
          >
            <div className="p-1">
              <button
                onClick={(e) => { e.stopPropagation(); onCopy(msg.content); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-terminal-text
                           hover:bg-terminal-green/20 rounded transition"
              >
                <Copy className="w-4 h-4 text-terminal-dim" />
                Copy
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onQuote(msg.content, msg.role); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-terminal-text
                           hover:bg-terminal-cyan/20 rounded transition"
              >
                <Quote className="w-4 h-4 text-terminal-dim" />
                Quote
              </button>
              {msg.role === 'user' && (
                <button
                  onClick={(e) => { e.stopPropagation(); onResend(msg.content); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-terminal-text
                             hover:bg-terminal-amber/20 rounded transition"
                >
                  <RotateCcw className="w-4 h-4 text-terminal-dim" />
                  Resend
                </button>
              )}
              {msg.role === 'user' && (
                <button
                  onClick={(e) => { e.stopPropagation(); onEdit(msg); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-terminal-text
                             hover:bg-terminal-cyan/20 rounded transition"
                >
                  <Pencil className="w-4 h-4 text-terminal-dim" />
                  Edit
                </button>
              )}
              {msg.role === 'assistant' && (
                <button
                  onClick={(e) => { e.stopPropagation(); onRegenerate(msg); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-terminal-text
                             hover:bg-terminal-amber/20 rounded transition"
                >
                  <RotateCcw className="w-4 h-4 text-terminal-dim" />
                  Regenerate
                </button>
              )}
              <div className="border-t border-terminal-border my-1" />
              {onPin && (
                <button
                  onClick={(e) => { e.stopPropagation(); onPin(msg.id, !msg.pinned); onToggleMenu(null); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-terminal-text
                             hover:bg-terminal-amber/20 rounded transition"
                >
                  <Pin className={`w-4 h-4 ${msg.pinned ? 'text-terminal-amber' : 'text-terminal-dim'}`} />
                  {msg.pinned ? 'Unpin' : 'Pin'}
                </button>
              )}
              {onResolve && (
                <button
                  onClick={(e) => { e.stopPropagation(); onResolve(msg.id, !msg.resolved); onToggleMenu(null); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-terminal-text
                             hover:bg-terminal-green/20 rounded transition"
                >
                  <Check className={`w-4 h-4 ${msg.resolved ? 'text-terminal-green' : 'text-terminal-dim'}`} />
                  {msg.resolved ? 'Unresolve' : 'Resolve'}
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onBranch(msg); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-terminal-text
                           hover:bg-terminal-green/20 rounded transition"
              >
                <GitBranch className="w-4 h-4 text-terminal-dim" />
                Branch from here
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(msg.id); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-terminal-red
                           hover:bg-terminal-red/20 rounded transition"
              >
                <Trash2 className="w-4 h-4" />
                Delete
              </button>
            </div>
          </div>
        )}

        {footer && msg.role === 'assistant' && !isEditing && (
          <div className="mt-1">{footer}</div>
        )}

        <div className={`flex items-center gap-2 text-xs text-terminal-dim mt-1 ${msg.role === 'user' ? 'justify-end' : ''}`}>
          {/* Time is now in .head — only show timestamp here on system
              messages (which have no .head). */}
          {msg.role === 'system' && <span>{formatTime(msg.timestamp)}</span>}
          {msg.pinned && <Pin className="w-3 h-3 text-terminal-amber" aria-label="Pinned" />}
          {msg.resolved && <Check className="w-3 h-3 text-terminal-green" aria-label="Resolved" />}
          {msg.role === 'assistant' && onRate && (
            <div className="flex items-center gap-0.5 md:opacity-0 md:group-hover:opacity-100 transition">
              <button
                onClick={(e) => { e.stopPropagation(); onRate(msg.id, msg.sentiment === 'up' ? null : 'up'); }}
                className={`p-1.5 md:p-0.5 hover:bg-terminal-bg rounded transition ${msg.sentiment === 'up' ? 'text-terminal-green opacity-100' : ''}`}
                title="Good answer"
              >
                <ThumbsUp className="w-4 h-4 md:w-3 md:h-3" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onRate(msg.id, msg.sentiment === 'down' ? null : 'down'); }}
                className={`p-1.5 md:p-0.5 hover:bg-terminal-bg rounded transition ${msg.sentiment === 'down' ? 'text-terminal-red opacity-100' : ''}`}
                title="Bad answer — memory down-ranks this approach"
              >
                <ThumbsDown className="w-4 h-4 md:w-3 md:h-3" />
              </button>
            </div>
          )}
          {msg.role !== 'system' && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleMenu(isMenuOpen ? null : msg.id); }}
              className="md:opacity-0 md:group-hover:opacity-100 p-1.5 md:p-0.5 hover:bg-terminal-bg rounded transition"
              title="Actions"
            >
              <MoreHorizontal className="w-4 h-4 md:w-3 md:h-3" />
            </button>
          )}
        </div>
      </div>

      {/* The user avatar that used to sit here has moved to the left column
          (Fusio grid puts avatar at col 1 for both user + AI). */}
    </div>
    </div>
  );
}

/**
 * Memoize on props identity — callback identity is controlled by the parent
 * (useCallback). When only an unrelated message streams/changes, every OTHER
 * row skips re-render entirely.
 */
export const MessageBubble = memo(MessageBubbleImpl);
