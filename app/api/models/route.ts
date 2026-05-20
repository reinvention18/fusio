/**
 * /api/models — Available Claude Code CLI models.
 *
 * Returns the models supported by `claude --model`.
 * No gateway dependency — purely static with context window info.
 */

import { NextResponse } from 'next/server';

interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  context_window: number;
}

const MODELS: ModelEntry[] = [
  { id: 'opus', name: 'Claude Opus 4.6', provider: 'anthropic', context_window: 1_000_000 },
  { id: 'sonnet', name: 'Claude Sonnet 4.6', provider: 'anthropic', context_window: 1_000_000 },
  { id: 'haiku', name: 'Claude Haiku 3.5', provider: 'anthropic', context_window: 200_000 },
];

export async function GET() {
  return NextResponse.json({ models: MODELS, source: 'claude-code-cli' });
}
