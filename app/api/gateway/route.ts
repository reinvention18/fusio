import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';

const SESSIONS_JSON = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
const SESSIONS_DIR = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions');

function readSessionsJson(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_JSON, 'utf-8'));
  } catch {
    return {};
  }
}

/** Read up to `maxLines` lines from the end of a .jsonl file */
function readJsonlTail(filePath: string, maxLines = 200): unknown[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const tail = lines.slice(-maxLines);
    return tail.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { gatewayUrl, token, action, params } = body;

    if (!gatewayUrl || !token) {
      return NextResponse.json({ error: 'Missing gateway config' }, { status: 400 });
    }

    const httpUrl = gatewayUrl.replace('ws://', 'http://').replace('wss://', 'https://');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-OpenClaw-Scopes': 'operator.read,operator.write',
    };

    // ── sessions_list ──────────────────────────────────────────────────────────
    if (action === 'sessions_list') {
      const data = readSessionsJson();
      const sessions = Object.entries(data).map(([key, val]: [string, any]) => ({
        key,
        kind: val?.kind || 'unknown',
        model: val?.modelOverride || val?.model || 'default',
        totalTokens: val?.totalTokens || 0,
        status: val?.status || 'unknown',
        lastActivity: val?.lastActivity || val?.updatedAt || null,
        title: val?.title || val?.name || key.slice(0, 8),
      }));
      return NextResponse.json({ sessions });
    }

    // ── sessions_history ───────────────────────────────────────────────────────
    if (action === 'sessions_history') {
      const sessionKey = params?.sessionKey;
      if (!sessionKey) {
        return NextResponse.json({ error: 'sessionKey required' }, { status: 400 });
      }

      // Find the transcript file for this session
      const jsonlPath = path.join(SESSIONS_DIR, `${sessionKey}.jsonl`);
      if (!fs.existsSync(jsonlPath)) {
        return NextResponse.json({ messages: [], error: 'Transcript not found' });
      }

      const maxLines = params?.limit || 200;
      const entries = readJsonlTail(jsonlPath, maxLines);
      // Each entry may be { role, content, ... } or { type, ... } depending on format
      return NextResponse.json({ messages: entries, sessionKey });
    }

    // ── session_status ─────────────────────────────────────────────────────────
    if (action === 'session_status') {
      try {
        const response = await fetch(httpUrl, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(5000),
        });
        const text = await response.text();
        let data: unknown = text;
        try { data = JSON.parse(text); } catch {}
        return NextResponse.json({ ok: response.ok, status: response.status, data });
      } catch (err: any) {
        return NextResponse.json({ ok: false, error: err.message });
      }
    }

    // ── cron_list ──────────────────────────────────────────────────────────────
    if (action === 'cron_list') {
      // Try REST endpoint first
      try {
        const cronRes = await fetch(`${httpUrl}/cron`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(4000),
        });
        if (cronRes.ok) {
          const data = await cronRes.json();
          return NextResponse.json(data);
        }
      } catch {}

      // Fall back to disk — look for cron config files
      const cronPaths = [
        path.join(os.homedir(), '.openclaw', 'cron.json'),
        path.join(os.homedir(), '.openclaw', 'agents', 'main', 'cron.json'),
        path.join(os.homedir(), '.openclaw', 'workspace', 'cron.json'),
      ];
      for (const p of cronPaths) {
        try {
          if (fs.existsSync(p)) {
            const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
            return NextResponse.json({ crons: Array.isArray(data) ? data : [data], source: p });
          }
        } catch {}
      }

      return NextResponse.json({ crons: [], error: 'No cron data found' });
    }

    // ── wake ───────────────────────────────────────────────────────────────────
    if (action === 'wake') {
      const chatUrl = `${httpUrl}/v1/chat/completions`;
      const wakeMessage = params?.message || 'Wake event triggered from Mission Control';

      const chatResponse = await fetch(chatUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: wakeMessage }],
          stream: false,
        }),
      });

      if (!chatResponse.ok) {
        return NextResponse.json(
          { error: 'Failed to send wake message', status: chatResponse.status },
          { status: chatResponse.status }
        );
      }

      return NextResponse.json({ success: true, message: 'Wake event sent' });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });

  } catch (error: any) {
    console.error('[Gateway API] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
