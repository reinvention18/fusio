/**
 * /api/debug/match-probe?text=... — auto-load matcher probe.
 *
 * Returns exactly which skills, subagent personas, and brand design systems
 * the per-turn matchers in claude-chat-bridge.ts would force-load for the
 * given text, plus the byte size of each inlined bundle. Used to verify the
 * 5-source skill index + the 2 specialist routers are firing correctly.
 *
 * Temporary debug surface — safe to leave in (no side effects, read-only).
 */

import { NextRequest } from 'next/server';
import { matchSkillsForText, loadMatchedSkillsBundle } from '../../../../lib/skills-mcp';
import { matchAgentsForText, loadMatchedAgentsBundle } from '../../../../lib/agents-mcp';
import { matchDesignSystemsForText, loadMatchedDesignSystemsBundle } from '../../../../lib/design-systems-mcp';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const text = request.nextUrl.searchParams.get('text') || '';
  if (!text) {
    return new Response(JSON.stringify({ error: 'text query param required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const skillMatches = matchSkillsForText(text);
    const agentMatches = matchAgentsForText(text);
    const dsMatches = matchDesignSystemsForText(text);

    const skillBundle = loadMatchedSkillsBundle(text);
    const agentBundle = loadMatchedAgentsBundle(text);
    const dsBundle = loadMatchedDesignSystemsBundle(text);

    return new Response(
      JSON.stringify({
        text,
        skills: {
          matched: skillMatches,
          bytesInlined: skillBundle.length,
        },
        agents: {
          matched: agentMatches,
          bytesInlined: agentBundle.length,
        },
        designSystems: {
          matched: dsMatches,
          bytesInlined: dsBundle.length,
        },
        totalBytesInlined: skillBundle.length + agentBundle.length + dsBundle.length,
      }, null, 2),
      {
        headers: { 'Content-Type': 'application/json' },
      },
    );
  } catch (e: any) {
    console.error('[debug/match-probe]', e?.stack || e?.message || e);
    return new Response(
      JSON.stringify({ error: 'matcher_failed', message: String(e?.message || e) }, null, 2),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
