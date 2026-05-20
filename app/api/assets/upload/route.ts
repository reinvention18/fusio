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

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const workspace = formData.get('workspace') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }
    if (!workspace) {
      return NextResponse.json({ error: 'No workspace/project provided' }, { status: 400 });
    }

    const projectSlug = slugify(workspace);
    const projectDir = path.join(ASSETS_BASE, projectSlug);
    fs.mkdirSync(projectDir, { recursive: true });

    const ext = path.extname(file.name);
    const baseName = path.basename(file.name, ext).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const timestamp = Date.now();
    const filename = `${baseName}-${timestamp}${ext}`;
    const filePath = path.join(projectDir, filename);

    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    const meta = {
      originalName: file.name,
      type: file.type,
      size: file.size,
      workspace,
      uploadedAt: new Date().toISOString(),
      path: filePath,
    };
    fs.writeFileSync(filePath + '.meta.json', JSON.stringify(meta, null, 2));

    return NextResponse.json({
      success: true,
      asset: {
        id: `${projectSlug}/${filename}`,
        name: file.name,
        filename,
        type: file.type,
        size: file.size,
        path: filePath,
        project: projectSlug,
        uploadedAt: meta.uploadedAt,
        url: `/api/assets/file/${projectSlug}/${filename}`,
      },
    });
  } catch (error: any) {
    console.error('[Assets Upload]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
