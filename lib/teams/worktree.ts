import 'server-only';
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';

// Ported from parallel-code/electron/ipc/git.ts — adapted for Node.js (no Electron IPC).
// References: createWorktree (git.ts:366–423), mergeTask (git.ts:899–1005),
// withWorktreeLock (git.ts:72–90), diff/numstat (git.ts:195–243).

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run a command to completion, capturing stdout/stderr. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const to = opts.timeoutMs
      ? setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* ignore */ } }, opts.timeoutMs)
      : null;
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      if (to) clearTimeout(to);
      reject(err);
    });
    child.on('close', code => {
      if (to) clearTimeout(to);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

// Use absolute path — PM2 production environment may have a stripped PATH.
const GIT = '/usr/bin/git';

async function git(cwd: string, ...args: string[]): Promise<SpawnResult> {
  return run(GIT, args, { cwd });
}

// ─── Per-repo serialization lock (ported from git.ts:72–90) ──────────────
// Prevents two concurrent merge/worktree operations from stepping on the
// same .git directory. Keyed by the repo's common dir (resolved absolute).

const repoLocks: Map<string, Promise<unknown>> = new Map();

export async function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoRoot);
  const prior = repoLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const chain = prior.then(() => gate);
  repoLocks.set(key, chain);
  try {
    await prior;
    return await fn();
  } finally {
    release();
    if (repoLocks.get(key) === chain) repoLocks.delete(key);
  }
}

// ─── Basic checks ────────────────────────────────────────────────────────

export async function isRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, 'rev-parse', '--is-inside-work-tree');
  return r.code === 0 && r.stdout.trim() === 'true';
}

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (r.code !== 0) return null;
  const b = r.stdout.trim();
  return b === 'HEAD' ? null : b;
}

export async function isDirty(cwd: string): Promise<boolean> {
  const r = await git(cwd, 'status', '--porcelain');
  if (r.code !== 0) throw new Error(`git status failed: ${r.stderr}`);
  return r.stdout.trim().length > 0;
}

async function isIgnored(cwd: string, p: string): Promise<boolean> {
  const r = await git(cwd, 'check-ignore', '-q', p);
  return r.code === 0;
}

// ─── Symlink helpers ─────────────────────────────────────────────────────
// Port of parallel-code's "shallow symlink .claude" trick: each agent
// shares most of .claude/ but has its own plans/ and settings.local.json.

const CLAUDE_DIR_EXCLUDE = new Set(['plans', 'settings.local.json']);

async function ensureParent(p: string): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
}

async function symlinkIfMissing(source: string, target: string): Promise<void> {
  if (!fs.existsSync(source)) return;
  if (fs.existsSync(target)) return; // skip silently (git.ts:409 pattern)
  await ensureParent(target);
  await fsp.symlink(source, target, 'dir');
}

async function shallowSymlinkClaudeDir(source: string, target: string): Promise<void> {
  if (!fs.existsSync(source)) return;
  await fsp.mkdir(target, { recursive: true });
  const entries = await fsp.readdir(source);
  for (const name of entries) {
    if (CLAUDE_DIR_EXCLUDE.has(name)) continue;
    const src = path.join(source, name);
    const dst = path.join(target, name);
    if (fs.existsSync(dst)) continue;
    const stat = await fsp.stat(src);
    await fsp.symlink(src, dst, stat.isDirectory() ? 'dir' : 'file');
  }
}

// Candidates to symlink into a fresh worktree from the parent repo.
// Only git-ignored ones are actually linked (so they don't conflict with
// anything the worktree may already contain from the branch checkout).
const SYMLINK_CANDIDATES = [
  'node_modules',
  '.next',
  '.env',
  '.env.local',
  '.venv',
  'venv',
  '.cursor',
  '.aider',
];

// ─── Worktree lifecycle ──────────────────────────────────────────────────

export interface CreateWorktreeInput {
  repoRoot: string;
  branchName: string;         // full branch name e.g. "mc/<team>/<agent>"
  worktreePath: string;       // absolute path where the worktree should live
  baseBranch?: string;        // defaults to current main
  forceClean?: boolean;       // if true, remove any stale worktree at the path
}

export interface CreateWorktreeResult {
  path: string;
  branch: string;
  linked: string[];           // actual paths that got symlinked
}

