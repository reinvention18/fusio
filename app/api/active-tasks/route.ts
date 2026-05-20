import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../../lib/memory-db';

// SQLite-backed replacement for data/active-tasks.json (Phase 1 of the
// Constellation refactor, resolves hidden coupling #4 — JSON file write
// races under parallel agents). The REST shape is preserved exactly so
// ChatPanel.tsx's fetch calls keep working unchanged.

interface ActiveTaskItem {
  id: string;
  text: string;
  priority: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  result?: string;
}

interface ActiveTask {
  id: string;
  sessionKey: string;
  prompt: string;
  filePath?: string;
  status: 'loading' | 'clarifying' | 'running' | 'paused' | 'completed' | 'failed';
  items: ActiveTaskItem[];
  currentItemIndex: number;
  output: string;
  questions?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

interface ActiveTaskRow {
  id: string;
  session_key: string;
  prompt: string;
  file_path: string | null;
  status: string;
  current_item_idx: number;
  output: string;
  questions: string | null;
  error: string | null;
  items_json: string;
  order_index: number;
  promoted_team_id: string | null;
  started_at: number;
  completed_at: number | null;
  updated_at: number;
}

interface SessionMetaRow {
  session_key: string;
  current_task_id: string | null;
  is_minimized: number;
  updated_at: number;
}

function rowToTask(r: ActiveTaskRow): ActiveTask {
  return {
    id: r.id,
    sessionKey: r.session_key,
    prompt: r.prompt,
    filePath: r.file_path ?? undefined,
    status: r.status as ActiveTask['status'],
    items: JSON.parse(r.items_json || '[]') as ActiveTaskItem[],
    currentItemIndex: r.current_item_idx,
    output: r.output,
    questions: r.questions ?? undefined,
    error: r.error ?? undefined,
    startedAt: new Date(r.started_at).toISOString(),
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : undefined,
  };
}

function parseTs(iso: string | undefined, fallback: number): number {
  if (!iso) return fallback;
  const n = Date.parse(iso);
  return isNaN(n) ? fallback : n;
}

// ─── One-shot legacy JSON migration ──────────────────────────────────────
let legacyMigrationDone = false;
function migrateLegacyJsonIfPresent() {
  if (legacyMigrationDone) return;
  legacyMigrationDone = true;
  const LEGACY = path.join(process.cwd(), 'data', 'active-tasks.json');
  if (!fs.existsSync(LEGACY)) return;
  try {
    const raw = fs.readFileSync(LEGACY, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const db = getDb();
    const now = Date.now();
    const upsertTask = db.prepare(
      `INSERT OR REPLACE INTO active_tasks (
        id, session_key, prompt, file_path, status, current_item_idx,
        output, questions, error, items_json, order_index,
        started_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const upsertMeta = db.prepare(
      `INSERT OR REPLACE INTO active_task_session_meta (session_key, current_task_id, is_minimized, updated_at)
       VALUES (?, ?, ?, ?)`
    );
    const run = db.transaction(() => {
      let orderIdx = 0;
      for (const [sid, data] of Object.entries(parsed)) {
        const sessionData: { tasks?: ActiveTask[]; currentTaskId?: string; isMinimized?: boolean } =
          Array.isArray(data) ? { tasks: data as ActiveTask[] } : (data as Record<string, unknown> as { tasks?: ActiveTask[]; currentTaskId?: string; isMinimized?: boolean });
        const tasks = sessionData.tasks ?? [];
        for (const t of tasks) {
          upsertTask.run(
            t.id,
            sid,
            t.prompt ?? '',
            t.filePath ?? null,
            t.status ?? 'loading',
            t.currentItemIndex ?? 0,
            t.output ?? '',
            t.questions ?? null,
            t.error ?? null,
            JSON.stringify(t.items ?? []),
            orderIdx++,
            parseTs(t.startedAt, now),
            t.completedAt ? parseTs(t.completedAt, now) : null,
            now,
          );
        }
        upsertMeta.run(sid, sessionData.currentTaskId ?? null, sessionData.isMinimized ? 1 : 0, now);
      }
    });
    run();
    fs.renameSync(LEGACY, LEGACY + '.bak');
    console.log('[active-tasks] migrated legacy JSON to SQLite; renamed to .bak');
  } catch (e) {
    console.warn('[active-tasks] legacy JSON migration failed:', (e as Error).message);
  }
}

function getSessionData(sessionId: string) {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM active_tasks WHERE session_key = ? ORDER BY order_index ASC, started_at ASC`)
    .all(sessionId) as ActiveTaskRow[];
  const meta = db
    .prepare(`SELECT * FROM active_task_session_meta WHERE session_key = ?`)
    .get(sessionId) as SessionMetaRow | undefined;
  return {
    tasks: rows.map(rowToTask),
    currentTaskId: meta?.current_task_id ?? null,
    isMinimized: meta?.is_minimized === 1,
  };
}

// GET /api/active-tasks?sessionId=xxx - Get tasks for a session
// GET /api/active-tasks?activeOnly=true - Get all active tasks across sessions
// GET /api/active-tasks - Get all
export async function GET(request: Request) {
  try {
    migrateLegacyJsonIfPresent();
    const db = getDb();
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    const activeOnly = searchParams.get('activeOnly') === 'true';

    if (sessionId) {
      const data = getSessionData(sessionId);
      return NextResponse.json(data);
    }

    if (activeOnly) {
      const rows = db
        .prepare(
          `SELECT * FROM active_tasks
            WHERE status IN ('running','paused','loading','clarifying')
            ORDER BY started_at DESC`,
        )
        .all() as ActiveTaskRow[];
      return NextResponse.json({
        activeTasks: rows.map(r => ({ sessionId: r.session_key, task: rowToTask(r) })),
      });
    }

    // Full dump — group by session_key
    const rows = db
      .prepare(`SELECT * FROM active_tasks ORDER BY session_key, order_index ASC`)
      .all() as ActiveTaskRow[];
    const metas = db
      .prepare(`SELECT * FROM active_task_session_meta`)
      .all() as SessionMetaRow[];
    const metaMap = new Map(metas.map(m => [m.session_key, m]));
    const allTasks: Record<string, { tasks: ActiveTask[]; currentTaskId: string | null; isMinimized: boolean }> = {};
    for (const r of rows) {
      if (!allTasks[r.session_key]) {
        const meta = metaMap.get(r.session_key);
        allTasks[r.session_key] = {
          tasks: [],
          currentTaskId: meta?.current_task_id ?? null,
          isMinimized: meta?.is_minimized === 1,
        };
      }
      allTasks[r.session_key].tasks.push(rowToTask(r));
    }
    return NextResponse.json({ allTasks });
  } catch (error) {
    console.error('[API] Failed to load active tasks:', error);
    return NextResponse.json({ error: 'Failed to load tasks' }, { status: 500 });
  }
}

// POST /api/active-tasks - Save tasks for a session (full replace)
export async function POST(request: Request) {
  try {
    migrateLegacyJsonIfPresent();
    const body = await request.json();
    const { sessionId, tasks, currentTaskId, isMinimized } = body as {
      sessionId?: string;
      tasks?: ActiveTask[];
      currentTaskId?: string | null;
      isMinimized?: boolean;
    };

    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
    }

    const db = getDb();
    const now = Date.now();
    const list = tasks ?? [];

    db.transaction(() => {
      // Delete existing tasks for this session and rewrite in new order.
      db.prepare(`DELETE FROM active_tasks WHERE session_key = ?`).run(sessionId);

      // If the session has no tasks and no currentTaskId, also clear its meta
      // row (matches old "cleanup empty sessions" behavior at line 133).
      if (list.length === 0 && !currentTaskId) {
        db.prepare(`DELETE FROM active_task_session_meta WHERE session_key = ?`).run(sessionId);
        return;
      }

      const ins = db.prepare(
        `INSERT INTO active_tasks (
          id, session_key, prompt, file_path, status, current_item_idx,
          output, questions, error, items_json, order_index,
          started_at, completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      list.forEach((t, idx) => {
        ins.run(
          t.id,
          sessionId,
          t.prompt ?? '',
          t.filePath ?? null,
          t.status ?? 'loading',
          t.currentItemIndex ?? 0,
          t.output ?? '',
          t.questions ?? null,
          t.error ?? null,
          JSON.stringify(t.items ?? []),
          idx,
          parseTs(t.startedAt, now),
          t.completedAt ? parseTs(t.completedAt, now) : null,
          now,
        );
      });

      db.prepare(
        `INSERT OR REPLACE INTO active_task_session_meta
           (session_key, current_task_id, is_minimized, updated_at)
         VALUES (?, ?, ?, ?)`
      ).run(sessionId, currentTaskId ?? null, isMinimized ? 1 : 0, now);
    })();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API] Failed to save active tasks:', error);
    return NextResponse.json({ error: 'Failed to save tasks' }, { status: 500 });
  }
}

// PATCH /api/active-tasks - Update a single task
export async function PATCH(request: Request) {
  try {
    migrateLegacyJsonIfPresent();
    const body = await request.json();
    const { sessionId, taskId, updates } = body as {
      sessionId?: string;
      taskId?: string;
      updates?: Partial<ActiveTask>;
    };

    if (!sessionId || !taskId) {
      return NextResponse.json({ error: 'sessionId and taskId required' }, { status: 400 });
    }

    const db = getDb();
    const row = db
      .prepare(`SELECT * FROM active_tasks WHERE id = ? AND session_key = ?`)
      .get(taskId, sessionId) as ActiveTaskRow | undefined;
    if (!row) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const patch = updates ?? {};
    const merged: ActiveTaskRow = {
      ...row,
      prompt: patch.prompt ?? row.prompt,
      file_path: patch.filePath !== undefined ? (patch.filePath ?? null) : row.file_path,
      status: patch.status ?? row.status,
      current_item_idx: patch.currentItemIndex ?? row.current_item_idx,
      output: patch.output ?? row.output,
      questions: patch.questions !== undefined ? (patch.questions ?? null) : row.questions,
      error: patch.error !== undefined ? (patch.error ?? null) : row.error,
      items_json: patch.items ? JSON.stringify(patch.items) : row.items_json,
      completed_at: patch.completedAt ? parseTs(patch.completedAt, Date.now()) : row.completed_at,
      updated_at: Date.now(),
    };

    db.prepare(
      `UPDATE active_tasks
          SET prompt = ?, file_path = ?, status = ?, current_item_idx = ?,
              output = ?, questions = ?, error = ?, items_json = ?,
              completed_at = ?, updated_at = ?
        WHERE id = ? AND session_key = ?`
    ).run(
      merged.prompt,
      merged.file_path,
      merged.status,
      merged.current_item_idx,
      merged.output,
      merged.questions,
      merged.error,
      merged.items_json,
      merged.completed_at,
      merged.updated_at,
      taskId,
      sessionId,
    );

    return NextResponse.json({ success: true, task: rowToTask(merged) });
  } catch (error) {
    console.error('[API] Failed to update task:', error);
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}
