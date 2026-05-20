import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const dirPath = searchParams.get('path') || '';
  const search = searchParams.get('search') || '';

  try {
    // If no path provided, return common starting points
    if (!dirPath) {
      const homedir = os.homedir();
      const roots = [];

      // Windows drives
      if (process.platform === 'win32') {
        for (const letter of ['C', 'D', 'E', 'F']) {
          const drive = `${letter}:\\`;
          if (fs.existsSync(drive)) {
            roots.push({ name: drive, path: drive, type: 'drive' });
          }
        }
      } else {
        roots.push({ name: '/', path: '/', type: 'drive' });
      }

      // Add home directory
      roots.push({ name: 'Home', path: homedir, type: 'home' });

      // Add common dev folders if they exist
      const commonPaths = [
        path.join(homedir, 'Projects'),
        path.join(homedir, 'projects'),
        path.join(homedir, 'Development'),
        path.join(homedir, 'dev'),
        path.join(homedir, 'Code'),
        path.join(homedir, 'code'),
        'C:\\DevApps',
        'C:\\Projects',
        'C:\\Users\\' + os.userInfo().username + '\\source\\repos',
      ];

      for (const p of commonPaths) {
        if (fs.existsSync(p)) {
          roots.push({ name: path.basename(p), path: p, type: 'folder' });
        }
      }

      return NextResponse.json({ 
        path: '',
        parent: null,
        items: roots,
        type: 'roots'
      });
    }

    // Normalize the path
    const normalizedPath = path.normalize(dirPath);
    
    // Check if path exists
    if (!fs.existsSync(normalizedPath)) {
      return NextResponse.json({ error: 'Path not found' }, { status: 404 });
    }

    const stats = fs.statSync(normalizedPath);
    if (!stats.isDirectory()) {
      return NextResponse.json({ error: 'Not a directory' }, { status: 400 });
    }

    // Read directory contents
    const entries = fs.readdirSync(normalizedPath, { withFileTypes: true });
    
    // Filter and map entries
    let items = entries
      .filter(entry => {
        // Skip hidden files/folders (starting with .)
        if (entry.name.startsWith('.')) return false;
        // Skip node_modules, .git, etc.
        if (['node_modules', '.git', '__pycache__', '.next', 'dist', 'build'].includes(entry.name)) return false;
        // Only show directories
        return entry.isDirectory();
      })
      .map(entry => ({
        name: entry.name,
        path: path.join(normalizedPath, entry.name),
        type: 'folder' as const,
      }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    // Apply search filter if provided
    if (search) {
      const searchLower = search.toLowerCase();
      items = items.filter(item => item.name.toLowerCase().includes(searchLower));
    }

    // Calculate parent path
    const parent = path.dirname(normalizedPath);
    const hasParent = parent !== normalizedPath;

    // Check if this looks like a project folder (has package.json, .git, etc.)
    const isProject = 
      fs.existsSync(path.join(normalizedPath, 'package.json')) ||
      fs.existsSync(path.join(normalizedPath, '.git')) ||
      fs.existsSync(path.join(normalizedPath, 'Cargo.toml')) ||
      fs.existsSync(path.join(normalizedPath, 'pyproject.toml')) ||
      fs.existsSync(path.join(normalizedPath, 'go.mod'));

    return NextResponse.json({
      path: normalizedPath,
      parent: hasParent ? parent : null,
      items,
      isProject,
      type: 'directory'
    });

  } catch (error: any) {
    console.error('[Browse] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
