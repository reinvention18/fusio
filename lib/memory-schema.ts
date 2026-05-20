import type Database from 'better-sqlite3';

const MIGRATION_1_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id                INTEGER PRIMARY KEY,
  chat_id           TEXT    NOT NULL,
  claude_session_id TEXT    NOT NULL,
  turn_index        INTEGER NOT NULL,
  ts_start          INTEGER NOT NULL,
  ts_end            INTEGER NOT NULL,
  user_text         TEXT    NOT NULL,
  assistant_text    TEXT    NOT NULL,
  thinking_text     TEXT    NOT NULL DEFAULT '',
  tool_summary      TEXT    NOT NULL DEFAULT '',
  content_text      TEXT    NOT NULL,
  content_summary   TEXT,
  token_count       INTEGER NOT NULL,
  files_touched     TEXT    NOT NULL DEFAULT '[]',
  tools_used        TEXT    NOT NULL DEFAULT '[]',
  indexed_at        INTEGER NOT NULL,
  UNIQUE (chat_id, turn_index)
);
CREATE INDEX IF NOT EXISTS idx_turns_chat_ts  ON turns(chat_id, ts_start);
CREATE INDEX IF NOT EXISTS idx_turns_chat_idx ON turns(chat_id, turn_index);

CREATE TABLE IF NOT EXISTS episodes (
  id                INTEGER PRIMARY KEY,
  chat_id           TEXT    NOT NULL,
  start_turn        INTEGER NOT NULL,
  end_turn          INTEGER NOT NULL,
  ts_start          INTEGER NOT NULL,
  ts_end            INTEGER NOT NULL,
  title             TEXT    NOT NULL,
  summary           TEXT    NOT NULL,
  key_decisions     TEXT    NOT NULL DEFAULT '[]',
  files_touched     TEXT    NOT NULL DEFAULT '[]',
  indexed_at        INTEGER NOT NULL,
  UNIQUE (chat_id, start_turn)
);
CREATE INDEX IF NOT EXISTS idx_episodes_chat_ts ON episodes(chat_id, ts_start);

CREATE TABLE IF NOT EXISTS index_state (
  chat_id                 TEXT PRIMARY KEY,
  claude_session_id       TEXT NOT NULL,
  last_indexed_turn       INTEGER NOT NULL DEFAULT -1,
  last_episode_end_turn   INTEGER NOT NULL DEFAULT -1,
  last_jsonl_line_offset  INTEGER NOT NULL DEFAULT 0,
  last_run_at             INTEGER,
  last_error              TEXT,
  last_error_at           INTEGER,
  disabled                INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  content_text,
  tool_summary,
  chat_id    UNINDEXED,
  turn_index UNINDEXED,
  content='turns',
  content_rowid='id',
  tokenize='trigram case_sensitive 0 remove_diacritics 1'
);

CREATE TRIGGER IF NOT EXISTS turns_fts_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, content_text, tool_summary, chat_id, turn_index)
  VALUES (new.id, new.content_text, new.tool_summary, new.chat_id, new.turn_index);
END;
CREATE TRIGGER IF NOT EXISTS turns_fts_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, content_text, tool_summary, chat_id, turn_index)
  VALUES('delete', old.id, old.content_text, old.tool_summary, old.chat_id, old.turn_index);
END;
CREATE TRIGGER IF NOT EXISTS turns_fts_au AFTER UPDATE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, content_text, tool_summary, chat_id, turn_index)
  VALUES('delete', old.id, old.content_text, old.tool_summary, old.chat_id, old.turn_index);
  INSERT INTO turns_fts(rowid, content_text, tool_summary, chat_id, turn_index)
  VALUES (new.id, new.content_text, new.tool_summary, new.chat_id, new.turn_index);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  title, summary,
  chat_id  UNINDEXED,
  content='episodes', content_rowid='id',
  tokenize='trigram case_sensitive 0 remove_diacritics 1'
);

CREATE TRIGGER IF NOT EXISTS episodes_fts_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, title, summary, chat_id)
  VALUES (new.id, new.title, new.summary, new.chat_id);
