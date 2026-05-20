import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

// Task Session API - Spawns isolated sessions and polls their progress

export const maxDuration = 300; // 5 min max per request

interface SpawnResponse {
  success: boolean;
  sessionKey?: string;
  initialOutput?: string;
  error?: string;
}

interface SessionHistoryMessage {
  role: string;
  content: any;
  timestamp?: number;
}

// Start a task via OpenClaw chat API and return a tracking ID
async function spawnTaskSession(
  gatewayUrl: string,
  token: string,
  task: string,
  label?: string
): Promise<SpawnResponse> {
  try {
    const url = new URL('/v1/chat/completions', gatewayUrl);
    const taskId = label || `task-${Date.now()}`;
    
    // Send the task to OpenClaw - it will spawn sub-agents as needed
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-OpenClaw-Scopes': 'operator.read,operator.write',
      },
      body: JSON.stringify({
        model: 'openclaw:main',
        stream: false,
        messages: [{ role: 'user', content: task }],
      }),
    });
    
    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `Task failed: ${response.status} ${text}` };
    }
    
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    
    // Store the response as the initial output
    return { 
      success: true, 
      sessionKey: taskId, // Use as tracking ID
      initialOutput: content,
    };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// Get session history from OpenClaw gateway
async function getSessionHistory(
  gatewayUrl: string,
  token: string,
  sessionKey: string,
  limit: number = 10
): Promise<{ messages: SessionHistoryMessage[]; error?: string }> {
  try {
    const url = new URL('/api/sessions/history', gatewayUrl);
    url.searchParams.set('sessionKey', sessionKey);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('includeTools', 'false');
    
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-OpenClaw-Scopes': 'operator.read,operator.write',
      },
    });
    
    if (!response.ok) {
      const text = await response.text();
      return { messages: [], error: `History failed: ${text}` };
    }
    
    const data = await response.json();
    return { messages: data.messages || [] };
  } catch (e: any) {
    return { messages: [], error: e.message };
  }
}

// List active sessions
async function listSessions(
  gatewayUrl: string,
  token: string
): Promise<{ sessions: any[]; error?: string }> {
  try {
    const url = new URL('/api/sessions/list', gatewayUrl);
    url.searchParams.set('kinds', JSON.stringify(['isolated']));
    url.searchParams.set('limit', '20');
    url.searchParams.set('messageLimit', '1');
    
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-OpenClaw-Scopes': 'operator.read,operator.write',
      },
    });
    
    if (!response.ok) {
      return { sessions: [] };
    }
    
    const data = await response.json();
    return { sessions: data.sessions || [] };
  } catch (e: any) {
    return { sessions: [], error: e.message };
  }
}

