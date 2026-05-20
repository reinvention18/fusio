import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function POST() {
  try {
    const workspace = process.env.FIELDREPAPP_WORKSPACE || 'C:\\DevApps\\MyMobileApp';

    const { stdout } = await execAsync('git push', { cwd: workspace });

    return NextResponse.json({ 
      success: true, 
      message: 'Pushed successfully',
      output: stdout 
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
