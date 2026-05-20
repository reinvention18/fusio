/**
 * POST /api/vault/sync — force an immediate git pull of the wiki + report status.
 *
 * Bypasses the 5-min interval. Used by the DOCS panel "Sync Now" button and
 * can be called by agents via Bash if they want to ensure freshness before
 * reading the vault.
 *
 * Returns commit info and the updated/added paths so the UI can refresh the
 * docs list intelligently.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { ensureVault } from '../../../../lib/vault/config';
import { isInboundAuthorized } from '../../../../lib/remote/config';
import { runCmd } from '../../../../lib/util/spawn';

export const dynamic = 'force-dynamic';

function isAllowed(req: NextRequest): boolean {
  const auth = req.headers.get('authorization');
  if (auth) return isInboundAuthorized(auth);
  return true; // local UI
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; ok: boolean }> {
  // runCmd ensures windowsHide:true so per-spawn console windows don't flash on Windows.
  const r = await runCmd('git', args, { cwd, timeout: 60_000, allowFail: true });
  return { stdout: r.ok ? r.stdout : (r.stdout || r.stderr || r.error?.message || ''), ok: r.ok };
}

export async function POST(req: NextRequest) {
  if (!isAllowed(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let vaultPath: string;
  try { vaultPath = ensureVault(); }
  catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || 'vault not configured' }, { status: 400 }); }

  if (!fs.existsSync(path.join(vaultPath, '.git'))) {
    return NextResponse.json({
      ok: false,
      error: 'Vault is not a git repository. Sync is a no-op.',
      vaultPath,
    });
  }

  // Stage any local changes (in case the debounced commit hasn't fired yet),
  // commit them, then pull. This guarantees the user's last edit is captured
  // before we rebase onto remote.
  await git(vaultPath, ['add', '-A']);
  const status = await git(vaultPath, ['status', '--porcelain']);
  let stashed = false;
  if (status.stdout.trim()) {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Mission Control',
      GIT_AUTHOR_EMAIL: 'mc@revolve.construction',
      GIT_COMMITTER_NAME: 'Mission Control',
      GIT_COMMITTER_EMAIL: 'mc@revolve.construction',
    };
    const cm = await runCmd('git', ['commit', '-m', 'mc: sync-now flush'], {
      cwd: vaultPath, env, timeout: 60_000, allowFail: true,
    });
    if (cm.ok) stashed = true;
    // commit may fail if nothing to commit; carry on either way
  }

  // Capture HEAD before pull so we can diff what changed
  const before = (await git(vaultPath, ['rev-parse', 'HEAD'])).stdout.trim();

  const pull = await git(vaultPath, ['pull', '--rebase', '--autostash', 'origin', 'HEAD']);
  if (!pull.ok) {
    return NextResponse.json({ ok: false, error: 'pull failed', detail: pull.stdout.slice(0, 500) }, { status: 502 });
  }

  // Push our committed changes (if any)
  let pushed = false;
  if (stashed) {
    const push = await git(vaultPath, ['push', 'origin', 'HEAD']);
    pushed = push.ok;
  }

  const after = (await git(vaultPath, ['rev-parse', 'HEAD'])).stdout.trim();

  // Files changed between before and after
  let changedFiles: string[] = [];
  if (before && after && before !== after) {
    const diff = await git(vaultPath, ['diff', '--name-only', `${before}...${after}`]);
    changedFiles = diff.stdout.trim().split('\n').filter(Boolean);
  }

  return NextResponse.json({
    ok: true,
    vaultPath,
    before,
    after,
    changedFiles,
    pulled: changedFiles.length,
    pushedLocalChanges: pushed,
  });
}
