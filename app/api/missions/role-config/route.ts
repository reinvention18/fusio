/**
 * GET /api/missions/role-config
 *
 * Returns the available role-config presets + the current default. Used by
 * the missions settings UI (Phase 9 deliverable 3) and by clients that
 * want to render "Frontier (mixed) — Opus / Sonnet / GPT-5 Codex / Browser"
 * before kicking off a mission.
 */

import { ROLE_PRESETS } from '@/lib/missions/role-config';
import { DEFAULT_ROLE_CONFIG } from '@/lib/missions/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    default: DEFAULT_ROLE_CONFIG,
    presets: ROLE_PRESETS,
  });
}
