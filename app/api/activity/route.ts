import { NextRequest, NextResponse } from 'next/server';
import { readStorage, writeStorage, generateId, ActivityData } from '@/lib/storage';

// GET /api/activity - Get activity feed
export async function GET(request: NextRequest) {
  try {
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '50');
    const data = await readStorage();
    
    // Return last N items, most recent last
    const activity = data.activity.slice(-limit);
    
    return NextResponse.json({ activity });
  } catch (error) {
    console.error('Error reading activity:', error);
    return NextResponse.json({ error: 'Failed to read activity' }, { status: 500 });
  }
}

// POST /api/activity - Add activity item
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const data = await readStorage();
    
    const newActivity: ActivityData = {
      id: generateId(),
      taskId: body.taskId,
      taskTitle: body.taskTitle,
      action: body.action,
      agent: body.agent || 'System',
      agentEmoji: body.agentEmoji || '🤖',
      timestamp: new Date().toISOString(),
      note: body.note,
    };
    
    data.activity.push(newActivity);
    
    // Keep only last 100
    if (data.activity.length > 100) {
      data.activity = data.activity.slice(-100);
    }
    
    await writeStorage(data);
    
    return NextResponse.json({ activity: newActivity });
  } catch (error) {
    console.error('Error adding activity:', error);
    return NextResponse.json({ error: 'Failed to add activity' }, { status: 500 });
  }
}

// DELETE /api/activity - Clear activity
export async function DELETE() {
  try {
    const data = await readStorage();
    data.activity = [];
    await writeStorage(data);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error clearing activity:', error);
    return NextResponse.json({ error: 'Failed to clear activity' }, { status: 500 });
  }
}
