#!/usr/bin/env node
// One-time backfill: for every running/planning/idle team that has no phases,
// look up its preset in data/team-presets.json and create team_phases rows.
// Also adds a team_composition decision if none exists.

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const dbPath = join(process.cwd(), 'data', 'memory.db');
const presetsPath = join(process.cwd(), 'data', 'team-presets.json');

const db = new Database(dbPath);
const presets = JSON.parse(readFileSync(presetsPath, 'utf-8'));

const teams = db.prepare(
  `SELECT id, name, constellation, preset, status FROM teams
    WHERE archived_at IS NULL AND status IN ('idle','planning','running','paused')`
).all();

let phasesAdded = 0;
let decisionsAdded = 0;

for (const team of teams) {
  const preset = presets.find(p => p.id === team.preset);
  if (!preset) {
    console.log(`[skip] team ${team.id.slice(0, 8)} (${team.constellation || team.name}) — preset "${team.preset}" not found`);
    continue;
  }

  // Check existing phases
  const existing = db.prepare('SELECT COUNT(*) AS n FROM team_phases WHERE team_id = ?').get(team.id).n;
  if (existing === 0 && Array.isArray(preset.phases)) {
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO team_phases (id, team_id, name, description, ordering, roles_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    );
    for (let i = 0; i < preset.phases.length; i++) {
      const ph = preset.phases[i];
      insert.run(randomUUID(), team.id, ph.name, ph.description ?? null, i, JSON.stringify(ph.roles ?? []), now);
      phasesAdded++;
    }
    console.log(`[backfill] team ${team.id.slice(0, 8)} (${team.constellation || team.name}) — added ${preset.phases.length} phases`);
  }

  // Check existing composition decision
  const hasComposition = db.prepare(
    `SELECT COUNT(*) AS n FROM team_decisions WHERE team_id = ? AND decision_type = 'team_composition'`
  ).get(team.id).n > 0;

  if (!hasComposition) {
    const roles = db.prepare('SELECT role, role_handle, model FROM team_agents WHERE team_id = ? ORDER BY created_at ASC')
      .all(team.id);
    db.prepare(
      `INSERT INTO team_decisions (id, team_id, agent_id, decision_type, summary, details_json, created_at)
       VALUES (?, ?, NULL, 'team_composition', ?, ?, ?)`
    ).run(
      randomUUID(),
      team.id,
      `Deployed ${preset.id} constellation with ${roles.length} agent${roles.length === 1 ? '' : 's'}${preset.phases ? ` across ${preset.phases.length} phase${preset.phases.length === 1 ? '' : 's'}` : ''}.`,
      JSON.stringify({
        preset: preset.id,
        roles: roles.map(r => ({ role: r.role, handle: r.role_handle, model: r.model })),
        phases: (preset.phases || []).map(p => ({ name: p.name, roles: p.roles })),
        backfilled: true,
      }),
      Date.now(),
    );
    decisionsAdded++;
  }
}

console.log(`\nDone. ${phasesAdded} phase rows, ${decisionsAdded} composition decisions added.`);
db.close();
