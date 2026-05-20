/**
 * Deploy executor — runs a set of DeployTarget commands in sequence,
 * streaming stdout/stderr per target and reporting final status.
 *
 * Runs are identified by a UUID and stored in memory. UI subscribes via SSE
 * to the `ship-runs` event stream and filters by runId.
 */

import 'server-only';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { DeployTarget } from './plan';

export type ShipStepStatus = 'queued' | 'running' | 'ok' | 'failed' | 'skipped';

export interface ShipStep {
  id: string;
  targetKind: DeployTarget['kind'];
  label: string;
  command: string;
  status: ShipStepStatus;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number;
  output: string[]; // captured lines
  error?: string;
  // Parsed URLs from output (e.g. Vercel deployment URL, EAS build URL)
  urls: string[];
}

export interface ShipRun {
  id: string;
  teamId: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'ok' | 'failed' | 'partial';
  steps: ShipStep[];
}

const runs = new Map<string, ShipRun>();
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export function getRun(id: string): ShipRun | undefined { return runs.get(id); }
export function listRuns(teamId?: string): ShipRun[] {
  const all = Array.from(runs.values()).sort((a, b) => b.startedAt - a.startedAt);
  return teamId ? all.filter(r => r.teamId === teamId) : all;
}

export function subscribeRun(runId: string, cb: (run: ShipRun) => void): () => void {
  const handler = (r: ShipRun) => { if (r.id === runId) cb(r); };
  emitter.on('run', handler);
  return () => emitter.off('run', handler);
}

function emit(run: ShipRun): void { emitter.emit('run', run); }

const URL_RE = /\bhttps?:\/\/[^\s)<>]+/g;

async function runStep(step: ShipStep, cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const [cmd, ...rest] = args;
    const proc = spawn(cmd, rest, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
      windowsHide: true,
    });

    const onData = (d: Buffer) => {
      const lines = d.toString().split('\n').map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
      for (const line of lines) {
        if (!line) continue;
        step.output.push(line);
        const urls = line.match(URL_RE);
        if (urls) {
          for (const u of urls) {
            if (!step.urls.includes(u)) step.urls.push(u);
          }
        }
      }
      if (step.output.length > 2000) step.output.splice(0, step.output.length - 2000);
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    // 30-minute hard cap per step — native EAS builds can take 15m+; vercel
    // prod deploys 2-5m; supabase pushes seconds.
    const timer = setTimeout(() => {
      step.output.push('[timeout] step exceeded 30m — killing process');
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }, 30 * 60 * 1000);

    proc.on('error', (err) => {
      clearTimeout(timer);
      step.error = err.message;
      step.status = 'failed';
      step.endedAt = Date.now();
      step.exitCode = -1;
      resolve();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      step.exitCode = code ?? -1;
      step.endedAt = Date.now();
      step.status = code === 0 ? 'ok' : 'failed';
      if (code !== 0 && !step.error) {
        step.error = `Exited with code ${code}`;
      }
      resolve();
    });
  });
}

export async function executeShipRun(params: {
  teamId: string;
  targets: Array<DeployTarget & { run: boolean }>;
}): Promise<ShipRun> {
  const run: ShipRun = {
    id: randomUUID(),
    teamId: params.teamId,
    startedAt: Date.now(),
    status: 'running',
    steps: params.targets.map(t => ({
      id: randomUUID(),
      targetKind: t.kind,
      label: t.label,
      command: t.command.join(' '),
      status: t.run ? 'queued' : 'skipped',
      output: [],
      urls: [],
    })),
  };
  runs.set(run.id, run);
  emit(run);

  for (let i = 0; i < params.targets.length; i++) {
    const target = params.targets[i];
    const step = run.steps[i];
    if (!target.run) continue;

    step.status = 'running';
    step.startedAt = Date.now();
    emit(run);

    await runStep(step, target.cwd, target.command);
    emit(run);
  }

  run.endedAt = Date.now();
  const ran = run.steps.filter(s => s.status !== 'skipped');
  const failed = ran.filter(s => s.status === 'failed');
  run.status = failed.length === 0 ? 'ok' : (failed.length === ran.length ? 'failed' : 'partial');
  emit(run);
  return run;
}
