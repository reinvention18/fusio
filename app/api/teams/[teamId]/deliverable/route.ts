import { NextRequest, NextResponse } from 'next/server';
import {
  getTeam,
  getScratchpad,
  listTeamTasks,
  listTeamAgents,
} from '../../../../../lib/teams/schema';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';

/**
 * Extracts the "Final Deliverable" view for a team:
 *   - Parses the scratchpad for a `## Final Deliverable` (or similar) section
 *   - Falls back to the latest done scribe task's result_summary
 *   - Aggregates all done-task result summaries + files touched
 *   - Reports which phases are done / in flight
 */

const DELIVERABLE_HEADINGS = [
  /^##\s+final\s+deliverable/i,
  /^##\s+final\s+report/i,
  /^##\s+deliverable/i,
  /^##\s+summary/i,
  /^##\s+mission\s+summary/i,
];

function extractScratchpadSection(content: string): string | null {
  if (!content) return null;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (DELIVERABLE_HEADINGS.some(re => re.test(lines[i]))) {
      const out: string[] = [lines[i]];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^##\s+/.test(lines[j])) break; // next section
        out.push(lines[j]);
      }
      return out.join('\n').trim();
    }
  }
  return null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  const team = getTeam(teamId);
  if (!team) return NextResponse.json({ error: 'Team not found' }, { status: 404 });

  const scratchpad = getScratchpad(teamId);
  const tasks = listTeamTasks(teamId);
  const agents = listTeamAgents(teamId);

  const scribeAgents = new Set(agents.filter(a => a.role === 'scribe').map(a => a.id));

  const doneTasks = tasks
    .filter(t => t.status === 'done' || t.status === 'approved' || t.status === 'merging')
    .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));

  const scribeReport = doneTasks.find(t =>
    (t.assigned_agent_id && scribeAgents.has(t.assigned_agent_id)) ||
    t.role_hint === 'scribe',
  );

  let scratchpadSection = extractScratchpadSection(scratchpad.content);

  // Fallback: if scratchpad has no Final Deliverable section but a scribe
  // task (any status) wrote a .md report file, surface that. Handles two
  // common cases:
  //   1. Scribe wrote to a file (architect's task said "publish to claudecodeedits/...")
  //      but skipped the scratchpad write.
  //   2. Codex audit reverted the scribe task to needs_rework — the file is
  //      still there, we should still show it as the best-available deliverable.
  if (!scratchpadSection) {
    const allScribeTasks = tasks
      .filter(t => (t.assigned_agent_id && scribeAgents.has(t.assigned_agent_id)) || t.role_hint === 'scribe')
      .sort((a, b) => (b.completed_at ?? b.claimed_at ?? 0) - (a.completed_at ?? a.claimed_at ?? 0));
    const scribeAgent = agents.find(a => a.role === 'scribe');
    const worktree = scribeAgent?.worktree_path;
    for (const t of allScribeTasks) {
      if (scratchpadSection) break;
      let files: string[] = [];
      try { files = JSON.parse(t.files_touched || '[]'); } catch { continue; }
      const reportFiles = files.filter(f => /\.md$/i.test(f));
      for (const rel of reportFiles) {
        if (!worktree) break;
        const abs = path.isAbsolute(rel) ? rel : path.join(worktree, rel);
        if (!abs.startsWith(worktree)) continue; // path-traversal guard
        try {
          const stat = await fsp.stat(abs);
          if (!stat.isFile() || stat.size > 200_000) continue; // cap at 200KB
          scratchpadSection = await fsp.readFile(abs, 'utf-8');
          break;
        } catch { /* try next file */ }
      }
    }
  }

  // Aggregate files touched across all done tasks
  const filesSet = new Set<string>();
  for (const t of doneTasks) {
    try {
      const files: string[] = JSON.parse(t.files_touched || '[]');
      files.forEach(f => filesSet.add(f));
    } catch { /* ignore */ }
  }

  const totalTasks = tasks.length;
  const doneCount = doneTasks.length;
  const isComplete = team.status === 'completed' || team.status === 'done'
    || (totalTasks > 0 && doneCount === totalTasks);

  return NextResponse.json({
    status: team.status,
    is_complete: isComplete,
    goal: team.goal,
    preset: team.preset,
    scratchpad_section: scratchpadSection,
    scratchpad_full: scratchpad.content,
    scribe_report: scribeReport
      ? {
          task_id: scribeReport.id,
          title: scribeReport.title,
          summary: scribeReport.result_summary,
          completed_at: scribeReport.completed_at,
        }
      : null,
    tasks_summary: doneTasks.map(t => ({
      id: t.id,
      title: t.title,
      role_hint: t.role_hint,
      phase: t.phase,
      summary: t.result_summary,
      diff_numstat: t.diff_numstat,
      completed_at: t.completed_at,
    })),
    files_changed: Array.from(filesSet).sort(),
    totals: {
      total: totalTasks,
      done: doneCount,
      pending: tasks.filter(t => t.status === 'pending').length,
      in_progress: tasks.filter(t => ['claimed', 'in_progress'].includes(t.status)).length,
    },
  });
}
