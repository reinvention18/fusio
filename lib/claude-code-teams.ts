// Claude Code Teams - File-based state management
// Watches .claude/teams/ and .claude/tasks/ folders

import { promises as fs } from 'fs';
import path from 'path';

export interface TeamConfig {
  id: string;
  name: string;
  created: string;
  agent_type?: string; // team lead type
  members: TeamMember[];
  status: 'active' | 'completed' | 'disbanded';
}

export interface TeamMember {
  id: string;
  name: string;
  role: string;
  status: 'active' | 'idle' | 'completed' | 'shutdown';
  taskId?: string;
  joinedAt: string;
}

export interface TeamTask {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  owner?: string;
  blockedBy: string[];
  blocks: string[];
  createdAt: string;
  updatedAt: string;
  teamId?: string;
}

export interface AgentMessage {
  id: string;
  from: string;
  to: string | 'broadcast';
  method: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response';
  content: string;
  timestamp: string;
  read: boolean;
}

export interface TeamState {
  teams: TeamConfig[];
  tasks: TeamTask[];
  messages: AgentMessage[];
  lastUpdated: string;
}

// Default Claude Code config paths
const CLAUDE_DIR = '.claude';
const TEAMS_DIR = 'teams';
const TASKS_DIR = 'tasks';
const INBOX_DIR = 'inbox';

export async function getClaudeBasePath(workspace?: string): Promise<string> {
  // Use provided workspace or fall back to common locations
  const basePaths = [
    workspace,
    process.cwd(),
    process.env.CLAUDE_CODE_WORKSPACE,
  ].filter(Boolean) as string[];

  for (const basePath of basePaths) {
    const claudePath = path.join(basePath, CLAUDE_DIR);
    try {
      await fs.access(claudePath);
      return basePath;
    } catch {
      // Try next path
    }
  }

  // Return first valid workspace even if .claude doesn't exist yet
  return basePaths[0] || process.cwd();
}

export async function getTeams(workspace?: string): Promise<TeamConfig[]> {
  try {
    const basePath = await getClaudeBasePath(workspace);
    const teamsPath = path.join(basePath, CLAUDE_DIR, TEAMS_DIR);
    
    try {
      await fs.access(teamsPath);
    } catch {
      return []; // Teams folder doesn't exist yet
    }

    const entries = await fs.readdir(teamsPath, { withFileTypes: true });
    const teams: TeamConfig[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const configPath = path.join(teamsPath, entry.name, 'config.json');
        try {
          const configData = await fs.readFile(configPath, 'utf-8');
          const config = JSON.parse(configData);
          teams.push({
            id: entry.name,
            name: config.name || entry.name,
            created: config.created || new Date().toISOString(),
            agent_type: config.agent_type,
            members: config.members || [],
            status: config.status || 'active',
          });
        } catch {
          // Config file might not exist or be invalid
          teams.push({
            id: entry.name,
            name: entry.name,
            created: new Date().toISOString(),
            members: [],
            status: 'active',
          });
        }
      }
    }

    return teams;
  } catch (error) {
    console.error('Error reading teams:', error);
    return [];
  }
}

export async function getTasks(workspace?: string): Promise<TeamTask[]> {
  try {
    const basePath = await getClaudeBasePath(workspace);
    const tasksPath = path.join(basePath, CLAUDE_DIR, TASKS_DIR);
    
    try {
      await fs.access(tasksPath);
    } catch {
      return []; // Tasks folder doesn't exist yet
    }

    const files = await fs.readdir(tasksPath);
    const tasks: TeamTask[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const taskData = await fs.readFile(path.join(tasksPath, file), 'utf-8');
          const task = JSON.parse(taskData);
          tasks.push({
            id: task.id || file.replace('.json', ''),
            subject: task.subject || 'Untitled Task',
            description: task.description || '',
            status: task.status || 'pending',
            owner: task.owner,
            blockedBy: task.blockedBy || task.blocked_by || [],
            blocks: task.blocks || [],
            createdAt: task.createdAt || task.created_at || new Date().toISOString(),
            updatedAt: task.updatedAt || task.updated_at || new Date().toISOString(),
            teamId: task.teamId || task.team_id,
          });
        } catch {
          // Invalid JSON, skip
        }
      }
    }

    // Sort by status and created date
    return tasks.sort((a, b) => {
      const statusOrder = { in_progress: 0, pending: 1, completed: 2, deleted: 3 };
      const statusDiff = (statusOrder[a.status] || 0) - (statusOrder[b.status] || 0);
      if (statusDiff !== 0) return statusDiff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  } catch (error) {
    console.error('Error reading tasks:', error);
    return [];
  }
}

export async function getInboxMessages(workspace?: string, teamId?: string): Promise<AgentMessage[]> {
  try {
    const basePath = await getClaudeBasePath(workspace);
    let inboxPath = path.join(basePath, CLAUDE_DIR, TEAMS_DIR, INBOX_DIR);
    
    // If team specified, look in team's inbox
    if (teamId) {
      inboxPath = path.join(basePath, CLAUDE_DIR, TEAMS_DIR, teamId, INBOX_DIR);
    }

    try {
      await fs.access(inboxPath);
    } catch {
      return []; // Inbox folder doesn't exist yet
    }

    const files = await fs.readdir(inboxPath);
    const messages: AgentMessage[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const msgData = await fs.readFile(path.join(inboxPath, file), 'utf-8');
          const msg = JSON.parse(msgData);
          messages.push({
            id: msg.id || file.replace('.json', ''),
            from: msg.from || 'unknown',
            to: msg.to || 'unknown',
            method: msg.method || 'message',
            content: msg.content || msg.message || '',
            timestamp: msg.timestamp || new Date().toISOString(),
            read: msg.read ?? false,
          });
        } catch {
          // Invalid JSON, skip
        }
      }
    }

    // Sort by timestamp, newest last
    return messages.sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  } catch (error) {
    console.error('Error reading inbox:', error);
    return [];
  }
}

export async function getTeamState(workspace?: string): Promise<TeamState> {
  const [teams, tasks, messages] = await Promise.all([
    getTeams(workspace),
    getTasks(workspace),
    getInboxMessages(workspace),
  ]);

  return {
    teams,
    tasks,
    messages,
    lastUpdated: new Date().toISOString(),
  };
}

// Watch for changes (polling-based for simplicity)
export function createTeamStatePoller(
  workspace: string | undefined,
  callback: (state: TeamState) => void,
  intervalMs: number = 2000
): () => void {
  let active = true;
  
  const poll = async () => {
    if (!active) return;
    
    try {
      const state = await getTeamState(workspace);
      callback(state);
    } catch (error) {
      console.error('Error polling team state:', error);
    }
    
    if (active) {
      setTimeout(poll, intervalMs);
    }
  };
  
  poll();
  
  return () => { active = false; };
}

// Helper to generate CLI commands
export function generateTeamCommand(action: 'create' | 'task' | 'update' | 'delete', params: Record<string, string>): string {
  switch (action) {
    case 'create':
      return `# Tell Claude Code to create a team:\n"Create a team called '${params.name}' to ${params.goal}"`;
    case 'task':
      return `# Tell Claude Code to create a task:\n"Add a task: ${params.subject} - ${params.description}"`;
    case 'update':
      return `# Tell Claude Code to update task status:\n"Mark task '${params.taskId}' as ${params.status}"`;
    case 'delete':
      return `# Tell Claude Code to delete team:\n"Disband the team '${params.teamId}'"`;
    default:
      return '';
  }
}
