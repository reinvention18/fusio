/**
 * spawn — single-source-of-truth wrapper around child_process.execFile that
 * keeps Windows from flashing console windows on every spawn.
 *
 * Without `windowsHide: true`, every execFile pops a brief console window on
 * Windows. MC fires dozens of process spawns per chat reload (git status
 * fan-out, vault sync, etc.) — without this wrapper, the user sees a
 * cascade of flashing terminal windows.
 *
 * Use `runCmd` instead of execFileAsync directly anywhere we shell out.
 */

import { execFile, type ExecFileException } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RunCmdOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** ms; default 60_000 */
  timeout?: number;
  /** bytes; default 5MB */
  maxBuffer?: number;
  /** Force shell:true (e.g. for Windows .cmd/.bat). Auto-detected when not set. */
  shell?: boolean;
  /** Suppress error throw; return { ok:false, stdout, stderr } instead. */
  allowFail?: boolean;
}

export interface RunCmdResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** the exec error if `allowFail` and the command failed */
  error?: ExecFileException;
}

function looksLikeWindowsCmd(file: string): boolean {
  return /\.(cmd|bat)$/i.test(file);
}

/**
 * Run a command. Always sets `windowsHide: true` so no console flashes on
 * Windows. On Windows, auto-uses `shell:true` for .cmd/.bat or bare names.
 */
export async function runCmd(
  file: string,
  args: string[] = [],
  opts: RunCmdOptions = {},
): Promise<RunCmdResult> {
  const isWin = process.platform === 'win32';
  const isAbsolute = isWin ? /[\\/]/.test(file) : file.startsWith('/');
  const useShell = opts.shell ?? (isWin && (looksLikeWindowsCmd(file) || !isAbsolute));

  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      timeout: opts.timeout ?? 60_000,
      maxBuffer: opts.maxBuffer ?? 5 * 1024 * 1024,
      shell: useShell,
      windowsHide: true,
    });
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (e) {
    const err = e as ExecFileException;
    if (opts.allowFail) {
      return {
        ok: false,
        stdout: (err as any).stdout?.toString() || '',
        stderr: (err as any).stderr?.toString() || err.message || '',
        error: err,
      };
    }
    throw err;
  }
}

/** Convenience for the very common "run git, return stdout, swallow errors" pattern. */
export async function runGit(args: string[], opts: RunCmdOptions = {}): Promise<string> {
  const r = await runCmd('git', args, { ...opts, allowFail: true });
  return r.ok ? r.stdout.trim() : '';
}
