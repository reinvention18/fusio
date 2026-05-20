/**
 * GET /api/git/status — list managed repos with their current sync state.
 * Used by the Pull Latest dropdown to show "you are 3 commits behind".
 *
 * Returns: { repos: [{ id, label, path, branch, head, ahead, behind, dirty, exists }] }
 *
 * NOTE: This file replaces an older implementation that returned a single
 *       repo's status. The chat-header Pull Latest button needs the
 *       multi-repo shape, so the route now lists every managed repo.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { listManagedRepos } from '../../../../lib/git-pull/repos';
import { runGit } from '../../../../lib/util/spawn';

export const dynamic = 'force-dynamic';

async function gitText(cwd: string, args: string[], timeoutMs = 8000): Promise<string> {
  // runGit always sets windowsHide:true so this fan-out doesn't flash 20+
  // console windows on Windows when the Pull Latest dropdown polls.
  return runGit(args, { cwd, timeout: timeoutMs });
}

export async function GET(_req: NextRequest) {
  const repos = listManagedRepos();
  const out = await Promise.all(repos.map(async (r) => {
    if (!fs.existsSync(path.join(r.path, '.git'))) {
      return { id: r.id, label: r.label, path: r.path, exists: false };
    }
    const [branch, head, dirtyRaw, behindAhead] = await Promise.all([
      gitText(r.path, ['rev-parse', '--abbrev-ref', 'HEAD']),
      gitText(r.path, ['rev-parse', '--short', 'HEAD']),
      gitText(r.path, ['status', '--porcelain']),
      gitText(r.path, ['rev-list', '--left-right', '--count', '@{u}...HEAD']).catch(() => ''),
    ]);
    let ahead = 0, behind = 0;
    if (behindAhead) {
      const [b, a] = behindAhead.split(/\s+/).map(s => parseInt(s, 10) || 0);
      behind = b; ahead = a;
    }
    return {
      id: r.id, label: r.label, path: r.path, exists: true,
      branch: branch || '?',
      head: head || '?',
      ahead, behind,
      dirty: dirtyRaw.length > 0,
      dirtyCount: dirtyRaw ? dirtyRaw.split('\n').length : 0,
    };
  }));
  return NextResponse.json({ repos: out });
}
