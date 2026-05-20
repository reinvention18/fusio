/**
 * /api/integrations — single-user local integrations vault.
 *
 * GET  → returns the merged state (auto-detected from common locations +
 *        whatever the user has saved in data/integrations.json).
 * POST → saves the body to data/integrations.json (overwrites).
 *
 * Auto-detection sources (only used to seed if nothing is saved yet):
 *   - process.env (ANTHROPIC_API_KEY, OPENAI_API_KEY, VERCEL_TOKEN, …)
 *   - ~/<your-mobile-app>/.env + .env.local
 *   - ~/.codex/auth.json           → OpenAI subscription auth
 *   - ~/.claude/                   → Claude Code subscription auth (existence)
 *   - ~/.config/gh/hosts.yml       → GitHub username
 *   - `tailscale status --json`    → Tailscale hostname
 *
 * This is a LOCAL single-user app; values are stored unencrypted in
 * data/integrations.json (file is gitignored). For encrypted shared
 * secrets use the existing CredentialsPanel vault.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

export type AuthMode = 'subscription' | 'apikey' | 'none';

export interface IntegrationsState {
  anthropic: {
    mode: AuthMode;
    apiKey: string;
    subscriptionDetected: boolean;
  };
  openai: {
    mode: AuthMode;
    apiKey: string;
    subscriptionDetected: boolean;
    authMode?: string; // 'chatgpt' | 'apikey' from ~/.codex/auth.json
  };
  vercel: {
    token: string;
    teamId: string;
  };
  supabase: {
    url: string;
    anonKey: string;
    serviceRoleKey: string;
    projectRef: string;
    accessToken: string;
  };
  github: {
    token: string;
    username: string;
  };
  tailscale: {
    authKey: string;
    hostname: string;
    running: boolean;
  };
  resend: {
    apiKey: string;
  };
  stripe: {
    secretKey: string;
    publishableKey: string;
  };
}

const STORE_FILE = path.join(process.cwd(), 'data', 'integrations.json');

function readEnvFile(p: string): Record<string, string> {
  if (!fs.existsSync(p)) return {};
  try {
    const text = fs.readFileSync(p, 'utf-8');
    const out: Record<string, string> = {};
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[k] = v;
    }
    return out;
  } catch { return {}; }
}

function emptyState(): IntegrationsState {
  return {
    anthropic: { mode: 'none', apiKey: '', subscriptionDetected: false },
    openai:    { mode: 'none', apiKey: '', subscriptionDetected: false },
    vercel:    { token: '', teamId: '' },
    supabase:  { url: '', anonKey: '', serviceRoleKey: '', projectRef: '', accessToken: '' },
    github:    { token: '', username: '' },
    tailscale: { authKey: '', hostname: '', running: false },
    resend:    { apiKey: '' },
    stripe:    { secretKey: '', publishableKey: '' },
  };
}

function detectFromSystem(): IntegrationsState {
  const state = emptyState();
  const home = os.homedir();

  // Auto-detect API keys from .env files in user-configured workspaces.
  // Path candidates come from data/integration-workspaces.json if it exists,
  // otherwise we just look at process.env (set by the shell or by ecosystem
  // config). To enable auto-detection from a project's .env, drop a JSON
  // file at data/integration-workspaces.json with an array of paths:
  //   ["/abs/path/to/project1", "/abs/path/to/project2"]
  // Earliest file wins for any var already set.
  function loadWorkspacePaths(): string[] {
    try {
      const f = path.join(process.cwd(), 'data', 'integration-workspaces.json');
      if (!fs.existsSync(f)) return [];
      const raw = fs.readFileSync(f, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((p: any) => typeof p === 'string') : [];
    } catch { return []; }
  }
  const envCandidates: string[] = [];
  for (const ws of loadWorkspacePaths()) {
    envCandidates.push(path.join(ws, '.env'));
    envCandidates.push(path.join(ws, '.env.local'));
    envCandidates.push(path.join(ws, '.env.production'));
  }
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  for (const p of envCandidates) {
    const parsed = readEnvFile(p);
    for (const [k, v] of Object.entries(parsed)) {
      // Earliest file wins for already-set vars
      if (!env[k] && v) env[k] = v;
    }
  }

  // Capture API keys but DON'T set mode yet — subscription detection
  // below should take precedence as the default if both are available.
  if (env.ANTHROPIC_API_KEY) state.anthropic.apiKey = env.ANTHROPIC_API_KEY;
  if (env.OPENAI_API_KEY)    state.openai.apiKey    = env.OPENAI_API_KEY;
  if (env.VERCEL_TOKEN || env.VERCEL_ACCESS_TOKEN) {
    state.vercel.token = env.VERCEL_TOKEN || env.VERCEL_ACCESS_TOKEN;
  }
  if (env.VERCEL_TEAM_ID) state.vercel.teamId = env.VERCEL_TEAM_ID;

  state.supabase.url            = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '';
  state.supabase.anonKey        = env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  state.supabase.serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || '';
  state.supabase.projectRef     = env.SUPABASE_PROJECT_REF || '';
  state.supabase.accessToken    = env.SUPABASE_ACCESS_TOKEN || '';

  state.github.token = env.GITHUB_TOKEN || env.GH_TOKEN || '';
  state.resend.apiKey = env.RESEND_API_KEY || '';
  state.stripe.secretKey      = env.STRIPE_SECRET_KEY || '';
  state.stripe.publishableKey = env.STRIPE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '';

  // Claude Code subscription — presence of ~/.claude/ with agents/commands.
  // Prefer subscription as the default mode when both subscription + API
  // key are available (no API costs).
  try {
    const claudeDir = path.join(home, '.claude');
    if (fs.existsSync(claudeDir) && fs.existsSync(path.join(claudeDir, 'agents'))) {
      state.anthropic.subscriptionDetected = true;
    }
  } catch { /* ignore */ }
  state.anthropic.mode =
    state.anthropic.subscriptionDetected ? 'subscription' :
    state.anthropic.apiKey ? 'apikey' : 'none';

  // Codex / OpenAI subscription — ~/.codex/auth.json with auth_mode "chatgpt"
  try {
    const codexAuth = path.join(home, '.codex', 'auth.json');
    if (fs.existsSync(codexAuth)) {
      const j = JSON.parse(fs.readFileSync(codexAuth, 'utf-8'));
      state.openai.authMode = j?.auth_mode;
      if (j?.auth_mode === 'chatgpt') state.openai.subscriptionDetected = true;
    }
  } catch { /* ignore */ }
  state.openai.mode =
    state.openai.subscriptionDetected ? 'subscription' :
    state.openai.apiKey ? 'apikey' : 'none';

  // GitHub username from gh config
  try {
    const ghHosts = path.join(home, '.config', 'gh', 'hosts.yml');
    if (fs.existsSync(ghHosts)) {
      const yml = fs.readFileSync(ghHosts, 'utf-8');
      const m = yml.match(/^\s*user:\s*(\S+)/m);
      if (m) state.github.username = m[1];
    }
  } catch { /* ignore */ }

  // Tailscale status — try to read hostname + running state
  try {
    const out = execSync('tailscale status --json 2>/dev/null', { timeout: 1500 }).toString();
    const j = JSON.parse(out);
    state.tailscale.running = j?.BackendState === 'Running';
    state.tailscale.hostname = j?.Self?.HostName || '';
  } catch { /* tailscale not installed or not authed */ }

  return state;
}

