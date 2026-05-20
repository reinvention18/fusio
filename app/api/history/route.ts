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

// Find transcripts directory
function findTranscriptsDir(): string | null {
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
        
        // OpenClaw transcript format: type="message" with nested message object
        if (entry.type === 'message' && entry.message) {
          const msg = entry.message;
          messages.push({
            role: msg.role,
            content: msg.content,
            timestamp: entry.timestamp,
          });
        }
        // Also support simple role/content format
        else if (entry.role && entry.content) {
          messages.push(entry);
        }
      } catch {
        // Skip invalid lines
      }
    }
    return messages;
  } catch (error) {
    console.error('[History] Error parsing transcript:', filePath, error);
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

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const action = searchParams.get('action') || 'list';
  const sessionId = searchParams.get('session');

  try {
    const transcriptsDir = findTranscriptsDir();
    
    if (!transcriptsDir) {
      return NextResponse.json({
        error: 'OpenClaw transcripts directory not found',
        sessions: [],
      });
    }

    if (action === 'list') {
      // List all transcript files
      const files = fs.readdirSync(transcriptsDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const filePath = path.join(transcriptsDir, f);
          const stats = fs.statSync(filePath);
          
          // Read first and last few lines for preview
          const messages = parseTranscript(filePath);
          const userMessages = messages.filter(m => m.role === 'user');
          const lastUserMsg = userMessages[userMessages.length - 1];
          
          return {
            id: f.replace('.jsonl', ''),
            filename: f,
            path: filePath,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            messageCount: messages.length,
            lastMessage: lastUserMsg ? extractContent(lastUserMsg.content).slice(0, 100) : null,
            lastActivity: stats.mtime.toISOString(),
          };
        })
        .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

      return NextResponse.json({
        transcriptsDir,
        sessions: files,
      });
    }

    if (action === 'history' && sessionId) {
      // Find the transcript file
      const possibleFiles = [
        `${sessionId}.jsonl`,
        sessionId,
      ];
      
      let transcriptPath: string | null = null;
      for (const f of possibleFiles) {
        const fullPath = path.join(transcriptsDir, f);
        if (fs.existsSync(fullPath)) {
          transcriptPath = fullPath;
          break;
        }
      }

      if (!transcriptPath) {
        return NextResponse.json({ error: 'Session not found', messages: [] });
      }

      const rawMessages = parseTranscript(transcriptPath);
      
      // Transform messages for display
      const messages = rawMessages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({
          role: m.role,
          content: extractContent(m.content),
          timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : null,
        }));

      return NextResponse.json({
        sessionId,
        path: transcriptPath,
        messages,
        rawCount: rawMessages.length,
      });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

  } catch (error: any) {
    console.error('[History] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to read history' },
      { status: 500 }
    );
  }
}
