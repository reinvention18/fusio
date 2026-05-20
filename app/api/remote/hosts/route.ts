/**
 * /api/remote/hosts — UI-safe view of configured peer MCs.
 * Returns id/label/url only. NEVER returns the bearer tokens.
 */

import { NextResponse } from 'next/server';
import { listHosts } from '../../../../lib/remote/config';

export async function GET() {
  const hosts = listHosts().map(h => ({ id: h.id, label: h.label, url: h.url }));
  return NextResponse.json({ hosts });
}
