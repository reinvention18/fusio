import 'server-only';
import { spawn } from 'node:child_process';
import { getDb } from './memory-db';

const EPISODE_PROMPT = `You are summarizing a window of recent turns from a coding-assistance conversation. Output STRICT JSON with keys "title", "summary", "key_decisions". Do not wrap in markdown fences.

Title: <80 chars, what this window of work was about (e.g., "Built check OCR for record payment screen").
Summary: 2-4 sentences. Concrete: what files changed, what problem was solved, what approach was taken. No fluff.
Key decisions: array of <=5 short strings, each a load-bearing decision made during this window.

Window:
---
{WINDOW_TEXT}
---

Respond with ONLY a JSON object. No prose, no explanation.`;

const inFlight = new Map<string, Promise<EpisodeResult>>();

export interface EpisodeResult {
  chatId: string;
  created: number;
  startTurn: number;
  endTurn: number;
  title?: string;
  error?: string;
}

export function summarizeNextEpisode(chatId: string): Promise<EpisodeResult> {
  const existing = inFlight.get(chatId);
  if (existing) return existing;
  const p = (async (): Promise<EpisodeResult> => {
    try {
      const db = getDb();
      const state = db
        .prepare(
          'SELECT last_indexed_turn, last_episode_end_turn FROM index_state WHERE chat_id = ?'
        )
        .get(chatId) as any;
      if (!state) {
        return { chatId, created: 0, startTurn: -1, endTurn: -1, error: 'no index_state' };
      }
      const startTurn = (state.last_episode_end_turn ?? -1) + 1;
      const endTurn = state.last_indexed_turn ?? -1;
      if (endTurn - startTurn < 4) {
        // Window too small — defer
        return { chatId, created: 0, startTurn, endTurn };
      }
      const turns = db
        .prepare(
          'SELECT turn_index, ts_start, content_text, files_touched FROM turns WHERE chat_id = ? AND turn_index BETWEEN ? AND ? ORDER BY turn_index'
        )
        .all(chatId, startTurn, endTurn) as any[];
      if (turns.length === 0) {
        return { chatId, created: 0, startTurn, endTurn };
      }
      const windowText = turns
        .map(
          (t) =>
            `[turn ${t.turn_index} @ ${new Date(t.ts_start).toISOString()}]\n${(t.content_text || '').slice(0, 4000)}`
        )
        .join('\n\n---\n\n');
      const truncatedWindowText =
        windowText.length > 60000 ? windowText.slice(0, 60000) : windowText;
      const prompt = EPISODE_PROMPT.replace('{WINDOW_TEXT}', truncatedWindowText);
      const json = await runClaudeOneShot(prompt, 90_000);
      let parsed: any;
      try {
        // Tolerate markdown fences in case the model adds them despite instructions
        let cleaned = json.trim();
        if (cleaned.startsWith('```')) {
          cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        }
        // If there's a JSON object anywhere, extract the first {...}
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
          cleaned = cleaned.slice(firstBrace, lastBrace + 1);
        }
        parsed = JSON.parse(cleaned);
      } catch (e: any) {
        return {
          chatId,
          created: 0,
          startTurn,
          endTurn,
          error: 'parse failure: ' + (e?.message || String(e)),
        };
      }
      const title = String(parsed.title || '').slice(0, 200);
      const summary = String(parsed.summary || '').slice(0, 4000);
      const keyDecisions = Array.isArray(parsed.key_decisions)
        ? parsed.key_decisions.slice(0, 10).map((s: any) => String(s).slice(0, 300))
        : [];
      // Aggregate files_touched union from window turns
      const filesUnion = new Set<string>();
      for (const t of turns) {
        try {
          for (const f of JSON.parse(t.files_touched || '[]')) filesUnion.add(f);
        } catch {
          // ignore bad JSON
        }
      }
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM episodes WHERE chat_id = ? AND start_turn = ?').run(
          chatId,
          startTurn
        );
        db.prepare(
          `INSERT INTO episodes (chat_id, start_turn, end_turn, ts_start, ts_end, title, summary, key_decisions, files_touched, indexed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(
          chatId,
          startTurn,
          endTurn,
          turns[0].ts_start,
          turns[turns.length - 1].ts_start,
          title,
          summary,
          JSON.stringify(keyDecisions),
          JSON.stringify([...filesUnion]),
          Date.now()
        );
        db.prepare(
          'UPDATE index_state SET last_episode_end_turn = ? WHERE chat_id = ?'
        ).run(endTurn, chatId);
      });
      tx();
      return { chatId, created: 1, startTurn, endTurn, title };
    } catch (e: any) {
      return {
        chatId,
        created: 0,
        startTurn: -1,
        endTurn: -1,
        error: e?.message || String(e),
      };
    }
  })();
  inFlight.set(chatId, p);
  p.finally(() => inFlight.delete(chatId));
  return p;
}

/** Build all pending episodes for a chat in a loop until no more windows remain. */
export async function summarizeAllEpisodes(
  chatId: string
): Promise<{ chatId: string; episodes: number; lastError?: string }> {
  let count = 0;
  let lastError: string | undefined;
  for (let i = 0; i < 200; i++) {
    // safety bound
    const r = await summarizeNextEpisode(chatId);
    if (r.created === 1) {
      count++;
    } else {
      if (r.error) lastError = r.error;
      break;
    }
  }
  return { chatId, episodes: count, lastError };
}

/** Spawn `claude -p` and capture stdout. Times out after `timeoutMs`. Resolves with stdout text. */
function runClaudeOneShot(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = process.env.CLAUDE_BIN || '/usr/bin/claude';
    const proc = spawn(
      bin,
      ['-p', prompt, '--model', 'sonnet', '--dangerously-skip-permissions'],
      {
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        // Don't flash a console window on Windows for the memory-episodes ticker.
        windowsHide: true,
        // Windows can't run claude.cmd via direct spawn — use shell when target is .cmd/.bat.
        shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin),
      }
    );
    try {
      proc.stdin.end();
    } catch {
      // ignore
    }
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => {
      out += d.toString();
    });
    proc.stderr.on('data', (d) => {
      err += d.toString();
    });
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      reject(new Error('claude -p timeout'));
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude -p exit ${code}: ${err.slice(0, 500)}`));
      else resolve(out);
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
