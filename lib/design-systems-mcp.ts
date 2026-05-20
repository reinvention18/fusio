/**
 * design-systems-mcp — expose nexu-io/open-design's 150+ brand-grade design
 * systems as MCP tools.
 *
 * Each design system at ~/open-design/design-systems/<name>/ ships:
 *   - DESIGN.md       — long-form visual analysis (palette, typography,
 *                       spacing, components, motion, do/don't)
 *   - tokens.css      — CSS custom properties for the palette/spacing/radii
 *   - components.html — example component compositions to crib from
 *
 * Tools:
 *   mc_list_design_systems(category?)  — compact index of all brand systems
 *   mc_load_design_system(name)        — full DESIGN.md + ref paths
 *
 * Per-turn auto-loader inlines a TRIMMED version of DESIGN.md when the user
 * mentions a brand by name OR uses generic design-language phrases — gives
 * the agent immediate access to the brand's visual grammar.
 */

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const DS_DIR = path.join(os.homedir(), 'open-design', 'design-systems');

interface DesignSystemMeta {
  name: string;           // directory name = canonical id
  dir: string;            // absolute path to system directory
  designMd: string;       // absolute path to DESIGN.md
  tokensCss?: string;     // absolute path to tokens.css if present
  componentsHtml?: string;// absolute path to components.html if present
  title: string;          // parsed `# Design System Inspired by X` heading
  category: string;       // parsed `> Category: X` line
  blurb: string;          // first sentence after the category line
}

const MAX_DESIGN_MD_INLINE = 3500; // characters per auto-loaded brand
const AUTO_BUNDLE_MAX_CHARS = 8000; // max total per turn

