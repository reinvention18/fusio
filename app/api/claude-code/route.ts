import { NextRequest, NextResponse } from 'next/server';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// In-memory session storage (in production, use Redis or similar)
interface RunningSession {
  id: string;
  name: string;
  type: 'lead' | 'teammate' | 'solo';
  status: 'running' | 'stopped' | 'error';
  workspace: string;
  prompt?: string;
  output: string[];
  startedAt: Date;
  pid?: number;
  teamMode: boolean;
}

const runningSessions = new Map<string, RunningSession>();

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const action = searchParams.get('action');
  const sessionId = searchParams.get('sessionId');

  if (action === 'list') {
    return NextResponse.json({
      sessions: Array.from(runningSessions.values()).map(s => ({
        id: s.id,
        name: s.name,
        type: s.type,
        status: s.status,
        workspace: s.workspace,
        startedAt: s.startedAt.toISOString(),
        teamMode: s.teamMode,
        outputLength: s.output.length,
        lastOutput: s.output.slice(-5),
      })),
    });
  }

  if (action === 'output' && sessionId) {
    const session = runningSessions.get(sessionId);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    return NextResponse.json({
      sessionId,
      status: session.status,
      output: session.output.slice(offset),
      totalLines: session.output.length,
    });
  }

  if (action === 'check') {
    // Check if Claude Code is installed and get version
    try {
      const { stdout } = await execAsync('claude --version', { timeout: 5000 });
      const version = stdout.trim();
      const teamsSupported = compareVersion(version, '2.1.34') >= 0;
      
      return NextResponse.json({
        installed: true,
        version,
        teamsSupported,
        path: process.platform === 'win32' ? 'claude.cmd' : 'claude',
      });
    } catch (error) {
      return NextResponse.json({
        installed: false,
        error: 'Claude Code not found in PATH',
      });
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, sessionId, workspace, prompt, teamMode, name } = body;

    if (action === 'start') {
      if (!workspace) {
        return NextResponse.json({ error: 'Workspace is required' }, { status: 400 });
      }

      const id = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      
      // Build command args
      const args: string[] = [];
      
      // Add teammate mode flag for teams
      if (teamMode) {
        args.push('--teammate-mode');
      }
      
      // Add workspace
      args.push('--cwd', workspace);
      
      // Add prompt if provided
      if (prompt) {
        args.push('-p', prompt);
      }
      
      // Set environment for teams
      const env = {
        ...process.env,
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: teamMode ? '1' : '0',
      };

      const session: RunningSession = {
        id,
        name: name || `Claude ${teamMode ? 'Team' : 'Solo'}`,
        type: teamMode ? 'lead' : 'solo',
        status: 'running',
        workspace,
        prompt,
        output: [],
        startedAt: new Date(),
        teamMode: !!teamMode,
      };

      // Spawn the process
      try {
        const claude = spawn('claude', args, {
          cwd: workspace,
          env,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });

        session.pid = claude.pid;

        // Capture output
        claude.stdout?.on('data', (data: Buffer) => {
          const lines = data.toString().split('\n').filter(Boolean);
          lines.forEach(line => {
            session.output.push(line);
            // Keep only last 2000 lines
            if (session.output.length > 2000) {
              session.output.shift();
            }
          });
        });

        claude.stderr?.on('data', (data: Buffer) => {
          const lines = data.toString().split('\n').filter(Boolean);
          lines.forEach(line => {
            session.output.push(`[stderr] ${line}`);
          });
        });

        claude.on('close', (code) => {
          session.status = code === 0 ? 'stopped' : 'error';
          session.output.push(`[Process exited with code ${code}]`);
        });

        claude.on('error', (err) => {
          session.status = 'error';
          session.output.push(`[Error: ${err.message}]`);
        });

        runningSessions.set(id, session);

        return NextResponse.json({
          success: true,
          sessionId: id,
          pid: claude.pid,
          message: `Claude Code started${teamMode ? ' in team mode' : ''}`,
        });

      } catch (spawnError: any) {
        return NextResponse.json({
          success: false,
          error: `Failed to spawn Claude Code: ${spawnError.message}`,
        }, { status: 500 });
      }
    }

    if (action === 'stop' && sessionId) {
      const session = runningSessions.get(sessionId);
      if (!session) {
        return NextResponse.json({ error: 'Session not found' }, { status: 404 });
      }

      if (session.pid) {
        try {
          process.kill(session.pid, 'SIGTERM');
          session.status = 'stopped';
          session.output.push('[Session terminated by user]');
          
          return NextResponse.json({
            success: true,
            message: 'Session stopped',
          });
        } catch (killError: any) {
          return NextResponse.json({
            success: false,
            error: `Failed to stop session: ${killError.message}`,
          }, { status: 500 });
        }
      }

      return NextResponse.json({ error: 'No PID found for session' }, { status: 400 });
    }

    if (action === 'send' && sessionId) {
      const session = runningSessions.get(sessionId);
      if (!session || session.status !== 'running') {
        return NextResponse.json({ error: 'Session not running' }, { status: 400 });
      }

      // For now, we can't send input to existing sessions easily
      // This would require PTY support
      return NextResponse.json({
        success: false,
        error: 'Input to running sessions not yet supported. Start a new session with a prompt.',
      }, { status: 400 });
    }

    if (action === 'clear' && sessionId) {
      const session = runningSessions.get(sessionId);
      if (session && session.status !== 'running') {
        runningSessions.delete(sessionId);
        return NextResponse.json({ success: true, message: 'Session cleared' });
      }
      return NextResponse.json({ error: 'Cannot clear running session' }, { status: 400 });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

  } catch (error: any) {
    console.error('[claude-code API] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Compare semantic versions
function compareVersion(v1: string, v2: string): number {
  const parts1 = v1.replace(/[^0-9.]/g, '').split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  for (let i = 0; i < 3; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}
