import { NextRequest, NextResponse } from 'next/server';
import { readStorage, writeStorage, generateId, TaskData, ActivityData } from '@/lib/storage';

// Valid status values
const VALID_STATUSES = ['inbox', 'up_next', 'in_progress', 'in_review', 'done'];
const VALID_PRIORITIES = ['none', 'low', 'medium', 'high'];

type TaskStatus = 'inbox' | 'up_next' | 'in_progress' | 'in_review' | 'done';
type TaskPriority = 'none' | 'low' | 'medium' | 'high';

// Validate and normalize status
function validateStatus(status: string | undefined): TaskStatus {
  if (!status || !VALID_STATUSES.includes(status)) {
    return 'inbox';
  }
  return status as TaskStatus;
}

// Validate and normalize priority
function validatePriority(priority: string | undefined): TaskPriority {
  if (!priority || !VALID_PRIORITIES.includes(priority)) {
    return 'none';
  }
  return priority as TaskPriority;
}

// GET /api/tasks - Get all tasks (optionally filtered by boardId)
export async function GET(request: NextRequest) {
  try {
    const boardId = request.nextUrl.searchParams.get('boardId');
    const data = await readStorage();
    
    let tasks = data.tasks;
    if (boardId) {
      tasks = tasks.filter((t) => t.boardId === boardId);
    }
    
    return NextResponse.json({ tasks });
  } catch (error) {
    console.error('Error reading tasks:', error);
    return NextResponse.json({ error: 'Failed to read tasks' }, { status: 500 });
  }
}

// POST /api/tasks - Create a new task
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const data = await readStorage();
    
    const newTask: TaskData = {
      id: generateId(),
      title: body.title || 'Untitled Task',
      description: body.description || '',
      status: validateStatus(body.status),
      priority: validatePriority(body.priority),
      momentum: body.momentum || 50,
      boardId: body.boardId || 'default',
      assignedTo: body.assignedTo || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      details: body.details,
    };
    
    data.tasks.push(newTask);
    
    // Update board task count
    const board = data.boards.find((b) => b.id === newTask.boardId);
    if (board) {
      board.taskCount = data.tasks.filter((t) => t.boardId === newTask.boardId).length;
    }
    
    // Add activity
    const activity: ActivityData = {
      id: generateId(),
      taskId: newTask.id,
      taskTitle: newTask.title,
      action: 'created',
      agent: 'System',
      agentEmoji: '🤖',
      timestamp: new Date().toISOString(),
    };
    data.activity.push(activity);
    
    // Keep only last 100 activity items
    if (data.activity.length > 100) {
      data.activity = data.activity.slice(-100);
    }
    
    await writeStorage(data);
    
    return NextResponse.json({ task: newTask, activity });
  } catch (error) {
    console.error('Error creating task:', error);
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}