export async function createWorktree(input: CreateWorktreeInput): Promise<CreateWorktreeResult> {
  const { repoRoot, branchName, worktreePath } = input;
  const baseBranch = input.baseBranch ?? (await getCurrentBranch(repoRoot)) ?? 'main';

  return withRepoLock(repoRoot, async () => {
    if (input.forceClean && fs.existsSync(worktreePath)) {
      const rm = await git(repoRoot, 'worktree', 'remove', '--force', worktreePath);
      if (rm.code !== 0) {
        // Fall back to fs rm, mirroring git.ts:381
        await fsp.rm(worktreePath, { recursive: true, force: true });
      }
      await git(repoRoot, 'worktree', 'prune');
    }

    const branchExists = (await git(repoRoot, 'rev-parse', '--verify', branchName)).code === 0;

    let addRes: SpawnResult;
    if (branchExists) {
      addRes = await git(repoRoot, 'worktree', 'add', worktreePath, branchName);
    } else {
      addRes = await git(repoRoot, 'worktree', 'add', '-b', branchName, worktreePath, baseBranch);
    }
    if (addRes.code !== 0) {
      throw new Error(`git worktree add failed: ${addRes.stderr.trim() || addRes.stdout.trim()}`);
    }

    // Neutralize project-level MCP configs that would otherwise be auto-loaded
    // by each agent's Claude Code SDK. Cross-platform paths, heavy npx installs
    // like task-master-ai, or Windows-only configs will hang the SDK on init.
    // We preserve the file (renamed) so the main repo's workflow is untouched.
    for (const name of ['.mcp.json', '.mcp.local.json']) {
      const src = path.join(worktreePath, name);
      if (fs.existsSync(src)) {
        try {
          await fsp.rename(src, path.join(worktreePath, `${name}.project-original`));
        } catch (e) {
          console.warn(`[worktree] failed to neutralize ${name}:`, (e as Error).message);
        }
      }
    }

    // Symlink git-ignored build deps so agents don't have to reinstall.
    const linked: string[] = [];
    for (const name of SYMLINK_CANDIDATES) {
      const src = path.join(repoRoot, name);
      if (!fs.existsSync(src)) continue;
      if (!(await isIgnored(repoRoot, name))) continue;
      const dst = path.join(worktreePath, name);
      try {
        await symlinkIfMissing(src, dst);
        linked.push(name);
      } catch (e) {
        // Non-fatal — agent can still run, just without prebuilt deps.
        console.warn(`[worktree] failed to symlink ${name}:`, (e as Error).message);
      }
    }

    // Special shallow-symlink for .claude so skills/agents are shared but
    // per-worktree plans/ and settings.local.json remain isolated.
    const claudeSrc = path.join(repoRoot, '.claude');
    if (fs.existsSync(claudeSrc)) {
      const claudeDst = path.join(worktreePath, '.claude');
      // If the branch checkout already has a .claude, merge by overlaying.
      try {
        await shallowSymlinkClaudeDir(claudeSrc, claudeDst);
        linked.push('.claude (shallow)');
      } catch (e) {
        console.warn(`[worktree] .claude shallow symlink failed:`, (e as Error).message);
      }
    }

    return { path: worktreePath, branch: branchName, linked };
  });
}

export interface RemoveWorktreeInput {
  repoRoot: string;
  worktreePath: string;
  branchName?: string;
  force?: boolean;             // allow removing dirty worktrees
  deleteBranch?: boolean;      // also `git branch -D branch`
}

export async function removeWorktree(input: RemoveWorktreeInput): Promise<void> {
  const { repoRoot, worktreePath } = input;
  return withRepoLock(repoRoot, async () => {
    if (!input.force && fs.existsSync(worktreePath)) {
      try {
        if (await isDirty(worktreePath)) {
          throw new Error('refusing to remove dirty worktree (pass force=true)');
        }
      } catch {
        // status failed — worktree may already be gone; proceed
      }
    }
    const rm = await git(repoRoot, 'worktree', 'remove', input.force ? '--force' : '', worktreePath);
    if (rm.code !== 0) {
      // Fall back to fs rm (git.ts:439 pattern)
      await fsp.rm(worktreePath, { recursive: true, force: true });
    }
    await git(repoRoot, 'worktree', 'prune');
    if (input.deleteBranch && input.branchName) {
      await git(repoRoot, 'branch', '-D', input.branchName);
    }
  });
}

// ─── Diff computation ────────────────────────────────────────────────────

export interface DiffResult {
  numstat: string;                // "+X -Y" human format
  linesAdded: number;
  linesRemoved: number;
  filesChanged: string[];
  unifiedDiff: string;
}

/**
 * Compute the diff of a worktree against a base branch. Mirrors claude-squad's
 * approach: `git add -N .` to stage untracked files so they appear in diff.
 */
