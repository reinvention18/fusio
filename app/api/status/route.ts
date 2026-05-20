/**
 * /api/status — Claude Code CLI health check.
 *
 * Runs `claude --version` to verify the CLI is available. Cross-platform:
 *   - Linux/macOS: tries $CLAUDE_BIN, then common bin paths
 *   - Windows:     tries $CLAUDE_BIN (.cmd), then common install paths.
 *                  execFile on Windows can't run .cmd directly, so we use
 *                  shell:true when the resolved binary is a .cmd or has no
 *                  absolute path. Fixes the "OFFLINE" badge on PC.
 */

import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

function resolveClaudeBin(): string {
  const fromEnv = process.env.CLAUDE_BIN?.trim();
  if (fromEnv && (fs.existsSync(fromEnv) || /^[a-z]+$/i.test(fromEnv))) return fromEnv;

  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [
        path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
        'C:\\Program Files\\claude\\claude.exe',
      ]
    : [
        path.join(home, '.local', 'bin', 'claude'),
        '/usr/local/bin/claude',
        '/usr/bin/claude',
        '/opt/homebrew/bin/claude',
      ];

  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return process.platform === 'win32' ? 'claude.cmd' : 'claude';
}

export async function GET() {
  const claudeBin = resolveClaudeBin();
  // execFile on Windows can't directly run .cmd / .bat — needs shell:true.
  // Skip shell on absolute Linux/macOS paths to avoid quoting issues.
  const isCmdOrBat = /\.(cmd|bat)$/i.test(claudeBin);
  const isAbsolute = process.platform === 'win32' ? /[\\/]/.test(claudeBin) : claudeBin.startsWith('/');
  const useShell = process.platform === 'win32' && (isCmdOrBat || !isAbsolute);

  try {
    const { stdout } = await execFileAsync(claudeBin, ['--version'], {
      timeout: 5000,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      shell: useShell,
      windowsHide: true,
    });
    return NextResponse.json({
      connected: true,
      backend: 'claude-code-cli',
      version: stdout.trim(),
      claudeBin,
    });
  } catch (err: any) {
    return NextResponse.json({
      connected: false,
      backend: 'claude-code-cli',
      claudeBin,
      error: err.message || 'Claude Code CLI not available',
      hint: process.platform === 'win32' && err?.code === 'EINVAL'
        ? 'On Windows, set CLAUDE_BIN to the full path of claude.cmd (e.g. C:\\Users\\<you>\\AppData\\Roaming\\npm\\claude.cmd)'
        : undefined,
    });
  }
}
