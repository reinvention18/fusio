// ⚠️ DEPRECATED: Multi-agent management (localStorage-based)
// This file is no longer used by AgentHub.tsx, which now reads real OpenClaw sessions.
// Kept for reference only. Safe to delete if no other components import from here.

import { Agent, AgentMessage } from './openclaw';

const AGENTS_KEY = 'missionControlAgents';
const MESSAGES_KEY = 'missionControlMessages';

// Default agents
const DEFAULT_AGENTS: Agent[] = [
  {
    id: 'jarvis',
    name: 'Jarvis',
    role: 'Commander',
    status: 'active',
    personality: 'Strategic leader. Delegates tasks, monitors progress, and coordinates between sub-agents.',
  },
  {
    id: 'architect',
    name: 'Architect',
    role: 'System Auditor',
    status: 'idle',
    personality: 'Perfectionist. Audits Mission Control daily, finds bugs, suggests improvements.',
  },
];

export function getAgents(): Agent[] {
  if (typeof window === 'undefined') return DEFAULT_AGENTS;
  
  const saved = localStorage.getItem(AGENTS_KEY);
  if (saved) {
    return JSON.parse(saved);
  }
  
  // Initialize with defaults
  saveAgents(DEFAULT_AGENTS);
  return DEFAULT_AGENTS;
}

export function saveAgents(agents: Agent[]) {
  localStorage.setItem(AGENTS_KEY, JSON.stringify(agents));
}

export function addAgent(agent: Omit<Agent, 'id'>): Agent {
  const agents = getAgents();
  const newAgent: Agent = {
    ...agent,
    id: crypto.randomUUID(),
  };
  agents.push(newAgent);
  saveAgents(agents);
  return newAgent;
}

export function updateAgent(id: string, updates: Partial<Agent>): Agent | null {
  const agents = getAgents();
  const index = agents.findIndex((a) => a.id === id);
  if (index === -1) return null;
  
  agents[index] = { ...agents[index], ...updates };
  saveAgents(agents);
  return agents[index];
}

export function deleteAgent(id: string): boolean {
  // Prevent deleting Jarvis
  if (id === 'jarvis') return false;
  
  const agents = getAgents();
  const filtered = agents.filter((a) => a.id !== id);
  if (filtered.length === agents.length) return false;
  
  saveAgents(filtered);
  return true;
}

// Agent messages (simulated hub communication)
export function getMessages(): AgentMessage[] {
  if (typeof window === 'undefined') return [];
  
  const saved = localStorage.getItem(MESSAGES_KEY);
  if (saved) {
    const messages = JSON.parse(saved);
    return messages.map((m: any) => ({
      ...m,
      timestamp: new Date(m.timestamp),
    }));
  }
  return [];
}

export function saveMessages(messages: AgentMessage[]) {
  // Keep only last 100 messages
  const trimmed = messages.slice(-100);
  localStorage.setItem(MESSAGES_KEY, JSON.stringify(trimmed));
}

export function addMessage(from: string, to: string, content: string): AgentMessage {
  const messages = getMessages();
  const newMessage: AgentMessage = {
    id: crypto.randomUUID(),
    from,
    to,
    content,
    timestamp: new Date(),
  };
  messages.push(newMessage);
  saveMessages(messages);
  return newMessage;
}

export function clearMessages() {
  localStorage.removeItem(MESSAGES_KEY);
}
