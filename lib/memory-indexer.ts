import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { getDb, type DB } from './memory-db';
import { embedText, vectorToBuffer } from './memory-embed';
import { summarizeNextEpisode } from './memory-episodes';

const EMBEDDING_MODEL_TAG = 'all-MiniLM-L6-v2';
const EPISODE_WINDOW = 20;

export interface IndexResult {
  chatId: string;
  indexed: number;
  lastTurn: number;
  durationMs: number;
}

const IDLE_COMMIT_MS = 30_000;
const PUMP_STALE_MS = 60_000;
const inFlight = new Map<string, Promise<IndexResult>>();

function sessionsFilePath(): string {
  return path.join(process.cwd(), 'data', 'claude-code-sessions.json');
}

function readSessionMap(): Record<string, string> {
  try {
    const raw = fs.readFileSync(sessionsFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
  } catch {
    // ignore
  }
  return {};
}

function locateJsonlFile(claudeSessionId: string): string | null {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(projectsRoot);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = path.join(projectsRoot, dir, `${claudeSessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isHumanTurnStart(entry: any): boolean {
  if (entry?.type !== 'user') return false;
  if (!entry.message) return false;
  if (entry.isSidechain === true) return false;
  const content = entry.message.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object' && b.type === 'tool_result') return false;
    }
    return true;
  }
  return false;
}

function extractUserText(firstEntry: any): string {
  const content = firstEntry?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function extractAssistantAndThinking(buffer: any[]): {
  assistantText: string;
  thinkingText: string;
} {
  const assistantParts: string[] = [];
  const thinkingParts: string[] = [];
  for (const entry of buffer) {
    if (entry?.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        assistantParts.push(b.text);
      } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
        thinkingParts.push(b.thinking);
      }
    }
  }
  return {
    assistantText: assistantParts.join('\n\n'),
    thinkingText: thinkingParts.join('\n\n'),
  };
}

function basename(p: unknown): string {
  if (typeof p !== 'string') return '?';
  try {
    return path.basename(p);
  } catch {
    return '?';
  }
}

function summarizeToolUses(buffer: any[]): {
  toolSummary: string;
  filesTouched: string[];
  toolsUsed: string[];
} {
  const summaryEntries: string[] = [];
  const files = new Set<string>();
  const tools = new Set<string>();

  for (const entry of buffer) {
    if (entry?.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object' || b.type !== 'tool_use') continue;
      const name: string = typeof b.name === 'string' ? b.name : 'unknown';
      const input = b.input ?? {};
      tools.add(name);

      let summary: string;
      switch (name) {
        case 'Read':
        case 'Edit':
        case 'Write': {
          if (typeof input.file_path === 'string') files.add(input.file_path);
          summary = `${name}(${basename(input.file_path)})`;
          break;
        }
        case 'NotebookEdit': {
          if (typeof input.notebook_path === 'string') files.add(input.notebook_path);
          summary = `NotebookEdit(${basename(input.notebook_path)})`;
          break;
        }
        case 'Grep': {
          const pat = typeof input.pattern === 'string' ? input.pattern : '';
          summary = `Grep("${pat.slice(0, 40)}")`;
          break;
        }
        case 'Glob': {
          const pat = typeof input.pattern === 'string' ? input.pattern : '';
          summary = `Glob("${pat.slice(0, 40)}")`;
          break;
        }
        case 'Bash': {
          const desc = (input.description ?? input.command ?? '') as string;
          summary = `Bash("${String(desc).slice(0, 40)}")`;
          break;
        }
        case 'Task':
        case 'Agent': {
          const subagent = input.subagent_type ?? '?';
          const desc = (input.description ?? '') as string;
          summary = `Task(${subagent}: ${String(desc).slice(0, 40)})`;
          break;
        }
        case 'WebFetch': {
          let host = '?';
          try {
            if (typeof input.url === 'string') host = new URL(input.url).hostname;
          } catch {
            host = '?';
          }
          summary = `WebFetch(${host})`;
          break;
        }
        case 'WebSearch': {
          const q = typeof input.query === 'string' ? input.query : '';
          summary = `WebSearch("${q.slice(0, 40)}")`;
          break;
        }
        case 'TodoWrite': {
          const n = Array.isArray(input.todos) ? input.todos.length : 0;
          summary = `TodoWrite(${n} items)`;
          break;
        }
        default: {
          summary = `${name}(…)`;
          break;
        }
      }
      summaryEntries.push(summary);
    }
  }

  const filesSorted = Array.from(files).sort();
  const toolsSorted = Array.from(tools).sort();
  let toolSummary = summaryEntries.join(', ');
  if (toolSummary.length > 500) toolSummary = toolSummary.slice(0, 500);

  return {
    toolSummary,
    filesTouched: filesSorted,
    toolsUsed: toolsSorted,
  };
}

function commitTurn(
  db: DB,
  chatId: string,
  claudeSessionId: string,
  buffer: any[],
  endByteOffset: number
): number {
  const first = buffer[0];
  const last = buffer[buffer.length - 1];
  const tsStart = Date.parse(first?.timestamp ?? '') || Date.now();
  const tsEnd = Date.parse(last?.timestamp ?? '') || tsStart;

  const userText = extractUserText(first);
  const { assistantText, thinkingText } = extractAssistantAndThinking(buffer);
  const { toolSummary, filesTouched, toolsUsed } = summarizeToolUses(buffer);

  const contentText =
    `USER: ${userText}\n\n` +
    `ASSISTANT: ${assistantText}\n\n` +
    `TOOLS: ${toolSummary}\n\n` +
    `FILES: ${filesTouched.join(' ')}\n\n` +
    `THINKING: ${thinkingText}`;

  const tokenCount = Math.ceil(contentText.length / 3.8);

  const tx = db.transaction(() => {
    const row = db
      .prepare(
        'SELECT COALESCE(MAX(turn_index), -1) + 1 AS n FROM turns WHERE chat_id = ?'
      )
      .get(chatId) as { n: number };
    const turnIndex = row.n;

    db.prepare('DELETE FROM turns WHERE chat_id = ? AND turn_index = ?').run(
      chatId,
      turnIndex
    );
    db.prepare(
      `INSERT INTO turns (chat_id, claude_session_id, turn_index, ts_start, ts_end, user_text, assistant_text, thinking_text, tool_summary, content_text, token_count, files_touched, tools_used, indexed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      chatId,
      claudeSessionId,
      turnIndex,
      tsStart,
      tsEnd,
      userText,
      assistantText,
      thinkingText,
      toolSummary,
      contentText,
      tokenCount,
      JSON.stringify(filesTouched),
      JSON.stringify(toolsUsed),
      Date.now()
    );
    db.prepare(
      'UPDATE index_state SET last_indexed_turn = ?, last_jsonl_line_offset = ?, claude_session_id = ? WHERE chat_id = ?'
    ).run(turnIndex, endByteOffset, claudeSessionId, chatId);
    return turnIndex;
  });

  return tx() as number;
}

