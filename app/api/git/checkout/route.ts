import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function POST(req: NextRequest) {
  try {
    const { branch } = await req.json();

    if (!branch) {
      return NextResponse.json({ error: 'Branch name is required' }, { status: 400 });
    }

    // Only allow switching to known branches for safety
    const allowedBranches = ['main', 'staging', 'develop'];
    if (!allowedBranches.includes(branch)) {
      return NextResponse.json({ error: 'Branch not allowed' }, { status: 400 });
    }

    const workspace = process.env.FIELDREPAPP_WORKSPACE || 'C:\\DevApps\\MyMobileApp';

    const { stdout } = await execAsync(`git checkout ${branch}`, { cwd: workspace });

    return NextResponse.json({ 
      success: true, 
      message: `Switched to ${branch}`,
      output: stdout 
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
