/**
 * edit-log — append-only JSONL capturing every file edit the agent makes,
 * for cross-machine awareness. Both machines log locally; peer logs are
 * exposed via /api/edits/recent + the mc_edits MCP tool.
 *
 * Capture semantics: collect tool_use blocks for Edit/Write/MultiEdit/
 * NotebookEdit during a turn, but only commit them at end-of-turn so we
 * miss the agent's mid-turn iterations and only log final state. Each
 * edit gets a 1-sentence agent-style summary derived from the input
 * (no extra LLM call — uses the diff data the tool already provides).
 *
 * Storage:  data/edit-log.jsonl   (append-only; oldest entries trimmed
 *                                   when file > MAX_LOG_BYTES)
 *
 * Reader:   listRecentEdits({since, file?, limit, host?})
 */

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { loadRemoteConfig } from './remote/config';

const LOG_FILE = path.join(process.cwd(), 'data', 'edit-log.jsonl');
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB rolling file
const TRIM_TARGET_BYTES = 3 * 1024 * 1024; // when over max, trim oldest until ≤ this

export interface EditLogEntry {
  /** millis since epoch */
  ts: number;
  /** human label of the local machine, from mc-remote-hosts.json */
  host: string;
  /** opaque chat session key, if known */
  sessionKey?: string;
  /** chatId from /api/chat, if known */
  chatId?: string;
  /** subagent_type if this came from a Task call, else 'parent' */
  agent: string;
  /** Edit | Write | MultiEdit | NotebookEdit */
  op: string;
  /** absolute file path */
  file: string;
  /** lines added / removed (rough — based on input shape) */
  linesAdded?: number;
  linesRemoved?: number;
  /** 1-sentence summary derived from the tool input */
  summary: string;
  /** brief preview of the change (first 200 chars of new text) */
  preview?: string;
}

interface ToolInputShape {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
  edits?: Array<{ old_string?: string; new_string?: string }>;
  notebook_path?: string;
  cell_id?: string;
  new_source?: string;
}

const RELEVANT_OPS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function lineCount(s: string | undefined): number {
  if (!s) return 0;
  return s.split('\n').length;
}

function summarize(op: string, input: ToolInputShape): string {
  const file = input.file_path || input.notebook_path || '?';
  const base = path.basename(file);
  if (op === 'Write') {
    const lines = lineCount(input.content);
    return `wrote ${base} (${lines} lines)`;
  }
  if (op === 'Edit') {
    const oldLines = lineCount(input.old_string);
    const newLines = lineCount(input.new_string);
    const oldFirst = (input.old_string || '').split('\n')[0]?.trim().slice(0, 60);
    if (newLines > oldLines) {
      return `edited ${base}: replaced ${oldLines}-line block "${oldFirst}…" with ${newLines} lines`;
    }
    if (newLines < oldLines) {
      return `edited ${base}: removed ${oldLines - newLines} lines from "${oldFirst}…"`;
    }
    return `edited ${base}: changed ${oldLines}-line block at "${oldFirst}…"`;
  }
  if (op === 'MultiEdit') {
    const n = (input.edits || []).length;
    return `edited ${base}: ${n} block${n === 1 ? '' : 's'}`;
  }
  if (op === 'NotebookEdit') {
    return `edited notebook ${base} (cell ${input.cell_id || '?'})`;
  }
  return `${op} ${base}`;
}

function lineStats(op: string, input: ToolInputShape): { added: number; removed: number } {
  if (op === 'Write') return { added: lineCount(input.content), removed: 0 };
  if (op === 'Edit') {
    return { added: lineCount(input.new_string), removed: lineCount(input.old_string) };
  }
  if (op === 'MultiEdit') {
    let a = 0, r = 0;
    for (const e of input.edits || []) {
      a += lineCount(e.new_string);
      r += lineCount(e.old_string);
    }
    return { added: a, removed: r };
  }
  if (op === 'NotebookEdit') return { added: lineCount(input.new_source), removed: 0 };
  return { added: 0, removed: 0 };
}

