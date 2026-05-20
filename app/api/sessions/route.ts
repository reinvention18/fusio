import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Find OpenClaw data directory
function findOpenClawDir(): string | null {
  const possiblePaths = [
    path.join(os.homedir(), '.openclaw'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'openclaw'),
    path.join(os.homedir(), '.config', 'openclaw'),
    '/var/lib/openclaw',
  ];
  
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

// Find sessions/transcripts directory
function findSessionsDir(): string | null {
  const openclawDir = findOpenClawDir();
  if (!openclawDir) return null;
  
  const possiblePaths = [
    path.join(openclawDir, 'agents', 'main', 'sessions'),
    path.join(openclawDir, 'transcripts'),
    path.join(openclawDir, 'data', 'transcripts'),
    path.join(openclawDir, 'sessions'),
  ];
  
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

interface TranscriptMessage {
  role: string;
  content: any;
  timestamp?: number;
}

// Parse JSONL transcript file
function parseTranscript(filePath: string): TranscriptMessage[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    const messages: TranscriptMessage[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        
        if (entry.type === 'message' && entry.message) {
          const msg = entry.message;
          messages.push({
            role: msg.role,
            content: msg.content,
            timestamp: entry.timestamp,
          });
        } else if (entry.role && entry.content) {
          messages.push(entry);
        }
      } catch {
        // Skip invalid lines
      }
    }
    return messages;
  } catch (error) {
    console.error('[Sessions] Error parsing transcript:', filePath, error);
    return [];
  }
}

// Extract text content from message
function extractContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }
  return '';
}

// Parse session key to extract parts
function parseSessionKey(filename: string): { agent: string; kind: string; name: string } {
  // Format: agent:kind:name.jsonl or similar
  const base = filename.replace('.jsonl', '');
  const parts = base.split(/[:\-_]/);
  
  if (parts.length >= 3) {
    return {
      agent: parts[0] || 'main',
      kind: parts[1] || 'main',
      name: parts[2] || base,
    };
  }
  
  return { agent: 'main', kind: 'main', name: base };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { gatewayUrl, token, action } = body;

    if (action === 'list') {
      // First, try to get sessions from local transcript files
      const sessionsDir = findSessionsDir();
      const sessions: any[] = [];
      
      if (sessionsDir) {
        try {
          const files = fs.readdirSync(sessionsDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => {
              const filePath = path.join(sessionsDir, f);
              const stats = fs.statSync(filePath);
              const parsed = parseSessionKey(f);
              
              // Get last message preview
              const messages = parseTranscript(filePath);
              const userMessages = messages.filter(m => m.role === 'user');
              const lastUserMsg = userMessages[userMessages.length - 1];
              
              return {
                sessionKey: f.replace('.jsonl', ''),
                filename: f,
                path: filePath,
                agent: parsed.agent,
                kind: parsed.kind,
                name: parsed.name,
                size: stats.size,
                modified: stats.mtime.toISOString(),
                messageCount: messages.length,
                lastMessage: lastUserMsg ? {
                  role: 'user',
                  content: extractContent(lastUserMsg.content).slice(0, 100),
                } : null,
                lastActivity: stats.mtime.toISOString(),
              };
            })
            .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

          sessions.push(...files);
        } catch (error) {
          console.error('[Sessions] Error reading sessions dir:', error);
        }
      }

      // Optionally try to get live session info from gateway
      if (gatewayUrl && token) {
        try {
          const httpUrl = gatewayUrl.replace('ws://', 'http://').replace('wss://', 'https://');
          const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        'X-OpenClaw-Scopes': 'operator.read,operator.write',
          };

          // Try different endpoints
          const endpoints = ['/api/sessions', '/sessions', '/v1/sessions'];
          
          for (const endpoint of endpoints) {
            try {
              const response = await fetch(`${httpUrl}${endpoint}`, { 
                headers,
                signal: AbortSignal.timeout(3000),
              });
              
              if (response.ok) {
                const data = await response.json();
                // Merge with local sessions if available
                if (data.sessions && Array.isArray(data.sessions)) {
                  // Mark gateway sessions
                  for (const s of data.sessions) {
                    const existing = sessions.find(
                      local => local.sessionKey === s.sessionKey || local.sessionKey === s.key
                    );
                    if (existing) {
                      existing.live = true;
                      existing.gatewayData = s;
                    } else {
                      sessions.unshift({
                        ...s,
                        sessionKey: s.sessionKey || s.key,
                        live: true,
                      });
                    }
                  }
                }
                break;
              }
            } catch {
              // Continue to next endpoint
            }
          }
        } catch (error) {
          console.error('[Sessions] Gateway fetch error:', error);
        }
      }

      return NextResponse.json({
        sessions,
        source: sessionsDir ? 'local' : 'gateway',
        sessionsDir,
      });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

  } catch (error: any) {
    console.error('[Sessions] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch sessions' },
      { status: 500 }
    );
  }
}