function getIndexState(
  db: DB,
  chatId: string
):
  | {
      chat_id: string;
      claude_session_id: string;
      last_indexed_turn: number;
      last_episode_end_turn: number;
      last_jsonl_line_offset: number;
      last_run_at: number | null;
      last_error: string | null;
      last_error_at: number | null;
      disabled: number;
    }
  | undefined {
  return db
    .prepare('SELECT * FROM index_state WHERE chat_id = ?')
    .get(chatId) as any;
}

function ensureIndexState(db: DB, chatId: string, claudeSessionId: string) {
  const existing = getIndexState(db, chatId);
  if (existing) return existing;
  db.prepare(
    `INSERT INTO index_state (chat_id, claude_session_id, last_indexed_turn, last_episode_end_turn, last_jsonl_line_offset, last_run_at, last_error, last_error_at, disabled)
     VALUES (?, ?, -1, -1, 0, NULL, NULL, NULL, 0)`
  ).run(chatId, claudeSessionId);
  return getIndexState(db, chatId)!;
}

async function _indexChatIncremental(chatId: string): Promise<IndexResult> {
  const start = Date.now();
  const db = getDb();

  const sessionMap = readSessionMap();
  const claudeSessionId = sessionMap[chatId];
  if (!claudeSessionId) {
    return { chatId, indexed: 0, lastTurn: -1, durationMs: Date.now() - start };
  }

  const jsonlFile = locateJsonlFile(claudeSessionId);
  if (!jsonlFile) {
    // Still ensure state row exists so pump tracking works
    ensureIndexState(db, chatId, claudeSessionId);
    return { chatId, indexed: 0, lastTurn: -1, durationMs: Date.now() - start };
  }

  let state = ensureIndexState(db, chatId, claudeSessionId);
  if (state.disabled === 1) {
    return {
      chatId,
      indexed: 0,
      lastTurn: state.last_indexed_turn,
      durationMs: Date.now() - start,
    };
  }

  let indexedCount = 0;
  let lastTurn = state.last_indexed_turn;
  const pendingEmbeds: number[] = [];

  try {
    const stat = fs.statSync(jsonlFile);
    let offset = state.last_jsonl_line_offset;
    if (stat.size < offset) {
      offset = 0;
    }

    if (stat.size > offset) {
      const stream = fs.createReadStream(jsonlFile, { start: offset });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      let currentOffset = offset;
      let currentBuffer: any[] = [];
      let currentBufferStartOffset = offset;
      let currentBufferEndOffset = offset;

      for await (const line of rl) {
        const lineStartOffset = currentOffset;
        const lineByteLen = Buffer.byteLength(line, 'utf8') + 1; // +1 for \n
        currentOffset += lineByteLen;

        if (!line) continue;

        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        if (isHumanTurnStart(entry)) {
          if (currentBuffer.length > 0) {
            const turnIdx = commitTurn(
              db,
              chatId,
              claudeSessionId,
              currentBuffer,
              currentBufferEndOffset
            );
            indexedCount += 1;
            lastTurn = turnIdx;
            pendingEmbeds.push(turnIdx);
          }
          currentBuffer = [entry];
          currentBufferStartOffset = lineStartOffset;
          currentBufferEndOffset = currentOffset;
        } else if (currentBuffer.length > 0) {
          currentBuffer.push(entry);
          currentBufferEndOffset = currentOffset;
        }
        // else: skip (pre-first-turn / orphan)
      }

      // Handle trailing buffer with idle-30s guard
      if (currentBuffer.length > 0) {
        const lastEntry = currentBuffer[currentBuffer.length - 1];
        const lastTs = Date.parse(lastEntry?.timestamp ?? '') || 0;
        if (lastTs && Date.now() - lastTs >= IDLE_COMMIT_MS) {
          const turnIdx = commitTurn(
            db,
            chatId,
            claudeSessionId,
            currentBuffer,
            currentBufferEndOffset
          );
          indexedCount += 1;
          lastTurn = turnIdx;
          pendingEmbeds.push(turnIdx);
        } else {
          db.prepare(
            'UPDATE index_state SET last_jsonl_line_offset = ? WHERE chat_id = ?'
          ).run(currentBufferStartOffset, chatId);
        }
      }
    }

    db.prepare(
      'UPDATE index_state SET last_run_at = ?, last_error = NULL, last_error_at = NULL WHERE chat_id = ?'
    ).run(Date.now(), chatId);

    // Embed pending turns serially (non-fatal on failure)
    for (const turnIndex of pendingEmbeds) {
      try {
        const row = db
          .prepare(
            'SELECT id, content_text FROM turns WHERE chat_id = ? AND turn_index = ?'
          )
          .get(chatId, turnIndex) as
          | { id: number; content_text: string }
          | undefined;
        if (!row) continue;
        const vec = await embedText(row.content_text);
        db.prepare(
          'UPDATE turns SET embedding = ?, embedding_model = ? WHERE id = ?'
        ).run(vectorToBuffer(vec), EMBEDDING_MODEL_TAG, row.id);
      } catch (e) {
        console.error('[Memory indexer] embed failed for turn', turnIndex, e);
        // Non-fatal: BM25 still works without embedding
      }
    }

    // Re-read lastTurn from DB to ensure accuracy
    const fresh = getIndexState(db, chatId);
    if (fresh) lastTurn = fresh.last_indexed_turn;

    // Episode trigger — fire-and-forget if window of >= EPISODE_WINDOW pending
    try {
      const stateAfter = getIndexState(db, chatId);
      if (
        stateAfter &&
        stateAfter.last_indexed_turn - stateAfter.last_episode_end_turn >= EPISODE_WINDOW
      ) {
        summarizeNextEpisode(chatId).catch((e) =>
          console.error('[Memory] summarizeNextEpisode failed:', e)
        );
      }
    } catch (e) {
      console.error('[Memory] episode trigger check failed:', e);
    }

    return { chatId, indexed: indexedCount, lastTurn, durationMs: Date.now() - start };
  } catch (err) {
    try {
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      db.prepare(
        'UPDATE index_state SET last_error = ?, last_error_at = ? WHERE chat_id = ?'
      ).run(msg.slice(0, 2000), Date.now(), chatId);
    } catch {
      // ignore
    }
    const fresh = getIndexState(db, chatId);
    return {
      chatId,
      indexed: indexedCount,
      lastTurn: fresh?.last_indexed_turn ?? lastTurn,
      durationMs: Date.now() - start,
    };
  }
}

