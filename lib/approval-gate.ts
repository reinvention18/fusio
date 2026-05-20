/**
 * approval-gate — blocking approval for destructive tool calls.
 *
 * Before the Agent SDK executes any tool, the bridge consults this module
 * via the `canUseTool` callback. For patterns matching destructive intent
 * (rm -rf, DROP TABLE, git push --force, git reset --hard origin, sudo rm),
 * we register a pending approval keyed by a freshly-minted id, emit a SSE
 * event so the client can show a modal, and await the user's decision.
 *
 * The client resolves the pending via POST /api/chat/approve with the id
 * and a boolean. Allow lets the tool run; deny returns a deny with a
 * message surfaced back to the agent.
 *
 * All non-destructive tools are allow-listed (no user interaction), so this
 * doesn't disturb the default bypassPermissions flow.
 */

import 'server-only';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

export interface PendingApproval {
  id: string;
  sessionKey?: string;
  toolName: string;
  input: Record<string, unknown>;
  title: string;
  reason: string;
  createdAt: number;
  resolve: (decision: 'allow' | 'deny', note?: string) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingApproval>();

// Timeout so the agent isn't stuck forever if the UI drops. After 5 min we
// deny to unblock the stream. Tune if needed.
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

export function listPendingForSession(sessionKey?: string): PendingApproval[] {
  if (!sessionKey) return [...pending.values()];
  return [...pending.values()].filter(p => p.sessionKey === sessionKey);
}

export function resolveApproval(id: string, allow: boolean, note?: string): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve(allow ? 'allow' : 'deny', note);
  return true;
}

/**
 * Heuristic for destructive intent. Kept conservative: false positives cost
 * only a single approval click, but a false negative lets a dangerous command
 * slip past. Patterns mirror the banner check in the chat UI so the user's
 * mental model is consistent.
 */
export function isDestructive(toolName: string, input: Record<string, unknown>): { hit: boolean; reason?: string } {
  // Bash patterns — the historical surface. Most destructive intent flows
  // through Bash, so most of the patterns live here.
  if (toolName === 'Bash' || toolName === 'bash') {
    const cmd = typeof input.command === 'string' ? input.command : '';
    if (!cmd) return { hit: false };
    const patterns: Array<{ rx: RegExp; reason: string }> = [
      { rx: /\brm\s+-rf\b/i,                      reason: 'rm -rf (recursive force delete)' },
      { rx: /\bsudo\s+rm\b/i,                     reason: 'sudo rm' },
      { rx: /\bDROP\s+TABLE\b/i,                  reason: 'DROP TABLE' },
      { rx: /\bDROP\s+DATABASE\b/i,               reason: 'DROP DATABASE' },
      { rx: /\bTRUNCATE\s+TABLE\b/i,              reason: 'TRUNCATE TABLE' },
      { rx: /\bgit\s+push\s+(--force|-f)\b/i,     reason: 'git push --force' },
      { rx: /\bgit\s+reset\s+--hard\s+origin/i,   reason: 'git reset --hard origin' },
      { rx: /\bgit\s+branch\s+-D\b/,              reason: 'git branch -D' },
      { rx: /\bgit\s+checkout\s+\.\s*$/,          reason: 'git checkout . (discards working tree)' },
      { rx: /:>\s*\/dev\/sd[a-z]/i,               reason: 'raw disk overwrite' },
      { rx: /\bmkfs\b/i,                          reason: 'mkfs (filesystem format)' },
    ];
    for (const p of patterns) {
      if (p.rx.test(cmd)) return { hit: true, reason: p.reason };
    }
    return { hit: false };
  }

  // Edit/Write/MultiEdit patterns — historically this gate was Bash-only and
  // destructive file-write tools bypassed it entirely. The protected-paths
  // list below catches the high-risk targets: trust file, secrets, sshd
  // configs, the local memory DB, the chat sessions store, and the PM2
  // process config. Adjust the list as new sensitive paths emerge.
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    const filePath = typeof input.file_path === 'string' ? input.file_path : '';
    if (!filePath) return { hit: false };
    const protectedPatterns: Array<{ rx: RegExp; reason: string }> = [
      { rx: /\.config\/mc-remote-hosts\.json$/,    reason: 'mc-remote trust file (bearer tokens)' },
      { rx: /\.env(\.[a-z0-9_-]+)?$/i,             reason: '.env file (secrets)' },
      { rx: /\/\.ssh\//,                            reason: '~/.ssh/ directory' },
      { rx: /\/\.aws\//,                            reason: '~/.aws/ directory' },
      { rx: /\/etc\/(passwd|shadow|sudoers|ssh)/,   reason: 'system identity / sshd config' },
      { rx: /\bdata\/memory\.db(-wal|-shm)?$/,     reason: 'mem SQLite DB' },
      { rx: /\bdata\/chat-sessions\.json$/,        reason: 'chat sessions store' },
      { rx: /\bdata\/(lukes|seo|support)-chat-sessions\.json$/, reason: 'namespaced chat sessions store' },
      { rx: /\bdata\/missions\/.*\/state\.json$/,  reason: 'mission state file' },
      { rx: /\becosystem\.config\.js$/,            reason: 'PM2 process config' },
      { rx: /\bauthorized_keys$/,                   reason: 'SSH authorized_keys' },
    ];
    for (const p of protectedPatterns) {
      if (p.rx.test(filePath)) return { hit: true, reason: `${toolName} on ${p.reason}` };
    }
    return { hit: false };
  }

  return { hit: false };
}

export interface MakeCanUseToolOpts {
  sessionKey?: string;
  onRequest: (ap: PendingApproval) => void;
}

/**
 * Build the CanUseTool callback bound to a specific stream/session. Non-
 * destructive tools auto-allow immediately; destructive ones register a
 * pending approval and notify the stream via onRequest.
 */
export function makeCanUseTool(opts: MakeCanUseToolOpts): CanUseTool {
  return async (toolName, input) => {
    const check = isDestructive(toolName, input);
    if (!check.hit) {
      return { behavior: 'allow', updatedInput: input } as PermissionResult;
    }
    const id = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const title = `Approve ${toolName}? Flagged: ${check.reason}`;
    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          resolve({
            behavior: 'deny',
            message: `Approval timed out after ${Math.round(APPROVAL_TIMEOUT_MS / 1000)}s. The user did not respond. Re-propose this action if still needed.`,
            interrupt: false,
          } as PermissionResult);
        }
      }, APPROVAL_TIMEOUT_MS);
      const entry: PendingApproval = {
        id,
        sessionKey: opts.sessionKey,
        toolName,
        input,
        title,
        reason: check.reason || 'destructive command',
        createdAt: Date.now(),
        timer,
        resolve: (decision, note) => {
          if (decision === 'allow') {
            resolve({ behavior: 'allow', updatedInput: input } as PermissionResult);
          } else {
            resolve({
              behavior: 'deny',
              message: note || `User denied: ${check.reason}. Propose a less destructive alternative or ask what's allowed.`,
              interrupt: false,
            } as PermissionResult);
          }
        },
      };
      pending.set(id, entry);
      try { opts.onRequest(entry); } catch (e) { console.error('[approval] onRequest failed:', e); }
    });
  };
}

/** Clear every pending approval for a session — used when stream is killed. */
export function cancelApprovalsForSession(sessionKey?: string): void {
  for (const [id, p] of pending) {
    if (!sessionKey || p.sessionKey === sessionKey) {
      p.resolve('deny', 'Stream cancelled by user.');
      clearTimeout(p.timer);
      pending.delete(id);
    }
  }
}
