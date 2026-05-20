// Task/Workshop management with server-side persistence

export type TaskStatus = 'inbox' | 'up_next' | 'in_progress' | 'in_review' | 'done';
export type TaskPriority = 'none' | 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  momentum: number; // 0-100, how well it fits
  boardId: string;
  assignedTo: string | null; // Agent ID
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  details?: string;
}

export interface ActivityItem {
  id: string;
  taskId: string;
  taskTitle: string;
  action: string;
  agent: string;
  agentEmoji: string;
  timestamp: Date;
  note?: string;
}

export const TASK_STATUSES: { id: TaskStatus; label: string; color: string }[] = [
  { id: 'inbox', label: 'INBOX', color: 'terminal-dim' },
  { id: 'up_next', label: 'UP NEXT', color: 'terminal-cyan' },
  { id: 'in_progress', label: 'IN PROGRESS', color: 'terminal-amber' },
  { id: 'in_review', label: 'IN REVIEW', color: 'terminal-cyan' },
  { id: 'done', label: 'DONE', color: 'terminal-green' },
];

export const TASK_PRIORITIES: { id: TaskPriority; label: string; color: string }[] = [
  { id: 'none', label: 'None', color: 'terminal-dim' },
  { id: 'low', label: 'Low', color: 'terminal-cyan' },
  { id: 'medium', label: 'Medium', color: 'terminal-amber' },
  { id: 'high', label: 'High', color: 'terminal-red' },
];

// Convert API response to Task objects with Date types
function parseTask(t: any): Task {
  return {
    ...t,
    createdAt: new Date(t.createdAt),
    updatedAt: new Date(t.updatedAt),
    completedAt: t.completedAt ? new Date(t.completedAt) : undefined,
  };
}

function parseActivity(a: any): ActivityItem {
  return {
    ...a,
    timestamp: new Date(a.timestamp),
  };
}

export async function getTasks(boardId?: string): Promise<Task[]> {
  try {
    const url = boardId ? `/api/tasks?boardId=${boardId}` : '/api/tasks';
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch tasks');
    const data = await res.json();
    return (data.tasks || []).map(parseTask);
  } catch (error) {
    console.error('Error fetching tasks:', error);
    return [];
  }
}

export async function addTask(task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Promise<Task | null> {
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task),
    });
    if (!res.ok) throw new Error('Failed to create task');
    const data = await res.json();
    return parseTask(data.task);
  } catch (error) {
    console.error('Error creating task:', error);
    return null;
  }
}

export async function updateTask(id: string, updates: Partial<Task>, activityNote?: string): Promise<Task | null> {
  try {
    const res = await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...updates, activityNote }),
    });
    if (!res.ok) throw new Error('Failed to update task');
    const data = await res.json();
    return parseTask(data.task);
  } catch (error) {
    console.error('Error updating task:', error);
    return null;
  }
}

export async function deleteTask(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/tasks/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete task');
    return true;
  } catch (error) {
    console.error('Error deleting task:', error);
    return false;
  }
}

export async function moveTask(id: string, newStatus: TaskStatus, activityNote?: string): Promise<Task | null> {
  const updates: Partial<Task> = { status: newStatus };
  if (newStatus === 'done') {
    updates.completedAt = new Date();
  }
  return updateTask(id, updates, activityNote);
}

export async function assignTask(id: string, agentId: string | null, agentName?: string): Promise<Task | null> {
  return updateTask(id, { assignedTo: agentId });
}

// Activity Feed
export async function getActivity(limit = 50): Promise<ActivityItem[]> {
  try {
    const res = await fetch(`/api/activity?limit=${limit}`);
    if (!res.ok) throw new Error('Failed to fetch activity');
    const data = await res.json();
    return (data.activity || []).map(parseActivity);
  } catch (error) {
    console.error('Error fetching activity:', error);
    return [];
  }
}

export async function addActivity(
  taskId: string, 
  taskTitle: string, 
  action: string, 
  agent: string, 
  agentEmoji: string,
  note?: string
): Promise<ActivityItem | null> {
  try {
    const res = await fetch('/api/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, taskTitle, action, agent, agentEmoji, note }),
    });
    if (!res.ok) throw new Error('Failed to add activity');
    const data = await res.json();
    return parseActivity(data.activity);
  } catch (error) {
    console.error('Error adding activity:', error);
    return null;
  }
}

export async function clearActivity(): Promise<boolean> {
  try {
    const res = await fetch('/api/activity', { method: 'DELETE' });
    return res.ok;
  } catch (error) {
    console.error('Error clearing activity:', error);
    return false;
  }
}

// Calculate momentum based on task similarity to recent work
export function calculateMomentum(task: Task, recentTasks: Task[]): number {
  if (recentTasks.length === 0) return 50;
  
  const keywords = task.title.toLowerCase().split(' ');
  let matches = 0;
  
  recentTasks.slice(-5).forEach((recent) => {
    const recentWords = recent.title.toLowerCase().split(' ');
    keywords.forEach((word) => {
      if (word.length > 3 && recentWords.includes(word)) {
        matches++;
      }
    });
  });
  
  return Math.min(100, 50 + matches * 10);
}

// Priority sorting weight
export function getPriorityWeight(priority: TaskPriority): number {
  switch (priority) {
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

// Legacy synchronous functions for components that haven't been updated yet
// These return empty data and should be replaced with async versions
export function getTasksSync(boardId?: string): Task[] {
  console.warn('getTasksSync is deprecated, use getTasks() instead');
  return [];
}

export function saveTasks(tasks: Task[]) {
  console.warn('saveTasks is deprecated, use addTask/updateTask/deleteTask instead');
}
