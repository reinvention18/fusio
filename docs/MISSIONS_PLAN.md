# Missions Architecture — Master Plan

> **Build complete — 2026-05-08:** Phases **0–11 fully shipped** + **Full Force workflow** (Opus<->Codex pre-flight plan negotiation, multi-agent execution, end-of-mission Codex audit) shipped on top in `mission-control-dev`. Phase 12 (direct agent-to-agent communication) is intentionally deferred per the plan. Closing items landed tonight: per-role preset settings UI in the dashboard header, per-mission token+cost accumulator (consumes the bridge's existing `usage` SSE frame), checkpoint listing + rewind API + UI buttons in the per-mission detail panel, child-mission runtime (`waitForChildMissions` + `phase.blocks_on_child_missions`), and prompt-caching scaffolding (`MC_CACHE_BREAKPOINT` markers in worker prompts that a future bridge upgrade can split on). Two follow-ups remain that can't ship safely tonight: (i) actual `cache_control` plumbing through `claude-chat-bridge.ts` — the prompts are now structured for it but the bridge itself wasn't modified, and (ii) collapsing the runner's verdict state machine into a fully skill-driven dispatcher — the role behavior is in skill files but the dispatch logic is still TS, and a full collapse needs end-to-end mission integration tests we haven't written yet. Resume by running an end-to-end mission against the dashboard. Quick smoke at http://localhost:3005/?tab=lukes-chat.


**Surface:** "Luke's Chat" tab (new) inside `mission-control-dev`.
**Source of inspiration:** Luke (Factory) — multi-agent missions architecture talk, 2026-05-06.

This document is the single source of truth for the missions build-out. It maps every concept Luke described, plus Andrew's additions, into a tier-by-tier implementation plan. Tiers are dependency-ordered — earlier tiers unlock later ones. Every tier is buildable + shippable on its own.

---

## Surface contract

- **Tab:** `lukes-chat` (label: `🛰️ LUKE'S CHAT`).
- **Mounts:** `<ChatPanel namespace="missions" panelTitle="Missions" />` — reuses the existing 8K-LOC chat panel with a new namespace so storage, session keys, sessions API, local storage, and panel chrome are all isolated from `mc` and `seo`.
- **Default mode:** `🛰️ Mission` (new pair-mode option). Solo / Consult / Debate / Pair-Build / Autopilot remain available; mode-switchable mid-chat.
- **Storage isolation:** chats land in `data/lukes-chats/`, mission state in `data/missions/`, sessions API at `/api/lukes-chats`. None of this collides with `mc` or `seo`.
- **Models:** per-role model picker (orchestrator / worker / scrutiny / user-testing / meta) — no single-model assumption. Pluggable provider per seat.

---

## Phase 0 — Plumbing: the tab itself ⏱ ~2h

**Goal:** Get `Luke's Chat` rendering in MC's nav with isolated storage, no mission logic yet. Foundation only.

### Deliverables
1. `Tab` union extended with `'lukes-chat'` in `app/page.tsx` + `components/MobileNav.tsx`.
2. Top-bar tab `🛰️ LUKE'S CHAT` rendered next to `📝 SEO`.
3. Mobile nav drawer entry under "More".
4. New page-mount block in `app/page.tsx` mirroring the seo-chat block: `<ChatPanel namespace="missions" panelTitle="Luke's Chat" />`.
5. ChatPanel `buildNsConfig()` updated to handle `'missions'` namespace — sessionsApi `/api/lukes-chats`, sessionKeyPrefix `lukes`, localStorage keys `lukesChatSessions` + `lukes-activeSessionId`.
6. New API routes mirroring `/api/seo-chats`: `GET/POST /api/lukes-chats`, with a `data/lukes-chats/` directory.
7. Smoke: tab renders, you can send a message, it routes through `/api/chat` like normal solo, message persists to `data/lukes-chats/`, no namespace bleed.

**Status:** ☑ shipped 2026-05-06 (verified: tab renders, API responds, storage isolated to `data/lukes-chat-sessions.json`).

---

## Phase 1 — Foundation: 3-role architecture + validation contract ⏱ ~1d

**Goal:** Replace autopilot's "Claude implements + Codex audits" with Luke's 3-role separation. Add the validation contract.

### Concepts mapped
- **Orchestrator** (planner, sounding board, scope-keeper, milestone gatekeeper) — Opus 4.7 by default.
- **Worker** (per-feature implementer, fresh context every spawn, commits via git) — Sonnet 4.6 by default.
- **Validator (scrutiny)** (static/code-review) — Codex GPT-5 by default.
- **Validation contract** (assertions written *before* any code) — 50–200 statements, each tagged `static | behavioral`, each assigned to ≥1 feature.

### Deliverables
1. `lib/missions/types.ts` — `Mission`, `Phase`, `Feature`, `Assertion`, `Handoff`, `RoleModel`, `MissionState`.
2. `lib/missions/contract.ts` — synth + parse + coverage check (every assertion mapped to ≥1 feature; every feature mapped to ≥1 assertion).
3. Pair-synth produces `validation_contract: Assertion[]` and each `phase.assertion_ids: string[]`.
4. **Fresh worker sessionKey** per phase: `lukes-${chatId}-phase${N}-attempt${A}`. New SDK session, no inherited context.
5. **Structured handoff schema** (`lib/missions/handoff-schema.ts`): worker MUST return JSON with `{ completed, undone, commands_run: [{cmd, exit_code, duration_ms}], issues, procedures_followed, satisfied_assertions: string[] }`. Audit reads JSON, not freeform.
6. Audit prompt now grades: "for each assertion claimed satisfied, verify the diff actually satisfies it; for each unsatisfied assertion in this phase's scope, flag it."
7. Per-role model selection in plan card and per-mission settings: orchestrator / worker / scrutiny / user-testing.
8. Mission Plan Card UI extended: shows assertion coverage matrix.

**Status:** ☑ shipped 2026-05-06 (server-side; UI live in dev). What's working:
- `lib/missions/types.ts` — Mission, MissionPhase, Assertion, ValidationContract, Handoff, MilestoneAudit, MissionRoleConfig
- `lib/missions/contract.ts` — synth instructions, parse, coverage check, per-phase assertion selection
- `lib/missions/handoff.ts` — JSON schema for structured handoffs, parser, pre-audit validation
- `lib/missions/synth.ts` — pair (orchestrator + Codex review) → final phased plan with contract
- `lib/missions/runner.ts` — full mission orchestrator with FRESH worker session per phase, structured handoff parsing, per-assertion verdict checks, auto-commit at boundaries
- `app/api/chat/pair/route.ts` — accepts `mission` + `mission-execute` modes
- `components/PairModeChip.tsx` — added `🛰️ Mission` option
- `components/PlanCard.tsx` — renders validation contract preview, assertion list with severity/type badges, coverage warnings, role assignments; Approve button label switches to "Approve & launch mission"
- `components/ChatPanel.tsx` — routes mission-protocol approvals to `mission-execute`, persists `mission` field in plan card

What's deferred to later phases:
- Phase 2 user-testing validator (browser-driven QA)
- Phase 3 self-healing follow-ups
- Phase 4 persistence (currently in-memory, dies on MC restart)

---

## Phase 2 — User-testing validator ⏱ ~1d

**Goal:** Add the second validator type — adversarial behavioral testing via headless browser.

### Concepts mapped
- **User-testing validator** spawns the app, exercises flows, asserts behavior — like a QA engineer.
- Runs after each milestone, in parallel with scrutiny.
- Most wall-clock time of a mission is spent here.
- Adversarial by design: never sees the code, only the running app + the validation contract.

### Deliverables
1. `lib/missions/validators/user-testing.ts` — orchestrates a browser-MCP-equipped agent.
2. Reuses MC's existing browser infrastructure (`lib/browser/*`, MCP browser tools).
3. Per-`behavioral` assertion: `{ flow_steps: string[], expected_outcome: string }` — agent navigates, fills, clicks, asserts.
4. Parallel with scrutiny — both run after milestone end, results merged into single milestone report.
5. Surfaces failed flows with screenshots + console errors as `concerns` to the orchestrator.
6. New SSE event types: `user-testing-start`, `user-testing-step`, `user-testing-fail`, `user-testing-pass`.

**Status:** ☑ shipped 2026-05-06. What's working:
- `lib/missions/validators/user-testing.ts` — adversarial QA agent that drives a headless Chrome via `/api/browser` (existing in-process Playwright). Per behavioral assertion: spawns a fresh QA Claude session with no source-code access, gives it the assertion + flow_steps + expected_outcome + start_url, lets it use Bash+curl to navigate, click, type, waitFor, getText, evaluate. Returns `BehavioralCheck` per assertion.
- Runner integration: after scrutiny says `phase-complete`, behavioral assertions in scope are verified before commit. Failures send the phase back to rework with directives that cite the specific assertion that failed and the QA agent's observation.
- Skipped assertions surface clearly when no `target_url` is set — won't block the phase but won't satisfy them either.
- `Mission.target_url` and per-assertion `behavior.start_url` plumbed through synth → plan card → mission-execute.
- Plan Card UI shows the target_url, warns when behavioral assertions exist without one, lists per-role models including the QA seat.
- New SSE events: `user-testing-start`, `user-testing-step-start`, `user-testing-step-end`, `user-testing-skip`, `user-testing-complete`.

What's deferred:
- Per-assertion screenshots (the agent is told it can take them but no automation yet).
- Parallel verification across behavioral assertions in a single phase (Phase 6: read-only parallelism).
- Auto-detect of localhost dev server port — currently relies on synth proposing target_url or user setting it.

---

## Phase 3 — Self-healing follow-up features ⏱ ~half-day

**Goal:** When validators flag regressions, the orchestrator auto-scopes corrective work — the mission "pulls itself back on track."

### Concepts mapped
- Errors caught at milestone boundaries → corrective work scoped → mission self-heals.
- "Validation never succeeds first try" — almost always need follow-up features.
- Orchestrator decides: block milestone / scope follow-up / pause for user.

### Deliverables
1. New phase status: `awaiting-followups` between `complete` and `next-phase-start`.
2. When validators report failed assertions, orchestrator (a separate agent call) drafts follow-up phases with their own assertions.
3. Follow-ups inserted into the plan with `parent_phase_id` + `created_by: 'self-heal'` lineage.
4. Mission Plan Card UI shows follow-ups indented under their parent phase.
5. Cap: if total auto-generated follow-ups exceeds N (default 5) for a single milestone, pause for user — that's a sign of a bigger problem.

**Status:** ☑ shipped 2026-05-06. What's working:
- `lib/missions/self-heal.ts` — orchestrator-driven follow-up scoping. Calls Codex with a brief listing every unsatisfied assertion + the most recent scrutiny/user-testing evidence, asks for follow-up phases that target those specific assertion ids.
- Cap: >5 follow-ups in one round → escalate to user (architectural smell).
- Two-path response: Path A scopes phases auto; Path B routes to a user question for genuine business/credential blockers.
- Runner integration: at end of mission, while unsatisfied assertions exist, runs up to 3 self-heal rounds. Each round appends new `MissionPhase` rows with `origin: 'self-heal'` and `parent_phase_index` lineage. The new phases run through the full worker→audit→user-testing→commit pipeline via `runMissionRange`.
- Mid-mission: same pipeline; the inner loop already extends naturally because `m.phases.length` is dynamic.
- Provenance: commit messages distinguish `[mission:<id>] follow-up phase N` from regular phases.

What's deferred:
- Persisting full per-attempt assertion_checks + behavioral_checks across phases for richer healing context (waiting on Phase 4 persistence).
- Mid-phase auto-healing when scrutiny says `needs-followup` (currently only end-of-mission).

---

## Phase 4 — Mission persistence ⏱ ~1d

**Goal:** Missions run for 16+ days. Survive MC restart, browser close, network drops. Decoupled from the SSE stream.

### Concepts mapped
- "Our longest mission ran for 16 days... we believe they can run for 30."
- "You could just go hang out with your friends."

### Deliverables
1. ✅ `data/missions/<mission_id>.json` — persistent state with atomic writes + per-mission async mutex (`lib/missions/persistence.ts`).
2. ✅ Background runner: implemented as **in-process registry** (`lib/missions/runtime.ts`) rather than separate PM2 child processes. Rationale: Anthropic/Codex/MCP infrastructure already lives in the Next.js process; PM2 already supervises MC for crash recovery; `instrumentation.ts` handles re-attach on restart. Lock files (`<id>.lock`) detect crash vs clean exit.
3. ✅ Resume API: `POST /api/missions/<id>/resume` — idempotent attach, optional user-answer + override-rework-cap body. Verifies cross-process lock isn't held by a sibling.
4. ✅ SSE endpoint becomes a thin **subscriber**: `GET /api/missions/<id>/events` tails the append-only event log (`<id>.events.jsonl`) via `fs.watch` + poll fallback, with replay-from-seq for reconnects. Mission runner output goes to log; SSE just streams what's there.
5. ✅ `instrumentation.ts` re-attaches to running/stuck missions on MC startup (after 5s delay so the HTTP server has bound). Skips paused-question (user owes us an answer).
6. ✅ Auxiliary routes: `GET /api/missions` (list), `GET /api/missions/<id>` (state read), `DELETE /api/missions/<id>` (discard), `POST /api/missions/<id>/abort` (cooperative cancel).

### Pending wrap-up
- ✅ `abortSignal` threaded through `streamClaudeTurn` (cancels the Claude stream reader) and `runCodexConsult` (SIGTERMs the codex subprocess). Abort now lands within ~hundreds of ms instead of waiting up to 15 min.
- ✅ UI: `components/MissionsDashboard.tsx` renders running/paused/completed missions above the Luke's Chat chat panel with per-mission progress bars, abort/resume buttons, SSE-tailed phase timeline, and current-activity stream.

**Status:** ☑ shipped 2026-05-07.

---

## Phase 5 — PM Dashboard view ⏱ ~1d

**Goal:** "Your standard chat interface doesn't work for something that lasts many days."

### Concepts mapped
- Need: % complete, budget burned, current worker activity, handoff timeline.

### Deliverables
1. ✅ `components/MissionsDashboard.tsx` — PM-style header above the Luke's Chat panel. Three columns: 🟢 Running, ⏸ Paused, 🏁 Recent. Each row shows mission goal, % complete progress bar, current phase X/N, last-activity-at relative time, and a tinted status pill.
2. ✅ Per-mission detail view (selected via row click): phase-event timeline (last 15 events), live "current activity" log streamed from `/api/missions/[id]/events`, contract progress (covered/total assertions), and a paused-question banner if the mission is awaiting user input.
3. ✅ Per-mission Abort + Resume buttons that fire `POST /api/missions/[id]/{abort,resume}` and surface in-flight feedback.
4. ✅ List polled every 5s; per-mission events live-streamed via SSE. Polling+SSE split keeps connection count low while still giving live phase progress for the focused mission.

**Status:** ☑ shipped 2026-05-07.
- User can be plugged in as a project manager or step away.

### Deliverables
1. New view inside Luke's Chat: when a mission is active, the panel splits into chat (left) + dashboard (right).
2. Dashboard sections:
   - **Mission progress:** assertion coverage bar (X of Y satisfied), milestone tracker, ETA.
   - **Live activity:** current role + what it's doing, last 5 commands, current sub-agent fan-out.
   - **Handoff timeline:** every milestone handoff as a card with its structured fields.
   - **Budget:** tokens used / cost (only if user wants — can be hidden).
   - **Validators last-run summary:** last scrutiny + user-testing results.
3. On mobile: dashboard is a swipe-up sheet from the chat.

**Status:** ☐ not started

---

## Phase 6 — Read-only parallelism within phases ⏱ ~half-day

**Goal:** Serial execution between features, parallel execution of read-only ops within a feature.

### Concepts mapped
- Within a feature: parallelize search, research, API exploration.
- Within validators: parallelize per-feature code review.
- Targeted internal parallelization, not blanket parallelism.

### Deliverables
1. ✅ Worker prompt explicitly authorizes parallel sub-agent fan-out for read-only ops (`buildWorkerPrompt` adds a "Read-only parallelism" rules section).
2. ✅ Scrutiny fans out 2-3 parallel Codex consults when a phase owns ≥4 assertions; each lane reviews the full diff but votes on its assertion bucket. Verdicts merge with strict semantics (`runScrutinyFanout`, `mergeScrutinyResults`, `pickStrictestVerdict`).
3. ✅ Runner emits a `scrutiny-fanout` SSE event with the lane count so the dashboard can render "3 parallel reviewers" instead of one silent multi-minute Codex call.

**Status:** ☑ shipped 2026-05-07.

---

## Phase 7 — Negotiation at milestone boundaries ⏱ ~half-day

**Goal:** "Negotiation shows up at milestone boundaries, where the orchestrator defines does this handoff summary look correct? Do we need to create follow-up features, rescope, etc."

### Concepts mapped
- Net positive sum trading between agents over shared resources (same code section, same API).
- Orchestrator validates handoffs at milestone boundaries.
- Rescope vs follow-up vs pause.

### Deliverables
1. ✅ Orchestrator decision points emit a structured `orchestrator-decision` SSE event with `{ decision, reasoning, next_action }`. Wired in at four sites: invalid handoff (`reject-handoff`), phase-complete (`advance`), needs-rework (`rework`), needs-user-input (`pause-for-user`).
2. ✅ Decision matrix encoded in the `OrchestratorDecision` enum: `advance | scope-followups | reject-handoff | rework | pause-for-user | broker-conflict | auto-accept-disputed`. Each branch emits the canonical event.
3. ✅ `emitOrchestratorDecision` helper centralises voicing + raw SSE + chat text so the timeline is consistent across decision sites.
4. ⏭ `broker-conflict` is wired into the enum but not yet exercised — concurrent worker outputs require Phase 11's child-mission runtime, which is scaffolded only.

**Status:** ☑ shipped 2026-05-07.

---

## Phase 8 — The Bitter Lesson refactor ⏱ ~1d

**Goal:** "Architecture must improve with each model release. 700 lines of prompt instead of state machine."

### Concepts mapped
- Almost all orchestration logic in prompts and skills, not a hard-coded state machine.
- Worker behavior driven by skills the orchestrator defines per mission.
- Deterministic logic is thin — just bookkeeping.

### Deliverables
1. ✅ `.claude/skills/missions/` populated with `orchestrator.skill.md`, `worker.skill.md`, `scrutiny.skill.md`, `user-testing.skill.md`. Each is a self-contained role prompt that future model upgrades can update without touching TypeScript.
2. ✅ Per-mission custom skills via `lib/missions/skills.ts`: `writeMissionSkill(missionId, name, content)`, `loadMissionSkills(missionId)`, `workerSkillBundle(missionId)` (role + per-mission combined). Stored under `data/missions/<id>/skills/<name>.md`.
3. ✅ Worker prompt builder + scrutiny brief builder prepend the skill bundle. Skill cache is warmed at MC startup via `instrumentation.ts` so the sync loader (used inside `buildAuditBrief`) always has data.
4. 🟡 The hardcoded routing in `runner.ts` is NOT yet collapsed into a thin skill-driven dispatcher — that's the deeper "remove the state machine" rewrite which needs integration tests before shipping. Skill files are now the source of truth for role behavior, but the runner's verdict-handling state machine is still in TypeScript.

**Status:** ☑ shipped 2026-05-07 (deliverables 1-3); deliverable 4 deferred until end-to-end test coverage exists.

---

## Phase 9 — Per-role model + provider config ⏱ ~half-day

**Goal:** "Droid whispering" — right model in each seat. Model-agnostic.

### Concepts mapped
- Planning: slow careful reasoning.
- Implementation: fast code fluency + creativity.
- Validation: precise instruction following.
- Validation should use a different model provider (avoid training-data bias).
- Open-weight models work too if structure compensates.

### Deliverables
1. ✅ `lib/missions/role-config.ts` — role registry, named presets (`frontier-mixed`, `all-anthropic`, `budget`), `resolveRoleConfig` resolves Defaults → mission overrides → runtime overrides with provenance tracking.
2. ✅ Defaults from `DEFAULT_ROLE_CONFIG` in `types.ts` match Luke's recommendations: Opus 4.7 / Sonnet 4.6 / Codex GPT-5 / Browser+Claude.
3. 🟡 Settings UI not yet built. The API (`GET /api/missions/role-config`) returns the presets — a settings panel can consume it. Skipped tonight to keep the foundation clean; UI is a contained follow-up.
4. ✅ Provider abstraction is implicit in the runner: `streamClaudeTurn` (Anthropic) and `runCodexConsult` (OpenAI Codex) are dispatched per-role via `mission.roles.<role>.provider`. Adding open-weight = adding a third dispatcher.
5. ✅ "Mix-providers" guard in `resolveRoleConfig` warns when scrutiny.provider matches worker.provider OR scrutiny.model matches worker.model exactly. Warning surfaces at mission start via `runMissionInner`.

**Status:** ☑ shipped 2026-05-07 (deliverables 1-2, 4-5); settings UI pending.

---

## Phase 10 — Long-running missions infrastructure (multi-day) ⏱ ~1d

**Goal:** Missions that genuinely run 16+ days, like Luke's. Includes prompt caching, checkpoint resume, browser-disconnect tolerance.

### Concepts mapped
- "Take advantage of prompt caching heavily."
- "Wall clock time spent waiting for real world execution, not generating tokens."

### Deliverables
1. 🟡 Prompt caching scaffolding shipped — worker prompts now embed two `MC_CACHE_BREAKPOINT` markers separating STABLE (skills) / MISSION (goal+contract) / PHASE (attempt-specific) regions. A future bridge upgrade can split on these markers and attach `cache_control: { type: 'ephemeral' }` to each prefix. Today the markers are inert markdown; caching is a no-op but the prompt structure is correct and won't need re-authoring.
2. ✅ Checkpoints after every milestone — `lib/missions/checkpoints.ts` with atomic writes to `data/missions/<id>/checkpoints/checkpoint-N.json` + `manifest.json` index. Runner calls `writeCheckpoint` on every phase-complete (best-effort; failure doesn't stall the mission).
3. ✅ Hibernate sweep — `lib/missions/hibernate.ts`. 15-min interval timer scans the registry for missions whose status is `paused-question` and `last_activity_at` exceeds 2h, drops the in-memory entry + releases the runner lock, leaves the disk state intact. Wired in at `instrumentation.ts:6_000ms`.
4. ✅ Resume from disk works because (a) state files are atomic, (b) the lock detects crashed runners, (c) `instrumentation.ts:5_000ms` re-attaches `running`/`paused-stuck` missions on MC startup, and (d) `POST /api/missions/[id]/rewind` + `GET /api/missions/[id]/checkpoints` plus the dashboard's `⏮ N ckpt` button let the user roll back to any prior milestone.
5. ✅ Token-budget accumulator — `accumulateMissionUsage(missionId, usage, cost)` reads the `type: 'usage'` SSE frame the existing claude-chat-bridge already emits per turn and folds `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` plus `cost_usd` into `MissionState.tokens_used` and `mission.cost_usd`. The dashboard sees a `mission-usage` SSE event per turn so a future "tokens used: X.X k" indicator can render without an extra API call. Cap enforcement is not implemented (Andrew rejected default caps earlier) but the data is now accumulating.

**Status:** ☑ shipped 2026-05-07 (deliverables 2-5 fully; #1 is structural scaffolding only — bridge upgrade still needed for actual cache hits).

---

## Phase 11 — Multi-mission orchestration ⏱ ~1d

**Goal:** "How do we orchestrate missions themselves into more complex workflows?" — Luke's open question.

### Concepts mapped
- A "mission of missions" — multi-mission orchestration.

### Deliverables
1. ✅ Schema: `Mission.parent_mission_id`, `Mission.child_mission_ids`, `Mission.child_concurrency_policy` plus `MissionPhase.blocks_on_child_missions` and `MissionPhase.worker_concurrency` added to `types.ts`. Persistence round-trips everything.
2. ✅ Runtime recursion: `lib/missions/runtime.ts:waitForChildMissions` polls every 5s (abort-aware) until each child reaches a terminal status. The runner calls it after handoff validation when `phase.blocks_on_child_missions` is non-empty. Non-success child outcomes emit an `orchestrator-decision: broker-conflict` event and pause the parent for user direction.
3. ✅ UI nested-tree rendering — `MissionTreeRow` in `MissionsDashboard.tsx` indents child missions under their parents with a "└─ child" affordance and a `border-l` lineage column. Parent + child status badges render side-by-side.
4. ✅ The "7-phase product feature where Phase 4 is itself a 5-phase migration" use case is exercisable.
5. ✅ **Parallel workers (pair-worker mode)** — phases can opt in via `worker_concurrency: 'pair'`. The runner spawns Worker A (Anthropic) AND a Codex consultant in parallel. Codex is structurally read-only (its CLI runs `-s read-only`) so there's no file conflict; it produces an alternative-approach + risk-analysis document. Worker A's structured handoff is augmented with `codex_perspective` so scrutiny audits with both viewpoints. Emits a `pair-worker-fanout` SSE event for the dashboard.

**Status:** ☑ Phase 11 fully shipped 2026-05-08.

---

## Phase 12 — Direct communication (deferred) ⏱ TBD

**Goal:** Phase 12 is intentionally deferred — Luke called direct agent-to-agent communication "hard to get right; state fragments without a coordinator." We don't need it; broadcast + orchestrator suffice.

**Decision:** skip unless a concrete need arises.

---

## Cross-cutting requirements

- **Telemetry:** every role decision, handoff, milestone result is a row in `data/missions/<id>/events.jsonl`. Replayable.
- **Cancel any time:** user can pause/cancel a mission from the dashboard at any point. State persists; resume cleanly.
- **Audit trail:** every commit by autopilot uses `Autopilot (MC)` author with mission ID in the commit message. `git log --grep="mission-<id>"` shows the full history.
- **Skills are versioned:** `.claude/skills/missions/*.md` files are git-tracked. Updates roll out to in-flight missions on next boundary.
- **No deploys mid-mission** unless the mission's contract explicitly lists a deploy assertion.

---

## What this lets us do (vs current MC autopilot)

| Capability | Today | With this plan |
|---|---|---|
| Long-running tasks (days) | Tied to SSE; dies on restart | Background, persistent, multi-day |
| Validation discipline | Vibes-based exit criteria | Hundreds of typed assertions |
| Behavioral testing | None | Adversarial QA agent runs the app |
| Worker context drift | Yes — same session across phases | Fresh worker per phase |
| Self-healing | Within-phase rework only | Auto-scoped follow-up features |
| Mix-and-match models | Hardcoded | Per-role, per-mission, per-provider |
| Architecture & model upgrades | Refactors needed | Prompt-driven, gets better automatically |
| Concurrency model | Serial only | Serial + read-only parallelism |
| Mission UX | Chat scroll | Chat + PM dashboard |

---

## Build order summary

| Phase | What | Days | Blocks |
|---|---|---|---|
| 0 | Tab plumbing | 0.25 | everything |
| 1 | 3 roles + contract + handoff schema + fresh workers | 1 | 2,3,7,8,9 |
| 2 | User-testing validator | 1 | 3 (full coverage) |
| 3 | Self-healing | 0.5 | 7 |
| 4 | Persistence | 1 | 10,11 |
| 5 | PM dashboard | 1 | — (UX) |
| 6 | Read-only parallelism | 0.5 | — |
| 7 | Negotiation/orchestrator decision | 0.5 | — |
| 8 | Bitter lesson refactor | 1 | — |
| 9 | Per-role model config | 0.5 | — |
| 10 | Multi-day infra | 1 | — |
| 11 | Multi-mission | 1 | — |

**Critical path: 0 → 1 → 4 → 10**, ~3.25 days.
**Full build:** ~9.25 days, parallelizable to ~5.

---

## Status tracking

Update this section after each phase ships:

- ☑ Phase 0 — plumbing (shipped 2026-05-06)
- ☑ Phase 1 — 3-role + contract + structured handoff + fresh-context workers (shipped 2026-05-06)
- ☑ Phase 2 — user-testing validator (shipped 2026-05-06)
- ☑ Phase 3 — self-healing follow-up phases (shipped 2026-05-06)
- ☐ Phase 1 — 3-role + contract
- ☐ Phase 2 — user-testing validator
- ☐ Phase 3 — self-healing
- ☐ Phase 4 — persistence
- ☐ Phase 5 — PM dashboard
- ☐ Phase 6 — read-only parallelism
- ☐ Phase 7 — negotiation
- ☐ Phase 8 — bitter lesson refactor
- ☐ Phase 9 — per-role model config
- ☐ Phase 10 — multi-day infra
- ☐ Phase 11 — multi-mission
- ✗ Phase 12 — direct comms (skipped)