export async function diffAgainstBase(worktreePath: string, baseBranch: string = 'main'): Promise<DiffResult> {
  await git(worktreePath, 'add', '-N', '.');

  const numstatRes = await git(worktreePath, 'diff', '--numstat', `${baseBranch}...HEAD`);
  let linesAdded = 0;
  let linesRemoved = 0;
  const filesChanged: string[] = [];
  if (numstatRes.code === 0) {
    for (const line of numstatRes.stdout.split('\n')) {
      const m = line.trim().match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
      if (!m) continue;
      const add = m[1] === '-' ? 0 : parseInt(m[1], 10);
      const rem = m[2] === '-' ? 0 : parseInt(m[2], 10);
      linesAdded += add;
      linesRemoved += rem;
      filesChanged.push(m[3]);
    }
  }

  const diffRes = await git(worktreePath, 'diff', `${baseBranch}...HEAD`);

  return {
    numstat: `+${linesAdded} -${linesRemoved}`,
    linesAdded,
    linesRemoved,
    filesChanged,
    unifiedDiff: diffRes.code === 0 ? diffRes.stdout : '',
  };
}

// ─── Merge (port of parallel-code/electron/ipc/git.ts:899–1005) ──────────

export interface MergeInput {
  repoRoot: string;
  branchName: string;           // the task branch being merged
  mainBranch?: string;          // target (default: current branch at repoRoot)
  squash?: boolean;
  commitMessage?: string;
}

export interface MergeResult {
  ok: true;
  mainBranch: string;
  linesAdded: number;
  linesRemoved: number;
}

export interface MergeConflictResult {
  ok: false;
  reason: 'conflict' | 'branch_mismatch' | 'dirty' | 'unknown';
  conflictFiles?: string[];
  error: string;
}

export async function mergeBranch(input: MergeInput): Promise<MergeResult | MergeConflictResult> {
  const { repoRoot, branchName } = input;
  const mainBranch = input.mainBranch ?? (await getCurrentBranch(repoRoot));
  if (!mainBranch) {
    return { ok: false, reason: 'branch_mismatch', error: 'detached HEAD in main repo' };
  }

  return withRepoLock(repoRoot, async () => {
    if (await isDirty(repoRoot)) {
      return { ok: false, reason: 'dirty', error: 'main repo working tree is dirty' } satisfies MergeConflictResult;
    }

    // Compute stats before the merge (parallel-code git.ts:933–937)
    const diff = await diffAgainstBase(repoRoot, branchName); // note: against *branch*

    const original = await getCurrentBranch(repoRoot);
    if (original !== mainBranch) {
      const co = await git(repoRoot, 'checkout', mainBranch);
      if (co.code !== 0) {
        return { ok: false, reason: 'unknown', error: `checkout ${mainBranch} failed: ${co.stderr}` } satisfies MergeConflictResult;
      }
    }

    const args = input.squash ? ['merge', '--squash', branchName] : ['merge', '--no-ff', branchName];
    const mrg = await git(repoRoot, ...args);
    if (mrg.code !== 0) {
      const conflictList = await git(repoRoot, 'diff', '--name-only', '--diff-filter=U');
      const files = conflictList.stdout.split('\n').map(s => s.trim()).filter(Boolean);
      await git(repoRoot, 'merge', '--abort');
      if (original && original !== mainBranch) {
        await git(repoRoot, 'checkout', original);
      }
      return { ok: false, reason: 'conflict', conflictFiles: files, error: mrg.stderr.trim() } satisfies MergeConflictResult;
    }

    if (input.squash) {
      const msg = input.commitMessage ?? `Merge ${branchName}`;
      const com = await git(repoRoot, 'commit', '-m', msg);
      if (com.code !== 0) {
        return { ok: false, reason: 'unknown', error: com.stderr } satisfies MergeConflictResult;
      }
    }

    if (original && original !== mainBranch) {
      await git(repoRoot, 'checkout', original);
    }

    return {
      ok: true,
      mainBranch,
      linesAdded: diff.linesAdded,
      linesRemoved: diff.linesRemoved,
    };
  });
}

// ─── Convenience ─────────────────────────────────────────────────────────

/** Derive the default worktree path for a Constellation agent. */
export function defaultWorktreePath(repoRoot: string, teamSlug: string, agentHandle: string): string {
  return path.join(repoRoot, '.mc-worktrees', teamSlug, agentHandle);
}

/** Slug used in branch names and worktree paths. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72);
}
