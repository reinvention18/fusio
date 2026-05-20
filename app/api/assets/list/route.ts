import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const ASSETS_BASE = path.join(process.env.HOME || '~', '.openclaw', 'workspace', 'assets');

function slugify(workspace: string): string {
  const name = workspace.split('/').filter(Boolean).pop() || '';
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 50);
  return slug || crypto.createHash('md5').update(workspace).digest('hex').slice(0, 12);
}

export async function GET(request: NextRequest) {
  try {
    const workspace = request.nextUrl.searchParams.get('workspace');
    if (!workspace) {
      return NextResponse.json({ error: 'workspace parameter required' }, { status: 400 });
    }

    const projectSlug = slugify(workspace);
    const projectDir = path.join(ASSETS_BASE, projectSlug);

    if (!fs.existsSync(projectDir)) {
      return NextResponse.json({ assets: [], project: projectSlug });
    }

    const files = fs.readdirSync(projectDir).filter(f => !f.endsWith('.meta.json'));
    const assets = files.map(filename => {
      const filePath = path.join(projectDir, filename);
      const stat = fs.statSync(filePath);
      
      // Try to read metadata
      let meta: any = {};
      const metaPath = filePath + '.meta.json';
      if (fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
      }

      return {
        id: `${projectSlug}/${filename}`,
        name: meta.originalName || filename,
        filename,
        type: meta.type || (filename.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i) ? `image/${RegExp.$1.toLowerCase()}` : 'application/octet-stream'),
        size: stat.size,
        path: filePath,
        project: projectSlug,
        uploadedAt: meta.uploadedAt || stat.birthtime.toISOString(),
        url: `/api/assets/file/${projectSlug}/${filename}`,
      };
    });

    // Sort newest first
    assets.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());

    return NextResponse.json({ assets, project: projectSlug });
  } catch (error: any) {
    console.error('[Assets List]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
