import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const ASSETS_BASE = path.join(process.env.HOME || '~', '.openclaw', 'workspace', 'assets');

export async function POST(request: NextRequest) {
  try {
    const { assetId } = await request.json();
    if (!assetId || !assetId.includes('/')) {
      return NextResponse.json({ error: 'Invalid asset ID' }, { status: 400 });
    }

    const filePath = path.join(ASSETS_BASE, assetId);
    // Security: ensure path stays within ASSETS_BASE
    if (!filePath.startsWith(ASSETS_BASE)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      const metaPath = filePath + '.meta.json';
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[Assets Delete]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
