/**
 * /api/files — Read and write files for the code editor.
 *
 * GET  ?path=/absolute/path  → { content, size, encoding }
 * POST { path, content }     → write file
 *
 * Safety: only allows access within the user's home directory.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

const HOME = os.homedir();
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

function isSafePath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(HOME) || resolved.startsWith('/tmp');
}

function isBinary(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const binaryExts = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx',
    '.mp3', '.mp4', '.wav', '.avi', '.mov',
    '.exe', '.dll', '.so', '.dylib', '.o',
    '.pyc', '.class', '.wasm',
  ]);
  return binaryExts.has(ext);
}

export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get('path');
  if (!filePath) {
    return NextResponse.json({ error: 'path required' }, { status: 400 });
  }

  if (!isSafePath(filePath)) {
    return NextResponse.json({ error: 'Access denied: path outside home directory' }, { status: 403 });
  }

  try {
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is a directory' }, { status: 400 });
    }

    if (stats.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: `File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB, max 5MB)` }, { status: 400 });
    }

    if (isBinary(filePath)) {
      return NextResponse.json({ error: 'Binary files cannot be edited' }, { status: 400 });
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    return NextResponse.json({
      content,
      size: stats.size,
      modified: stats.mtime.toISOString(),
      encoding: 'utf-8',
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { path: filePath, content } = await request.json();

    if (!filePath || typeof content !== 'string') {
      return NextResponse.json({ error: 'path and content required' }, { status: 400 });
    }

    if (!isSafePath(filePath)) {
      return NextResponse.json({ error: 'Access denied: path outside home directory' }, { status: 403 });
    }

    if (isBinary(filePath)) {
      return NextResponse.json({ error: 'Cannot write binary files' }, { status: 400 });
    }

    // Ensure parent directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, content, 'utf-8');

    return NextResponse.json({ success: true, size: Buffer.byteLength(content) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