export async function indexChatIncremental(chatId: string): Promise<IndexResult> {
  const existing = inFlight.get(chatId);
  if (existing) return existing;
  const p = _indexChatIncremental(chatId).finally(() => {
    inFlight.delete(chatId);
  });
  inFlight.set(chatId, p);
  return p;
}

export async function reindexChatFull(chatId: string): Promise<IndexResult> {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM turns WHERE chat_id = ?').run(chatId);
    db.prepare('DELETE FROM episodes WHERE chat_id = ?').run(chatId);
    db.prepare(
      `UPDATE index_state
         SET last_indexed_turn = -1,
             last_episode_end_turn = -1,
             last_jsonl_line_offset = 0,
             last_error = NULL,
             last_error_at = NULL
         WHERE chat_id = ?`
    ).run(chatId);
  });
  tx();
  return indexChatIncremental(chatId);
}

export async function reembedChat(
  chatId: string
): Promise<{ chatId: string; embedded: number; durationMs: number }> {
  const start = Date.now();
  const db = getDb();
  let embedded = 0;
  const rows = db
    .prepare(
      'SELECT id, content_text FROM turns WHERE chat_id = ? ORDER BY turn_index'
    )
    .all(chatId) as Array<{ id: number; content_text: string }>;
  const upd = db.prepare(
    'UPDATE turns SET embedding = ?, embedding_model = ? WHERE id = ?'
  );
  for (const row of rows) {
    try {
      const vec = await embedText(row.content_text || '');
      upd.run(vectorToBuffer(vec), EMBEDDING_MODEL_TAG, row.id);
      embedded += 1;
    } catch (e) {
      console.error('[Memory indexer] reembed failed for id', row.id, e);
    }
  }
  return { chatId, embedded, durationMs: Date.now() - start };
}

export async function pumpAllChats(): Promise<{
  pumped: number;
  results: IndexResult[];
}> {
  const db = getDb();
  const sessionMap = readSessionMap();
  const results: IndexResult[] = [];
  const now = Date.now();

  for (const [chatId, claudeSessionId] of Object.entries(sessionMap)) {
    const jsonlFile = locateJsonlFile(claudeSessionId);
    if (!jsonlFile) continue;

    let mtime = 0;
    try {
      mtime = fs.statSync(jsonlFile).mtimeMs;
    } catch {
      continue;
    }

    const state = getIndexState(db, chatId);
    const lastRunAt = state?.last_run_at ?? null;

    const shouldPump =
      !state ||
      lastRunAt == null ||
      mtime > lastRunAt ||
      now - lastRunAt > PUMP_STALE_MS;

    if (!shouldPump) continue;

    try {
      const r = await indexChatIncremental(chatId);
      results.push(r);
    } catch {
      // swallow; indexChatIncremental already handles errors internally
    }
  }

  return { pumped: results.length, results };
}
