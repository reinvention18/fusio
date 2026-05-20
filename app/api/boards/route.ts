import { NextRequest, NextResponse } from 'next/server';
import { readStorage, writeStorage, generateId, BoardData } from '@/lib/storage';

// GET /api/boards - Get all boards
export async function GET() {
  try {
    const data = await readStorage();
    return NextResponse.json({ 
      boards: data.boards,
      activeBoard: data.activeBoard 
    });
  } catch (error) {
    console.error('Error reading boards:', error);
    return NextResponse.json({ error: 'Failed to read boards' }, { status: 500 });
  }
}

// POST /api/boards - Create a new board
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const data = await readStorage();
    
    const newBoard: BoardData = {
      id: generateId(),
      name: body.name || 'New Board',
      icon: body.icon || '📋',
      createdAt: new Date().toISOString(),
      taskCount: 0,
    };
    
    data.boards.push(newBoard);
    await writeStorage(data);
    
    return NextResponse.json({ board: newBoard });
  } catch (error) {
    console.error('Error creating board:', error);
    return NextResponse.json({ error: 'Failed to create board' }, { status: 500 });
  }
}

// PATCH /api/boards - Update active board
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    
    if (body.activeBoard) {
      const data = await readStorage();
      data.activeBoard = body.activeBoard;
      await writeStorage(data);
      return NextResponse.json({ activeBoard: body.activeBoard });
    }
    
    return NextResponse.json({ error: 'No activeBoard provided' }, { status: 400 });
  } catch (error) {
    console.error('Error updating active board:', error);
    return NextResponse.json({ error: 'Failed to update active board' }, { status: 500 });
  }
}
