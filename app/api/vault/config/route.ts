import { NextRequest } from 'next/server';
import { getVaultSettings, setVaultSettings, vaultExists } from '../../../../lib/vault/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ settings: getVaultSettings(), exists: vaultExists() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const next = setVaultSettings(body ?? {});
  return Response.json({ settings: next, exists: vaultExists() });
}
