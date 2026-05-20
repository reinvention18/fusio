// OpenClaw Gateway WebSocket Chat Client

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  attachments?: { name: string; type: string; url: string }[];
}

export interface GatewayConfig {
  url: string;
  token: string;
}

type MessageHandler = (message: ChatMessage) => void;
type StatusHandler = (connected: boolean) => void;

class GatewayChatClient {
  private ws: WebSocket | null = null;
  private config: GatewayConfig = { url: 'ws://localhost:18789', token: '' };
  private messageHandlers: MessageHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pendingMessages: Map<string, (response: any) => void> = new Map();

  connect(config: GatewayConfig) {
    this.config = config;
    this.doConnect();
  }

  private doConnect() {
    if (this.ws) {
      this.ws.close();
    }

    try {
      const wsUrl = this.config.url.startsWith('http') 
        ? this.config.url.replace('http', 'ws')
        : this.config.url;
      
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[Gateway] Connected');
        // Authenticate
        if (this.config.token) {
          this.send({ type: 'auth', token: this.config.token });
        }
        this.notifyStatus(true);
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (e) {
          console.error('[Gateway] Failed to parse message:', e);
        }
      };

      this.ws.onclose = () => {
        console.log('[Gateway] Disconnected');
        this.notifyStatus(false);
        this.scheduleReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('[Gateway] WebSocket error:', error);
        this.notifyStatus(false);
      };
    } catch (e) {
      console.error('[Gateway] Failed to connect:', e);
      this.notifyStatus(false);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, 5000);
  }

  private send(data: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private handleMessage(data: any) {
    // Handle different message types from gateway
    if (data.type === 'chat.message' || data.type === 'message') {
      const message: ChatMessage = {
        id: data.id || crypto.randomUUID(),
        role: data.role || 'assistant',
        content: data.content || data.text || '',
        timestamp: new Date(data.timestamp || Date.now()),
      };
      this.notifyMessage(message);
    } else if (data.type === 'chat.history') {
      // Handle history response
      if (data.messages && Array.isArray(data.messages)) {
        data.messages.forEach((msg: any) => {
          const message: ChatMessage = {
            id: msg.id || crypto.randomUUID(),
            role: msg.role || 'user',
            content: msg.content || msg.text || '',
            timestamp: new Date(msg.timestamp || Date.now()),
          };
          this.notifyMessage(message);
        });
      }
    } else if (data.type === 'response' && data.requestId) {
      // Handle response to a pending request
      const handler = this.pendingMessages.get(data.requestId);
      if (handler) {
        handler(data);
        this.pendingMessages.delete(data.requestId);
      }
    } else if (data.content || data.text) {
      // Generic message with content
      const message: ChatMessage = {
        id: data.id || crypto.randomUUID(),
        role: data.role || 'assistant',
        content: data.content || data.text || '',
        timestamp: new Date(data.timestamp || Date.now()),
      };
      this.notifyMessage(message);
    }
  }

  async sendChatMessage(content: string, attachments?: any[]): Promise<void> {
    const requestId = crypto.randomUUID();
    
    this.send({
      type: 'chat.send',
      requestId,
      message: content,
      attachments: attachments?.map(a => ({
        name: a.name,
        type: a.type,
        data: a.url, // base64 data URL
      })),
    });
  }

  async getHistory(): Promise<void> {
    this.send({
      type: 'chat.history',
      limit: 50,
    });
  }

  onMessage(handler: MessageHandler) {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter(h => h !== handler);
    };
  }

  onStatus(handler: StatusHandler) {
    this.statusHandlers.push(handler);
    return () => {
      this.statusHandlers = this.statusHandlers.filter(h => h !== handler);
    };
  }

  private notifyMessage(message: ChatMessage) {
    this.messageHandlers.forEach(h => h(message));
  }

  private notifyStatus(connected: boolean) {
    this.statusHandlers.forEach(h => h(connected));
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

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

// Singleton instance
export const gatewayChatClient = new GatewayChatClient();
