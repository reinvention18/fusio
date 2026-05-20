// OpenClaw Gateway connection utilities

export interface GatewayConfig {
  url: string;
  token: string;
  workspace?: string;
}

export interface AgentStatus {
  status: 'idle' | 'working' | 'error';
  currentTask: string | null;
  lastHeartbeat: Date | null;
  nextHeartbeat: Date | null;
  bandwidth: number; // 0-100
  recentCommits: string[];
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  lastRun: Date | null;
  nextRun: Date | null;
  enabled: boolean;
  payload: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: 'queued' | 'in-progress' | 'completed';
  priority: number;
  momentum: number; // 0-100, how well it fits
  createdAt: Date;
  completedAt?: Date;
  details?: string;
}

export interface Session {
  key: string;
  kind: string;
  lastMessage: string;
  lastActivity: Date;
  messageCount: number;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  status: 'active' | 'idle' | 'offline';
  personality: string;
  currentTask?: string;
}

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: Date;
}

// Get gateway config from localStorage or defaults
export function getGatewayConfig(): GatewayConfig {
  if (typeof window === 'undefined') {
    return { url: 'ws://localhost:18789', token: '' };
  }
  
  const saved = localStorage.getItem('gatewayConfig');
  if (saved) {
    return JSON.parse(saved);
  }
  
  return {
    url: 'ws://localhost:18789',
    token: '',
  };
}

export function saveGatewayConfig(config: GatewayConfig) {
  localStorage.setItem('gatewayConfig', JSON.stringify(config));
}

// WebSocket connection class
export class OpenClawConnection {
  private ws: WebSocket | null = null;
  private config: GatewayConfig;
  private listeners: Map<string, Set<(data: any) => void>> = new Map();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connected = false;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = new URL(this.config.url);
        if (this.config.token) {
          wsUrl.searchParams.set('token', this.config.token);
        }

        this.ws = new WebSocket(wsUrl.toString());

        this.ws.onopen = () => {
          this.connected = true;
          this.emit('connected', {});
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            this.emit('message', data);
            if (data.type) {
              this.emit(data.type, data);
            }
          } catch (e) {
            console.error('Failed to parse message:', e);
          }
        };

        this.ws.onclose = () => {
          this.connected = false;
          this.emit('disconnected', {});
          this.scheduleReconnect();
        };

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          reject(error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(console.error);
    }, 5000);
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(data: any) {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(data));
    }
  }

  on(event: string, callback: (data: any) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
    return () => this.off(event, callback);
  }

  off(event: string, callback: (data: any) => void) {
    this.listeners.get(event)?.delete(callback);
  }

  private emit(event: string, data: any) {
    this.listeners.get(event)?.forEach((cb) => cb(data));
  }

  isConnected() {
    return this.connected;
  }
}

// REST API calls to gateway
export async function fetchFromGateway(
  endpoint: string,
  config: GatewayConfig
): Promise<any> {
  const httpUrl = config.url.replace('ws://', 'http://').replace('wss://', 'https://');
  const url = new URL(endpoint, httpUrl);
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  
  if (config.token) {
    headers['Authorization'] = `Bearer ${config.token}`;
  }

  const response = await fetch(url.toString(), { headers });
  if (!response.ok) {
    throw new Error(`Gateway request failed: ${response.statusText}`);
  }
  return response.json();
}
