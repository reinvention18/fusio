import { NextRequest, NextResponse } from 'next/server';
import { readStorage, writeStorage } from '@/lib/storage';

// GET /api/boards/[id] - Get a specific board
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const data = await readStorage();
    const board = data.boards.find((b) => b.id === id);
    
    if (!board) {
      return NextResponse.json({ error: 'Board not found' }, { status: 404 });
    }
    
    return NextResponse.json({ board });
  } catch (error) {
    console.error('Error reading board:', error);
    return NextResponse.json({ error: 'Failed to read board' }, { status: 500 });
  }
}

// PATCH /api/boards/[id] - Update a board
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const data = await readStorage();
    
    const index = data.boards.findIndex((b) => b.id === id);
    if (index === -1) {
      return NextResponse.json({ error: 'Board not found' }, { status: 404 });
    }
    
    const oldBoard = data.boards[index];
    data.boards[index] = {
      ...oldBoard,
      ...body,
      id: oldBoard.id, // Prevent ID change
      createdAt: oldBoard.createdAt, // Prevent createdAt change
    };
    
    await writeStorage(data);
    
    return NextResponse.json({ board: data.boards[index] });
  } catch (error) {
    console.error('Error updating board:', error);
    return NextResponse.json({ error: 'Failed to update board' }, { status: 500 });
  }
}

// DELETE /api/boards/[id] - Delete a board
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    
    // Can't delete default board
    if (id === 'default') {
      return NextResponse.json({ error: 'Cannot delete default board' }, { status: 400 });
    }
    
    const data = await readStorage();
    
    const board = data.boards.find((b) => b.id === id);
    if (!board) {
      return NextResponse.json({ error: 'Board not found' }, { status: 404 });
    }
    
    // Move tasks from deleted board to default
    data.tasks.forEach((task) => {
      if (task.boardId === id) {
        task.boardId = 'default';
      }
    });
    
    // Update default board task count
    const defaultBoard = data.boards.find((b) => b.id === 'default');
    if (defaultBoard) {
      defaultBoard.taskCount = data.tasks.filter((t) => t.boardId === 'default').length;
    }
    
    data.boards = data.boards.filter((b) => b.id !== id);
    
    // If active board was deleted, switch to default
    if (data.activeBoard === id) {
      data.activeBoard = 'default';
    }
    
    await writeStorage(data);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting board:', error);
    return NextResponse.json({ error: 'Failed to delete board' }, { status: 500 });
  }
}
