import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function POST(req: NextRequest) {
  try {
    const { type = 'all', watch = false } = await req.json();

    const workspace = process.env.FIELDREPAPP_WORKSPACE || 'C:\\DevApps\\MyMobileApp';

    // Determine the test command
    let command = 'npm test';
    if (type === 'changed') {
      command = 'npm test -- --changedSince=HEAD~1';
    }
    if (watch) {
      command += ' -- --watch';
    }

    // Run tests and parse output
    // Note: This is a simplified version - real implementation would stream results
    try {
      const { stdout, stderr } = await execAsync(command, { 
        cwd: workspace,
        timeout: 120000 // 2 minute timeout
      });

      // Parse Jest output (simplified - would need proper parsing for real use)
      const suites = parseJestOutput(stdout);

      return NextResponse.json({ 
        success: true, 
        suites,
        output: stdout 
      });
    } catch (testError: any) {
      // Jest exits with error code when tests fail
      const suites = parseJestOutput(testError.stdout || '');
      return NextResponse.json({ 
        success: false, 
        suites,
        output: testError.stdout,
        error: testError.stderr
      });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

function parseJestOutput(output: string) {
  // Simplified Jest output parser
  // In production, you'd want to use Jest's JSON reporter
  const suites: any[] = [];
  
  const lines = output.split('\n');
  let currentSuite: any = null;

  for (const line of lines) {
    // Match test file
    if (line.includes('PASS') || line.includes('FAIL')) {
      const match = line.match(/(PASS|FAIL)\s+(.+)/);
      if (match) {
        if (currentSuite) suites.push(currentSuite);
        currentSuite = {
          file: match[2].trim(),
          tests: [],
          status: match[1] === 'PASS' ? 'pass' : 'fail'
        };
      }
    }
    
    // Match individual test
    if (line.includes('✓') || line.includes('✕')) {
      const isPass = line.includes('✓');
      const testMatch = line.match(/[✓✕]\s+(.+?)(\s+\((\d+)\s*ms\))?$/);
      if (testMatch && currentSuite) {
        currentSuite.tests.push({
          name: testMatch[1].trim(),
          status: isPass ? 'pass' : 'fail',
          duration: testMatch[3] ? parseInt(testMatch[3]) : undefined
        });
      }
    }
  }

  if (currentSuite) suites.push(currentSuite);
  
  return suites;
}
