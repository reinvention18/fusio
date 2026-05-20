/**
 * Client-safe pre-launch estimate helper. Mirrors `estimateMission` from
 * `cost.ts` but without the `server-only` guard so it can be used inside
 * 'use client' components like LaunchWizard. Keep the rate tables in sync
 * with cost.ts.
 */

interface ModelRates {
  input_usd_per_m: number;
  output_usd_per_m: number;
}

const RATES: Record<string, ModelRates> = {
  'claude-opus-4-7':     { input_usd_per_m: 15.0, output_usd_per_m: 75.0 },
  'claude-opus-4-7[1m]': { input_usd_per_m: 22.5, output_usd_per_m: 112.5 },
  'claude-opus-4-6':     { input_usd_per_m: 15.0, output_usd_per_m: 75.0 },
  'claude-sonnet-4-6':   { input_usd_per_m: 3.0,  output_usd_per_m: 15.0 },
  'claude-haiku-4-5':    { input_usd_per_m: 1.0,  output_usd_per_m: 5.0 },
};

function rateFor(model: string): ModelRates {
  if (RATES[model]) return RATES[model];
  if (model.includes('opus') && model.includes('[1m]')) return RATES['claude-opus-4-7[1m]'];
  if (model.includes('opus')) return RATES['claude-opus-4-7'];
  if (model.includes('haiku')) return RATES['claude-haiku-4-5'];
  return RATES['claude-sonnet-4-6'];
}

const TYPICAL_TOKENS_PER_TASK: Record<string, { input: number; output: number }> = {
  commander:   { input: 5000,  output: 800 },
  architect:   { input: 8000,  output: 1500 },
  builder:     { input: 15000, output: 3000 },
  inspector:   { input: 5000,  output: 500 },
  sentinel:    { input: 500,   output: 200 },
  scout:       { input: 10000, output: 1500 },
  scribe:      { input: 2000,  output: 400 },
  navigator:   { input: 2000,  output: 300 },
  security:    { input: 8000,  output: 1000 },
  dba:         { input: 6000,  output: 800 },
  tester:      { input: 10000, output: 2000 },
  perfanalyst: { input: 6000,  output: 800 },
  uxreviewer:  { input: 5000,  output: 500 },
  deployer:    { input: 2000,  output: 300 },
  apidesigner: { input: 8000,  output: 1200 },
  refactorer:  { input: 15000, output: 3000 },
};

// Per-role expected wall-clock minutes per task (rough averages from observed runs).
const TYPICAL_MINUTES_PER_TASK: Record<string, number> = {
  commander: 1, architect: 3, builder: 6, inspector: 4, sentinel: 1,
  scout: 5, scribe: 3, navigator: 2, security: 4, dba: 3, tester: 5,
  perfanalyst: 4, uxreviewer: 3, deployer: 2, apidesigner: 4, refactorer: 7,
};

export interface RosterEstimate {
  agentCount: number;
  estimatedTasks: number;
  costLowUsd: number;
  costHighUsd: number;
  costMidUsd: number;
  etaMinutesLow: number;
  etaMinutesHigh: number;
}

/**
 * Rough cost + wall-clock estimate for a roster. Assumes one task per agent
 * minimum (architect alone may produce 3-5 tasks; we approximate by 1.5x).
 * Time uses parallelism: max-per-phase, not sum.
 */
export function estimateRoster(roster: Array<{ role: string; model: string }>): RosterEstimate {
  if (roster.length === 0) {
    return { agentCount: 0, estimatedTasks: 0, costLowUsd: 0, costHighUsd: 0, costMidUsd: 0, etaMinutesLow: 0, etaMinutesHigh: 0 };
  }

  // Heuristic: each agent does ~1.5 tasks; architect produces extras for the team.
  const tasksPerAgent = 1.5;
  const totalTasks = Math.round(roster.length * tasksPerAgent);

  let sumCost = 0;
  let totalMinutes = 0;
  for (const r of roster) {
    const tokens = TYPICAL_TOKENS_PER_TASK[r.role] ?? TYPICAL_TOKENS_PER_TASK.builder;
    // r.model here is the alias ('opus'/'sonnet'/'haiku') from the wizard.
    const fullModel = r.role === 'architect' && r.model === 'opus'
      ? 'claude-opus-4-7[1m]'
      : r.model === 'opus' ? 'claude-opus-4-7'
      : r.model === 'haiku' ? 'claude-haiku-4-5'
      : 'claude-sonnet-4-6';
    const rate = rateFor(fullModel);
    const inputUsd = (tokens.input * tasksPerAgent * rate.input_usd_per_m) / 1_000_000;
    const outputUsd = (tokens.output * tasksPerAgent * rate.output_usd_per_m) / 1_000_000;
    sumCost += inputUsd + outputUsd;

    const minPerTask = TYPICAL_MINUTES_PER_TASK[r.role] ?? 4;
    totalMinutes += minPerTask * tasksPerAgent;
  }

  // Wall-clock with parallelism: agents within a phase run concurrently, so
  // the actual time is much less than total. Estimate 40-60% parallelism.
  const etaLow = Math.max(2, Math.round(totalMinutes * 0.35));
  const etaHigh = Math.max(etaLow + 2, Math.round(totalMinutes * 0.6));

  // Inspector reviews add ~$1.50 each (Codex adversarial). Roughly 1 review per builder.
  const builderCount = roster.filter(r => r.role === 'builder' || r.role === 'refactorer').length;
  const codexCost = builderCount * 1.5;
  const mid = sumCost + codexCost;

  return {
    agentCount: roster.length,
    estimatedTasks: totalTasks,
    costLowUsd: mid * 0.5,
    costHighUsd: mid * 1.6,
    costMidUsd: mid,
    etaMinutesLow: etaLow,
    etaMinutesHigh: etaHigh,
  };
}

export function formatEstimate(e: RosterEstimate): string {
  if (e.agentCount === 0) return 'No agents selected';
  const cost = e.costMidUsd < 0.5
    ? `<$0.50`
    : e.costMidUsd < 5
      ? `~$${e.costMidUsd.toFixed(2)} ($${e.costLowUsd.toFixed(2)}–$${e.costHighUsd.toFixed(2)})`
      : `~$${e.costMidUsd.toFixed(0)} ($${e.costLowUsd.toFixed(0)}–$${e.costHighUsd.toFixed(0)})`;
  return `${e.agentCount} agent${e.agentCount === 1 ? '' : 's'} · ~${e.estimatedTasks} tasks · ${cost} · ${e.etaMinutesLow}–${e.etaMinutesHigh} min`;
}
