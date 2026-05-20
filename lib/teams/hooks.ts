/**
 * Constellation TaskCompleted hook runner.
 *
 * Executes the team's configured test/lint/typecheck command per task
 * completion. Uses spawn(cmd, args) — array form, no shell — to prevent
 * injection. Captures stdout/stderr up to 64KB. Respects timeout.
 *
 * Exit codes:
 *   0  — pass → task transitions to next stage
 *   2  — block → task reverts to 'blocked' with feedback
 *   *  — infrastructure error → task → 'blocked' with error detail
 */

import 'server-only';
import { spawn } from 'node:child_process';
import type { TeamTaskRow, TeamRow } from './schema';
import { transitionTask, appendEvent, getTeam } from './schema';

const MAX_CAPTURE = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  timedOut: boolean;
}

function parseSettings(team: TeamRow): { cmd: string; args: string[]; timeoutMs: number } {
  try {
    const settings = JSON.parse(team.settings_json || '{}');
    const hook = settings?.hooks?.taskCompleted;
    if (hook?.cmd) {
      return {
        cmd: hook.cmd,
        args: Array.isArray(hook.args) ? hook.args : [],
        timeoutMs: hook.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      };
    }
  } catch { /* use defaults */ }
  return { cmd: 'pnpm', args: ['test'], timeoutMs: DEFAULT_TIMEOUT_MS };
}

export async function runTaskCompletedHook(task: TeamTaskRow, teamId: string): Promise<HookResult> {
  const team = getTeam(teamId);
  if (!team) return { exitCode: -1, stdout: '', stderr: 'team not found', passed: false, timedOut: false };

  const { cmd, args, timeoutMs } = parseSettings(team);
  const cwd = task.worktree_path || team.project_id;
  const filesTouched = task.files_touched || '[]';

  return new Promise<HookResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let resolved = false;

    const proc = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        MC_TASK_ID: task.id,
        MC_TEAM_ID: teamId,
        MC_AGENT_ID: task.assigned_agent_id || '',
        MC_WORKTREE: cwd,
        MC_FILES_TOUCHED: filesTouched,
        MC_BRANCH_NAME: task.branch_name || '',
        MC_BASE_BRANCH: team.main_branch,
      },
    });

    proc.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString().slice(0, MAX_CAPTURE - stdout.length);
    });
    proc.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString().slice(0, MAX_CAPTURE - stderr.length);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }, timeoutMs);

    const finish = (code: number) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);

      const passed = code === 0;
      const result: HookResult = { exitCode: code, stdout, stderr, passed, timedOut };

      appendEvent({
        team_id: teamId,
        agent_id: task.assigned_agent_id,
        task_id: task.id,
        kind: 'hook_run',
        severity: passed ? 'info' : 'warn',
        payload: {
          hook: 'taskCompleted',
          cmd: [cmd, ...args].join(' '),
          exitCode: code,
          passed,
          timedOut,
          stdoutTail: stdout.slice(-500),
          stderrTail: stderr.slice(-500),
        },
        chat_report: !passed,
      });

      if (passed) {
        transitionTask(task.id, 'review');
      } else {
        const reason = timedOut
          ? `Hook timed out after ${timeoutMs / 1000}s`
          : code === 2
            ? `Hook blocked: ${stderr.slice(-300) || stdout.slice(-300)}`
            : `Hook failed (exit ${code}): ${stderr.slice(-300) || stdout.slice(-300)}`;
        transitionTask(task.id, 'blocked', { status_reason: reason, error_detail: reason });
      }

      resolve(result);
    };

    proc.on('close', (code) => finish(code ?? -1));
    proc.on('error', (err) => {
      stderr += `\nspawn error: ${err.message}`;
      finish(-1);
    });
  });
}
