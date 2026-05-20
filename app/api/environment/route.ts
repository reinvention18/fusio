import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const execAsync = promisify(exec);

export async function GET() {
  try {
    const workspace = process.env.FIELDREPAPP_WORKSPACE || 'C:\\DevApps\\MyMobileApp';

    // Read MyMobileApp's .env.local to determine its environment
    let supabaseRef = 'unknown';
    let supabaseUrl = '';
    
    // Try to read MyMobileApp's environment files
    const envFiles = [
      path.join(workspace, '.env.local'),
      path.join(workspace, '.env'),
    ];

    for (const envFile of envFiles) {
      if (existsSync(envFile)) {
        try {
          const content = await readFile(envFile, 'utf-8');
          // Look for SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL
          const urlMatch = content.match(/(?:NEXT_PUBLIC_)?SUPABASE_URL\s*=\s*["']?([^"'\n]+)/);
          if (urlMatch) {
            supabaseUrl = urlMatch[1];
            const refMatch = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/);
            if (refMatch) {
              supabaseRef = refMatch[1];
              break;
            }
          }
        } catch (e) {
          // Continue to next file
        }
      }
    }

    // Determine environment name based on Supabase ref
    let envName: 'production' | 'staging' | 'development' = 'development';
    
    if (supabaseRef === 'nqzhoplyamubcbqjuvxh') {
      envName = 'production';
    } else if (supabaseRef === 'zbshprhsogdnawuviqgq') {
      envName = 'staging';
    }

    // Get current branch from MyMobileApp
    let branch = 'unknown';
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: workspace });
      branch = stdout.trim();
    } catch {
      // Ignore git errors
    }

    // Check for uncommitted changes
    let isDirty = false;
    try {
      const { stdout } = await execAsync('git status --porcelain', { cwd: workspace });
      isDirty = stdout.trim().length > 0;
    } catch {
      // Ignore git errors  
    }

    return NextResponse.json({
      name: envName,
      supabaseRef,
      supabaseUrl,
      branch,
      isDirty,
      workspace,
      environments: {
        production: {
          supabaseRef: 'nqzhoplyamubcbqjuvxh',
          saasUrl: 'https://example.com',
          appUrl: 'https://app.example.com',
          branch: 'main'
        },
        staging: {
          supabaseRef: 'zbshprhsogdnawuviqgq',
          saasUrl: 'https://staging.example.com',
          appUrl: 'https://staging-app.example.com',
          branch: 'staging'
        }
      }
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