let _cached: DesignSystemMeta[] | null = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function parseDesignMd(filePath: string): { title: string; category: string; blurb: string } {
  try {
    const head = fs.readFileSync(filePath, 'utf-8').slice(0, 4000);
    const titleMatch = head.match(/^#\s+(.+)$/m);
    const categoryMatch = head.match(/^>\s*Category:\s*(.+)$/im);
    const blurbMatch = head.match(/^>\s*[^>\n]+\n>\s*(.+)$/m);
    return {
      title: titleMatch?.[1]?.trim() || '',
      category: categoryMatch?.[1]?.trim() || 'Uncategorized',
      blurb: (blurbMatch?.[1] || '').trim().replace(/\s+/g, ' ').slice(0, 180),
    };
  } catch {
    return { title: '', category: 'Uncategorized', blurb: '' };
  }
}

function listAllSystems(): DesignSystemMeta[] {
  const now = Date.now();
  if (_cached && now - _cachedAt < CACHE_TTL_MS) return _cached;
  if (!fs.existsSync(DS_DIR)) { _cached = []; _cachedAt = now; return _cached; }
  const out: DesignSystemMeta[] = [];
  for (const d of fs.readdirSync(DS_DIR)) {
    // Skip files at the top level (README.md, _schema, AGENTS.md).
    if (d.startsWith('_') || d.startsWith('.')) continue;
    const full = path.join(DS_DIR, d);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      const designMd = path.join(full, 'DESIGN.md');
      if (!fs.existsSync(designMd)) continue;
      const parsed = parseDesignMd(designMd);
      const tokensCss = path.join(full, 'tokens.css');
      const componentsHtml = path.join(full, 'components.html');
      out.push({
        name: d,
        dir: full,
        designMd,
        tokensCss: fs.existsSync(tokensCss) ? tokensCss : undefined,
        componentsHtml: fs.existsSync(componentsHtml) ? componentsHtml : undefined,
        title: parsed.title || d,
        category: parsed.category,
        blurb: parsed.blurb,
      });
    } catch { /* skip */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  _cached = out;
  _cachedAt = now;
  return out;
}

/** Marquee brand systems featured in the system-prompt index. The full set
 *  is still discoverable via mc_list_design_systems, but these get top
 *  billing because they're the most likely to be asked for by name. */
const MARQUEE_BRANDS = [
  'apple', 'stripe', 'linear-app', 'vercel', 'notion', 'figma', 'github',
  'shopify', 'spotify', 'discord', 'slack', 'airbnb', 'cursor', 'raycast',
  'arc', 'framer', 'webflow', 'claude', 'openai', 'perplexity', 'sentry',
  'supabase', 'lovable', 'mintlify', 'posthog', 'intercom', 'tesla',
  'nike', 'mastercard', 'starbucks',
];

/** System-prompt appendix — categorized list of brand systems plus
 *  the hand-curated marquee set. ~3 KB. */
export function loadDesignSystemsIndex(): string {
  const all = listAllSystems();
  if (all.length === 0) return '';

  const byCategory = new Map<string, DesignSystemMeta[]>();
  for (const ds of all) {
    const cat = ds.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(ds);
  }
  const categories = [...byCategory.keys()].sort();

  const out: string[] = [
    '',
    '---',
    `## DESIGN SYSTEMS — ${all.length} brand-grade systems (nexu-io/open-design)`,
    '',
    'Each entry is a full visual analysis of a real brand: palette, typography, spacing, motion, component patterns, do/don\'t. **When the user wants UI that looks like a specific brand** (e.g. "Apple-style settings page", "Stripe-style dashboard", "design like Linear"), pull the brand\'s design system FIRST via `mc_load_design_system(<name>)` — the returned DESIGN.md is your spec. Pair it with `/frontend-design` or `/shadcn-ui` for implementation.',
    '',
    '**How to use:**',
    '1. Identify the brand the user named (or pick the closest match from this list).',
    '2. Call `mc_load_design_system("<name>")` — returns full DESIGN.md plus paths to `tokens.css` and `components.html`.',
    '3. Translate the design tokens into the project\'s actual variables (Tailwind config, CSS vars, RN theme).',
    '4. Reference `components.html` for component patterns; do NOT copy-paste raw — adapt to the project\'s stack.',
    '',
    '**Marquee brands** (most-likely picks):',
    MARQUEE_BRANDS.filter(b => all.find(a => a.name === b)).map(b => `\`${b}\``).join(' · '),
    '',
    '**By category:**',
  ];
  for (const cat of categories) {
    const items = byCategory.get(cat)!;
    out.push(`- **${cat}** (${items.length}): ${items.map(i => `\`${i.name}\``).join(' · ')}`);
  }
  out.push('', '_Call `mc_list_design_systems()` for the full categorized list with descriptions, or `mc_list_design_systems("Media & Consumer")` to filter by category._');
  return out.join('\n');
}

// ─── Auto-trigger router ──────────────────────────────────────────────────
//
// Two trigger paths:
//   (a) User mentions a brand name → load that brand's DESIGN.md (trimmed)
//   (b) User uses generic design-language phrases ("design system",
//       "brand language", "look like X") → load DESIGN.md for any brand
//       named in the message.

const GENERIC_DESIGN_TRIGGERS = [
  /\b(design system|brand language|brand identity|design language|look like|inspired by|in the style of|aesthetic of)\b/i,
  /\b(match (the |our )?brand|on.brand|brand.aligned)\b/i,
];

/**
 * Design-system names that ARE also common English words. These would
 * otherwise auto-fire on totally unrelated text ("clean modern UI",
 * "fetch the dashboard URL", "claude told me…"). They stay discoverable
 * via mc_list_design_systems / mc_load_design_system explicitly, just no
 * silent auto-load — unless a generic design-context phrase like
 * "design system" / "look like X" / "in the style of" is in the message.
 *
 * Keeping `claude`, `figma`, `github`, `nike`, etc. OUT of this list —
 * those are unambiguous proper-noun brand names even though they double
 * as words.
 */
const GENERIC_DS_STOPLIST = new Set([
  'agentic', 'application', 'artistic', 'bento', 'bold', 'brutalism',
  'cafe', 'clay', 'claymorphism', 'clean', 'colorful', 'contemporary',
  'corporate', 'cosmic', 'creative', 'dashboard', 'default', 'dithered',
  'doodle', 'dramatic', 'editorial', 'elegant', 'energetic', 'enterprise',
  'expressive', 'fantasy', 'flat', 'friendly', 'futuristic',
  'glassmorphism', 'gradient', 'hud', 'luxury', 'material', 'minimal',
  'modern', 'mono', 'neobrutalism', 'neon', 'neumorphism', 'paper',
  'perspective', 'premium', 'professional', 'publication', 'refined',
  'retro', 'simple', 'skeumorphism', 'sleek', 'spacious', 'storytelling',
  'vibrant', 'vintage', 'warm-editorial', 'wired',
  // Format/utility names that aren't proper brands
  'agent-browser', 'trading-terminal', 'totality-festival',
  // Single-segment hyphenated entries whose prefixes overlap English
  'kami', 'lingo', 'mono', 'urdu',
]);

/** Find brand names mentioned in the user's text. Case-insensitive,
 *  word-boundary matched. Limited to MARQUEE first, then full list, capped
 *  at 3 matches per turn. Generic-name systems in GENERIC_DS_STOPLIST
 *  only fire when an explicit design-context phrase is also present. */
export function matchDesignSystemsForText(text: string, max = 3): string[] {
  if (!text || text.length < 6) return [];
  const all = listAllSystems();
  if (all.length === 0) return [];

  const hasGenericDesignContext = GENERIC_DESIGN_TRIGGERS.some(re => re.test(text));
  const matched: string[] = [];

  // Quick path: direct name mentions, marquee first.
  const ordered = [
    ...MARQUEE_BRANDS,
    ...all.map(a => a.name).filter(n => !MARQUEE_BRANDS.includes(n)),
  ];
  for (const name of ordered) {
    if (matched.length >= max) break;
    // 2-char brand names ("ai") would over-match — skip.
    if (name.length < 3) continue;
    // Stop-list names only fire when there's explicit design context
    // ("design system", "look like X", "in the style of") in the text.
    if (GENERIC_DS_STOPLIST.has(name) && !hasGenericDesignContext) continue;
    // Match the full canonical name (with hyphen → optional space/hyphen)
    // OR the brand prefix (first hyphen-separated segment) when the suffix
    // is a generic word like "-app" / "-ai" / "-ui". Lets "linear-app"
    // match plain "Linear" too, while "bmw-m" stays distinct from "bmw".
    const segments = name.split('-');
    const alternates: string[] = [name.replace(/-/g, '[- .]?')];
    if (segments.length > 1 && segments[0] && segments[0].length >= 5) {
      const suffix = segments.slice(1).join('-');
      if (['app', 'ai', 'ui', 'js', 'io'].includes(suffix)) {
        alternates.push(segments[0]);
      }
    }
    const pattern = alternates.map(a => a.replace(/\./g, '\\.')).join('|');
    const re = new RegExp(`\\b(?:${pattern})\\b`, 'i');
    if (re.test(text)) {
      if (!matched.includes(name)) matched.push(name);
    }
  }

  // If no direct hits BUT the user is clearly talking about design systems,
  // we don't return anything (no specific brand to load); the index in the
  // system prompt already tells the agent how to ask `mc_list_design_systems`.
  return matched;
}

/** Per-turn bundle: trimmed DESIGN.md for each matched brand. */
export function loadMatchedDesignSystemsBundle(text: string): string {
  const names = matchDesignSystemsForText(text);
  if (names.length === 0) return '';
  const all = listAllSystems();
  const byName = new Map(all.map(s => [s.name, s]));
  const parts: string[] = [];
  let total = 0;
  for (const name of names) {
    const ds = byName.get(name);
    if (!ds) continue;
    try {
      let body = fs.readFileSync(ds.designMd, 'utf-8');
      if (body.length > MAX_DESIGN_MD_INLINE) {
        body = body.slice(0, MAX_DESIGN_MD_INLINE) + '\n\n_…[truncated — call `mc_load_design_system("' + name + '")` for the full spec]_';
      }
      const refs: string[] = [];
      if (ds.tokensCss) refs.push(`tokens.css: ${ds.tokensCss}`);
      if (ds.componentsHtml) refs.push(`components.html: ${ds.componentsHtml}`);
      const block = `\n\n## Auto-loaded design system: ${name}\n\n_(${ds.category} — ${ds.blurb})_\n\n**Reference files:**\n${refs.map(r => `- ${r}`).join('\n')}\n\n${body.trim()}\n`;
      if (total + block.length > AUTO_BUNDLE_MAX_CHARS) break;
      parts.push(block);
      total += block.length;
    } catch { /* skip unreadable */ }
  }
  if (parts.length === 0) return '';
  return [
    '',
    '---',
    '## AUTO-LOADED DESIGN SYSTEMS (matched brand names in your message)',
    '',
    `_The brand(s) ${names.slice(0, parts.length).map(n => `**${n}**`).join(', ')} were named in your message. Their visual specs are inlined below — use these as the design source-of-truth when generating UI._`,
    ...parts,
    '',
    '---',
    '',
  ].join('\n');
}

