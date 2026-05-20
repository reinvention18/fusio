import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

interface QAConfig {
  targetUrl: string;
  credentials?: {
    email?: string;
    password?: string;
  };
  browser?: 'chrome' | 'openclaw';
}

interface QAState {
  status: 'idle' | 'running' | 'paused' | 'completed';
  targetUrl: string;
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  currentSection: string | null;
  currentItem: string | null;
  sections: {
    [key: string]: {
      status: 'pending' | 'running' | 'completed' | 'skipped';
      items: {
        [key: string]: 'pending' | 'passed' | 'failed' | 'skipped';
      };
    };
  };
  sampleData: Record<string, any>;
  issueCount: number;
}

interface QAIssue {
  id: string;
  timestamp: string;
  section: string;
  item: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
  screenshot?: string;
  steps?: string[];
}

function getQADir(workspace: string): string {
  return path.join(workspace, '.qa');
}

function ensureQADir(workspace: string): void {
  const qaDir = getQADir(workspace);
  if (!fs.existsSync(qaDir)) {
    fs.mkdirSync(qaDir, { recursive: true });
  }
}

function getConfig(workspace: string): QAConfig | null {
  const configPath = path.join(getQADir(workspace), 'config.json');
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
  return null;
}

function saveConfig(workspace: string, config: QAConfig): void {
  ensureQADir(workspace);
  const configPath = path.join(getQADir(workspace), 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function getState(workspace: string): QAState | null {
  const statePath = path.join(getQADir(workspace), 'state.json');
  if (fs.existsSync(statePath)) {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  }
  return null;
}

function saveState(workspace: string, state: QAState): void {
  ensureQADir(workspace);
  const statePath = path.join(getQADir(workspace), 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function getTestPlan(workspace: string): string | null {
  const planPath = path.join(getQADir(workspace), 'testplan.md');
  if (fs.existsSync(planPath)) {
    return fs.readFileSync(planPath, 'utf-8');
  }
  return null;
}

function saveTestPlan(workspace: string, plan: string): void {
  ensureQADir(workspace);
  const planPath = path.join(getQADir(workspace), 'testplan.md');
  fs.writeFileSync(planPath, plan);
}

function getIssues(workspace: string): QAIssue[] {
  const issuesPath = path.join(getQADir(workspace), 'issues.json');
  if (fs.existsSync(issuesPath)) {
    return JSON.parse(fs.readFileSync(issuesPath, 'utf-8'));
  }
  return [];
}

function saveIssues(workspace: string, issues: QAIssue[]): void {
  ensureQADir(workspace);
  const issuesPath = path.join(getQADir(workspace), 'issues.json');
  fs.writeFileSync(issuesPath, JSON.stringify(issues, null, 2));
}

function parseTestPlan(markdown: string): { [section: string]: string[] } {
  const sections: { [section: string]: string[] } = {};
  let currentSection = '';
  
  const lines = markdown.split('\n');
  for (const line of lines) {
    // Section header (## Section Name)
    const sectionMatch = line.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      sections[currentSection] = [];
      continue;
    }
    
    // Test item (- [ ] or - [x] Item name)
    const itemMatch = line.match(/^-\s+\[[ x]\]\s+(.+)$/);
    if (itemMatch && currentSection) {
      sections[currentSection].push(itemMatch[1].trim());
    }
  }
  
  return sections;
}

function initializeState(workspace: string, config: QAConfig, plan: string): QAState {
  const parsed = parseTestPlan(plan);
  const sections: QAState['sections'] = {};
  
  for (const [sectionName, items] of Object.entries(parsed)) {
    // Skip sections with no test items (e.g., "Target" section with just URL note)
    if (items.length === 0) continue;
    
    sections[sectionName] = {
      status: 'pending',
      items: {},
    };
    for (const item of items) {
      sections[sectionName].items[item] = 'pending';
    }
  }
  
  return {
    status: 'idle',
    targetUrl: config.targetUrl,
    startedAt: null,
    pausedAt: null,
    completedAt: null,
    currentSection: null,
    currentItem: null,
    sections,
    sampleData: {},
    issueCount: 0,
  };
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const workspace = searchParams.get('workspace');
  const action = searchParams.get('action') || 'status';

  if (!workspace) {
    return NextResponse.json({ error: 'Missing workspace parameter' }, { status: 400 });
  }

  if (!fs.existsSync(workspace)) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  try {
    switch (action) {
      case 'status': {
        const config = getConfig(workspace);
        const state = getState(workspace);
        const plan = getTestPlan(workspace);
        const issues = getIssues(workspace);
        
        // Calculate progress
        let total = 0;
        let completed = 0;
        if (state?.sections) {
          for (const section of Object.values(state.sections)) {
            for (const itemStatus of Object.values(section.items)) {
              total++;
              if (itemStatus === 'passed' || itemStatus === 'failed' || itemStatus === 'skipped') {
                completed++;
              }
            }
          }
        }
        
        return NextResponse.json({
          hasQA: fs.existsSync(getQADir(workspace)),
          config,
          state,
          plan,
          issues,
          progress: { total, completed, percent: total > 0 ? Math.round((completed / total) * 100) : 0 },
        });
      }
      
      case 'issues': {
        const issues = getIssues(workspace);
        return NextResponse.json({ issues });
      }
      
      case 'plan': {
        const plan = getTestPlan(workspace);
        return NextResponse.json({ plan });
      }
      
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { workspace, action, ...params } = body;

    if (!workspace) {
      return NextResponse.json({ error: 'Missing workspace' }, { status: 400 });
    }

    if (!fs.existsSync(workspace)) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    switch (action) {
      case 'init': {
        // Initialize QA for a workspace
        const { targetUrl, plan } = params;
        if (!targetUrl || !plan) {
          return NextResponse.json({ error: 'Missing targetUrl or plan' }, { status: 400 });
        }
        
        ensureQADir(workspace);
        const config: QAConfig = { targetUrl };
        saveConfig(workspace, config);
        saveTestPlan(workspace, plan);
        
        const state = initializeState(workspace, config, plan);
        saveState(workspace, state);
        saveIssues(workspace, []);
        
        return NextResponse.json({ success: true, state });
      }
      
      case 'start': {
        let state = getState(workspace);
        const config = getConfig(workspace);
        const plan = getTestPlan(workspace);
        
        if (!config) {
          return NextResponse.json({ error: 'QA not initialized - missing config' }, { status: 400 });
        }
        
        // If no state or empty sections, initialize from plan
        if (!state || !state.sections || Object.keys(state.sections).length === 0) {
          if (!plan) {
            return NextResponse.json({ error: 'QA not initialized - missing test plan' }, { status: 400 });
          }
          state = initializeState(workspace, config, plan);
        }
        
        state.status = 'running';
        state.startedAt = state.startedAt || new Date().toISOString();
        state.pausedAt = null;
        
        // Find first section with pending items
        for (const [sectionName, section] of Object.entries(state.sections)) {
          // Skip sections with no items
          if (Object.keys(section.items).length === 0) continue;
          
          if (section.status === 'pending' || section.status === 'running') {
            // Find first pending item in this section
            let foundItem = false;
            for (const [itemName, itemStatus] of Object.entries(section.items)) {
              if (itemStatus === 'pending') {
                state.currentSection = sectionName;
                section.status = 'running';
                state.currentItem = itemName;
                foundItem = true;
                break;
              }
            }
            
            if (foundItem) break;
            
            // No pending items in this section, mark it complete and continue
            section.status = 'completed';
          }
        }
        
        // If we didn't find any pending items, mark as completed
        if (!state.currentItem) {
          state.status = 'completed';
          state.completedAt = new Date().toISOString();
        }
        
        saveState(workspace, state);
        return NextResponse.json({ success: true, state });
      }
      
      case 'pause': {
        const state = getState(workspace);
        if (!state) {
          return NextResponse.json({ error: 'QA not initialized' }, { status: 400 });
        }
        
        state.status = 'paused';
        state.pausedAt = new Date().toISOString();
        saveState(workspace, state);
        
        return NextResponse.json({ success: true, state });
      }
      
      case 'resume': {
        const state = getState(workspace);
        if (!state) {
          return NextResponse.json({ error: 'QA not initialized' }, { status: 400 });
        }
        
        state.status = 'running';
        state.pausedAt = null;
        saveState(workspace, state);
        
        // If notify flag is set and gateway config provided, send wake message
        const { notify, gatewayUrl, gatewayToken } = params;
        if (notify && gatewayUrl && gatewayToken) {
          try {
            const httpUrl = gatewayUrl.replace('ws://', 'http://').replace('wss://', 'https://');
            const currentSection = state.currentSection || 'Unknown';
            const currentItem = state.currentItem || 'Unknown';
            const progress = `${Object.values(state.sections).flatMap(s => Object.values(s.items)).filter(s => s !== 'pending').length}/${Object.values(state.sections).flatMap(s => Object.values(s.items)).length}`;
            
            const wakeMessage = `🧪 QA Resume requested from Mission Control Dashboard.\n\nCurrent test: ${currentSection} → ${currentItem}\nProgress: ${progress}\n\nPlease continue testing the staging app at ${state.targetUrl}`;
            
            await fetch(`${httpUrl}/v1/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${gatewayToken}`,
                'X-OpenClaw-Scopes': 'operator.read,operator.write',
              },
              body: JSON.stringify({
                model: 'default',
                messages: [{ role: 'user', content: wakeMessage }],
                stream: false,
              }),
            });
          } catch (notifyError) {
            console.error('Failed to notify agent:', notifyError);
            // Don't fail the resume, just log the error
          }
        }
        
        return NextResponse.json({ success: true, state, notified: !!params.notify });
      }
      
      case 'update': {
        // Update test item status
        const { section, item, status, sampleData } = params;
        const state = getState(workspace);
        if (!state) {
          return NextResponse.json({ error: 'QA not initialized' }, { status: 400 });
        }
        
        if (section && item && status) {
          if (state.sections[section]) {
            state.sections[section].items[item] = status;
            
            // Check if section is complete
            const allDone = Object.values(state.sections[section].items).every(
              s => s === 'passed' || s === 'failed' || s === 'skipped'
            );
            if (allDone) {
              state.sections[section].status = 'completed';
              
              // Move to next section
              const sectionNames = Object.keys(state.sections);
              const currentIndex = sectionNames.indexOf(section);
              if (currentIndex < sectionNames.length - 1) {
                const nextSection = sectionNames[currentIndex + 1];
                state.currentSection = nextSection;
                state.sections[nextSection].status = 'running';
                state.currentItem = Object.keys(state.sections[nextSection].items)[0];
              } else {
                // All done
                state.status = 'completed';
                state.completedAt = new Date().toISOString();
                state.currentSection = null;
                state.currentItem = null;
              }
            } else {
              // Move to next item in section
              const itemNames = Object.keys(state.sections[section].items);
              const currentIndex = itemNames.indexOf(item);
              if (currentIndex < itemNames.length - 1) {
                state.currentItem = itemNames[currentIndex + 1];
              }
            }
          }
        }
        
        if (sampleData) {
          state.sampleData = { ...state.sampleData, ...sampleData };
        }
        
        saveState(workspace, state);
        return NextResponse.json({ success: true, state });
      }
      
      case 'addIssue': {
        const { section, item, severity, title, description, screenshot, steps } = params;
        const issues = getIssues(workspace);
        const state = getState(workspace);
        
        const issue: QAIssue = {
          id: `issue_${Date.now()}`,
          timestamp: new Date().toISOString(),
          section: section || state?.currentSection || 'Unknown',
          item: item || state?.currentItem || 'Unknown',
          severity: severity || 'medium',
          title,
          description,
          screenshot,
          steps,
        };
        
        issues.push(issue);
        saveIssues(workspace, issues);
        
        if (state) {
          state.issueCount = issues.length;
          saveState(workspace, state);
        }
        
        return NextResponse.json({ success: true, issue, total: issues.length });
      }
      
      case 'reset': {
        const config = getConfig(workspace);
        const plan = getTestPlan(workspace);
        
        if (config && plan) {
          const state = initializeState(workspace, config, plan);
          saveState(workspace, state);
          saveIssues(workspace, []);
          return NextResponse.json({ success: true, state });
        }
        
        return NextResponse.json({ error: 'Cannot reset - missing config or plan' }, { status: 400 });
      }
      
      case 'updateConfig': {
        const config = getConfig(workspace) || { targetUrl: '' };
        const newConfig = { ...config, ...params.config };
        saveConfig(workspace, newConfig);
        return NextResponse.json({ success: true, config: newConfig });
      }
      
      case 'updatePlan': {
        const { plan } = params;
        if (!plan) {
          return NextResponse.json({ error: 'Missing plan' }, { status: 400 });
        }
        saveTestPlan(workspace, plan);
        
        // Re-initialize state with new plan
        const config = getConfig(workspace);
        if (config) {
          const state = initializeState(workspace, config, plan);
          saveState(workspace, state);
        }
        
        return NextResponse.json({ success: true });
      }
      
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
