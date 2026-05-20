/**
 * /api/chat/pair — pair-mode chat endpoint (Claude + Codex)
 *
 * Body (POST):
 *   {
 *     mode: 'consult' | 'debate' | 'pair-build' | 'pair-build-execute',
 *     messages: [...],
 *     sessionKey?, workspace?, model?, permissionMode?, requestId?, chatId?, clientId?,
 *     focus?: string[],          // domains to weight Codex on
 *     approvedPlan?: PlanCard,   // required for 'pair-build-execute'
 *   }
 *
 * Returns: SSE stream identical in shape to /api/chat plus two extra event
 * types the client recognizes:
 *   { type: 'agent', agent, phase }   — flips the active speaker
 *   { type: 'plan-card', card }       — render the Plan Card
 *
 * /api/chat (solo) is untouched. The client picks this route only when the
 * user is in a non-solo pair mode.
 */

import { NextRequest } from 'next/server';
import { runPair, runPairBuildExecute, type PairMode } from '../../../../lib/teams/pair';
import { runAutopilot } from '../../../../lib/teams/autopilot';
import type { PhasedPlan, Phase } from '../../../../lib/teams/phased-plan';
import { ensureChatSession, captureUserMessage } from '../../../../lib/mem/api';
import { commitUserMessageIfMissing } from '../../../../lib/chat-storage';
import { broadcastUserMessage } from '../../../../lib/chat-broadcast';

export const maxDuration = 3600;
export const dynamic = 'force-dynamic';

function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (typeof c === 'string' ? c : c?.text ?? '')).join('\n');
  }
  return '';
}

function isContextMessage(content: any): boolean {
  const text = extractText(content);
  return /^\[context:/.test(text.trim());
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      mode,
      messages = [],
      sessionKey,
      requestId,
      workspace,
      model,
      permissionMode,
      chatId,
      clientId,
      focus,
      approvedPlan,
    } = body;

    const VALID_MODES = ['consult', 'debate', 'pair-build', 'pair-build-execute', 'autopilot', 'autopilot-execute'];
    if (!mode || !VALID_MODES.includes(mode)) {
      return new Response(JSON.stringify({ error: `mode must be one of: ${VALID_MODES.join(' | ')}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Mem session bookkeeping (mirrors /api/chat).
    if (sessionKey) {
      try {
        const memSession = ensureChatSession(sessionKey);
        const lastUser = [...messages].reverse().find(
          (m: any) => m.role === 'user' && typeof m.content !== 'undefined',
        );
        const userText = lastUser ? extractText(lastUser.content) : '';
        if (userText) captureUserMessage(memSession.id, userText.slice(0, 8000));
      } catch (e) {
        console.warn('[mem] pair chat session/capture failed:', (e as Error).message);
      }
    }

    // Persist user message + broadcast (mirrors /api/chat).
    if (chatId) {
      try {
        const lastUserMsg = [...messages].reverse().find(
          (m: any) => m.role === 'user' && typeof m.content !== 'undefined' && !isContextMessage(m.content),
        );
        const lastUserText = lastUserMsg ? extractText(lastUserMsg.content) : '';
        if (lastUserText) {
          commitUserMessageIfMissing({ chatId, content: lastUserText, sessionKey, workspace });
          broadcastUserMessage(chatId, lastUserText);
        }
      } catch (e) {
        console.warn('[chat-pair] user-msg server-commit failed:', (e as Error).message);
      }
    }

    const baseOpts = {
      messages,
      sessionKey,
      workspace,
      model,
      permissionMode,
      requestId,
      chatId,
      clientId,
      focus,
    };

    if (mode === 'pair-build-execute') {
      if (!approvedPlan) {
        return new Response(JSON.stringify({ error: 'approvedPlan required for pair-build-execute' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const { stream } = await runPairBuildExecute({ ...baseOpts, mode: 'pair-build', approvedPlan });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    if (mode === 'autopilot-execute') {
      // The approved plan must include phases. If not, refuse so the user
      // doesn't accidentally run a single-phase plan on autopilot.
      if (!approvedPlan || !Array.isArray(approvedPlan.phases) || approvedPlan.phases.length === 0) {
        return new Response(JSON.stringify({ error: 'approvedPlan.phases (non-empty array) required for autopilot-execute' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const phases: Phase[] = approvedPlan.phases.map((p: any, i: number) => ({
        index: typeof p?.index === 'number' ? p.index : i + 1,
        name: String(p?.name || `Phase ${i + 1}`),
        spec: String(p?.spec || ''),
        exit_criteria: Array.isArray(p?.exit_criteria) ? p.exit_criteria.map((x: any) => String(x)) : [],
        expected_files: Array.isArray(p?.expected_files) ? p.expected_files.map((x: any) => String(x)) : undefined,
      }));
      const plan: PhasedPlan = {
        goal: approvedPlan.goal || 'autopilot run',
        preface: approvedPlan.approach || approvedPlan.resolution,
        phases,
        rework_cap: typeof approvedPlan.rework_cap === 'number' ? approvedPlan.rework_cap : 5,
      };
      const { stream } = runAutopilot({
        plan,
        messages,
        sessionKey,
        workspace,
        model,
        permissionMode,
        requestId,
        chatId,
        clientId,
        focus,
        pendingUserAnswer: body.pendingUserAnswer,
        resume_from_phase: body.resume_from_phase,
        resume_from_attempt: body.resume_from_attempt,
        resume_audit_history: Array.isArray(body.resume_audit_history) ? body.resume_audit_history : undefined,
        override_rework_cap: typeof body.override_rework_cap === 'number' ? body.override_rework_cap : undefined,
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    const { stream } = runPair({ ...baseOpts, mode: mode as PairMode });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err: any) {
    console.error('[Chat-Pair API] Error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
