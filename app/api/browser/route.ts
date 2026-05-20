/**
 * /api/browser — Playwright-based browser control.
 *
 * Manages a persistent Chromium instance that the chat agent can control:
 * navigate, click, type, extract data, run JS, manage tabs.
 * Returns structured DOM data — NOT screenshots.
 *
 * POST { action: "navigate", url: "https://..." }
 * POST { action: "click", selector: "#login-btn" }
 * POST { action: "getText", selector: "main" }
 * POST { action: "evaluate", script: "document.title" }
 * etc.
 */

import { NextRequest, NextResponse } from 'next/server';
import { executeBrowserAction, type BrowserAction } from '../../../lib/browser-session';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const cmd = body as BrowserAction;

    if (!cmd.action) {
      return NextResponse.json({ error: 'action is required' }, { status: 400 });
    }

    const result = await executeBrowserAction(cmd);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET() {
  const result = await executeBrowserAction({ action: 'status' });
  return NextResponse.json(result);
}
