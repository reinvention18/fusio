import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

const BUNDLED_SKILLS_DIR = '/usr/lib/node_modules/openclaw/skills';
const WORKSPACE_SKILLS_DIR = path.join(os.homedir(), '.openclaw', 'workspace', 'skills');

// For toggle operations (default to workspace dir)
const SKILLS_DIR = process.env.SKILLS_DIR || WORKSPACE_SKILLS_DIR;

interface SkillRequires {
  bins?: string[];
  anyBins?: string[];
  npm?: string[];
  anyNpm?: string[];
}

interface InstallRecipeItem {
  id: string;
  kind: string;
  package?: string;
  bins?: string[];
  label?: string;
}

interface Skill {
  name: string;
  description: string;
  enabled: boolean;
  path: string;
  version?: string;
  category: 'bundled' | 'workspace';
  requirements: SkillRequires | null;
  installRecipe: InstallRecipeItem[] | null;
  requirementsMet: boolean;
}

// Check if a binary exists in PATH
function binExists(bin: string): boolean {
  try {
    const result = require('child_process').execSync(`which ${bin} 2>/dev/null`, { timeout: 2000 });
    return !!result.toString().trim();
  } catch {
    return false;
  }
}

// Check if requirements are met
function checkRequirements(requires: SkillRequires | null): boolean {
  if (!requires) return true;

  if (requires.bins && requires.bins.length > 0) {
    if (!requires.bins.every(binExists)) return false;
  }

  if (requires.anyBins && requires.anyBins.length > 0) {
    if (!requires.anyBins.some(binExists)) return false;
  }

  return true;
}

