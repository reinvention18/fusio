// Server-side JSON storage for tasks, boards, and activity

import { promises as fs } from 'fs';
import path from 'path';

const DATA_FILE = path.join(process.cwd(), 'data', 'tasks.json');

export interface TaskData {
  id: string;
  title: string;
  description: string;
  status: 'inbox' | 'up_next' | 'in_progress' | 'in_review' | 'done';
  priority: 'none' | 'low' | 'medium' | 'high';
  momentum: number;
  boardId: string;
  assignedTo: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  details?: string;
}

export interface BoardData {
  id: string;
  name: string;
  icon: string;
  createdAt: string;
  taskCount: number;
}

export interface ActivityData {
  id: string;
  taskId: string;
  taskTitle: string;
  action: string;
  agent: string;
  agentEmoji: string;
  timestamp: string;
  note?: string;
}

export interface StorageData {
  tasks: TaskData[];
  boards: BoardData[];
  activity: ActivityData[];
  activeBoard: string;
}

const DEFAULT_DATA: StorageData = {
  tasks: [],
  boards: [
    {
      id: 'default',
      name: 'Main Board',
      icon: '🚀',
      createdAt: new Date().toISOString(),
      taskCount: 0,
    },
  ],
  activity: [],
  activeBoard: 'default',
};

export async function readStorage(): Promise<StorageData> {
  try {
    const content = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    // File doesn't exist or is invalid, return defaults
    await writeStorage(DEFAULT_DATA);
    return DEFAULT_DATA;
  }
}

export async function writeStorage(data: StorageData): Promise<void> {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// Helper to generate UUID
export function generateId(): string {
  return crypto.randomUUID();
}
