/**
 * vault/config — resolves the Obsidian vault path from env or settings file.
 *
 * Precedence: VAULT_PATH env > data/mission-control-settings.json > default.
 * Default: ~/Documents/MissionControl-Vault (only auto-created on first write).
 */

import 'server-only';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export interface VaultSettings {
  path: string;
  enabled: boolean;
  autoIndex: boolean;
  createIfMissing: boolean;
}

const SETTINGS_FILE = path.join(process.cwd(), 'data', 'mission-control-settings.json');

function loadSettingsFile(): Partial<Record<string, any>> {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) ?? {};
  } catch {
    return {};
  }
}

function saveSettingsFile(next: Record<string, any>): void {
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
}

export function getVaultSettings(): VaultSettings {
  const file = loadSettingsFile();
  const vaultCfg = (file.vault ?? {}) as Partial<VaultSettings>;
  const envPath = process.env.VAULT_PATH?.trim();
  const resolved =
    envPath ||
    vaultCfg.path ||
    path.join(os.homedir(), 'Documents', 'MissionControl-Vault');

  return {
    path: resolved,
    enabled: vaultCfg.enabled ?? !!(envPath || vaultCfg.path),
    autoIndex: vaultCfg.autoIndex ?? false,
    createIfMissing: vaultCfg.createIfMissing ?? true,
  };
}

export function setVaultSettings(next: Partial<VaultSettings>): VaultSettings {
  const file = loadSettingsFile();
  const current = getVaultSettings();
  const merged: VaultSettings = { ...current, ...next };
  saveSettingsFile({ ...file, vault: merged });
  return merged;
}

export function vaultExists(): boolean {
  const { path: p } = getVaultSettings();
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export function ensureVault(): string {
  const s = getVaultSettings();
  if (!fs.existsSync(s.path) && s.createIfMissing) {
    fs.mkdirSync(s.path, { recursive: true });
    // Seed a minimal README so the vault is visibly a vault.
    const readme = path.join(s.path, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme,
        `# Mission Control Vault\n\nThis Obsidian-compatible vault holds notes written by the Mission Control agents.\n\nOpen it in Obsidian with **File → Open vault** → select this folder.\n`);
    }
  }
  return s.path;
}

/** Resolve an untrusted input path safely inside the vault. Throws on traversal. */
export function resolveInVault(relativePath: string): string {
  const root = path.resolve(ensureVault());
  const cleaned = relativePath.replace(/^[\\/]+/, '');
  const joined = path.resolve(root, cleaned);
  if (!joined.startsWith(root + path.sep) && joined !== root) {
    throw new Error(`Path escapes vault: ${relativePath}`);
  }
  return joined;
}
