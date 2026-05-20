/**
 * vault/obsidian-md — minimal Obsidian-flavored markdown helpers so agent-written
 * notes come out spec-correct (wikilinks, callouts, frontmatter). The prose rules
 * live in the obsidian-markdown SKILL.md file — this file just enforces syntax.
 */

export interface Frontmatter {
  [key: string]: unknown;
}

const FM_OPEN = /^---\s*\n/;
const FM_CLOSE = /\n---\s*\n/;

export function parseFrontmatter(text: string): { fm: Frontmatter; body: string } {
  if (!FM_OPEN.test(text)) return { fm: {}, body: text };
  const rest = text.replace(FM_OPEN, '');
  const closeIdx = rest.search(FM_CLOSE);
  if (closeIdx < 0) return { fm: {}, body: text };
  const raw = rest.slice(0, closeIdx);
  const body = rest.slice(closeIdx).replace(FM_CLOSE, '');
  const fm: Frontmatter = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1];
    const v = m[2].trim();
    if (/^\[.*\]$/.test(v)) {
      try { fm[k] = JSON.parse(v.replace(/([A-Za-z0-9_\-]+)/g, '"$1"')); continue; } catch {}
      fm[k] = v.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    } else if (v === 'true' || v === 'false') {
      fm[k] = v === 'true';
    } else if (/^-?\d+(\.\d+)?$/.test(v)) {
      fm[k] = Number(v);
    } else {
      fm[k] = v.replace(/^["']|["']$/g, '');
    }
  }
  return { fm, body };
}

export function formatFrontmatter(fm: Frontmatter): string {
  const keys = Object.keys(fm);
  if (keys.length === 0) return '';
  const lines: string[] = ['---'];
  for (const k of keys) {
    const v = fm[k];
    if (v == null) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(', ')}]`);
    } else if (typeof v === 'object') {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else if (typeof v === 'string' && (/[:#{}[\]|>]/.test(v) || v.includes('\n'))) {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

export function withFrontmatter(fm: Frontmatter, body: string): string {
  const existing = parseFrontmatter(body);
  const merged = { ...existing.fm, ...fm };
  return formatFrontmatter(merged) + existing.body.replace(/^\n+/, '');
}

/** Convert "Some Title" to a vault-safe note name (no path separators). */
export function noteSlug(title: string): string {
  return title
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    || 'Untitled';
}

export function wikilink(target: string, display?: string): string {
  const safe = target.replace(/[\[\]|]/g, '');
  return display ? `[[${safe}|${display.replace(/[\[\]|]/g, '')}]]` : `[[${safe}]]`;
}

export function callout(kind: 'note' | 'info' | 'tip' | 'warning' | 'important', title: string, body: string): string {
  const lines = body.split('\n').map(l => `> ${l}`);
  return [`> [!${kind}] ${title}`, ...lines].join('\n');
}
