#!/usr/bin/env node
// Advance phase status based on current task states — for teams created before
// the phase-transition hook existed.
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const db = new Database(join(process.cwd(), 'data', 'memory.db'));
const now = Date.now();

const teams = db.prepare(
  `SELECT id FROM teams WHERE archived_at IS NULL AND status IN ('idle','planning','running','paused')`
).all();

const ACTIVE = ['claimed','in_progress','ready_for_review','review','approved','merging','done',
  'rework_in_progress','re_testing','needs_rework'];
const TERMINAL = ['done','approved','merging','cancelled','failed'];

let phasesActivated = 0;
let phasesCompleted = 0;

for (const { id: teamId } of teams) {
  const phases = db.prepare('SELECT * FROM team_phases WHERE team_id = ?').all(teamId);
  for (const ph of phases) {
    const total = db.prepare('SELECT COUNT(*) AS n FROM team_tasks WHERE phase = ?').get(ph.id).n;
    if (total === 0) continue;

    const activeCnt = db.prepare(
      `SELECT COUNT(*) AS n FROM team_tasks WHERE phase = ? AND status IN (${ACTIVE.map(() => '?').join(',')})`
    ).get(ph.id, ...ACTIVE).n;

    const remaining = db.prepare(
      `SELECT COUNT(*) AS n FROM team_tasks WHERE phase = ? AND status NOT IN (${TERMINAL.map(() => '?').join(',')})`
    ).get(ph.id, ...TERMINAL).n;

    if (remaining === 0) {
      // all terminal → completed
      if (ph.status !== 'completed') {
        db.prepare(`UPDATE team_phases SET status = 'completed', started_at = COALESCE(started_at, ?), completed_at = ? WHERE id = ?`)
          .run(now, now, ph.id);
        db.prepare(
          `INSERT INTO team_decisions (id, team_id, agent_id, decision_type, summary, details_json, created_at)
           VALUES (?, ?, NULL, 'phase_transition', ?, ?, ?)`
        ).run(randomUUID(), teamId,
          `Phase "${ph.name}" completed (${total} task${total === 1 ? '' : 's'}).`,
          JSON.stringify({ phase_id: ph.id, from: 'active', to: 'completed', task_count: total, backfilled: true }),
          now);
        phasesCompleted++;
      }
    } else if (activeCnt > 0) {
      // some in progress → active
      if (ph.status === 'pending') {
        db.prepare(`UPDATE team_phases SET status = 'active', started_at = ? WHERE id = ?`).run(now, ph.id);
        db.prepare(
          `INSERT INTO team_decisions (id, team_id, agent_id, decision_type, summary, details_json, created_at)
           VALUES (?, ?, NULL, 'phase_transition', ?, ?, ?)`
        ).run(randomUUID(), teamId,
          `Phase "${ph.name}" started.`,
          JSON.stringify({ phase_id: ph.id, from: 'pending', to: 'active', backfilled: true }),
          now);
        phasesActivated++;
      }
    }
  }
}

console.log(`Activated ${phasesActivated} phases, completed ${phasesCompleted} phases.`);
db.close();
