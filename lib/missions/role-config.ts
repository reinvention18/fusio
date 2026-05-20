/**
 * Missions — per-role model + provider configuration.
 *
 * Phase 9 ("droid whispering"): missions are model-agnostic. The orchestrator,
 * workers, scrutiny, user-testing — each role gets its own model from its own
 * provider. Defaults below match Luke's recommendations:
 *   • Orchestrator: slow careful reasoning → Opus 4.7
 *   • Worker: fast code fluency → Sonnet 4.6
 *   • Scrutiny: precise instruction-following → Codex GPT-5 (different provider!)
 *   • User-testing: browser + visual reasoning → Claude + browser
 *
 * Why a separate provider for scrutiny: validation correlation bias. If the
 * worker and scrutiny share training data, scrutiny inherits the worker's
 * blind spots. The "mix providers" rule is enforced (with a warning, not a
 * hard refusal — power user override) at config-resolution time.
 *
 * Per-mission overrides: a mission can pin a specific model for any role
 * via `mission.roles.<role>`. The orchestrator may also write a mission
 * skill that names model preferences. Overrides flow:
 *   user setting → mission override → default
 */

import 'server-only';
import type { MissionRoleConfig, RoleModel, Mission } from './types';
import { DEFAULT_ROLE_CONFIG } from './types';

// ─── Presets ─────────────────────────────────────────────────────────────
//
// Named presets the user can pick from in settings. Each is a complete
// MissionRoleConfig — switching presets swaps every role at once. This is
// the level of granularity Luke recommends ("droid whispering" matters most
// at the team level, not per-call).

export interface RolePreset {
  id: string;
  label: string;
  description: string;
  config: MissionRoleConfig;
}

export const ROLE_PRESETS: RolePreset[] = [
  {
    id: 'full-force',
    label: 'Full Force',
    description: 'Opus 4.7 orchestrator + worker, OpenAI Codex scrutiny. Maximum capability, highest cost — use when the mission absolutely has to land. Worker runs on Opus instead of the default Sonnet 4.6, and scrutiny stays on a different provider so the validator still has training-data independence from the worker.',
    config: {
      orchestrator: { provider: 'anthropic', model: 'claude-opus-4-7' },
      worker:       { provider: 'anthropic', model: 'claude-opus-4-7' },
      scrutiny:     { provider: 'openai',    model: 'default' },
      user_testing: { provider: 'browser',   model: 'claude-opus-4-7' },
    },
  },
  {
    id: 'frontier-mixed',
    label: 'Frontier (mixed)',
    description: 'Anthropic for build, OpenAI Codex for scrutiny. Default.',
    config: DEFAULT_ROLE_CONFIG,
  },
  {
    id: 'all-anthropic',
    label: 'All Anthropic',
    description: 'Opus 4.7 / Sonnet 4.6 across all roles. Faster turnaround, weaker scrutiny.',
    config: {
      orchestrator: { provider: 'anthropic', model: 'claude-opus-4-7' },
      worker:       { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      scrutiny:     { provider: 'anthropic', model: 'claude-opus-4-7' },
      user_testing: { provider: 'browser',   model: 'claude-sonnet-4-6' },
    },
  },
  {
    id: 'budget',
    label: 'Budget',
    description: 'Haiku-class everywhere. Use only for trivial missions or smoke tests.',
    config: {
      orchestrator: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      worker:       { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      scrutiny:     { provider: 'openai',    model: 'default' },
      user_testing: { provider: 'browser',   model: 'claude-haiku-4-5-20251001' },
    },
  },
];

// ─── Resolution ──────────────────────────────────────────────────────────

export interface ResolvedRoleConfig {
  config: MissionRoleConfig;
  /** Warnings the orchestrator should surface to the user. Includes the
   *  mix-providers warning when scrutiny.provider matches worker.provider. */
  warnings: string[];
  /** Per-role provenance: 'default' | 'mission' | 'override'. */
  provenance: Record<keyof MissionRoleConfig, 'default' | 'mission' | 'override'>;
}

/** Resolve the effective role config for a mission. Layers:
 *    1. Defaults (DEFAULT_ROLE_CONFIG)
 *    2. Mission's `mission.roles` (per-mission pin)
 *    3. Optional override (e.g. user setting injected at runtime)
 *  Plus a mix-providers warning if scrutiny ends up on the same provider as
 *  the worker. */
export function resolveRoleConfig(
  mission: Pick<Mission, 'roles'>,
  override?: Partial<MissionRoleConfig>,
): ResolvedRoleConfig {
  const provenance = {
    orchestrator: 'default',
    worker: 'default',
    scrutiny: 'default',
    user_testing: 'default',
    meta: 'default',
  } as ResolvedRoleConfig['provenance'];

  const merge = (role: keyof MissionRoleConfig): RoleModel | undefined => {
    if (override && override[role]) {
      provenance[role] = 'override';
      return override[role] as RoleModel;
    }
    if (mission.roles && mission.roles[role]) {
      provenance[role] = 'mission';
      return mission.roles[role] as RoleModel;
    }
    return DEFAULT_ROLE_CONFIG[role];
  };

  const config: MissionRoleConfig = {
    orchestrator: merge('orchestrator')!,
    worker:       merge('worker')!,
    scrutiny:     merge('scrutiny')!,
    user_testing: merge('user_testing')!,
    meta:         merge('meta'),
  };

  const warnings: string[] = [];
  if (config.scrutiny.provider === config.worker.provider) {
    warnings.push(
      `Mix-providers rule violated: scrutiny.provider="${config.scrutiny.provider}" matches worker.provider — scrutiny may inherit the worker's training-data blind spots. Consider switching scrutiny to a different provider (default: openai/gpt-5-codex).`
    );
  }
  if (config.scrutiny.model === config.worker.model) {
    warnings.push(
      `Mix-providers rule violated: scrutiny.model="${config.scrutiny.model}" matches worker.model exactly. Validators should always use a different model than the worker they audit.`
    );
  }

  return { config, warnings, provenance };
}

/** Find a preset by id. Returns undefined if not found. */
export function getPreset(id: string): RolePreset | undefined {
  return ROLE_PRESETS.find(p => p.id === id);
}