export const DESIGN_SYSTEMS_TOOL_NAMES = [
  'mcp__mc-design__mc_list_design_systems',
  'mcp__mc-design__mc_load_design_system',
];

let cachedServer: ReturnType<typeof createSdkMcpServer> | null = null;
export function createDesignSystemsMcpServer() {
  if (cachedServer) return cachedServer;
  const t = <S extends z.ZodRawShape>(
    name: string,
    desc: string,
    schema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
  ) => tool(name, desc, schema, handler as any);

  const tools = [
    t(
      'mc_list_design_systems',
      'List all brand-grade design systems available (150+ from nexu-io/open-design). Optionally filter by category (e.g. "Media & Consumer", "Developer Tools", "Finance"). Returns name, category, and one-line blurb per system.',
      {
        category: z.string().optional().describe('Optional category filter; case-insensitive substring match.'),
      },
      async ({ category }) => {
        const all = listAllSystems();
        const filter = (category || '').trim().toLowerCase();
        const filtered = filter ? all.filter(a => a.category.toLowerCase().includes(filter)) : all;
        if (filtered.length === 0) {
          return { content: [{ type: 'text' as const, text: filter ? `No design systems matched category "${category}". Try one of: ${[...new Set(all.map(a => a.category))].sort().join(', ')}` : 'No design systems installed.' }] };
        }
        const lines: string[] = [`# ${filtered.length} design systems${filter ? ` (category: ${category})` : ''}`, ''];
        const byCat = new Map<string, DesignSystemMeta[]>();
        for (const ds of filtered) {
          if (!byCat.has(ds.category)) byCat.set(ds.category, []);
          byCat.get(ds.category)!.push(ds);
        }
        for (const cat of [...byCat.keys()].sort()) {
          lines.push(`## ${cat}`);
          for (const ds of byCat.get(cat)!) {
            lines.push(`- **${ds.name}** — ${ds.blurb || ds.title}`);
          }
          lines.push('');
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    ),
    t(
      'mc_load_design_system',
      'Return the full DESIGN.md for a named brand design system, plus paths to its tokens.css and components.html files. Use this when the user wants UI styled after a specific brand (Apple, Stripe, Linear, Notion, etc.).',
      {
        name: z.string().min(1).describe('Exact brand name (matches the directory name in design-systems/, e.g. "apple", "stripe", "linear-app").'),
      },
      async ({ name }) => {
        const all = listAllSystems();
        const hit = all.find(s => s.name.toLowerCase() === name.toLowerCase());
        if (!hit) {
          const close = all
            .filter(s => s.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(s.name.toLowerCase()))
            .slice(0, 5)
            .map(s => s.name);
          return { content: [{ type: 'text' as const, text: `Unknown design system "${name}". ${close.length ? `Did you mean: ${close.join(', ')}?` : 'Call mc_list_design_systems to see all options.'}` }] };
        }
        try {
          const body = fs.readFileSync(hit.designMd, 'utf-8');
          const refs: string[] = [];
          refs.push(`- DESIGN.md: ${hit.designMd}`);
          if (hit.tokensCss) refs.push(`- tokens.css: ${hit.tokensCss}`);
          if (hit.componentsHtml) refs.push(`- components.html: ${hit.componentsHtml}`);
          return {
            content: [{
              type: 'text' as const,
              text: `# ${hit.title} (${hit.category})\n\n**Files on disk:**\n${refs.join('\n')}\n\n**Usage:** read \`tokens.css\` for the CSS custom properties to drop into the target project's theme, and \`components.html\` for component compositions. The DESIGN.md below is the design spec — translate it into the project's actual stack (Tailwind config, RN theme, CSS-in-JS, etc.) rather than copy-pasting raw.\n\n---\n\n${body}`,
            }],
          };
        } catch (e: any) {
          return { content: [{ type: 'text' as const, text: `Failed to read design system "${name}": ${e.message}` }] };
        }
      },
    ),
  ];

  cachedServer = createSdkMcpServer({ name: 'mc-design', version: '1.0.0', tools });
  return cachedServer;
}