function preview(op: string, input: ToolInputShape): string | undefined {
  if (op === 'Write') return (input.content || '').slice(0, 200);
  if (op === 'Edit') return (input.new_string || '').slice(0, 200);
  if (op === 'MultiEdit') return (input.edits || []).map(e => e.new_string || '').join('\n').slice(0, 200);
  return undefined;
}

function ensureLogDir() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function trimIfOversized() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size <= MAX_LOG_BYTES) return;
    // Read whole file, drop the oldest lines until under TRIM_TARGET_BYTES.
    const raw = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    let kept = lines;
    while (kept.length > 100) {
      const sample = kept.slice(-Math.max(1, Math.floor(kept.length * 0.7)));
      if (sample.join('\n').length <= TRIM_TARGET_BYTES) {
        kept = sample;
        break;
      }
      kept = kept.slice(Math.floor(kept.length * 0.3));
    }
    fs.writeFileSync(LOG_FILE, kept.join('\n') + '\n');
    console.log('[edit-log] trimmed: %d → %d lines', lines.length, kept.length);
  } catch {/* ignore */}
}

/**
 * Append a single edit. Buffer multiple Edits to the same file within a turn
 * to dedupe — only the LATEST is logged (reflecting end-of-turn state).
 */
const turnBuffers = new Map<string, EditLogEntry[]>(); // chatId → entries

export function bufferEdit(opts: {
  chatId?: string;
  sessionKey?: string;
  agent?: string;
  op: string;
  input: ToolInputShape;
}): void {
  if (!RELEVANT_OPS.has(opts.op)) return;
  const file = opts.input.file_path || opts.input.notebook_path;
  if (!file) return;

  const cfg = loadRemoteConfig();
  const stats = lineStats(opts.op, opts.input);
  const entry: EditLogEntry = {
    ts: Date.now(),
    host: cfg?.myLabel || 'local',
    sessionKey: opts.sessionKey,
    chatId: opts.chatId,
    agent: opts.agent || 'parent',
    op: opts.op,
    file,
    linesAdded: stats.added,
    linesRemoved: stats.removed,
    summary: summarize(opts.op, opts.input),
    preview: preview(opts.op, opts.input),
  };

  const key = opts.chatId || 'no-chat';
  let buf = turnBuffers.get(key);
  if (!buf) { buf = []; turnBuffers.set(key, buf); }
  // Dedupe by file path — keep only the LATEST edit per file in this turn.
  const idx = buf.findIndex(e => e.file === file);
  if (idx >= 0) buf[idx] = entry;
  else buf.push(entry);
}

/**
 * Flush all buffered edits for a chat to disk. Called at end-of-turn.
 */
export function flushTurn(chatId?: string): EditLogEntry[] {
  const key = chatId || 'no-chat';
  const buf = turnBuffers.get(key);
  if (!buf || buf.length === 0) return [];
  turnBuffers.delete(key);

  ensureLogDir();
  try {
    const lines = buf.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(LOG_FILE, lines);
    trimIfOversized();
  } catch (e) {
    console.warn('[edit-log] flush failed:', (e as Error).message);
  }
  return buf;
}

/**
 * Read recent edits, optionally filtered. Returns newest-first.
 */
export function listRecentEdits(opts: {
  since?: number;
  file?: string;
  limit?: number;
} = {}): EditLogEntry[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  const limit = opts.limit ?? 50;
  const since = opts.since ?? 0;
  const out: EditLogEntry[] = [];
  // Read tail efficiently — for a 5MB file this is fine to read whole.
  const raw = fs.readFileSync(LOG_FILE, 'utf-8');
  const lines = raw.split('\n');
  // Walk backward newest-first
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const ln = lines[i];
    if (!ln) continue;
    try {
      const e = JSON.parse(ln) as EditLogEntry;
      if (e.ts < since) break; // older than 'since', and lines are time-ordered (mostly)
      if (opts.file && e.file !== opts.file) continue;
      out.push(e);
    } catch {/* skip malformed */}
  }
  return out;
}