function mergeStates(base: IntegrationsState, override: Partial<IntegrationsState>): IntegrationsState {
  const out = { ...base };
  for (const k of Object.keys(override) as Array<keyof IntegrationsState>) {
    const ov = override[k];
    if (ov && typeof ov === 'object') {
      // @ts-expect-error nested merge
      out[k] = { ...base[k], ...ov };
    }
  }
  return out;
}

function readStored(): Partial<IntegrationsState> | null {
  try {
    if (!fs.existsSync(STORE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
  } catch { return null; }
}

function writeStored(state: IntegrationsState): void {
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2));
}

export async function GET() {
  try {
    const detected = detectFromSystem();
    const stored = readStored();
    // Stored values WIN over detected (user explicitly entered something);
    // detected fills in everything the user hasn't touched yet.
    const merged = stored ? mergeStates(detected, stored) : detected;
    // Re-detect always-fresh signals (subscription presence, tailscale state)
    merged.anthropic.subscriptionDetected = detected.anthropic.subscriptionDetected;
    merged.openai.subscriptionDetected = detected.openai.subscriptionDetected;
    merged.openai.authMode = detected.openai.authMode;
    merged.tailscale.running = detected.tailscale.running;
    if (!merged.tailscale.hostname) merged.tailscale.hostname = detected.tailscale.hostname;
    if (!merged.github.username) merged.github.username = detected.github.username;
    return NextResponse.json({ state: merged });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const incoming = body?.state || body;
    const detected = detectFromSystem();
    const stored = readStored() || {};
    const merged = mergeStates(mergeStates(detected, stored), incoming);
    writeStored(merged);
    return NextResponse.json({ ok: true, state: merged });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
