/**
 * Missions — milestone checkpoints.
 *
 * Phase 10 ("long-running missions"): after every milestone (phase-complete,
 * self-heal followup, mission-end), the runner writes a numbered checkpoint
 * snapshot of the mission's full state. Checkpoints let a crashed runner
 * resume from a known-good boundary instead of replaying the entire event
 * log, and they give the dashboard a "rewind to checkpoint N" affordance.
 *
 * On disk:
 *   data/missions/<id>/checkpoints/checkpoint-1.json
 *   data/missions/<id>/checkpoints/checkpoint-2.json
 *   data/missions/<id>/checkpoints/manifest.json   ← index { latest, count }
 *
 * Each checkpoint is a deep clone of the mission state at the moment it was
 * written. They're additive — never overwritten — so a mission with 16
 * milestones produces 16 checkpoint files. Disk usage is fine: each
 * checkpoint is at most a few KB plus the contract size.
 *
 * The runtime registry holds the live state in memory. Checkpoints are the
 * disk-resident shadow that survives crashes and process restarts.
 */

import 'server-only';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MissionState } from './types';

function safeId(id: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) {
    throw new Error(`mission id contains invalid characters: ${JSON.stringify(id.slice(0, 32))}`);
  }
  return id;
}

function checkpointsDir(missionId: string): string {
  return path.join(process.cwd(), 'data', 'missions', safeId(missionId), 'checkpoints');
}

function checkpointPath(missionId: string, n: number): string {
  return path.join(checkpointsDir(missionId), `checkpoint-${n}.json`);
}

function manifestPath(missionId: string): string {
  return path.join(checkpointsDir(missionId), 'manifest.json');
}

interface CheckpointManifest {
  latest: number;
  count: number;
  /** ISO timestamp of the latest checkpoint write. */
  updated_at: string;
  /** Optional per-checkpoint label so a UI can show "after Phase 3" instead
   *  of "checkpoint 7". */
  labels?: Record<number, string>;
}

async function readManifest(missionId: string): Promise<CheckpointManifest> {
  try {
    const body = await fs.readFile(manifestPath(missionId), 'utf8');
    const parsed = JSON.parse(body) as CheckpointManifest;
    if (typeof parsed?.latest === 'number' && typeof parsed?.count === 'number') return parsed;
  } catch (err: any) {
    if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
  }
  return { latest: 0, count: 0, updated_at: new Date().toISOString() };
}

async function writeManifest(missionId: string, m: CheckpointManifest): Promise<void> {
  const dir = checkpointsDir(missionId);
  await fs.mkdir(dir, { recursive: true });
  // Atomic write — same pattern as persistence.ts.
  const tmp = `${manifestPath(missionId)}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(m, null, 2), 'utf8');
  await fs.rename(tmp, manifestPath(missionId));
}

/** Write a milestone checkpoint. Returns the checkpoint number (monotonically
 *  increasing per mission). Optional `label` is recorded in the manifest so a
 *  UI rewind picker can show context. */
export async function writeCheckpoint(missionId: string, state: MissionState, label?: string): Promise<number> {
  const dir = checkpointsDir(missionId);
  await fs.mkdir(dir, { recursive: true });
  const manifest = await readManifest(missionId);
  const n = manifest.latest + 1;
  const tmp = `${checkpointPath(missionId, n)}.tmp-${process.pid}-${Date.now()}`;
  // Deep clone via JSON so the checkpoint doesn't share refs with live state.
  // Mission states are JSON-safe (no Date objects, no Maps), so this is
  // sufficient and ~free at our scale.
  const snapshot = JSON.parse(JSON.stringify(state));
  await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
  await fs.rename(tmp, checkpointPath(missionId, n));
  const next: CheckpointManifest = {
    latest: n,
    count: manifest.count + 1,
    updated_at: new Date().toISOString(),
    labels: { ...(manifest.labels || {}), ...(label ? { [n]: label } : {}) },
  };
  await writeManifest(missionId, next);
  return n;
}

/** List all checkpoint numbers for a mission, sorted ascending. */
export async function listCheckpoints(missionId: string): Promise<Array<{ n: number; label?: string; path: string }>> {
  const manifest = await readManifest(missionId);
  if (manifest.count === 0) return [];
  const out: Array<{ n: number; label?: string; path: string }> = [];
  for (let n = 1; n <= manifest.latest; n++) {
    try {
      await fs.stat(checkpointPath(missionId, n));
      out.push({ n, label: manifest.labels?.[n], path: checkpointPath(missionId, n) });
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      // Tolerate gaps: a previously-deleted checkpoint won't show in the list.
    }
  }
  return out;
}

/** Load a specific checkpoint by number, or null if missing. */
export async function loadCheckpoint(missionId: string, n: number): Promise<MissionState | null> {
  try {
    const body = await fs.readFile(checkpointPath(missionId, n), 'utf8');
    return JSON.parse(body) as MissionState;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/** Load the most recent checkpoint for a mission, or null if none exist. */
export async function loadLatestCheckpoint(missionId: string): Promise<{ state: MissionState; n: number } | null> {
  const manifest = await readManifest(missionId);
  if (manifest.latest === 0) return null;
  const state = await loadCheckpoint(missionId, manifest.latest);
  if (!state) return null;
  return { state, n: manifest.latest };
}
