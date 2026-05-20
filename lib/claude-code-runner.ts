// Claude Code Runner - Spawn and manage Claude Code sessions from Mission Control

export interface ClaudeSession {
  id: string;
  name: string;
  status: 'starting' | 'running' | 'idle' | 'stopped' | 'error';
  type: 'lead' | 'teammate' | 'solo';
  teamId?: string;
  taskId?: string;
  workspace: string;
  output: string[];
  startedAt: Date;
  lastActivity: Date;
  pid?: number;
}

export interface SessionEvent {
  sessionId: string;
  type: 'output' | 'status' | 'message' | 'error' | 'team_create' | 'task_update';
  data: any;
  timestamp: Date;
}

// Session manager state
let sessions: Map<string, ClaudeSession> = new Map();
let eventHandlers: ((event: SessionEvent) => void)[] = [];

export function getSessions(): ClaudeSession[] {
  return Array.from(sessions.values());
}

export function getSession(id: string): ClaudeSession | undefined {
  return sessions.get(id);
}

export function onSessionEvent(handler: (event: SessionEvent) => void): () => void {
  eventHandlers.push(handler);
  return () => {
    eventHandlers = eventHandlers.filter(h => h !== handler);
  };
}

function emitEvent(event: SessionEvent) {
  eventHandlers.forEach(h => {
    try {
      h(event);
    } catch (e) {
      console.error('Event handler error:', e);
    }
  });
}

export function updateSession(id: string, updates: Partial<ClaudeSession>) {
  const session = sessions.get(id);
  if (session) {
    Object.assign(session, updates, { lastActivity: new Date() });
    emitEvent({
      sessionId: id,
      type: 'status',
      data: { status: session.status, ...updates },
      timestamp: new Date(),
    });
  }
}

export function appendOutput(id: string, output: string) {
  const session = sessions.get(id);
  if (session) {
    session.output.push(output);
    session.lastActivity = new Date();
    
    // Keep only last 1000 lines per session
    if (session.output.length > 1000) {
      session.output = session.output.slice(-1000);
    }
    
    emitEvent({
      sessionId: id,
      type: 'output',
      data: output,
      timestamp: new Date(),
    });
  }
}

export function createSession(config: {
  name: string;
  workspace: string;
  type: 'lead' | 'teammate' | 'solo';
  teamId?: string;
  taskId?: string;
}): ClaudeSession {
  const id = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  
  const session: ClaudeSession = {
    id,
    name: config.name,
    status: 'starting',
    type: config.type,
    teamId: config.teamId,
    taskId: config.taskId,
    workspace: config.workspace,
    output: [],
    startedAt: new Date(),
    lastActivity: new Date(),
  };
  
  sessions.set(id, session);
  
  emitEvent({
    sessionId: id,
    type: 'status',
    data: { status: 'starting', session },
    timestamp: new Date(),
  });
  
  return session;
}

export function removeSession(id: string) {
  const session = sessions.get(id);
  if (session) {
    sessions.delete(id);
    emitEvent({
      sessionId: id,
      type: 'status',
      data: { status: 'removed' },
      timestamp: new Date(),
    });
  }
}

// Parse Claude Code output for team-related events
export function parseClaudeOutput(sessionId: string, line: string) {
  // Detect team creation
  if (line.includes('team_create') || line.includes('Creating team')) {
    emitEvent({
      sessionId,
      type: 'team_create',
      data: { raw: line },
      timestamp: new Date(),
    });
  }
  
  // Detect task updates
  if (line.includes('task_update') || line.includes('Task status')) {
    emitEvent({
      sessionId,
      type: 'task_update',
      data: { raw: line },
      timestamp: new Date(),
    });
  }
  
  // Detect agent messages
  if (line.includes('send_message') || line.includes('→')) {
    emitEvent({
      sessionId,
      type: 'message',
      data: { raw: line },
      timestamp: new Date(),
    });
  }
}
