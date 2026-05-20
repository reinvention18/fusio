/**
 * mc-remote — load the cross-MC trust file at ~/.config/mc-remote-hosts.json.
 * Each side lists the OTHER MC instances it trusts + a shared bearer token
 * used by /api/remote-chat to authenticate inbound requests.
 *
 * Falls back to "no peers" silently when the file doesn't exist — the rest
 * of MC keeps working as a single-machine setup.
 */

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface RemoteHost {
  /** stable id used in tool calls — e.g. "pc" */
  id: string;
  /** human label shown in UI */
  label: string;
  /** base URL of the peer MC (Tailscale URL, http: or https:) */
  url: string;
  /** bearer token to authenticate this side's outbound requests to the peer */
  token: string;
}

export interface RemoteHostsConfig {
  /** bearer token this side accepts on inbound /api/remote-chat */
  myToken: string;
  myLabel: string;
  myUrl: string;
  hosts: RemoteHost[];
}

const CONFIG_PATH = path.join(os.homedir(), '.config', 'mc-remote-hosts.json');

let cached: RemoteHostsConfig | null = null;
let cacheMtime = 0;

export function loadRemoteConfig(): RemoteHostsConfig | null {
  try {
    const st = fs.statSync(CONFIG_PATH);
    if (cached && st.mtimeMs === cacheMtime) return cached;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as RemoteHostsConfig;
    if (!parsed.myToken || !Array.isArray(parsed.hosts)) return null;
    cached = parsed;
    cacheMtime = st.mtimeMs;
    return cached;
  } catch {
    return null;
  }
}

export function findHost(id: string): RemoteHost | undefined {
  const cfg = loadRemoteConfig();
  return cfg?.hosts.find(h => h.id === id);
}

export function listHosts(): RemoteHost[] {
  return loadRemoteConfig()?.hosts ?? [];
}

/** Verify a bearer token from an inbound request matches our myToken. */
export function isInboundAuthorized(authHeader: string | null): boolean {
  const cfg = loadRemoteConfig();
  if (!cfg) return false;
  if (!authHeader) return false;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return m[1] === cfg.myToken;
}
