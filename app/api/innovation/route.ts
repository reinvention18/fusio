import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

// Data file paths
const DATA_DIR = path.join(process.cwd(), 'data');
const SUBJECTS_FILE = path.join(DATA_DIR, 'innovation-subjects.json');
const SUGGESTIONS_FILE = path.join(DATA_DIR, 'innovation-suggestions.json');
const INSIGHTS_FILE = path.join(DATA_DIR, 'innovation-insights.json');

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    // Ignore if exists
  }
}

// Read JSON file with fallback
async function readJsonFile(filePath: string, defaultValue: any = []) {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return defaultValue;
  }
}

// Write JSON file
async function writeJsonFile(filePath: string, data: any) {
  await ensureDataDir();
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

// Get gateway config - read from config.json if exists
async function getGatewayConfig(): Promise<{ url: string; token: string }> {
  // Try to read from config file first
  try {
    const configPath = path.join(DATA_DIR, 'gateway-config.json');
    const configData = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configData);
    return {
      url: config.url || 'http://localhost:18789',
      token: config.token || '',
    };
  } catch {
    // Fall back to environment variables
    return {
      url: process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18789',
      token: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    };
  }
}

// Generate a suggestion using the OpenClaw gateway
async function generateSuggestion(subject: any, gatewayConfig?: { url: string; token: string }): Promise<any> {
  const { url, token } = gatewayConfig || await getGatewayConfig();
  
  if (!token) {
    throw new Error('No gateway token configured');
  }

  // Build context about what to analyze
  const foldersList = subject.folders.join('\n- ');
  const focusAreas = subject.researchFocus?.join(', ') || 'features, improvements';
  
  const prompt = `You are an AI Product Manager analyzing a codebase for improvement opportunities.

## Subject: ${subject.title}
${subject.description}

## Folders to analyze:
- ${foldersList}

## Focus areas: ${focusAreas}

## Your Task:
1. Analyze the codebase structure and patterns in the folders above
2. Research current industry best practices for similar applications
3. Identify ONE specific, actionable improvement or feature suggestion

## Output Format (JSON):
{
  "title": "Short descriptive title",
  "type": "feature|improvement|fix|refactor|security|performance",
  "problem": "Clear description of the current problem or gap (2-3 sentences)",
  "solution": "Proposed solution (2-3 sentences)",
  "reasoning": "Why this matters and how you discovered it (include research)",
  "difficulty": "easy|medium|hard",
  "estimatedHours": number,
  "sources": [
    { "type": "code|web|chat|dependency", "title": "Source name", "url": "optional" }
  ],
  "implementationSteps": [
    "Step 1...",
    "Step 2...",
    "Step 3..."
  ]
}

Be specific and practical. Focus on high-impact, achievable improvements.
Output ONLY the JSON object, no markdown or explanation.`;

  try {
    // Call the OpenClaw chat API
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-OpenClaw-Scopes': 'operator.read,operator.write',
      },
      body: JSON.stringify({
        model: 'openclaw:main',
        messages: [
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`Gateway error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    
    // Parse the JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }
    
    const suggestion = JSON.parse(jsonMatch[0]);
    
    return {
      id: crypto.randomUUID(),
      subjectId: subject.id,
      subjectTitle: subject.title,
      status: 'new',
      createdAt: new Date().toISOString(),
      ...suggestion,
    };
  } catch (error) {
    console.error('Failed to generate suggestion:', error);
    throw error;
  }
}

// Spawn an agent to implement a suggestion
async function implementSuggestion(suggestion: any, gatewayConfig?: { url: string; token: string }): Promise<void> {
  const { url, token } = gatewayConfig || await getGatewayConfig();
  
  if (!token) {
    throw new Error('No gateway token configured');
  }

  const task = `Implement the following feature/improvement:

## ${suggestion.title}

### Problem
${suggestion.problem}

### Solution
${suggestion.solution}

### Implementation Steps
${suggestion.implementationSteps.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}

### Notes
- Difficulty: ${suggestion.difficulty}
- Estimated time: ${suggestion.estimatedHours} hours
- Type: ${suggestion.type}

Please:
1. Create an OpenSpec proposal for this change
2. Implement the changes following best practices
3. Add appropriate tests
4. Update documentation if needed

Start by analyzing the codebase structure and creating the proposal.`;

  try {
    // Use sessions_spawn equivalent via gateway
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-OpenClaw-Scopes': 'operator.read,operator.write',
      },
      body: JSON.stringify({
        model: 'openclaw:main',
        messages: [
          { role: 'user', content: task }
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Gateway error: ${response.status}`);
    }
  } catch (error) {
    console.error('Failed to spawn implementation agent:', error);
    throw error;
  }
}

