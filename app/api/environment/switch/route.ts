import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

const ENVIRONMENTS = {
  production: {
    supabaseRef: 'nqzhoplyamubcbqjuvxh',
    supabaseUrl: 'https://nqzhoplyamubcbqjuvxh.supabase.co',
    branch: 'main'
  },
  staging: {
    supabaseRef: 'zbshprhsogdnawuviqgq',
    supabaseUrl: 'https://zbshprhsogdnawuviqgq.supabase.co',
    branch: 'staging'
  }
};

export async function POST(request: NextRequest) {
  try {
    const { target } = await request.json();
    
    if (!target || !['production', 'staging'].includes(target)) {
      return NextResponse.json({ error: 'Invalid target. Use "production" or "staging"' }, { status: 400 });
    }

    const workspace = process.env.FIELDREPAPP_WORKSPACE || 'C:\\DevApps\\MyMobileApp';
    const envConfig = ENVIRONMENTS[target as keyof typeof ENVIRONMENTS];

    // Step 1: Check for uncommitted changes
    try {
      const { stdout: statusOutput } = await execAsync('git status --porcelain', { cwd: workspace });
      if (statusOutput.trim().length > 0) {
        return NextResponse.json({ 
          error: 'Uncommitted changes detected. Please commit or stash your changes first.',
          details: statusOutput.trim()
        }, { status: 400 });
      }
    } catch (e: any) {
      console.error('Git status error:', e);
      return NextResponse.json({ error: 'Failed to check git status: ' + e.message }, { status: 500 });
    }

    // Step 2: Checkout the target branch
    try {
      await execAsync(`git checkout ${envConfig.branch}`, { cwd: workspace });
    } catch (e: any) {
      // Try to fetch first if branch doesn't exist locally
      try {
        await execAsync(`git fetch origin ${envConfig.branch}`, { cwd: workspace });
        await execAsync(`git checkout ${envConfig.branch}`, { cwd: workspace });
      } catch (fetchError: any) {
        return NextResponse.json({ 
          error: `Failed to checkout ${envConfig.branch} branch`,
          details: fetchError.message
        }, { status: 500 });
      }
    }

    // Step 3: Update .env.local with the correct Supabase URL
    try {
      const envLocalPath = path.join(workspace, '.env.local');
      let envContent = '';
      
      try {
        envContent = await readFile(envLocalPath, 'utf-8');
      } catch {
        // File doesn't exist, we'll create it
      }

      // Update or add NEXT_PUBLIC_SUPABASE_URL
      const urlPattern = /NEXT_PUBLIC_SUPABASE_URL\s*=\s*.*/;
      const newUrl = `NEXT_PUBLIC_SUPABASE_URL=${envConfig.supabaseUrl}`;
      
      if (urlPattern.test(envContent)) {
        envContent = envContent.replace(urlPattern, newUrl);
      } else {
        envContent = `${newUrl}\n${envContent}`;
      }

      // Also update SUPABASE_URL if it exists
      const supabaseUrlPattern = /^SUPABASE_URL\s*=\s*.*/m;
      if (supabaseUrlPattern.test(envContent)) {
        envContent = envContent.replace(supabaseUrlPattern, `SUPABASE_URL=${envConfig.supabaseUrl}`);
      }

      await writeFile(envLocalPath, envContent);
    } catch (e: any) {
      console.error('Failed to update .env.local:', e);
      // Non-fatal, continue
    }

    // Step 4: Pull latest changes
    try {
      await execAsync(`git pull origin ${envConfig.branch}`, { cwd: workspace });
    } catch (e: any) {
      console.error('Git pull error:', e);
      // Non-fatal, just log it
    }

    return NextResponse.json({
      success: true,
      message: `Switched to ${target}`,
      branch: envConfig.branch,
      supabaseRef: envConfig.supabaseRef
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
