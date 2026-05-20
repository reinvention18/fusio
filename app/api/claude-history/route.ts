/**
 * /api/claude-history — Browse native Claude Code session history.
 *
 * Reads from ~/.claude.json (project list) and ~/.claude/projects/{path}/*.jsonl
 * (session transcripts). This gives Mission Control access to all Claude Code
 * conversations, not just those started through Mission Control.
 *
 * Actions:
 *   GET ?action=projects         → list all Claude Code projects
 *   GET ?action=sessions&project=X  ��� list sessions for a project
 *   GET ?action=messages&project=X&session=Y → get messages from a session
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_CONFIG = path.join(os.homedir(), '.claude.json');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

interface TranscriptMessage {
  role: string;
  content: any;
  timestamp?: number;
}

function parseTranscript(filePath: string): TranscriptMessage[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    const messages: TranscriptMessage[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Claude Code format: { type: "assistant"|"user", message: { role, content } }
        if (entry.type === 'assistant' || entry.type === 'user') {
          const msg = entry.message || entry;
          if (msg.role && msg.content) {
            messages.push({
              role: msg.role,
              content: msg.content,
              timestamp: entry.timestamp,
            });
          }
        }
        // Also handle { type: "message", message: { role, content } } (OpenClaw format)
        else if (entry.type === 'message' && entry.message) {
          messages.push({
            role: entry.message.role,
            content: entry.message.content,
            timestamp: entry.timestamp,
          });
        }
        // Simple { role, content } format
        else if (entry.role && entry.content) {
          messages.push(entry);
        }
      } catch {
        // Skip invalid lines
      }
    }
    return messages;
  } catch {
    return [];
  }
}

function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
  }
  return '';
}

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get('action') || 'projects';
  const project = request.nextUrl.searchParams.get('project') || '';
  const session = request.nextUrl.searchParams.get('session') || '';

  try {
    // ── List projects ──
    if (action === 'projects') {
      const projects: any[] = [];

      // Read from ~/.claude.json
      try {
        const config = JSON.parse(fs.readFileSync(CLAUDE_CONFIG, 'utf-8'));
        const projectMap = config.projects || {};

        for (const [projectPath, meta] of Object.entries(projectMap)) {
          // Encode path the same way Claude Code does: replace / with -
          const encodedPath = projectPath.replace(/\//g, '-').replace(/^-/, '-');
          const sessionsDir = path.join(PROJECTS_DIR, encodedPath);
          let sessionCount = 0;
          let lastActivity = '';

          try {
            if (fs.existsSync(sessionsDir)) {
              const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
              sessionCount = files.length;
              if (files.length > 0) {
                const stats = files
                  .map(f => ({ f, mtime: fs.statSync(path.join(sessionsDir, f)).mtime }))
                  .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
                lastActivity = stats[0].mtime.toISOString();
              }
            }
          } catch {}

          projects.push({
            path: projectPath,
            encodedPath,
            sessionCount,
            lastActivity,
            ...(typeof meta === 'object' ? meta : {}),
          });
        }
      } catch {}

      // Also scan the projects directory for any not in config
      try {
        if (fs.existsSync(PROJECTS_DIR)) {
          const dirs = fs.readdirSync(PROJECTS_DIR);
          for (const dir of dirs) {
            if (projects.some(p => p.encodedPath === dir)) continue;
            const sessionsDir = path.join(PROJECTS_DIR, dir);
            if (!fs.statSync(sessionsDir).isDirectory()) continue;

            const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
            if (files.length === 0) continue;

            const stats = files
              .map(f => ({ f, mtime: fs.statSync(path.join(sessionsDir, f)).mtime }))
              .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

            projects.push({
              path: dir.replace(/^-/, '/').replace(/-/g, '/'),
              encodedPath: dir,
              sessionCount: files.length,
              lastActivity: stats[0].mtime.toISOString(),
            });
          }
        }
      } catch {}

      // Sort by last activity
      projects.sort((a, b) => {
        if (!a.lastActivity) return 1;
        if (!b.lastActivity) return -1;
        return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
      });

      return NextResponse.json({ projects });
    }

    // ── List sessions for a project ──
    if (action === 'sessions' && project) {
      const sessionsDir = path.join(PROJECTS_DIR, project);
      if (!fs.existsSync(sessionsDir)) {
        return NextResponse.json({ sessions: [], error: 'Project not found' });
      }

      const files = fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const filePath = path.join(sessionsDir, f);
          const stats = fs.statSync(filePath);
          const messages = parseTranscript(filePath);
          const userMsgs = messages.filter(m => m.role === 'user');
          const firstMsg = userMsgs[0];
          const lastMsg = userMsgs[userMsgs.length - 1];

          return {
            id: f.replace('.jsonl', ''),
            filename: f,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            messageCount: messages.length,
            firstMessage: firstMsg ? extractText(firstMsg.content).slice(0, 150) : null,
            lastMessage: lastMsg ? extractText(lastMsg.content).slice(0, 150) : null,
            lastActivity: stats.mtime.toISOString(),
          };
        })
        .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

      return NextResponse.json({ sessions: files });
    }

    // ── Get messages from a session ──
    if (action === 'messages' && project && session) {
      const sessionFile = session.endsWith('.jsonl') ? session : `${session}.jsonl`;
      const filePath = path.join(PROJECTS_DIR, project, sessionFile);

      if (!fs.existsSync(filePath)) {
        return NextResponse.json({ error: 'Session not found', messages: [] });
      }

      const rawMessages = parseTranscript(filePath);
      const messages = rawMessages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({
          role: m.role,
          content: extractText(m.content),
          timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : null,
        }));

      return NextResponse.json({ sessionId: session, messages, rawCount: rawMessages.length });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('[Claude History] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