// Parse task file
async function parseTaskFile(filePath: string): Promise<{
  title: string;
  items: { id: string; text: string; priority: string }[];
  error?: string;
}> {
  try {
    const resolvedPath = path.isAbsolute(filePath) 
      ? filePath 
      : path.join(process.cwd(), filePath);
    
    const content = await fs.readFile(resolvedPath, 'utf-8');
    const lines = content.split('\n');
    const items: { id: string; text: string; priority: string }[] = [];
    let title = '';
    let currentPriority = 'medium';
    let itemIndex = 0;

    for (const line of lines) {
      if (!title && line.match(/^#\s+(.+)/)) {
        title = line.replace(/^#\s+/, '').trim();
        continue;
      }

      if (line.includes('🔴') || line.toLowerCase().includes('critical')) {
        currentPriority = 'critical';
      } else if (line.includes('🟡') || line.toLowerCase().includes('high priority')) {
        currentPriority = 'high';
      } else if (line.includes('🟢') || line.toLowerCase().includes('medium')) {
        currentPriority = 'medium';
      } else if (line.includes('🔵') || line.toLowerCase().includes('low')) {
        currentPriority = 'low';
      }

      const checkboxMatch = line.match(/^[\s-]*\[([x ])\]\s*(.+)$/i);
      if (checkboxMatch) {
        items.push({
          id: `task-${itemIndex++}`,
          text: checkboxMatch[2].trim(),
          priority: currentPriority,
        });
        continue;
      }

      const headerMatch = line.match(/^###\s*\d+\.\s*(.+)/);
      if (headerMatch) {
        items.push({
          id: `task-${itemIndex++}`,
          text: headerMatch[1].trim(),
          priority: currentPriority,
        });
      }
    }

    return { title, items };
  } catch (e: any) {
    return { title: '', items: [], error: e.message };
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, gatewayUrl, token, filePath, task, sessionKey, answers } = body;
    
    const baseUrl = (gatewayUrl || 'http://localhost:18789')
      .replace('ws://', 'http://')
      .replace('wss://', 'https://');
    
    // Parse task file
    if (action === 'parse') {
      if (!filePath) {
        return NextResponse.json({ error: 'filePath required' }, { status: 400 });
      }
      const result = await parseTaskFile(filePath);
      return NextResponse.json(result);
    }
    
    // Spawn a new task session
    if (action === 'spawn') {
      if (!task && !filePath) {
        return NextResponse.json({ error: 'task or filePath required' }, { status: 400 });
      }
      
      let taskPrompt = task;
      
      // If file path provided, build task prompt from file
      if (filePath) {
        const parsed = await parseTaskFile(filePath);
        if (parsed.error) {
          return NextResponse.json({ error: parsed.error }, { status: 404 });
        }
        
        const taskList = parsed.items
          .map((item, i) => `${i + 1}. [${item.priority.toUpperCase()}] ${item.text}`)
          .join('\n');
        
        taskPrompt = `Execute this task list from ${filePath}. Work through each task one by one.

${answers ? `User's preferences:\n${answers}\n\n` : ''}

## ${parsed.title || 'Task List'}

${taskList}

---

Work through each task. After completing each one, clearly indicate:
✅ Task N complete: <brief summary>

If you need to skip a task, indicate:
⏭️ Task N skipped: <reason>

If a task fails:
❌ Task N failed: <reason>

When all tasks are done, end with:
🎉 ALL TASKS COMPLETE

Start now with Task 1.`;
      }
      
      const result = await spawnTaskSession(baseUrl, token, taskPrompt, body.label);
      return NextResponse.json(result);
    }
    
    // Poll session for progress
    if (action === 'poll') {
      if (!sessionKey) {
        return NextResponse.json({ error: 'sessionKey required' }, { status: 400 });
      }
      
      const history = await getSessionHistory(baseUrl, token, sessionKey, 5);
      
      // Parse output to determine progress
      let output = '';
      let completedTasks: number[] = [];
      let skippedTasks: number[] = [];
      let failedTasks: number[] = [];
      let isComplete = false;
      let isRunning = true;
      
      for (const msg of history.messages) {
        if (msg.role === 'assistant') {
          const content = typeof msg.content === 'string' 
            ? msg.content 
            : JSON.stringify(msg.content);
          
          output = content; // Use latest assistant message as output
          
          // Check for task completion markers
          const completeMatches = content.matchAll(/✅\s*Task\s*(\d+)/gi);
          for (const match of completeMatches) {
            completedTasks.push(parseInt(match[1]));
          }
          
          const skipMatches = content.matchAll(/⏭️\s*Task\s*(\d+)/gi);
          for (const match of skipMatches) {
            skippedTasks.push(parseInt(match[1]));
          }
          
          const failMatches = content.matchAll(/❌\s*Task\s*(\d+)/gi);
          for (const match of failMatches) {
            failedTasks.push(parseInt(match[1]));
          }
          
          if (content.includes('ALL TASKS COMPLETE') || content.includes('🎉')) {
            isComplete = true;
            isRunning = false;
          }
        }
      }
      
      return NextResponse.json({
        success: true,
        output,
        completedTasks: [...new Set(completedTasks)],
        skippedTasks: [...new Set(skippedTasks)],
        failedTasks: [...new Set(failedTasks)],
        isComplete,
        isRunning,
      });
    }
    
    // List all active task sessions
    if (action === 'list') {
      const result = await listSessions(baseUrl, token);
      return NextResponse.json(result);
    }
    
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    
  } catch (error: any) {
    console.error('[TaskSession] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  // Convenience GET for polling
  const { searchParams } = new URL(request.url);
  const sessionKey = searchParams.get('sessionKey');
  const gatewayUrl = searchParams.get('gateway') || 'http://localhost:18789';
  const token = searchParams.get('token') || '';
  
  if (!sessionKey) {
    return NextResponse.json({ error: 'sessionKey required' }, { status: 400 });
  }
  
  const baseUrl = gatewayUrl.replace('ws://', 'http://').replace('wss://', 'https://');
  const history = await getSessionHistory(baseUrl, token, sessionKey, 5);
  
  return NextResponse.json(history);
}