export async function GET(request: NextRequest) {
  await ensureDataDir();
  
  try {
    const [subjects, suggestions, insights] = await Promise.all([
      readJsonFile(SUBJECTS_FILE, []),
      readJsonFile(SUGGESTIONS_FILE, []),
      readJsonFile(INSIGHTS_FILE, []),
    ]);

    return NextResponse.json({
      subjects,
      suggestions: suggestions.sort((a: any, b: any) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
      insights,
    });
  } catch (error) {
    console.error('Failed to load innovation data:', error);
    return NextResponse.json(
      { error: 'Failed to load data' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  await ensureDataDir();
  
  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      case 'save-subject': {
        const { subject } = body;
        const subjects = await readJsonFile(SUBJECTS_FILE, []);
        
        const existingIndex = subjects.findIndex((s: any) => s.id === subject.id);
        if (existingIndex >= 0) {
          subjects[existingIndex] = subject;
        } else {
          subjects.push(subject);
        }
        
        await writeJsonFile(SUBJECTS_FILE, subjects);
        return NextResponse.json({ success: true, subject });
      }

      case 'delete-subject': {
        const { subjectId } = body;
        let subjects = await readJsonFile(SUBJECTS_FILE, []);
        let suggestions = await readJsonFile(SUGGESTIONS_FILE, []);
        
        subjects = subjects.filter((s: any) => s.id !== subjectId);
        suggestions = suggestions.filter((s: any) => s.subjectId !== subjectId);
        
        await Promise.all([
          writeJsonFile(SUBJECTS_FILE, subjects),
          writeJsonFile(SUGGESTIONS_FILE, suggestions),
        ]);
        
        return NextResponse.json({ success: true });
      }

      case 'generate': {
        const { subjectId, gatewayUrl, token } = body;
        const subjects = await readJsonFile(SUBJECTS_FILE, []);
        const subject = subjects.find((s: any) => s.id === subjectId);
        
        if (!subject) {
          return NextResponse.json({ error: 'Subject not found' }, { status: 404 });
        }

        // Build gateway config from request or fall back to saved config
        const gatewayConfig = (gatewayUrl && token) 
          ? { url: gatewayUrl, token } 
          : undefined;

        try {
          const suggestion = await generateSuggestion(subject, gatewayConfig);
          
          const suggestions = await readJsonFile(SUGGESTIONS_FILE, []);
          suggestions.unshift(suggestion);
          await writeJsonFile(SUGGESTIONS_FILE, suggestions);
          
          // Update subject lastRun
          subject.lastRun = new Date().toISOString();
          subject.suggestionCount = (subject.suggestionCount || 0) + 1;
          const subjectIndex = subjects.findIndex((s: any) => s.id === subjectId);
          subjects[subjectIndex] = subject;
          await writeJsonFile(SUBJECTS_FILE, subjects);
          
          return NextResponse.json({ success: true, suggestion });
        } catch (error: any) {
          return NextResponse.json(
            { error: error.message || 'Failed to generate suggestion' },
            { status: 500 }
          );
        }
      }

      case 'update-status': {
        const { suggestionId, status } = body;
        const suggestions = await readJsonFile(SUGGESTIONS_FILE, []);
        
        const index = suggestions.findIndex((s: any) => s.id === suggestionId);
        if (index >= 0) {
          suggestions[index].status = status;
          if (status === 'implemented') {
            suggestions[index].implementedAt = new Date().toISOString();
          }
          await writeJsonFile(SUGGESTIONS_FILE, suggestions);
        }
        
        return NextResponse.json({ success: true });
      }

      case 'save-comment': {
        const { suggestionId, comment } = body;
        const suggestions = await readJsonFile(SUGGESTIONS_FILE, []);
        
        const index = suggestions.findIndex((s: any) => s.id === suggestionId);
        if (index >= 0) {
          suggestions[index].comments = comment;
          await writeJsonFile(SUGGESTIONS_FILE, suggestions);
        }
        
        return NextResponse.json({ success: true });
      }

      case 'implement': {
        const { suggestion } = body;
        
        try {
          await implementSuggestion(suggestion);
          return NextResponse.json({ success: true });
        } catch (error: any) {
          return NextResponse.json(
            { error: error.message || 'Failed to start implementation' },
            { status: 500 }
          );
        }
      }

      case 'save-insights': {
        const { insights } = body;
        await writeJsonFile(INSIGHTS_FILE, insights);
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Innovation API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
