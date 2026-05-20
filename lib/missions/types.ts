/**
 * Missions — shared types.
 *
 * Maps Luke's "missions" architecture (Factory talk, 2026-05-06) into MC primitives:
 *   • Orchestrator: planner + milestone gatekeeper (Opus 4.7 default)
 *   • Worker: per-phase implementer with FRESH context (Sonnet 4.6 default)
 *   • Validators: scrutiny (Codex GPT-5) + user-testing (browser, Phase 2)
 *   • Validation contract: typed assertions written BEFORE any code
 *   • Structured handoffs: workers return JSON, not freeform summaries
 *
 * This file is types-only. Logic lives in runner.ts, contract.ts, handoff.ts.
 */

export type Provider = 'anthropic' | 'openai' | 'browser' | 'open-weight';

export interface RoleModel {
  /** Which model family. Determines the spawn path. */
  provider: Provider;
  /** Model id (e.g. 'claude-opus-4-7', 'claude-sonnet-4-6', 'gpt-5-codex'). */
  model: string;
  /** Optional temperature override. */
  temperature?: number;
  /** Optional max output tokens. */
  max_tokens?: number;
}

export interface MissionRoleConfig {
  /** Plans, asks strategic questions, writes contract, decides milestone advances. */
  orchestrator: RoleModel;
  /** Per-feature implementer. FRESH session each spawn. */
  worker: RoleModel;
  /** Static/code-review validator. SHOULD use a different provider than worker
   *  to avoid training-data correlation bias (Luke's "different model provider"). */
  scrutiny: RoleModel;
  /** Behavioral/QA validator — spawns app + computer-use. Phase 2. */
  user_testing: RoleModel;
  /** Optional meta-orchestrator for multi-mission runs. Phase 11. */
  meta?: RoleModel;
}

/** Default role configuration. Uses heterogeneous providers per Luke's principle:
 *  validation comes from a different family than implementation so validators
 *  aren't biased by the same training data.
 *
 *  Note on the scrutiny model: `'default'` means "let the codex CLI pick the
 *  model its account is authorized for" (skip the `-m` flag entirely).
 *  Hardcoding `gpt-5-codex` here used to fail for ChatGPT-account users
 *  ("model not supported when using Codex with a ChatGPT account"). */
