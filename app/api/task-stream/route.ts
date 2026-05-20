import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

// SSE endpoint for streaming task execution
// Streams live output as the agent works through each task item

export const maxDuration = 300; // 5 min max
export const dynamic = 'force-dynamic';

// Parse task file for items
async function parseTaskFile(filePath: string): Promise<{
  title: string;
  items: { id: string; text: string; priority: string; status: 'pending' | 'done' }[];
  error?: string;
}> {
  try {
    let resolvedPath = path.isAbsolute(filePath) 
      ? filePath 
      : path.join(process.cwd(), filePath);
    
    // Fallback: try archive/ subdirectory if file not found
    try {
      await fs.access(resolvedPath);
    } catch {
      const dirname = path.dirname(resolvedPath);
      const filename = path.basename(resolvedPath);
      const archivePath = path.join(dirname, 'archive', filename);
      try {
        await fs.access(archivePath);
        resolvedPath = archivePath;
      } catch {
        // Try parent directory
        const parentPath = path.join(path.dirname(dirname), filename);
        try {
          await fs.access(parentPath);
          resolvedPath = parentPath;
        } catch {
          // Fall through to original path (will error on read)
        }
      }
    }
    
    const content = await fs.readFile(resolvedPath, 'utf-8');
    const lines = content.split('\n');
    const items: { id: string; text: string; priority: string; status: 'pending' | 'done' }[] = [];
    let title = '';
    let currentPriority = 'medium';
    let itemIndex = 0;
    let lastHeaderIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (!title && line.match(/^#\s+(.+)/)) {
        title = line.replace(/^#\s+/, '').trim();
        continue;
      }

      // Detect priority sections
      if (line.includes('🔴') || line.toLowerCase().includes('critical')) {
        currentPriority = 'critical';
      } else if (line.includes('🟡') || line.toLowerCase().includes('high')) {
        currentPriority = 'high';
      } else if (line.includes('🟢') || line.toLowerCase().includes('medium')) {
        currentPriority = 'medium';
      } else if (line.includes('🔵') || line.toLowerCase().includes('low')) {
        currentPriority = 'low';
      }

      // Check for **STATUS:** ✅ COMPLETE pattern (marks previous header as done)
      if (line.match(/\*\*STATUS:\*\*.*✅.*COMPLETE/i)) {
        if (lastHeaderIndex >= 0 && items[lastHeaderIndex]) {
          items[lastHeaderIndex].status = 'done';
        }
        continue;
      }

      // Parse checkbox items: - [x] or - [ ] at START of line
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
      if (statusMatch && items.length > 0) {
        items[items.length - 1].status = statusMatch[1].toLowerCase() === 'x' ? 'done' : 'pending';
        continue;
      }

      // Parse numbered headers: ### 1. Title, ### T-001: Title, ### T001: Title, ### Task 1: Title
      const headerMatch = line.match(/^###\s*(?:\d+\.\s*|T-?\d+[:.]\s*|Task\s*\d+[:.]\s*)(.+)/i);
      if (headerMatch) {
        lastHeaderIndex = items.length;
        items.push({
          id: `task-${itemIndex++}`,
          text: headerMatch[1].trim(),
          priority: currentPriority,
          status: 'pending', // May be updated when we hit STATUS line
        });
      }
    }

    return { title, items };
  } catch (e: any) {
    return { title: '', items: [], error: e.message };
  }
}

import { spawnClaudeStream } from '../../../lib/claude-chat-bridge';

// Execute a single task item via Claude Code CLI and return the result
async function executeTaskItem(
  item: { text: string; priority: string },
  filePath: string,
  workspace: string,
  itemIndex: number,
  totalItems: number,
  send: (event: string, data: any) => void
): Promise<{ content: string; success: boolean; error?: string }> {
  const prompt = `Execute task ${itemIndex + 1} of ${totalItems}:

**Task:** ${item.text}
**Priority:** ${item.priority}
**File:** ${filePath}
**Workspace:** ${workspace}

Complete this task now. Be thorough but efficient.
When done, end with: ✅ Task ${itemIndex + 1} complete
If failed, end with: ❌ Task ${itemIndex + 1} failed: <reason>`;

  try {
    const { stream } = spawnClaudeStream({
      prompt,
      workspace,
      model: 'sonnet',
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value);
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            send('task_output', { index: itemIndex, chunk: delta });
          }
        } catch {}
      }
    }

    const success = fullContent.includes('complete') && !fullContent.includes('failed');
    return { content: fullContent, success };
  } catch (e: any) {
    return { content: '', success: false, error: e.message };
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { filePath, answers, workspace, priorityFilter, items: itemsFromBody } = body;

  // Create a streaming response
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        let items;
        let title = '';
        
        // If items are provided in the request body, use them directly
        if (itemsFromBody && Array.isArray(itemsFromBody) && itemsFromBody.length > 0) {
          send('status', { message: 'Using provided task items...' });
          items = itemsFromBody;
          title = 'Chat Task';
        } else {
          // Otherwise, parse the task file
          send('status', { message: 'Parsing task file...' });
          
          const parsed = await parseTaskFile(filePath);
          if (parsed.error) {
            send('error', { message: `Failed to parse: ${parsed.error}` });
            controller.close();
            return;
          }
          
          items = parsed.items;
          title = parsed.title;
        }

        // Filter by priority if specified
        if (priorityFilter) {
          const priorities = priorityFilter.toLowerCase().split(',').map((p: string) => p.trim());
          items = items.filter(item => priorities.includes(item.priority.toLowerCase()));
        }
        
        // Skip already-completed tasks (marked with [x] or STATUS: ✅ COMPLETE)
        const pendingItems = items.filter(item => item.status !== 'done');
        const skippedCount = items.length - pendingItems.length;

        send('parsed', { 
          title, 
          totalItems: pendingItems.length,
          skippedDone: skippedCount,
          items: pendingItems.map((item, i) => ({ ...item, index: i }))
        });

        if (pendingItems.length === 0) {
          const msg = skippedCount > 0 
            ? `All ${skippedCount} tasks already complete!` 
            : 'No tasks to execute';
          send('complete', { message: msg });
          controller.close();
          return;
        }
        
        items = pendingItems;

        // Execute each task
        let completed = 0;
        let failed = 0;

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          
          send('task_start', { 
            index: i, 
            total: items.length,
            text: item.text,
            priority: item.priority 
          });

          const result = await executeTaskItem(
            item,
            filePath,
            workspace || process.cwd(),
            i,
            items.length,
            send
          );

          if (result.success) {
            completed++;
            send('task_complete', { 
              index: i, 
              content: result.content,
              completed,
              failed,
              remaining: items.length - i - 1
            });
          } else {
            failed++;
            send('task_failed', { 
              index: i, 
              error: result.error || 'Unknown error',
              content: result.content,
              completed,
              failed,
              remaining: items.length - i - 1
            });
          }

          // Small delay between tasks
          await new Promise(r => setTimeout(r, 500));
        }

        send('complete', { 
          message: `All tasks processed. ${completed} completed, ${failed} failed.`,
          completed,
          failed,
          total: items.length
        });

      } catch (e: any) {
        send('error', { message: e.message });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