END;
CREATE TRIGGER IF NOT EXISTS episodes_fts_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, title, summary, chat_id)
  VALUES('delete', old.id, old.title, old.summary, old.chat_id);
END;
CREATE TRIGGER IF NOT EXISTS episodes_fts_au AFTER UPDATE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, title, summary, chat_id)
  VALUES('delete', old.id, old.title, old.summary, old.chat_id);
  INSERT INTO episodes_fts(rowid, title, summary, chat_id)
  VALUES (new.id, new.title, new.summary, new.chat_id);
END;
`;

const MIGRATION_2_SQL = `
ALTER TABLE turns ADD COLUMN embedding BLOB;
ALTER TABLE turns ADD COLUMN embedding_model TEXT;
CREATE INDEX IF NOT EXISTS idx_turns_chat_embed ON turns(chat_id) WHERE embedding IS NOT NULL;
`;

// Migration #3 — Constellation teams + SQLite-backed JSON state.
// Verified against a backup of the 34MB production memory.db on 2026-04-11:
// all 10 new tables + 32 indexes create cleanly, existing turns/episodes preserved,
// atomic claim query tested race-free. See docs/MULTI_AGENT_TEAMS_PLAN.md §17.
const MIGRATION_3_SQL = `
-- ── Constellation team tables ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teams (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  constellation     TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  main_branch       TEXT NOT NULL,
  parent_chat_key   TEXT,
  preset            TEXT,
  goal              TEXT,
  status            TEXT NOT NULL,
  pause_reason      TEXT,
  budget_usd        REAL,
  spent_usd         REAL NOT NULL DEFAULT 0,
  max_agents        INTEGER NOT NULL DEFAULT 5,
  max_parallel      INTEGER NOT NULL DEFAULT 2,
  settings_json     TEXT NOT NULL DEFAULT '{}',
  created_by        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  started_at        INTEGER,
  completed_at      INTEGER,
  archived_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_teams_status ON teams(status) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_teams_parent_chat ON teams(parent_chat_key) WHERE parent_chat_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_teams_project ON teams(project_id);
CREATE INDEX IF NOT EXISTS idx_teams_archived ON teams(archived_at) WHERE archived_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS team_agents (
  id                  TEXT PRIMARY KEY,
  team_id             TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role                TEXT NOT NULL,
  role_handle         TEXT NOT NULL,
  role_file           TEXT,
  model               TEXT NOT NULL,
  status              TEXT NOT NULL,
  status_reason       TEXT,
  session_id          TEXT,
  session_key         TEXT NOT NULL UNIQUE,
  worktree_path       TEXT NOT NULL,
  branch_name         TEXT NOT NULL,
  last_output_hash    TEXT,
  last_activity_at    INTEGER,
  current_task_id     TEXT,
  tokens_in           INTEGER NOT NULL DEFAULT 0,
  tokens_out          INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read   INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write  INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL NOT NULL DEFAULT 0,
  retries_remaining   INTEGER NOT NULL DEFAULT 3,
  permission_mode     TEXT,
  started_at          INTEGER,
  ended_at            INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_agents_team ON team_agents(team_id);
CREATE INDEX IF NOT EXISTS idx_team_agents_status ON team_agents(team_id, status);
CREATE INDEX IF NOT EXISTS idx_team_agents_session_key ON team_agents(session_key);
CREATE INDEX IF NOT EXISTS idx_team_agents_session_id ON team_agents(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_team_agents_current_task ON team_agents(current_task_id) WHERE current_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS team_tasks (
  id                   TEXT PRIMARY KEY,
  team_id              TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  parent_task_id       TEXT,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN (
                         'pending','claimed','in_progress',
                         'ready_for_review','review','approved',
                         'merging','done','blocked','failed','cancelled'
                       )),
  status_reason        TEXT,
  priority             INTEGER NOT NULL DEFAULT 0,
  role_hint            TEXT,
  assigned_agent_id    TEXT,
  depends_on           TEXT NOT NULL DEFAULT '[]',
  files_touched        TEXT NOT NULL DEFAULT '[]',
  diff_numstat         TEXT,
  worktree_path        TEXT,
  branch_name          TEXT,
  commit_sha           TEXT,
  result_summary       TEXT,
  error_detail         TEXT,
  retry_count          INTEGER NOT NULL DEFAULT 0,
  max_retries          INTEGER NOT NULL DEFAULT 3,
  created_at           INTEGER NOT NULL,
  claimed_at           INTEGER,
  started_at           INTEGER,
  completed_at         INTEGER,
  reviewed_at          INTEGER,
  merged_at            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_team_tasks_claim
  ON team_tasks(team_id, status, priority DESC, created_at ASC)
  WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_team_tasks_team ON team_tasks(team_id);
CREATE INDEX IF NOT EXISTS idx_team_tasks_agent ON team_tasks(assigned_agent_id) WHERE assigned_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_team_tasks_stale
  ON team_tasks(status, claimed_at)
  WHERE status IN ('claimed','in_progress');
CREATE INDEX IF NOT EXISTS idx_team_tasks_parent ON team_tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS team_messages (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  from_agent_id TEXT,
  to_agent_id   TEXT,
  type          TEXT NOT NULL CHECK (type IN ('direct','broadcast','halt','note','chat_report')),
  priority      TEXT NOT NULL DEFAULT 'next' CHECK (priority IN ('now','next','later')),
  body          TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  delivered_at  INTEGER,
  read_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_team_messages_team ON team_messages(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_messages_undelivered
  ON team_messages(to_agent_id, created_at ASC)
  WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS team_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id   TEXT,
  task_id    TEXT,
  kind       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('debug','info','warn','error')),
  payload    TEXT NOT NULL DEFAULT '{}',
  chat_report INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_events_team_time ON team_events(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_events_team_kind ON team_events(team_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_events_chat_report ON team_events(team_id, chat_report, created_at DESC) WHERE chat_report = 1;
CREATE INDEX IF NOT EXISTS idx_team_events_agent ON team_events(agent_id, created_at DESC) WHERE agent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS team_scratchpad (
  team_id     TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  content     TEXT NOT NULL DEFAULT '',
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL DEFAULT 'user'
);

CREATE TABLE IF NOT EXISTS task_reviews (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
  reviewer_agent_id  TEXT,
  reviewer_model     TEXT NOT NULL,
  review_kind        TEXT NOT NULL CHECK (review_kind IN (
                       'sentinel','diff','holistic','security','framework','adversarial'
                     )),
  clean              INTEGER NOT NULL,
  verdict            TEXT,
  summary            TEXT,
  cost_usd           REAL,
  duration_ms        INTEGER,
  raw_output         TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_reviews_task ON task_reviews(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_reviews_kind ON task_reviews(review_kind);

CREATE TABLE IF NOT EXISTS task_review_findings (
  id             TEXT PRIMARY KEY,
  review_id      TEXT NOT NULL REFERENCES task_reviews(id) ON DELETE CASCADE,
  severity       TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','nit','pre_existing','info')),
  file           TEXT,
  line_start     INTEGER,
  line_end       INTEGER,
  title          TEXT NOT NULL,
  body           TEXT,
  recommendation TEXT,
  confidence     REAL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
                   'open','addressed','waived','false_positive'
                 )),
  addressed_by   TEXT,
  addressed_at   INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_review ON task_review_findings(review_id);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON task_review_findings(severity, status);
CREATE INDEX IF NOT EXISTS idx_findings_open
  ON task_review_findings(review_id, severity)
  WHERE status = 'open' AND severity IN ('critical','high');

-- ── SQLite-backed replacement for data/mc-subagents.json ─────────────────
CREATE TABLE IF NOT EXISTS mc_subagents (
  tool_use_id       TEXT PRIMARY KEY,
  session_key       TEXT NOT NULL,
  parent_session_id TEXT,
  team_id           TEXT,
  team_agent_id     TEXT,
  team_task_id      TEXT,
  subagent_type     TEXT,
  label             TEXT,
  task              TEXT,
  status            TEXT NOT NULL CHECK (status IN ('running','complete','failed','cancelled')),
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  result_full       TEXT,
  error             TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mc_subagents_session ON mc_subagents(session_key, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mc_subagents_team ON mc_subagents(team_id) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mc_subagents_status ON mc_subagents(status) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_mc_subagents_gc ON mc_subagents(ended_at) WHERE ended_at IS NOT NULL;

-- ── SQLite-backed replacement for data/active-tasks.json ─────────────────
CREATE TABLE IF NOT EXISTS active_tasks (
  id               TEXT PRIMARY KEY,
  session_key      TEXT NOT NULL,
  prompt           TEXT NOT NULL DEFAULT '',
  file_path        TEXT,
  status           TEXT NOT NULL,
  current_item_idx INTEGER NOT NULL DEFAULT 0,
  output           TEXT NOT NULL DEFAULT '',
  questions        TEXT,
  error            TEXT,
  items_json       TEXT NOT NULL DEFAULT '[]',
  order_index      INTEGER NOT NULL DEFAULT 0,
  promoted_team_id TEXT,
  started_at       INTEGER NOT NULL,
  completed_at     INTEGER,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_active_tasks_session ON active_tasks(session_key, order_index);
CREATE INDEX IF NOT EXISTS idx_active_tasks_status ON active_tasks(session_key, status);
CREATE INDEX IF NOT EXISTS idx_active_tasks_promoted ON active_tasks(promoted_team_id) WHERE promoted_team_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS active_task_session_meta (
  session_key    TEXT PRIMARY KEY,
  current_task_id TEXT,
  is_minimized  INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
`;

// Migration #4 — Learned Skills: auto-extracted knowledge from completed tasks.
// Unlike Multica's static CRUD approach, these skills are automatically generated
// when constellation tasks complete successfully, building a compounding knowledge
// base that improves future agent performance.
// Migration #4 also adds chat_context to teams for constellation←chat inheritance.
const MIGRATION_4_SQL = `
ALTER TABLE teams ADD COLUMN chat_context TEXT;

CREATE TABLE IF NOT EXISTS learned_skills (
  id             TEXT PRIMARY KEY,
  team_id        TEXT,
  task_id        TEXT,
  project_id     TEXT NOT NULL,              -- workspace path (for project-scoped retrieval)
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL,              -- what was done and why it worked
  pattern        TEXT,                       -- reusable pattern/approach extracted
  files_involved TEXT NOT NULL DEFAULT '[]', -- JSON array of file paths
  tags           TEXT NOT NULL DEFAULT '[]', -- JSON array of tags for matching
  tools_used     TEXT NOT NULL DEFAULT '[]', -- JSON array of tool names used
  outcome        TEXT NOT NULL DEFAULT 'success', -- 'success' | 'partial' | 'learned_failure'
  agent_role     TEXT,                       -- which role produced this
  agent_model    TEXT,                       -- which model tier
  cost_usd       REAL,                      -- how much this task cost
  duration_ms    INTEGER,                   -- how long it took
  applicability  INTEGER NOT NULL DEFAULT 1, -- 1-5 scale, bumped when skill is reused successfully
  times_applied  INTEGER NOT NULL DEFAULT 0,
  last_applied_at INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learned_skills_project ON learned_skills(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_learned_skills_tags ON learned_skills(tags);
CREATE INDEX IF NOT EXISTS idx_learned_skills_outcome ON learned_skills(outcome, applicability DESC);
`;

// Migration #5 — Constellation overhaul: expanded task statuses for feedback loops,
// phase tracking, team decisions, rework cycle counting.
// Rebuilds team_tasks table to update CHECK constraint with new statuses.
const MIGRATION_5_SQL = `
-- Rebuild team_tasks with expanded status CHECK constraint + new columns
CREATE TABLE IF NOT EXISTS team_tasks_new (
  id                   TEXT PRIMARY KEY,
  team_id              TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  parent_task_id       TEXT,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN (
                         'pending','claimed','in_progress',
                         'ready_for_review','review','approved',
                         'needs_rework','rework_in_progress','re_testing',
                         'merging','done','blocked','failed','cancelled'
                       )),
  status_reason        TEXT,
  priority             INTEGER NOT NULL DEFAULT 0,
  role_hint            TEXT,
  assigned_agent_id    TEXT,
  depends_on           TEXT NOT NULL DEFAULT '[]',
  files_touched        TEXT NOT NULL DEFAULT '[]',
  diff_numstat         TEXT,
  worktree_path        TEXT,
  branch_name          TEXT,
  commit_sha           TEXT,
  result_summary       TEXT,
  error_detail         TEXT,
  retry_count          INTEGER NOT NULL DEFAULT 0,
  max_retries          INTEGER NOT NULL DEFAULT 3,
  phase                TEXT,
  rework_count         INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  claimed_at           INTEGER,
  started_at           INTEGER,
  completed_at         INTEGER,
  reviewed_at          INTEGER,
  merged_at            INTEGER
);
INSERT INTO team_tasks_new SELECT
  id, team_id, parent_task_id, title, description, status, status_reason,
  priority, role_hint, assigned_agent_id, depends_on, files_touched,
  diff_numstat, worktree_path, branch_name, commit_sha, result_summary,
  error_detail, retry_count, max_retries,
  NULL, 0,
  created_at, claimed_at, started_at, completed_at, reviewed_at, merged_at
FROM team_tasks;
DROP TABLE team_tasks;
ALTER TABLE team_tasks_new RENAME TO team_tasks;

-- Recreate indexes on rebuilt table
CREATE INDEX IF NOT EXISTS idx_team_tasks_claim
  ON team_tasks(team_id, status, priority DESC, created_at ASC)
  WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_team_tasks_team ON team_tasks(team_id);
CREATE INDEX IF NOT EXISTS idx_team_tasks_agent ON team_tasks(assigned_agent_id) WHERE assigned_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_team_tasks_stale
  ON team_tasks(status, claimed_at)
  WHERE status IN ('claimed','in_progress');
CREATE INDEX IF NOT EXISTS idx_team_tasks_parent ON team_tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_team_tasks_phase ON team_tasks(team_id, phase) WHERE phase IS NOT NULL;

-- Phase tracking for workflow visualization
CREATE TABLE IF NOT EXISTS team_phases (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  ordering     INTEGER NOT NULL,
  roles_json   TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','completed','skipped')),
  started_at   INTEGER,
  completed_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_phases_team ON team_phases(team_id, ordering);

-- Team decision log (architect team composition, phase transitions, rework requests)
CREATE TABLE IF NOT EXISTS team_decisions (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id      TEXT,
  decision_type TEXT NOT NULL CHECK (decision_type IN (
    'team_composition', 'task_plan', 'rework_request',
    'escalation', 'phase_transition', 'agent_spawn', 'agent_remove'
  )),
  summary       TEXT NOT NULL,
  details_json  TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_decisions_team ON team_decisions(team_id, created_at DESC);
`;

const MIGRATION_6_SQL = `
-- Rebuild team_decisions with expanded decision_type CHECK constraint.
-- Adds commander_input, revision_requested, architect_plan, mission_complete.
CREATE TABLE IF NOT EXISTS team_decisions_new (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id      TEXT,
  decision_type TEXT NOT NULL CHECK (decision_type IN (
    'team_composition', 'task_plan', 'rework_request',
    'escalation', 'phase_transition', 'agent_spawn', 'agent_remove',
    'architect_plan', 'commander_input', 'revision_requested',
    'mission_complete'
  )),
  summary       TEXT NOT NULL,
  details_json  TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);

INSERT OR IGNORE INTO team_decisions_new
  SELECT id, team_id, agent_id, decision_type, summary, details_json, created_at FROM team_decisions;

DROP TABLE team_decisions;
ALTER TABLE team_decisions_new RENAME TO team_decisions;

CREATE INDEX IF NOT EXISTS idx_team_decisions_team ON team_decisions(team_id, created_at DESC);
`;

const MIGRATION_7_SQL = `
-- claude-mem-style session memory: compressed observations + session pooling.
-- mem_sessions map any unit of work (chat, team_agent, team_meta) to a namespace
-- that mem_observations attach to. The observation layer is deliberately separate
-- from the turns table (raw chat history) — observations are AI-compressed
-- learnings that cross-pollinate between sessions.
CREATE TABLE IF NOT EXISTS mem_sessions (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('chat','team_agent','team_meta','manual')),
  chat_id            TEXT,
  team_id            TEXT,
  agent_id           TEXT,
  parent_session_id  TEXT,
  title              TEXT NOT NULL DEFAULT '',
  summary            TEXT NOT NULL DEFAULT '',
  tags               TEXT NOT NULL DEFAULT '[]',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  ended_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mem_sessions_chat ON mem_sessions(chat_id) WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mem_sessions_team ON mem_sessions(team_id) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mem_sessions_agent ON mem_sessions(agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mem_sessions_parent ON mem_sessions(parent_session_id) WHERE parent_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mem_sessions_updated ON mem_sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS mem_observations (
  id              INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES mem_sessions(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN (
                    'decision','pattern','blocker','fact','skill','finding','summary'
                  )),
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  tags            TEXT NOT NULL DEFAULT '[]',
  source_turn_ids TEXT NOT NULL DEFAULT '[]',
  files_involved  TEXT NOT NULL DEFAULT '[]',
  embedding       BLOB,
  embedding_model TEXT,
  created_at      INTEGER NOT NULL,
  compressed_from TEXT
);
CREATE INDEX IF NOT EXISTS idx_mem_obs_session ON mem_observations(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mem_obs_type ON mem_observations(type, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS mem_observations_fts USING fts5(
  title,
  content,
  tags,
  session_id UNINDEXED,
  type       UNINDEXED,
  content='mem_observations',
  content_rowid='id',
  tokenize='trigram case_sensitive 0 remove_diacritics 1'
);

CREATE TRIGGER IF NOT EXISTS mem_obs_fts_ai AFTER INSERT ON mem_observations BEGIN
  INSERT INTO mem_observations_fts(rowid, title, content, tags, session_id, type)
  VALUES (new.id, new.title, new.content, new.tags, new.session_id, new.type);
END;
CREATE TRIGGER IF NOT EXISTS mem_obs_fts_ad AFTER DELETE ON mem_observations BEGIN
  INSERT INTO mem_observations_fts(mem_observations_fts, rowid, title, content, tags, session_id, type)
  VALUES ('delete', old.id, old.title, old.content, old.tags, old.session_id, old.type);
END;
CREATE TRIGGER IF NOT EXISTS mem_obs_fts_au AFTER UPDATE ON mem_observations BEGIN
  INSERT INTO mem_observations_fts(mem_observations_fts, rowid, title, content, tags, session_id, type)
  VALUES ('delete', old.id, old.title, old.content, old.tags, old.session_id, old.type);
  INSERT INTO mem_observations_fts(rowid, title, content, tags, session_id, type)
  VALUES (new.id, new.title, new.content, new.tags, new.session_id, new.type);
END;

-- User prompts, indexed for FTS5 cross-session lookup ("when did I ask about X?")
CREATE TABLE IF NOT EXISTS mem_prompts (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES mem_sessions(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_prompts_session ON mem_prompts(session_id, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS mem_prompts_fts USING fts5(
  content,
  session_id UNINDEXED,
  content='mem_prompts',
  content_rowid='id',
  tokenize='trigram case_sensitive 0 remove_diacritics 1'
);
CREATE TRIGGER IF NOT EXISTS mem_prompts_fts_ai AFTER INSERT ON mem_prompts BEGIN
  INSERT INTO mem_prompts_fts(rowid, content, session_id) VALUES (new.id, new.content, new.session_id);
END;
CREATE TRIGGER IF NOT EXISTS mem_prompts_fts_ad AFTER DELETE ON mem_prompts BEGIN
  INSERT INTO mem_prompts_fts(mem_prompts_fts, rowid, content, session_id) VALUES ('delete', old.id, old.content, old.session_id);
END;

-- Raw observation queue: captured during tool use, compressed later by the tick worker.
CREATE TABLE IF NOT EXISTS mem_obs_queue (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES mem_sessions(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('tool_use','tool_result','assistant','user','event')),
  tool_name   TEXT,
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mem_obs_queue_pending ON mem_obs_queue(session_id, created_at) WHERE processed_at IS NULL;

-- Vault index (optional cache; the vault itself is authoritative on disk).
CREATE TABLE IF NOT EXISTS vault_notes (
  path        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  frontmatter TEXT NOT NULL DEFAULT '{}',
  mtime       INTEGER NOT NULL,
  size_bytes  INTEGER NOT NULL,
  indexed_at  INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS vault_notes_fts USING fts5(
  path UNINDEXED,
  title,
  tags,
  body,
  tokenize='trigram case_sensitive 0 remove_diacritics 1'
);
`;

const MIGRATION_8_SQL = `
-- Add 'review_approved' to team_decisions.decision_type CHECK constraint.
-- mc_approve_task records reviewer approvals as decisions; without this
-- migration every approval call fails with a CHECK violation, blocking the
-- reviewer workflow.
CREATE TABLE IF NOT EXISTS team_decisions_v8 (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id      TEXT,
  decision_type TEXT NOT NULL CHECK (decision_type IN (
    'team_composition', 'task_plan', 'rework_request',
    'escalation', 'phase_transition', 'agent_spawn', 'agent_remove',
    'architect_plan', 'commander_input', 'revision_requested',
    'mission_complete', 'review_approved'
  )),
  summary       TEXT NOT NULL,
  details_json  TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);

INSERT OR IGNORE INTO team_decisions_v8
  SELECT id, team_id, agent_id, decision_type, summary, details_json, created_at FROM team_decisions;

DROP TABLE team_decisions;
ALTER TABLE team_decisions_v8 RENAME TO team_decisions;

CREATE INDEX IF NOT EXISTS idx_team_decisions_team ON team_decisions(team_id, created_at DESC);
`;

const MIGRATION_9_SQL = `
-- Add 'acceptance' and 'model_override' to team_tasks.
--
-- acceptance: criteria for "this task is done correctly". Reviewers verify
-- against it. Stops the "agent thinks it's done but didn't deliver what was
-- asked" failure mode.
--
-- model_override: optional per-task model hint (haiku/sonnet/opus). The
-- architect uses this to route trivial work to haiku for cost/speed and
-- deep-reasoning work to opus. Surfaced in mc_get_next_task so the agent
-- can pick the right model when delegating sub-work.
ALTER TABLE team_tasks ADD COLUMN acceptance TEXT;
ALTER TABLE team_tasks ADD COLUMN model_override TEXT;
`;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: MIGRATION_1_SQL },
  { version: 2, sql: MIGRATION_2_SQL },
  { version: 3, sql: MIGRATION_3_SQL },
  { version: 4, sql: MIGRATION_4_SQL },
  { version: 5, sql: MIGRATION_5_SQL },
  { version: 6, sql: MIGRATION_6_SQL },
  { version: 7, sql: MIGRATION_7_SQL },
  { version: 8, sql: MIGRATION_8_SQL },
  { version: 9, sql: MIGRATION_9_SQL },
];

export function runMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      applied_at INTEGER NOT NULL
    );`
  );

  const row = db
    .prepare('SELECT version FROM schema_meta WHERE id = 1')
    .get() as { version: number } | undefined;
  const currentVersion = row?.version ?? 0;

  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (migration.version <= currentVersion) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        'INSERT OR REPLACE INTO schema_meta (id, version, applied_at) VALUES (1, ?, ?)'
      ).run(migration.version, Date.now());
    });
    apply();
  }
}
