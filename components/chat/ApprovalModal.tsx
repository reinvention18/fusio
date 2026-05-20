/**
 * ApprovalModal — blocks the agent until the user approves or denies a
 * destructive tool call. Rendered inline as a fixed overlay when a request
 * is active. Posts the decision to /api/chat/approve; the server resolves
 * the pending canUseTool promise and the stream continues.
 *
 * Markup uses the AI Fusio `.card.approval` design class from
 * /fusio/mc.css so the modal matches the design's amber-accented approval
 * styling. Functionality (id, allow/deny, optional note) is unchanged.
 */
'use client';
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

export interface ApprovalRequest {
  id: string;
  toolName: string;
  input: Record<string, any>;
  reason: string;
  title: string;
  createdAt: number;
}

export interface ApprovalModalProps {
  request: ApprovalRequest | null;
  onDecision: (id: string, allow: boolean, note?: string) => Promise<void>;
}

export function ApprovalModal({ request, onDecision }: ApprovalModalProps) {
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!request) setNote('');
  }, [request?.id]);

  if (!request) return null;

  const cmd = typeof request.input.command === 'string'
    ? request.input.command
    : JSON.stringify(request.input, null, 2);

  const decide = async (allow: boolean) => {
    if (pending) return;
    setPending(true);
    try { await onDecision(request.id, allow, note.trim() || undefined); }
    finally { setPending(false); }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 120,
        background: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div className="card approval" style={{ width: '100%', maxWidth: 520, margin: 0 }}>
        <div className="card-head" style={{ justifyContent: 'space-between' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <span className="pip" />
            <span>Approve destructive command</span>
          </span>
          <AlertTriangle style={{ width: 14, height: 14, color: 'var(--amber, #E8A23B)' }} />
        </div>

        <div className="card-body">
          The agent wants to run{' '}
          <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--white, #fff)', background: 'var(--ink-2, #131319)', border: '1px solid var(--line, rgba(255,255,255,0.08))', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>
            {request.toolName}
          </code>
          . Flagged:{' '}
          <span style={{ color: 'var(--amber, #E8A23B)' }}>{request.reason}</span>
          .
        </div>

        <pre
          style={{
            marginTop: 10,
            background: 'var(--ink, #0A0A0E)',
            border: '1px solid var(--line, rgba(255,255,255,0.08))',
            borderRadius: 8,
            padding: '10px 12px',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--fog, rgba(255,255,255,0.78))',
            maxHeight: 220,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {cmd}
        </pre>

        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note sent back to the agent if you deny…"
          rows={2}
          style={{
            marginTop: 10,
            width: '100%',
            background: 'var(--ink-3, #1B1B23)',
            border: '1px solid var(--line, rgba(255,255,255,0.08))',
            borderRadius: 8,
            padding: '10px 12px',
            color: 'var(--white, #fff)',
            fontFamily: 'var(--font-sans)',
            fontSize: 13,
            outline: 'none',
            resize: 'vertical',
          }}
        />

        <div className="card-actions" style={{ justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="card-btn danger"
            onClick={() => decide(false)}
            disabled={pending}
            style={{ opacity: pending ? 0.5 : 1 }}
          >
            Deny
          </button>
          <button
            type="button"
            className="card-btn primary"
            onClick={() => decide(true)}
            disabled={pending}
            style={{ opacity: pending ? 0.5 : 1, background: 'var(--amber, #E8A23B)', borderColor: 'var(--amber, #E8A23B)', color: '#1a1410' }}
          >
            Allow once
          </button>
        </div>
      </div>
    </div>
  );
}