// Parse YAML frontmatter from SKILL.md
function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const fm: Record<string, any> = {};
  const raw = match[1];

  // Parse simple key: value pairs (non-nested)
  const lines = raw.split('\n');
  for (const line of lines) {
    const m = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (m) {
      fm[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }

  // Parse metadata: <json> specially (may span multiple lines as a JSON block)
  const metaMatch = raw.match(/^metadata:\s*(\{[\s\S]*?\})\s*$/m);
  if (metaMatch) {
    try {
      fm['metadata'] = JSON.parse(metaMatch[1]);
    } catch {
      // try multiline JSON
      const metaIdx = raw.indexOf('metadata:');
      if (metaIdx !== -1) {
        const rest = raw.slice(metaIdx + 'metadata:'.length).trim();
        // Find balanced JSON object
        let depth = 0, start = rest.indexOf('{'), end = -1;
        if (start !== -1) {
          for (let i = start; i < rest.length; i++) {
            if (rest[i] === '{') depth++;
            else if (rest[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
          }
          if (end !== -1) {
            try { fm['metadata'] = JSON.parse(rest.slice(start, end + 1)); } catch { /* ignore */ }
          }
        }
      }
    }
  }

  // Parse requires: as YAML inline or block
  const requiresMatch = raw.match(/^requires:\s*(.+)$/m);
  if (requiresMatch) {
    const val = requiresMatch[1].trim();
    // inline JSON object
    if (val.startsWith('{')) {
      try { fm['requires'] = JSON.parse(val); } catch { /* ignore */ }
    }
  }

  return fm;
}

// Extract requires/install from parsed frontmatter
function extractSkillMeta(fm: Record<string, any>): {
  requires: SkillRequires | null;
  installRecipe: InstallRecipeItem[] | null;
} {
  let requires: SkillRequires | null = null;
  let installRecipe: InstallRecipeItem[] | null = null;

  // Check top-level requires field
  if (fm.requires && typeof fm.requires === 'object') {
    requires = fm.requires as SkillRequires;
  }

  // Check metadata.openclaw or metadata.clawdbot
  const meta = fm.metadata;
  if (meta) {
    const provider = meta.openclaw || meta.clawdbot;
    if (provider) {
      if (provider.requires && !requires) {
        requires = provider.requires as SkillRequires;
      }
      if (provider.install && Array.isArray(provider.install)) {
        installRecipe = provider.install as InstallRecipeItem[];
      }
    }
  }

  return { requires, installRecipe };
}

// Read skill metadata from SKILL.md
async function getSkillMetadata(skillPath: string): Promise<Partial<Skill>> {
  const skillFile = path.join(skillPath, 'SKILL.md');
  try {
    if (!fs.existsSync(skillFile)) return {};

    const content = fs.readFileSync(skillFile, 'utf-8');
    const fm = parseFrontmatter(content);
    const { requires, installRecipe } = extractSkillMeta(fm);

    // Fallback name from # Title
    let name = fm.name;
    if (!name) {
      const titleMatch = content.match(/^#\s+(.+)/m);
      name = titleMatch?.[1]?.trim();
    }

    return {
      name,
      description: fm.description,
      version: fm.version,
      requirements: requires,
      installRecipe,
    };
  } catch {
    return {};
  }
}

// Check if skill is enabled (not a .disabled file)
function isSkillEnabled(skillPath: string): boolean {
  return !fs.existsSync(path.join(skillPath, '.disabled'));
}

// List skills from a directory with a given category
async function listSkillsFromDir(dir: string, category: 'bundled' | 'workspace'): Promise<Skill[]> {
  const skills: Skill[] = [];

  if (!fs.existsSync(dir)) return skills;

  const dirs = fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const dirName of dirs) {
    const skillPath = path.join(dir, dirName);
    const metadata = await getSkillMetadata(skillPath);
    const enabled = isSkillEnabled(skillPath);
    const requirementsMet = checkRequirements(metadata.requirements || null);

    skills.push({
      name: metadata.name || dirName,
      description: metadata.description || '',
      enabled,
      path: skillPath,
      version: metadata.version,
      category,
      requirements: metadata.requirements || null,
      installRecipe: metadata.installRecipe || null,
      requirementsMet,
    });
  }

  return skills;
}

// List all installed skills from both dirs
async function listAllSkills(): Promise<Skill[]> {
  const [bundled, workspace] = await Promise.all([
    listSkillsFromDir(BUNDLED_SKILLS_DIR, 'bundled'),
    listSkillsFromDir(WORKSPACE_SKILLS_DIR, 'workspace'),
  ]);

  // Merge: workspace overrides bundled by name
  const wsNames = new Set(workspace.map(s => s.name.toLowerCase()));
  const filteredBundled = bundled.filter(s => !wsNames.has(s.name.toLowerCase()));

  return [...filteredBundled, ...workspace].sort((a, b) => a.name.localeCompare(b.name));
}

// Toggle skill enabled/disabled
function toggleSkill(skillDirName: string, enabled: boolean): boolean {
  // Try workspace first, then bundled
  const candidates = [
    path.join(WORKSPACE_SKILLS_DIR, skillDirName),
    path.join(BUNDLED_SKILLS_DIR, skillDirName),
  ];

  const skillPath = candidates.find(p => fs.existsSync(p));
  if (!skillPath) return false;

  const disabledFile = path.join(skillPath, '.disabled');
  if (enabled) {
    if (fs.existsSync(disabledFile)) fs.unlinkSync(disabledFile);
  } else {
    fs.writeFileSync(disabledFile, 'Disabled by Mission Control');
  }

  return true;
}

// Search ClawHub for skills
async function searchSkills(query: string): Promise<any[]> {
  try {
    const { stdout } = await execAsync(`clawhub search "${query}"`, {
      timeout: 30000,
      cwd: WORKSPACE_SKILLS_DIR,
    });

    const lines = stdout.split('\n').filter(l => l.trim() && !l.includes('Searching'));
    const results: any[] = [];

    for (const line of lines) {
      const match = line.match(/^(\S+)\s+v?([\d.]+)\s+(.+?)\s+\(([\d.]+)\)$/);
      if (match) {
        results.push({
          slug: match[1],
          version: match[2],
          description: match[3].trim(),
          score: parseFloat(match[4]),
        });
      }
    }

    return results;
  } catch (e: any) {
    console.error('[Skills] Search error:', e.message);
    return [];
  }
}

// Install a skill from ClawHub
async function installSkill(slug: string): Promise<{ success: boolean; message: string }> {
  try {
    const { stdout, stderr } = await execAsync(
      `clawhub install ${slug} --workdir "${path.dirname(WORKSPACE_SKILLS_DIR)}"`,
      { timeout: 60000 }
    );

    if (stdout.includes('OK. Installed') || stdout.includes('√')) {
      return { success: true, message: `Installed ${slug}` };
    }

    return { success: false, message: stderr || stdout || 'Unknown error' };
  } catch (e: any) {
    return { success: false, message: e.message };
  }
}

// Uninstall a skill (workspace only)
async function uninstallSkill(skillDirName: string): Promise<{ success: boolean; message: string }> {
  const skillPath = path.join(WORKSPACE_SKILLS_DIR, skillDirName);

  try {
    if (!fs.existsSync(skillPath)) {
      return { success: false, message: 'Skill not found in workspace skills' };
    }

    fs.rmSync(skillPath, { recursive: true, force: true });
    return { success: true, message: `Uninstalled ${skillDirName}` };
  } catch (e: any) {
    return { success: false, message: e.message };
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'list';
  const query = searchParams.get('query') || '';

  try {
    if (action === 'list') {
      const skills = await listAllSkills();

      // Also include Claude Code custom commands (from ~/.claude/commands/)
      const ccCmdsDir = path.join(os.homedir(), '.claude', 'commands');
      const claudeCommands: Skill[] = [];
      if (fs.existsSync(ccCmdsDir)) {
        try {
          const files = fs.readdirSync(ccCmdsDir).filter(f => f.endsWith('.md'));
          for (const f of files) {
            const name = f.replace('.md', '');
            const content = fs.readFileSync(path.join(ccCmdsDir, f), 'utf-8');
            const firstLine = content.split('\n').find(l => l.trim()) || '';
            claudeCommands.push({
              name: `/${name}`,
              description: firstLine.slice(0, 150),
              enabled: true,
              path: path.join(ccCmdsDir, f),
              category: 'claude-code' as any,
              requirements: null,
              installRecipe: null,
              requirementsMet: true,
            });
          }
        } catch {}
      }

      return NextResponse.json({
        skills: [...skills, ...claudeCommands],
        dirs: {
          bundled: BUNDLED_SKILLS_DIR,
          workspace: WORKSPACE_SKILLS_DIR,
          claudeCommands: ccCmdsDir,
        },
      });
    }

    if (action === 'search' && query) {
      const results = await searchSkills(query);
      return NextResponse.json({ results });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, skill, enabled, slug } = body;

    if (action === 'toggle' && skill) {
      const success = toggleSkill(skill, enabled);
      return NextResponse.json({ success });
    }

    if (action === 'install' && slug) {
      const result = await installSkill(slug);
      return NextResponse.json(result);
    }

    if (action === 'uninstall' && skill) {
      const result = await uninstallSkill(skill);
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
