/**
 * /api/usage/today — rolling 24h count of agent + API calls.
 *
 * Counts messages from data/chats/*.json over the last 24 hours. The Fusio
 * topbar polls this every 30s to populate the "Calls today" group.
 *
 * Falls back to 0 on any error so the topbar never errors out.
 */

import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const CHATS_DIR = path.join(process.cwd(), 'data', 'chats');

interface ChatMessage {
  role: string;
  timestamp?: string | number;
}

interface ChatSession {
  messages?: ChatMessage[];
}

export async function GET() {
  try {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(CHATS_DIR);
    } catch {
      return NextResponse.json({ count: 0, ok: true, note: 'no chats dir' });
    }

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let count = 0;

    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(CHATS_DIR, name), 'utf8');
        const data = JSON.parse(raw) as ChatSession;
        for (const m of data.messages || []) {
          const ts = typeof m.timestamp === 'string'
            ? new Date(m.timestamp).getTime()
            : (typeof m.timestamp === 'number' ? m.timestamp : 0);
          if (ts >= cutoff) count++;
        }
      } catch {
        // Skip bad chat files
      }
    }

    return NextResponse.json({ count, ok: true });
  } catch (err: any) {
    return NextResponse.json({ count: 0, ok: false, error: err?.message || 'unknown' });
  }
}
