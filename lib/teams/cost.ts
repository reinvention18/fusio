import 'server-only';
import { getDb } from '../memory-db';

// Per-million-token pricing (USD) as of April 2026. Source: Anthropic public
// pricing. Keep this in sync when rates change or new models ship.
// The SDK's result.usage object includes a total_cost_usd field for the whole
// turn — we PREFER that when available and only fall back to this table when
// the SDK hasn't surfaced a cost figure.

export interface ModelRates {
  input_usd_per_m: number;
  output_usd_per_m: number;
  cache_read_usd_per_m: number;
  cache_write_usd_per_m: number;
}

export const MODEL_RATES: Record<string, ModelRates> = {
  'claude-opus-4-7':     { input_usd_per_m: 15.0, output_usd_per_m: 75.0, cache_read_usd_per_m: 1.50, cache_write_usd_per_m: 18.75 },
  'claude-opus-4-7[1m]': { input_usd_per_m: 22.5, output_usd_per_m: 112.5, cache_read_usd_per_m: 2.25, cache_write_usd_per_m: 28.125 },
  'claude-opus-4-6':     { input_usd_per_m: 15.0, output_usd_per_m: 75.0, cache_read_usd_per_m: 1.50, cache_write_usd_per_m: 18.75 },
  'claude-sonnet-4-6':   { input_usd_per_m: 3.0,  output_usd_per_m: 15.0, cache_read_usd_per_m: 0.30, cache_write_usd_per_m: 3.75 },
  'claude-haiku-4-5':    { input_usd_per_m: 1.0,  output_usd_per_m: 5.0,  cache_read_usd_per_m: 0.10, cache_write_usd_per_m: 1.25 },
};

/** Resolve a model string (e.g. "sonnet", "claude-sonnet-4-6") to a rate row. */
export function ratesFor(model: string): ModelRates {
  if (MODEL_RATES[model]) return MODEL_RATES[model];
  if (model.includes('opus') && model.includes('[1m]'))   return MODEL_RATES['claude-opus-4-7[1m]'];
  if (model.includes('opus'))   return MODEL_RATES['claude-opus-4-7'];
  if (model.includes('haiku'))  return MODEL_RATES['claude-haiku-4-5'];
  return MODEL_RATES['claude-sonnet-4-6']; // default
}

// SDK usage shape (subset of Anthropic Messages API usage).
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Compute USD cost from tokens if the SDK didn't give us total_cost_usd. */
export function costFor(model: string, usage: Usage): number {
  const r = ratesFor(model);
  const input = (usage.input_tokens ?? 0) * r.input_usd_per_m / 1_000_000;
  const output = (usage.output_tokens ?? 0) * r.output_usd_per_m / 1_000_000;
  const cacheRead = (usage.cache_read_input_tokens ?? 0) * r.cache_read_usd_per_m / 1_000_000;
  const cacheWrite = (usage.cache_creation_input_tokens ?? 0) * r.cache_write_usd_per_m / 1_000_000;
  return input + output + cacheRead + cacheWrite;
}

// ─── Budget enforcement ──────────────────────────────────────────────────

export interface BudgetStatus {
  spent_usd: number;
  budget_usd: number | null;
  over_budget: boolean;
  percent: number | null; // null when no budget
}

/**
 * Atomically add cost to an agent and roll it up to the team. Returns the
 * team's current budget status. Called on every SDK result message.
 *
 * Implementation notes:
 *  - We use a single transaction so the agent + team counters stay consistent.
 *  - total_cost_usd from the SDK is preferred over computed cost.
 */
export function addCostAndCheckBudget(
  agentId: string,
  addedUsd: number,
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): BudgetStatus {
  const db = getDb();
  return db.transaction((): BudgetStatus => {
    const row = db.prepare(
      `SELECT team_id, cost_usd FROM team_agents WHERE id = ?`
    ).get(agentId) as { team_id: string; cost_usd: number } | undefined;
    if (!row) {
      return { spent_usd: 0, budget_usd: null, over_budget: false, percent: null };
    }
    db.prepare(
      `UPDATE team_agents SET
         cost_usd = cost_usd + ?,
         tokens_in = tokens_in + ?,
         tokens_out = tokens_out + ?,
         tokens_cache_read = tokens_cache_read + ?,
         tokens_cache_write = tokens_cache_write + ?,
         updated_at = ?
       WHERE id = ?`
    ).run(
      addedUsd,
      tokens.input,
      tokens.output,
      tokens.cacheRead ?? 0,
      tokens.cacheWrite ?? 0,
      Date.now(),
      agentId,
    );
    db.prepare(
      `UPDATE teams SET spent_usd = spent_usd + ?, updated_at = ? WHERE id = ?`
    ).run(addedUsd, Date.now(), row.team_id);

    const team = db.prepare(
      `SELECT spent_usd, budget_usd FROM teams WHERE id = ?`
    ).get(row.team_id) as { spent_usd: number; budget_usd: number | null };

    const over = team.budget_usd !== null && team.spent_usd >= team.budget_usd;
    const percent = team.budget_usd !== null && team.budget_usd > 0
      ? team.spent_usd / team.budget_usd
      : null;
    return {
      spent_usd: team.spent_usd,
      budget_usd: team.budget_usd,
      over_budget: over,
      percent,
    };
  })();
}

// ─── Pre-run estimate ────────────────────────────────────────────────────

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

export interface EstimateInput {
  roles: Array<{ role: string; model: string }>;
  expectedTasks: number;
  expectedReviews?: number;
}

export function estimateMission(input: EstimateInput): { low_usd: number; high_usd: number; midpoint_usd: number } {
  let sum = 0;
  for (const r of input.roles) {
    const tokens = TYPICAL_TOKENS_PER_TASK[r.role] ?? TYPICAL_TOKENS_PER_TASK.builder;
    const cost = costFor(r.model, {
      input_tokens: tokens.input,
      output_tokens: tokens.output,
    });
    sum += cost * input.expectedTasks;
  }
  const codexCost = (input.expectedReviews ?? 0) * 1.5; // rough $1–$2 per adversarial review
  const mid = sum + codexCost;
  return {
    low_usd: mid * 0.5,
    high_usd: mid * 1.6,
    midpoint_usd: mid,
  };
}

/** Human-readable cost breakdown for the UI cost badge. */
export function costBreakdown(teamId: string): {
  total_usd: number;
  by_agent: Array<{ agent_id: string; role: string; role_handle: string; cost_usd: number }>;
  budget_usd: number | null;
  percent: number | null;
} {
  const db = getDb();
  const team = db.prepare('SELECT spent_usd, budget_usd FROM teams WHERE id = ?').get(teamId) as
    | { spent_usd: number; budget_usd: number | null }
    | undefined;
  const agents = db.prepare(
    'SELECT id, role, role_handle, cost_usd FROM team_agents WHERE team_id = ? ORDER BY cost_usd DESC'
  ).all(teamId) as Array<{ id: string; role: string; role_handle: string; cost_usd: number }>;

  return {
    total_usd: team?.spent_usd ?? 0,
    by_agent: agents.map(a => ({
      agent_id: a.id,
      role: a.role,
      role_handle: a.role_handle,
      cost_usd: a.cost_usd,
    })),
    budget_usd: team?.budget_usd ?? null,
    percent: team?.budget_usd ? (team.spent_usd / team.budget_usd) : null,
  };
}
