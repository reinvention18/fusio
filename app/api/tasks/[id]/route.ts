import { NextRequest, NextResponse } from 'next/server';
import { readStorage, writeStorage, generateId, ActivityData } from '@/lib/storage';

// Valid status values
const VALID_STATUSES = ['inbox', 'up_next', 'in_progress', 'in_review', 'done'];
const VALID_PRIORITIES = ['none', 'low', 'medium', 'high'];

// GET /api/tasks/[id] - Get a specific task
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const data = await readStorage();
    const task = data.tasks.find((t) => t.id === id);
    
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    
    return NextResponse.json({ task });
  } catch (error) {
    console.error('Error reading task:', error);
    return NextResponse.json({ error: 'Failed to read task' }, { status: 500 });
  }
}

// PATCH /api/tasks/[id] - Update a task
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const data = await readStorage();
    
    const index = data.tasks.findIndex((t) => t.id === id);
    if (index === -1) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    
    const oldTask = data.tasks[index];
    
    // Validate status and priority if provided
    if (body.status && !VALID_STATUSES.includes(body.status)) {
      body.status = oldTask.status; // Keep original if invalid
    }
    if (body.priority && !VALID_PRIORITIES.includes(body.priority)) {
      body.priority = oldTask.priority; // Keep original if invalid
    }
    
    const updatedTask = {
      ...oldTask,
      ...body,
      id: oldTask.id, // Prevent ID change
      createdAt: oldTask.createdAt, // Prevent createdAt change
      updatedAt: new Date().toISOString(),
    };
    
    // Handle completion
    if (body.status === 'done' && oldTask.status !== 'done') {
      updatedTask.completedAt = new Date().toISOString();
    }
    
    data.tasks[index] = updatedTask;
    
    // Log activity for status changes
    if (body.status && body.status !== oldTask.status) {
      const activity: ActivityData = {
        id: generateId(),
        taskId: id,
        taskTitle: oldTask.title,
        action: `moved to ${body.status}`,
        agent: body.assignedTo || oldTask.assignedTo || 'System',
        agentEmoji: '🦞',
        timestamp: new Date().toISOString(),
        note: body.activityNote,
      };
      data.activity.push(activity);
      
      // Keep only last 100
      if (data.activity.length > 100) {
        data.activity = data.activity.slice(-100);
      }
    }
    
    // Update board task counts if board changed
    if (body.boardId && body.boardId !== oldTask.boardId) {
      const oldBoard = data.boards.find((b) => b.id === oldTask.boardId);
      const newBoard = data.boards.find((b) => b.id === body.boardId);
      if (oldBoard) {
        oldBoard.taskCount = data.tasks.filter((t) => t.boardId === oldTask.boardId).length;
      }
      if (newBoard) {
        newBoard.taskCount = data.tasks.filter((t) => t.boardId === body.boardId).length;
      }
    }
    
    await writeStorage(data);
    
    return NextResponse.json({ task: updatedTask });
  } catch (error) {
    console.error('Error updating task:', error);
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}

// DELETE /api/tasks/[id] - Delete a task
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const data = await readStorage();
    
    const task = data.tasks.find((t) => t.id === id);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    
    data.tasks = data.tasks.filter((t) => t.id !== id);
    
    // Update board task count
    const board = data.boards.find((b) => b.id === task.boardId);
    if (board) {
      board.taskCount = data.tasks.filter((t) => t.boardId === task.boardId).length;
    }
    
    // Log activity
    const activity: ActivityData = {
      id: generateId(),
      taskId: id,
      taskTitle: task.title,
      action: 'deleted',
      agent: 'System',
      agentEmoji: '🗑️',
      timestamp: new Date().toISOString(),
    };
    data.activity.push(activity);
    
    if (data.activity.length > 100) {
      data.activity = data.activity.slice(-100);
    }
    
    await writeStorage(data);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting task:', error);
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}
