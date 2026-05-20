import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function POST(req: NextRequest) {
  try {
    const { message } = await req.json();

    if (!message) {
      return NextResponse.json({ error: 'Commit message is required' }, { status: 400 });
    }

    const workspace = process.env.FIELDREPAPP_WORKSPACE || 'C:\\DevApps\\MyMobileApp';

    // Stage all changes
    await execAsync('git add -A', { cwd: workspace });

    // Commit with message
    const { stdout } = await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: workspace });

    return NextResponse.json({ 
      success: true, 
      message: 'Committed successfully',
      output: stdout 
    });
  } catch (error: any) {
    // Check if it's a "nothing to commit" error
    if (error.message.includes('nothing to commit')) {
      return NextResponse.json({ error: 'Nothing to commit' }, { status: 400 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
