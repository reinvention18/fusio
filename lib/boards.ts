// Multi-board management with server-side persistence

export interface Board {
  id: string;
  name: string;
  icon: string;
  createdAt: Date;
  taskCount: number;
}

const DEFAULT_BOARD: Board = {
  id: 'default',
  name: 'Main Board',
  icon: '🚀',
  createdAt: new Date(),
  taskCount: 0,
};

// Convert API response to Board objects with Date types
function parseBoard(b: any): Board {
  return {
    ...b,
    createdAt: new Date(b.createdAt),
  };
}

export async function getBoards(): Promise<Board[]> {
  try {
    const res = await fetch('/api/boards');
    if (!res.ok) throw new Error('Failed to fetch boards');
    const data = await res.json();
    return (data.boards || []).map(parseBoard);
  } catch (error) {
    console.error('Error fetching boards:', error);
    return [DEFAULT_BOARD];
  }
}

export async function addBoard(name: string, icon: string): Promise<Board | null> {
  try {
    const res = await fetch('/api/boards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, icon }),
    });
    if (!res.ok) throw new Error('Failed to create board');
    const data = await res.json();
    return parseBoard(data.board);
  } catch (error) {
    console.error('Error creating board:', error);
    return null;
  }
}

export async function updateBoard(id: string, updates: Partial<Board>): Promise<Board | null> {
  try {
    const res = await fetch(`/api/boards/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) throw new Error('Failed to update board');
    const data = await res.json();
    return parseBoard(data.board);
  } catch (error) {
    console.error('Error updating board:', error);
    return null;
  }
}

export async function deleteBoard(id: string): Promise<boolean> {
  if (id === 'default') return false; // Can't delete default
  
  try {
    const res = await fetch(`/api/boards/${id}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch (error) {
    console.error('Error deleting board:', error);
    return false;
  }
}

export async function getActiveBoard(): Promise<string> {
  try {
    const res = await fetch('/api/boards');
    if (!res.ok) throw new Error('Failed to fetch boards');
    const data = await res.json();
    return data.activeBoard || 'default';
  } catch (error) {
    console.error('Error fetching active board:', error);
    return 'default';
  }
}

export async function setActiveBoard(id: string): Promise<boolean> {
  try {
    const res = await fetch('/api/boards', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeBoard: id }),
    });
    return res.ok;
  } catch (error) {
    console.error('Error setting active board:', error);
    return false;
  }
}

// Board emoji options
export const BOARD_ICONS = [
  '🚀', '📋', '💼', '🎯', '⚡', '🔧', '📊', '🎨', 
  '💡', '🔬', '📱', '🌐', '🤖', '🦞', '✨', '🔥'
];

// Legacy synchronous functions for components that haven't been updated yet
export function getBoardsSync(): Board[] {
  console.warn('getBoardsSync is deprecated, use getBoards() instead');
  return [DEFAULT_BOARD];
}

export function saveBoards(boards: Board[]) {
  console.warn('saveBoards is deprecated, use addBoard/updateBoard/deleteBoard instead');
}

export function getActiveBoardSync(): string {
  console.warn('getActiveBoardSync is deprecated, use getActiveBoard() instead');
  return 'default';
}
