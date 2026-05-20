/**
 * /api/config — Mission Control configuration.
 *
 * Returns workspace path and backend info. Token kept for /api/agent auth.
 */

import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export async function GET() {
  try {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    let workspace = '';
    let token = '';

    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      token = config.gateway?.auth?.token || '';
      workspace = config.agents?.defaults?.workspace || '';
    }

    if (!workspace) {
      // Prefer the user's primary project (~/<your-mobile-app>) when it exists.
      // Per-chat workspace selection (saved on each ChatSession) still wins
      // over this default.
      const fieldRepApp = path.join(os.homedir(), 'MyMobileApp');
      const openclaw = path.join(os.homedir(), '.openclaw', 'workspace');
      workspace = fs.existsSync(fieldRepApp) ? fieldRepApp : openclaw;
    }

    return NextResponse.json({
      workspace,
      token,
      backend: 'claude-code-cli',
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
