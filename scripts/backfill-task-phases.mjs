#!/usr/bin/env node
// Backfill task.phase for existing teams based on role_hint matching phase.roles_json.
import Database from 'better-sqlite3';
import { join } from 'node:path';

const db = new Database(join(process.cwd(), 'data', 'memory.db'));

const teams = db.prepare(
  `SELECT id FROM teams WHERE archived_at IS NULL AND status IN ('idle','planning','running','paused')`
).all();

let updated = 0;
for (const { id: teamId } of teams) {
  const phases = db.prepare('SELECT id, roles_json FROM team_phases WHERE team_id = ? ORDER BY ordering ASC').all(teamId);
  if (phases.length === 0) continue;

  const roleToPhase = {};
  for (const ph of phases) {
    try {
      const roles = JSON.parse(ph.roles_json || '[]');
      for (const r of roles) if (!roleToPhase[r]) roleToPhase[r] = ph.id;
    } catch {}
  }

  const tasks = db.prepare('SELECT id, role_hint, phase FROM team_tasks WHERE team_id = ? AND phase IS NULL').all(teamId);
  const setPhase = db.prepare('UPDATE team_tasks SET phase = ? WHERE id = ?');
  for (const t of tasks) {
    if (!t.role_hint) continue;
    const ph = roleToPhase[t.role_hint];
    if (ph) {
      setPhase.run(ph, t.id);
      updated++;
    }
  }
}

console.log(`Updated ${updated} task.phase values across ${teams.length} teams.`);
db.close();
