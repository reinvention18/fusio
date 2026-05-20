import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Task API - parses MD files for tasks and executes them via Claude Code CLI

export const maxDuration = 3600; // 1 hour max

// Parse task items from markdown content
function parseTasksFromMarkdown(content: string): { 
  title: string;
  summary: string;
  items: { id: string; text: string; priority: string; status: 'pending' | 'done' }[];
} {
  const lines = content.split('\n');
  const items: { id: string; text: string; priority: string; status: 'pending' | 'done' }[] = [];
  let title = '';
  let summary = '';
  let currentPriority = 'medium';
  let currentTaskText = '';
  let itemIndex = 0;

  for (const line of lines) {
    // Extract title (first # heading)
    if (!title && line.match(/^#\s+(.+)/)) {
      title = line.replace(/^#\s+/, '').trim();
      continue;
    }

    // Detect priority sections
    if (line.includes('🔴') || line.toLowerCase().includes('critical')) {
      currentPriority = 'critical';
    } else if (line.includes('🟡') || line.toLowerCase().includes('high priority')) {
      currentPriority = 'high';
    } else if (line.includes('🟢') || line.toLowerCase().includes('medium priority')) {
      currentPriority = 'medium';
    } else if (line.includes('🔵') || line.toLowerCase().includes('low priority')) {
      currentPriority = 'low';
    }

    // Parse checkbox items: - [ ] or - [x] at START of line
    const checkboxMatch = line.match(/^[\s-]*\[([x ])\]\s*(.+)$/i);
    if (checkboxMatch) {
      items.push({
        id: `task-${itemIndex++}`,
        text: checkboxMatch[2].trim(),
        priority: currentPriority,
        status: checkboxMatch[1].toLowerCase() === 'x' ? 'done' : 'pending',
      });
      continue;
    }

    // Parse status checkbox at END of line: - **Status:** [ ] or [x]
    const statusMatch = line.match(/^\s*-\s*\*\*Status:\*\*\s*\[([x ])\]/i);
    if (statusMatch && currentTaskText) {
      // Update the last item's status if it exists
      if (items.length > 0) {
        items[items.length - 1].status = statusMatch[1].toLowerCase() === 'x' ? 'done' : 'pending';
      }
      continue;
    }

    // Parse numbered items with task descriptions (### headers)
    // Supports: ### 1. Title, ### T-001: Title, ### T001: Title, ### Task 1: Title
    const headerMatch = line.match(/^###\s*(?:\d+\.\s*|T-?\d+[:.]\s*|Task\s*\d+[:.]\s*)(.+)/i);
    if (headerMatch) {
      currentTaskText = headerMatch[1].trim();
      items.push({
        id: `task-${itemIndex++}`,
        text: currentTaskText,
        priority: currentPriority,
        status: 'pending',
      });
      continue;
    }
  }

  // Build summary from first paragraph after title
  const summaryMatch = content.match(/^#[^#].*?\n\n(.+?)(?=\n\n|$)/s);
  if (summaryMatch) {
    summary = summaryMatch[1].replace(/[>\-*]/g, '').trim().slice(0, 200);
  }

  return { title, summary, items };
}

// Execute prompt via Claude Code CLI (replaces old gateway call)
async function makeRequest(
  prompt: string,
  workspace?: string,
): Promise<{ status: number; body: string }> {
  try {
    const claudeBin = process.env.CLAUDE_BIN || '/usr/bin/claude';
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--model', 'sonnet',
    ];

    const { stdout } = await execFileAsync(claudeBin, args, {
      cwd: workspace || process.cwd(),
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300_000,
      windowsHide: true,
      // Windows can't run claude.cmd via direct execFile — use shell when target is .cmd/.bat
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(claudeBin),
    });

    // Parse CLI JSON output and convert to OpenAI-compatible format
    let content = '';
    try {
      const parsed = JSON.parse(stdout);
      content = parsed.result || '';
    } catch {
      content = stdout.trim();
    }

    const body = JSON.stringify({
      choices: [{ message: { content } }],
    });

    return { status: 200, body };
  } catch (e: any) {
    return { status: 500, body: JSON.stringify({ error: e.message }) };
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, filePath, task, currentItem, workspace } = body;
    
    // Parse an MD file for tasks
    if (action === 'parse') {
      if (!filePath) {
        return NextResponse.json({ error: 'filePath required' }, { status: 400 });
      }

      // Helper to check if file exists
      const fileExists = async (filePath: string): Promise<boolean> => {
        try {
          await fs.access(filePath);
          return true;
        } catch {
          return false;
        }
      };

      // Helper to search recursively
      const searchRecursively = async (startDir: string, filename: string, maxDepth: number = 3): Promise<string | null> => {
        const search = async (dir: string, depth: number): Promise<string | null> => {
          if (depth > maxDepth) return null;
          try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            
            // Check current directory first
            for (const entry of entries) {
              if (entry.isFile() && entry.name === filename) {
                return path.join(dir, entry.name);
              }
            }
            
            // Then search subdirectories
            for (const entry of entries) {
              if (entry.isDirectory() && !entry.name.startsWith('.')) {
                const found = await search(path.join(dir, entry.name), depth + 1);
                if (found) return found;
              }
            }
          } catch {
            // Skip directories we can't read
          }
          return null;
        };
        
        return search(startDir, 0);
      };

      try {
        // Resolve path (handle relative paths)
        const resolvedPath = path.isAbsolute(filePath) 
          ? filePath 
          : path.join(process.cwd(), filePath);
        
        const triedPaths: string[] = [resolvedPath];
        let finalPath: string | null = null;
        
        // 1. Try exact path
        if (await fileExists(resolvedPath)) {
          console.log(`✅ Task file found at exact path: ${resolvedPath}`);
          finalPath = resolvedPath;
        }
        
        // 2. Try archive/ subdirectory (same directory, archive folder)
        if (!finalPath) {
          const filename = path.basename(resolvedPath);
          const dirname = path.dirname(resolvedPath);
          const archivePath = path.join(dirname, 'archive', filename);
          triedPaths.push(archivePath);
          console.log(`🔍 Checking archive path: ${archivePath}`);
          if (await fileExists(archivePath)) {
            console.log(`✅ Task file found in archive: ${archivePath}`);
            finalPath = archivePath;
          }
        }
        
        // 3. Try parent directory
        if (!finalPath) {
          const filename = path.basename(resolvedPath);
          const parentDir = path.dirname(path.dirname(resolvedPath));
          const parentPath = path.join(parentDir, filename);
          triedPaths.push(parentPath);
          if (await fileExists(parentPath)) {
            finalPath = parentPath;
          }
        }
        
        // 4. Search recursively from grandparent directory
        if (!finalPath) {
          const filename = path.basename(resolvedPath);
          const grandparentDir = path.dirname(path.dirname(path.dirname(resolvedPath)));
          const searchPath = await searchRecursively(grandparentDir, filename);
          if (searchPath) {
            triedPaths.push(`${grandparentDir}/** (recursive search)`);
            finalPath = searchPath;
          }
        }
        
        // If still not found, return error with all attempted paths
        if (!finalPath) {
          return NextResponse.json({ 
            error: `File not found: ${path.basename(filePath)}`,
            details: `Searched in the following locations:\n${triedPaths.map(p => `  • ${p}`).join('\n')}`,
            triedPaths,
          }, { status: 404 });
        }
        
        // Read and parse the file
        const content = await fs.readFile(finalPath, 'utf-8');
        const parsed = parseTasksFromMarkdown(content);
        
        return NextResponse.json({ 
          success: true, 
          ...parsed,
          filePath: finalPath,
          ...(finalPath !== resolvedPath ? { foundAt: finalPath, requestedPath: filePath } : {}),
        });
      } catch (e: any) {
        return NextResponse.json({ 
          error: `Failed to read file: ${e.message}` 
        }, { status: 500 });
      }
    }

    // Ask clarifying questions before starting
    if (action === 'clarify') {
      const clarifyPrompt = `You are about to execute a task list. Review the following tasks and ask any clarifying questions you need answered BEFORE you start working.

## Task File: ${body.filePath || 'Unknown'}

## Task Summary:
${body.summary || 'No summary'}

## Tasks to Complete:
${(body.items || []).map((item: any, i: number) => `${i + 1}. [${item.priority.toUpperCase()}] ${item.text}`).join('\n')}

---

Do you have any questions before starting? If yes, list them clearly. If no questions, respond with exactly: "READY_TO_START"`;

      const result = await makeRequest(clarifyPrompt, workspace);
      
      if (result.status !== 200) {
        return NextResponse.json({ error: result.body }, { status: result.status });
      }
      
      try {
        const parsed = JSON.parse(result.body);
        const content = parsed.choices?.[0]?.message?.content || '';
        const isReady = content.includes('READY_TO_START');
        
        return NextResponse.json({ 
          success: true, 
          ready: isReady,
          questions: isReady ? null : content,
        });
      } catch {
        return NextResponse.json({ success: true, content: result.body });
      }
    }

    // Answer questions and check if ready
    if (action === 'answer') {
      const answerPrompt = `The user has answered your questions:

${body.answer}

Based on their answers, are you ready to start the task list? 
If yes, respond with exactly: "READY_TO_START"
If you have more questions, ask them.`;

      const result = await makeRequest(answerPrompt, workspace);
      
      if (result.status !== 200) {
        return NextResponse.json({ error: result.body }, { status: result.status });
      }
      
      try {
        const parsed = JSON.parse(result.body);
        const content = parsed.choices?.[0]?.message?.content || '';
        const isReady = content.includes('READY_TO_START');
        
        return NextResponse.json({ 
          success: true, 
          ready: isReady,
          questions: isReady ? null : content,
        });
      } catch {
        return NextResponse.json({ success: true, content: result.body });
      }
    }

    // Execute a single task item
    if (action === 'execute-item') {
      if (!currentItem) {
        return NextResponse.json({ error: 'currentItem required' }, { status: 400 });
      }

      const executePrompt = `Execute this specific task item NOW. When complete, end your response with:
✅ TASK_COMPLETE

If you encounter an error, end with:
❌ TASK_FAILED: <reason>

## Current Task Item:
${currentItem.text}

## Context:
- Task file: ${body.filePath || 'Unknown'}
- Priority: ${currentItem.priority || 'medium'}
- Working directory: ${body.workspace || process.cwd()}

Execute this task now. Be thorough but efficient.`;

      const result = await makeRequest(executePrompt, workspace);
      
      if (result.status !== 200) {
        return NextResponse.json({ error: result.body }, { status: result.status });
      }
      
      try {
        const parsed = JSON.parse(result.body);
        const content = parsed.choices?.[0]?.message?.content || '';
        const isComplete = content.includes('TASK_COMPLETE');
        const isFailed = content.includes('TASK_FAILED');
        
        return NextResponse.json({ 
          success: true, 
          content,
          itemComplete: isComplete,
          itemFailed: isFailed,
          itemId: currentItem.id,
        });
      } catch {
        return NextResponse.json({ success: true, content: result.body });
      }
    }

    // Simple task execution (legacy - no MD file)
    if (action === 'run') {
      const result = await makeRequest(task, workspace);
      
      if (result.status !== 200) {
        return NextResponse.json({ error: result.body }, { status: result.status });
      }
      
      try {
        const parsed = JSON.parse(result.body);
        const content = parsed.choices?.[0]?.message?.content || '';
        return NextResponse.json({ 
          success: true, 
          content,
          raw: parsed,
        });
      } catch {
        return NextResponse.json({ 
          success: true, 
          content: result.body,
        });
      }
    }
    
    return NextResponse.json({ error: 'Invalid action. Use: parse, clarify, answer, execute-item, run' }, { status: 400 });
    
  } catch (error: any) {
    console.error('[Task API] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
