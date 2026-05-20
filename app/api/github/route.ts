/**
 * /api/github — GitHub integration via `gh` CLI.
 *
 * Uses the already-authenticated gh CLI to:
 *   - List repos, branches, PRs, issues
 *   - Read file contents
 *   - Get repo info
 *   - Clone/attach repos to chat sessions
 *
 * Actions:
 *   GET ?action=status          — auth status
 *   GET ?action=repos           — list user's repos
 *   GET ?action=repo&name=X     — repo details
 *   GET ?action=branches&repo=X — list branches
 *   GET ?action=files&repo=X&path=Y — list files in a path
 *   GET ?action=content&repo=X&path=Y — read file content
 *   GET ?action=prs&repo=X      — list PRs
 *   GET ?action=issues&repo=X   — list issues
 *   POST { action: 'clone', repo, path } — clone repo to local path
 */

import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);

/**
 * Resolve the `gh` binary across Linux + macOS + Windows.
 * Order:
 *   1. $GH_BIN env override
 *   2. Common known absolute paths (linuxbrew, mac homebrew, Windows GH CLI)
 *   3. Bare "gh" / "gh.exe" — relies on PATH
 */
function resolveGhPath(): string {
  const fromEnv = process.env.GH_BIN?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\GitHub CLI\\gh.exe',
        'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
      ]
    : [
        '/home/linuxbrew/.linuxbrew/bin/gh',
        '/usr/local/bin/gh',
        '/opt/homebrew/bin/gh',
        '/usr/bin/gh',
      ];

  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return process.platform === 'win32' ? 'gh.exe' : 'gh';
}

const GH = resolveGhPath();

async function gh(args: string[]): Promise<string> {
  // On Windows we need shell:true to find .exe by name from PATH, but that
  // breaks when the resolved GH path contains spaces (e.g. "C:\Program Files\..").
  // Workaround: shell:true ONLY when GH is a bare command (no path separators);
  // when GH is an absolute path, run without shell so spaces are fine.
  const isAbsolute = process.platform === 'win32'
    ? /[\\/]/.test(GH)
    : GH.startsWith('/');
  const { stdout } = await execFileAsync(GH, args, {
    timeout: 30_000,
    maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, GH_PAGER: '', NO_COLOR: '1' },
    shell: process.platform === 'win32' && !isAbsolute,
    windowsHide: true,
  });
  return stdout.trim();
}

async function ghJson(args: string[]): Promise<any> {
  const raw = await gh(args);
  return JSON.parse(raw);
}

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get('action') || 'status';
  const repo = request.nextUrl.searchParams.get('repo') || '';
  const filePath = request.nextUrl.searchParams.get('path') || '';

  try {
    switch (action) {
      case 'status': {
        // Distinguish: gh missing entirely vs gh present but unauthenticated.
        // Lets the UI show a useful error instead of an empty repo list.
        try {
          const out = await gh(['auth', 'status']);
          const userMatch = out.match(/Logged in to github.com account (\S+)/);
          const tokenInvalid = /token in default is invalid|token has expired|not authenticated/i.test(out);
          if (tokenInvalid) {
            return NextResponse.json({
              authenticated: false,
              ghPath: GH,
              hint: `gh CLI is installed at ${GH} but the auth token is invalid. Run: gh auth login -h github.com`,
              raw: out,
            });
          }
          return NextResponse.json({
            authenticated: true,
            user: userMatch?.[1] || 'unknown',
            ghPath: GH,
            raw: out,
          });
        } catch (e: any) {
          // gh either missing or returned non-zero. The CLI returns non-zero
          // when not authenticated, but error.stderr usually carries a useful
          // message. Surface it.
          const msg = (e?.stderr || e?.message || 'gh failed').toString().slice(0, 400);
          const tokenInvalid = /token in default is invalid|token has expired|not authenticated/i.test(msg);
          return NextResponse.json({
            authenticated: false,
            ghPath: GH,
            hint: tokenInvalid
              ? `gh auth token is invalid. On this machine, run: gh auth login -h github.com`
              : `gh CLI failed (path: ${GH}). Verify it's installed and on PATH. Set GH_BIN env var if it's elsewhere.`,
            error: msg,
          });
        }
      }

      case 'repos': {
        const limit = request.nextUrl.searchParams.get('limit') || '30';
        const repos = await ghJson([
          'repo', 'list', '--json',
          'name,owner,description,url,isPrivate,pushedAt,stargazerCount',
          '--limit', limit,
        ]);
        return NextResponse.json({ repos });
      }

      case 'repo': {
        if (!repo) return NextResponse.json({ error: 'repo required' }, { status: 400 });
        const info = await ghJson(['repo', 'view', repo, '--json',
          'name,owner,description,url,isPrivate,defaultBranchRef,pushedAt,primaryLanguage,issues,pullRequests,stargazerCount,forkCount',
        ]);
        return NextResponse.json(info);
      }

      case 'branches': {
        if (!repo) return NextResponse.json({ error: 'repo required' }, { status: 400 });
        const raw = await gh(['api', `repos/${repo}/branches`, '--paginate', '-q', '.[].name']);
        const branches = raw.split('\n').filter(Boolean);
        return NextResponse.json({ branches });
      }

      case 'files': {
        if (!repo) return NextResponse.json({ error: 'repo required' }, { status: 400 });
        const apiPath = filePath
          ? `repos/${repo}/contents/${filePath}`
          : `repos/${repo}/contents`;
        const items = await ghJson(['api', apiPath]);
        const files = (Array.isArray(items) ? items : [items]).map((f: any) => ({
          name: f.name,
          type: f.type, // 'file' or 'dir'
          path: f.path,
          size: f.size,
          sha: f.sha,
        }));
        return NextResponse.json({ files, path: filePath || '/' });
      }

      case 'content': {
        if (!repo || !filePath) return NextResponse.json({ error: 'repo and path required' }, { status: 400 });
        const file = await ghJson(['api', `repos/${repo}/contents/${filePath}`]);
        const content = file.encoding === 'base64'
          ? Buffer.from(file.content, 'base64').toString('utf-8')
          : file.content;
        return NextResponse.json({
          content,
          name: file.name,
          path: file.path,
          size: file.size,
          sha: file.sha,
        });
      }

      case 'prs': {
        if (!repo) return NextResponse.json({ error: 'repo required' }, { status: 400 });
        const prs = await ghJson(['pr', 'list', '-R', repo, '--json',
          'number,title,state,author,createdAt,url,headRefName,isDraft',
          '--limit', '20',
        ]);
        return NextResponse.json({ prs });
      }

      case 'issues': {
        if (!repo) return NextResponse.json({ error: 'repo required' }, { status: 400 });
        const issues = await ghJson(['issue', 'list', '-R', repo, '--json',
          'number,title,state,author,createdAt,url,labels',
          '--limit', '20',
        ]);
        return NextResponse.json({ issues });
      }

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error: any) {
    console.error('[GitHub API]', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, repo, path: targetPath } = body;

    if (action === 'clone') {
      if (!repo) return NextResponse.json({ error: 'repo required' }, { status: 400 });
      const clonePath = targetPath || `~/${repo.split('/').pop()}`;
      await gh(['repo', 'clone', repo, clonePath]);
      return NextResponse.json({ success: true, path: clonePath });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
