/**
 * /api/projects — per-project records with optional credential overrides.
 *
 * Each project = { name, path, overrides, createdAt, updatedAt }. The
 * overrides object only carries values the user EXPLICITLY set (so a
 * blank field falls back to /api/integrations at runtime).
 *
 * Stored at data/projects.json. Local single-user app — values are
 * unencrypted; use CredentialsPanel for shared/encrypted secrets.
 *
 * GET    → list all projects
 * POST   → create or update (matches on `path`)
 * DELETE → remove by `path` query param
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export interface ProjectOverrides {
  vercelToken?: string;
  vercelTeamId?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  supabaseServiceRoleKey?: string;
  supabaseProjectRef?: string;
  githubRepo?: string;
  notes?: string;
}

export interface ProjectRecord {
  name: string;
  path: string;
  overrides: ProjectOverrides;
  createdAt: number;
  updatedAt: number;
}

const STORE_FILE = path.join(process.cwd(), 'data', 'projects.json');

function readAll(): ProjectRecord[] {
  try {
    if (!fs.existsSync(STORE_FILE)) return [];
    const j = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    return Array.isArray(j?.projects) ? j.projects : [];
  } catch { return []; }
}

function writeAll(projects: ProjectRecord[]): void {
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify({ projects }, null, 2));
}

/** Strip empty-string fields from overrides so a saved project only
 *  carries the user's actual edits — lets runtime fall through to the
 *  app-wide /api/integrations values cleanly. */
function cleanOverrides(o: ProjectOverrides): ProjectOverrides {
  const out: ProjectOverrides = {};
  for (const [k, v] of Object.entries(o || {})) {
    if (typeof v === 'string' && v.trim()) out[k as keyof ProjectOverrides] = v.trim();
  }
  return out;
}

export async function GET() {
  try {
    return NextResponse.json({ projects: readAll() });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const pPath = String(body?.path || '').trim();
    if (!pPath) return NextResponse.json({ error: 'path required' }, { status: 400 });
    const name = String(body?.name || pPath.split(/[/\\]/).pop() || pPath).trim();
    const overrides = cleanOverrides(body?.overrides || {});

    const projects = readAll();
    const idx = projects.findIndex(p => p.path === pPath);
    const now = Date.now();
    if (idx >= 0) {
      projects[idx] = { ...projects[idx], name, overrides, updatedAt: now };
    } else {
      projects.unshift({ name, path: pPath, overrides, createdAt: now, updatedAt: now });
    }
    writeAll(projects);
    return NextResponse.json({ ok: true, project: projects.find(p => p.path === pPath) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const pPath = searchParams.get('path');
    if (!pPath) return NextResponse.json({ error: 'path required' }, { status: 400 });
    const projects = readAll().filter(p => p.path !== pPath);
    writeAll(projects);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
