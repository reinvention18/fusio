import { NextResponse } from 'next/server';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';

export async function GET() {
  try {
    const workspace = process.env.FIELDREPAPP_WORKSPACE || 'C:\\DevApps\\MyMobileApp';
    const apiDir = join(workspace, 'pages', 'api');

    const routes = await scanApiRoutes(apiDir, '/api');

    return NextResponse.json({ routes });
  } catch (error: any) {
    // Return common API routes as fallback
    return NextResponse.json({
      routes: [
        { path: '/api/auth/session', method: 'GET', description: 'Get current session' },
        { path: '/api/auth/login', method: 'POST', description: 'Login user' },
        { path: '/api/billing/subscription', method: 'GET', description: 'Get subscription' },
        { path: '/api/company/settings', method: 'GET', description: 'Get company settings' },
        { path: '/api/company/settings', method: 'PUT', description: 'Update company settings' },
        { path: '/api/team/members', method: 'GET', description: 'List team members' },
        { path: '/api/team/invite', method: 'POST', description: 'Invite team member' },
        { path: '/api/user/profile', method: 'GET', description: 'Get user profile' },
        { path: '/api/user/profile', method: 'PUT', description: 'Update profile' },
      ]
    });
  }
}

async function scanApiRoutes(dir: string, basePath: string): Promise<any[]> {
  const routes: any[] = [];
  
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      
      if (entry.isDirectory()) {
        // Recurse into subdirectories
        const subRoutes = await scanApiRoutes(fullPath, `${basePath}/${entry.name}`);
        routes.push(...subRoutes);
      } else if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) {
        // Extract route path from filename
        let routePath = basePath;
        const fileName = entry.name.replace(/\.(js|ts)$/, '');
        
        if (fileName !== 'index') {
          // Handle dynamic routes like [id].js
          if (fileName.startsWith('[') && fileName.endsWith(']')) {
            routePath += `/:${fileName.slice(1, -1)}`;
          } else {
            routePath += `/${fileName}`;
          }
        }

        // Default to GET method, actual methods would need file parsing
        routes.push({
          path: routePath,
          method: 'GET',
          description: ''
        });
      }
    }
  } catch (e) {
    // Directory doesn't exist or can't be read
  }
  
  return routes;
}