export const DEFAULT_ROLE_CONFIG: MissionRoleConfig = {
  orchestrator: { provider: 'anthropic', model: 'claude-opus-4-7' },
  worker:       { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  scrutiny:     { provider: 'openai',    model: 'default' },
  user_testing: { provider: 'browser',   model: 'claude-sonnet-4-6' },
};

// ─── Validation contract ──────────────────────────────────────────────────

export type AssertionType = 'static' | 'behavioral';

export interface Assertion {
  /** Stable id within a mission (e.g. 'A001', 'A042'). */
  id: string;
  /** Human-readable statement. SHOULD be checkable; avoid "high quality code" language. */
  statement: string;
  /** static = checked by scrutiny (diff/test/lint). behavioral = checked by user-testing (browser flow). */
  type: AssertionType;
  /** Optional command/script for static assertions (e.g. 'npx tsc --noEmit'). */
  verification_command?: string;
  /** Optional behavioral flow steps for behavioral assertions. */
  behavior?: {
    /** Plain-language steps the QA agent will perform. */
    flow_steps: string[];
    /** Plain-language expected outcome to assert. */
    expected_outcome: string;
    /** Optional start URL — overrides Mission.target_url for this assertion. */
    start_url?: string;
  };
  /** Severity if this assertion fails — informs whether to block the milestone. */
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface ValidationContract {
  /** All assertions that the mission promises to satisfy by completion. */
  assertions: Assertion[];
}

// ─── Phases / features ───────────────────────────────────────────────────

export interface MissionPhase {
  /** 1-based index. */
  index: number;
  /** Short, human-readable. */
  name: string;
  /** What this phase delivers. */
  spec: string;
  /** Files this phase is expected to touch (globs ok). */
  expected_files?: string[];
  /** IDs of assertions this phase is responsible for satisfying. */
  assertion_ids: string[];
  /** Maximum rework rounds before this phase pauses for user. */
  rework_cap?: number;
  /** Set when this phase was auto-scoped by the orchestrator as a follow-up. */
  parent_phase_index?: number;
  /** Provenance: 'plan' (in original plan) | 'self-heal' (auto-added). */
  origin: 'plan' | 'self-heal';
  /** Phase 11: child mission ids this phase delegates to. Before the phase
   *  is allowed to advance, every named child must be in `completed` status.
   *  Concurrency between children is governed by the parent mission's
   *  `child_concurrency_policy`. */
  blocks_on_child_missions?: string[];
  /** Phase 11 (pair worker): when 'pair', the runner spawns Worker A
   *  (Anthropic, the configured `mission.roles.worker` model) AND a
   *  Codex consultant in parallel. Codex is naturally read-only so it
   *  can't edit files — its output is captured as `codex_perspective`
   *  on the handoff and surfaced to scrutiny as alternative-approach
   *  evidence. Default 'single'. Use 'pair' for high-stakes phases
   *  where having a different-provider perspective on the
   *  implementation is worth the extra ~$0.10 / phase. */
  worker_concurrency?: 'single' | 'pair';
}

export interface Mission {
  /** Stable id (uuid-ish, used for state file path). */
  id: string;
  /** Goal in one sentence. */
  goal: string;
  /** Optional preface — global plan context. */
  preface?: string;
  /** All phases. Ordered. */
  phases: MissionPhase[];
  /** Validation contract — pinned at synth time. */
  contract: ValidationContract;
  /** Per-role model config. */
  roles: MissionRoleConfig;
  /** Per-phase rework cap default. */
  rework_cap?: number;
  /** Working directory for git ops + cwd for spawned processes. */
  cwd: string;
  /** Default URL the user-testing validator will navigate to when no
   *  per-assertion start_url is specified. If absent, behavioral assertions
   *  cannot be verified — surface a warning and let scrutiny stand alone. */
  target_url?: string;
  /** Mission lifecycle state. */
  status: MissionStatus;
  /** Created at (ISO). */
  created_at: string;
  /** Last activity at (ISO). */
  last_activity_at: string;
  /** Phase 11 (multi-mission orchestration): if this mission was spawned by
   *  a parent mission, the parent's id. The parent's orchestrator validates
   *  this mission's milestones before its own phases advance. */
  parent_mission_id?: string;
  /** Phase 11: ids of child missions this mission delegates to. The runner
   *  blocks on each child's status before advancing past the phase that
   *  spawned it. Children can run in parallel if their phases are
   *  independent (the parent orchestrator decides — see
   *  child_concurrency_policy). */
  child_mission_ids?: string[];
  /** Phase 11: 'parallel' (children run concurrently) | 'sequential' | 'auto'
   *  (orchestrator picks based on shared-resource analysis). Default 'auto'. */
  child_concurrency_policy?: 'parallel' | 'sequential' | 'auto';
  /** Phase 11 / Full Force workflow: 'standard' is the default per-phase
   *  loop. 'full-force' adds (a) a pre-flight Opus<->Codex plan negotiation
   *  before phase 1, (b) per-phase pair workers where the orchestrator
   *  asks for them, and (c) a single final Codex audit at mission end
   *  (separate from per-phase scrutiny). Set automatically when the user
   *  picks the 'full-force' role-config preset. */
  workflow_mode?: 'standard' | 'full-force';
  /** Full Force workflow: list of negotiation rounds captured before the
   *  mission started. Each entry has the round number plus what each
   *  agent proposed. Surfaced in the dashboard so the user can see the
   *  back-and-forth that produced this plan. Optional. */
  negotiation_rounds?: Array<{ round: number; opus_view: string; codex_view: string; converged: boolean }>;
}

// ─── Final audit (Full Force workflow) ───────────────────────────────────

/** End-of-mission single-pass Codex audit. Distinct from MilestoneAudit
 *  (which audits one phase at a time during the run). The final audit
 *  asks: did the WHOLE mission deliver the goal? Looks at every phase
 *  handoff, every per-phase audit, the contract, and the full diff in
 *  one go. */
export interface FinalAudit {
  verdict: 'pass' | 'fail' | 'concerns';
  summary: string;
  findings: HandoffIssue[];
  /** Raw model output for traceability. */
  raw: string;
  /** Wall-clock duration. */
  duration_ms: number;
  /** ISO timestamp when the final audit ran. */
  ran_at: string;
}

export type MissionStatus =
  | 'draft'              // synthesized, not yet approved
  | 'approved'           // user approved; ready to run
  | 'running'            // a worker or validator is active
  | 'paused-question'    // waiting on user input
  | 'paused-stuck'       // exhausted attempts, awaiting user direction
  | 'paused-checkpoint'  // hibernating; resumes on demand
  | 'completed'
  | 'cancelled';

// ─── Structured handoff ──────────────────────────────────────────────────

export interface CommandRun {
  cmd: string;
  exit_code: number;
  /** Brief stdout/stderr summary; FULL output not stored here. */
  output_summary?: string;
  duration_ms?: number;
}

export interface HandoffIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  body?: string;
  file?: string;
  /** If this issue prevented an assertion from being satisfied. */
  blocks_assertion?: string;
}

export interface Handoff {
  /** Phase the handoff belongs to. */
  phase_index: number;
  /** Attempt number within the phase. */
  attempt: number;
  /** Worker session id (so audits can re-spawn the same context if needed). */
  worker_session_id?: string;
  /** What the worker actually completed. Cite file:line where possible. */
  completed: string[];
  /** What was deliberately left undone (must be empty for the phase to complete). */
  undone: string[];
  /** Commands the worker ran during the phase. */
  commands_run: CommandRun[];
  /** Issues discovered during implementation. */
  issues: HandoffIssue[];
  /** Did the worker abide by the orchestrator's procedures (skills)? */
  procedures_followed: boolean;
  /** Notes about deviations. */
  procedures_notes?: string;
  /** Assertions the worker claims to have satisfied. The audit verifies this. */
  satisfied_assertions: string[];
  /** Free-form summary, max 500 chars. */
  summary: string;
  /** Phase 11 pair-worker mode: alternative-approach review captured by a
   *  Codex consultant running in parallel with the Anthropic worker.
   *  Surfaced to scrutiny as evidence for / against the worker's implementation.
   *  Markdown text, ≤ ~4 KB. */
  codex_perspective?: string;
}

// ─── Audit result ────────────────────────────────────────────────────────

export type AuditVerdict = 'phase-complete' | 'needs-rework' | 'needs-user-input' | 'needs-followup';

export interface AssertionCheck {
  assertion_id: string;
  /** What scrutiny actually saw vs. what the worker claimed. */
  status: 'satisfied' | 'unsatisfied' | 'inconclusive';
  evidence?: string;
}

export interface MilestoneAudit {
  /** Phase being audited. */
  phase_index: number;
  attempt: number;
  verdict: AuditVerdict;
  summary: string;
  /** Per-assertion verification result. */
  assertion_checks: AssertionCheck[];
  /** Per-behavioral-assertion check from the user-testing validator (when run). */
  behavioral_checks?: BehavioralCheck[];
  /** Specific items the worker must address before re-audit (verdict=needs-rework). */
  rework_directive: string[];
  /** Question for the user (verdict=needs-user-input). RARE — high bar. */
  user_question?: string;
  /** Auto-scoped follow-up phases (verdict=needs-followup). */
  followup_phases?: MissionPhase[];
  /** Free-form concerns; severity=low items are informational only. */
  concerns: HandoffIssue[];
}

export interface BehavioralCheck {
  assertion_id: string;
  status: 'satisfied' | 'unsatisfied' | 'inconclusive' | 'skipped';
  /** What the QA agent observed that justifies the verdict. */
  evidence?: string;
  /** Number of flow steps successfully completed before judgement. */
  steps_completed?: number;
  /** Wall-clock duration of the verification run. */
  duration_ms?: number;
  /** Reason if skipped (e.g. "no target_url set on mission"). */
  skipped_reason?: string;
}

// ─── Mission state (persistent) ──────────────────────────────────────────

export interface MissionState {
  mission: Mission;
  /** All handoffs ever submitted, in order. */
  handoffs: Handoff[];
  /** All audits ever performed, in order. */
  audits: MilestoneAudit[];
  /** Current phase being worked on (1-based). */
  current_phase_index: number;
  /** Current attempt within the current phase (1-based). */
  current_attempt: number;
  /** Token usage running totals (informational). */
  tokens_used?: { input: number; cache_read: number; cache_creation: number; output: number };
  /** Wall-clock time spent in active work (ms). */
  active_ms?: number;
  /** When the mission was last paused (ISO). null if currently running. */
  paused_at?: string | null;
  /** Full Force workflow: end-of-mission single-pass Codex audit result.
   *  Set after every phase has run + self-heal completed, before the
   *  mission transitions to 'completed'. Standard missions don't have it. */
  final_audit?: FinalAudit;
}
