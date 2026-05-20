/**
 * vault/git-sync — debounced auto-commit + push for the Obsidian wiki.
 *
 * When MC writes a doc into the vault mirror (or the user calls vault_write),
 * this module schedules a background `git add . && git commit && git push` so
 * the change propagates to the other machine.
 *
 * Pull happens on a polling interval and on first agent turn — see hookGitPull.
 *
 * All git ops run with stdio:'ignore' (silent on success, logged on failure).
 * Failures are non-fatal: the file is still on local disk, just not synced.
 *
 * Designed to be a no-op when the vault dir is not a git repo (single-machine
 * setups stay simple).
 */

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { ensureVault } from './config';
import { runCmd } from '../util/spawn';

const GIT_USER_NAME = process.env.MC_GIT_USER_NAME || 'Mission Control';
const GIT_USER_EMAIL = process.env.MC_GIT_USER_EMAIL || 'mc@revolve.construction';
const COMMIT_DEBOUNCE_MS = 30_000;     // batch rapid edits into one commit
const PULL_INTERVAL_MS = 5 * 60_000;   // pull every 5 min

let commitTimer: NodeJS.Timeout | null = null;
let pullTimer: NodeJS.Timeout | null = null;
let lastPullAt = 0;

function vaultIsGitRepo(vaultPath: string): boolean {
  try {
    return fs.existsSync(path.join(vaultPath, '.git'));
  } catch {
    return false;
  }
}

async function git(vaultPath: string, args: string[], opts: { allowFail?: boolean } = {}) {
  // runCmd centralizes windowsHide:true so the wiki's auto-commit (every 30s
  // after a write) and auto-pull (every 5min) don't flash console windows
  // on Windows in the background.
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: GIT_USER_NAME,
    GIT_AUTHOR_EMAIL: GIT_USER_EMAIL,
    GIT_COMMITTER_NAME: GIT_USER_NAME,
    GIT_COMMITTER_EMAIL: GIT_USER_EMAIL,
  };
  const r = await runCmd('git', args, { cwd: vaultPath, env, timeout: 60_000, allowFail: true });
  if (r.ok) return r.stdout;
  if (!opts.allowFail) {
    console.warn('[wiki-git] git', args.join(' '), 'failed:', r.error?.message?.slice(0, 200));
  }
  return '';
}

/** Schedule a debounced commit + push. Repeated calls within COMMIT_DEBOUNCE_MS reset the timer. */
export function scheduleCommit(reason: string) {
  let vaultPath: string;
  try {
    vaultPath = ensureVault();
  } catch {
    return;
  }
  if (!vaultIsGitRepo(vaultPath)) return;

  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = setTimeout(async () => {
    commitTimer = null;
    await commitNow(vaultPath, reason);
  }, COMMIT_DEBOUNCE_MS);
}

async function commitNow(vaultPath: string, reason: string) {
  // Stage everything
  await git(vaultPath, ['add', '-A']);
  // Check if there's anything to commit
  const status = await git(vaultPath, ['status', '--porcelain'], { allowFail: true });
  if (!status.trim()) return;
  await git(vaultPath, ['commit', '-m', `mc: ${reason}`]);
  // Push — try with autostash in case the remote is ahead
  await git(vaultPath, ['push', 'origin', 'HEAD'], { allowFail: true });
  console.log('[wiki-git] auto-committed +', status.trim().split('\n').length, 'changes');
}

/** Pull the latest from origin. Safe to call repeatedly; throttled by PULL_INTERVAL_MS. */
export async function pullIfDue(force = false) {
  let vaultPath: string;
  try {
    vaultPath = ensureVault();
  } catch {
    return;
  }
  if (!vaultIsGitRepo(vaultPath)) return;
  const now = Date.now();
  if (!force && now - lastPullAt < PULL_INTERVAL_MS) return;
  lastPullAt = now;
  // Stash any local-only changes (unlikely in normal flow), pull, pop
  await git(vaultPath, ['pull', '--rebase', '--autostash', 'origin', 'HEAD'], { allowFail: true });
}

/** Start the background pull loop. Idempotent — safe to call from module init. */
export function startGitSyncLoop() {
  if (pullTimer) return;
  // Initial pull on startup
  setTimeout(() => { pullIfDue(true).catch(() => {}); }, 5_000);
  pullTimer = setInterval(() => { pullIfDue().catch(() => {}); }, PULL_INTERVAL_MS);
}

/** Force a flush of any pending debounced commit (e.g. on shutdown — not currently wired). */
export async function flushPendingCommit() {
  if (!commitTimer) return;
  clearTimeout(commitTimer);
  commitTimer = null;
  try {
    const vaultPath = ensureVault();
    await commitNow(vaultPath, 'flush on shutdown');
  } catch {}
}
