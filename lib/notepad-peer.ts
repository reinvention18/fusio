/**
 * notepad-peer — single-source-of-truth resolver for the shared notepad.
 *
 * When you run MC on more than one machine, each machine writes to its
 * own data/notepads/<id>.json by default, which means typing on one
 * machine never appears on another. To share a single notepad across
 * machines, designate one as the canonical host and point the others
 * at it via the MC_NOTEPAD_PEER env var.
 *
 * Resolution order:
 *   1. MC_NOTEPAD_PEER env var (explicit override — full URL like
 *      "http://10.0.0.5:3001"). Set this on every NON-canonical machine.
 *   2. Otherwise this machine acts as the canonical host (returns null,
 *      which makes the notepad routes serve from local disk).
 *
 * Recommended setup for a multi-machine pair sharing one notepad:
 *   - Canonical host (always-on box): don't set MC_NOTEPAD_PEER.
 *   - Every other machine: set MC_NOTEPAD_PEER=http://<canonical-host>:3001
 *     (use a Tailscale hostname, a LAN IP, or any URL the peer can reach).
 *     The proxy machine's notepad routes will transparently forward every
 *     GET/POST/SSE-listen call to the canonical host.
 */

import 'server-only';

export function getNotepadPeerUrl(): string | null {
  const fromEnv = process.env.MC_NOTEPAD_PEER;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().replace(/\/$/, '');
  return null;
}
