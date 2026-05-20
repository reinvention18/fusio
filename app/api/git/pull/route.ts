/**
 * POST /api/git/pull — fast-forward pull of a managed repo, or all of them.
 *
 *   { repo: "fieldrepapp" }       → pull just that one
 *   { repo: "all" }               → pull every managed repo
 *
 * Safety: refuses to pull if working tree is dirty (would risk merge mess).
 * The user can stash + retry from the UI.
 *
 * Auth: same model as the rest — local UI free, peer requires bearer.
 * (No peer scenario today, but we keep the door open for future "ask peer
 * to pull on its end" calls.)
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { listManagedRepos, getRepo, type ManagedRepo } from '../../../../lib/git-pull/repos';
import { isInboundAuthorized } from '../../../../lib/remote/config';
import { runCmd } from '../../../../lib/util/spawn';

export const dynamic = 'force-dynamic';

function isAllowed(req: NextRequest): boolean {
  const auth = req.headers.get('authorization');
  if (auth) return isInboundAuthorized(auth);
  return true;
}

interface PullResult {
  id: string;
  label: string;
  ok: boolean;
  before?: string;
  after?: string;
  changedFiles?: string[];
  error?: string;
  pullCount?: number;
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  // runCmd always sets windowsHide:true — silences the per-spawn console flash on Windows.
  const r = await runCmd('git', args, { cwd, timeout: 90_000, allowFail: true });
  return { ok: r.ok, stdout: r.ok ? r.stdout : (r.stdout || r.stderr || r.error?.message || '') };
}

async function pullOne(r: ManagedRepo): Promise<PullResult> {
  if (!fs.existsSync(path.join(r.path, '.git'))) {
    return { id: r.id, label: r.label, ok: false, error: 'not a git repo' };
  }

  // Refuse if the tree is dirty — pulling could merge into uncommitted work.
  const status = (await git(r.path, ['status', '--porcelain'])).stdout.trim();
  if (status) {
    return {
      id: r.id, label: r.label, ok: false,
      error: `working tree has ${status.split('\n').length} uncommitted change(s); commit, stash, or discard before pulling`,
    };
  }

  const before = (await git(r.path, ['rev-parse', 'HEAD'])).stdout.trim();
  const branch = (await git(r.path, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim() || 'HEAD';

  // fetch + ff-only pull. ff-only refuses to merge — keeps history flat.
  const fetch = await git(r.path, ['fetch', 'origin']);
  if (!fetch.ok) {
    return { id: r.id, label: r.label, ok: false, before, error: 'fetch failed: ' + fetch.stdout.slice(0, 200) };
  }
  const pull = await git(r.path, ['merge', '--ff-only', `origin/${branch}`]);
  if (!pull.ok) {
    return { id: r.id, label: r.label, ok: false, before,
      error: 'pull not fast-forward — local commits diverged. Push or rebase manually: ' + pull.stdout.slice(0, 200) };
  }

  const after = (await git(r.path, ['rev-parse', 'HEAD'])).stdout.trim();
  let changedFiles: string[] = [];
  if (before && after && before !== after) {
    const diff = await git(r.path, ['diff', '--name-only', `${before}...${after}`]);
    changedFiles = diff.stdout.trim().split('\n').filter(Boolean);
  }

  return {
    id: r.id, label: r.label, ok: true,
    before, after,
    changedFiles,
    pullCount: changedFiles.length,
  };
}

export async function POST(req: NextRequest) {
  if (!isAllowed(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: any = {};
  try { body = await req.json(); } catch {}
  const repoId = typeof body.repo === 'string' ? body.repo : 'all';

  let targets: ManagedRepo[];
  if (repoId === 'all') {
    targets = listManagedRepos();
  } else {
    const r = getRepo(repoId);
    if (!r) return NextResponse.json({ error: `unknown repo: ${repoId}` }, { status: 404 });
    targets = [r];
  }

  const results = await Promise.all(targets.map(pullOne));
  const totalPulled = results.filter(r => r.ok).reduce((s, r) => s + (r.pullCount || 0), 0);
  return NextResponse.json({
    ok: results.every(r => r.ok),
    results,
    totalPulled,
  });
}
