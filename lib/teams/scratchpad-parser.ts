/**
 * Scratchpad parser utility for extracting structured data from the
 * team scratchpad. Used by mc_launch_from_research and other tools
 * that need to parse scribe-generated content.
 */

export interface ImplementationPrompt {
  severity: string;
  title: string;
  role: string;
  files: string[];
  description: string;
  acceptance: string;
  priority: number;
}

/**
 * Parse the "## Implementation Prompts" section from a scratchpad.
 * Returns structured prompts that can be converted to tasks.
 */
export function parseImplementationPrompts(scratchpadContent: string): ImplementationPrompt[] {
  const match = scratchpadContent.match(/## Implementation Prompts\s*\n([\s\S]*?)(?=\n## (?!#)|$)/);
  if (!match) return [];

  const promptsText = match[1];
  const promptBlocks = promptsText.split(/(?=###\s+\d+\.)/).filter(b => b.trim());
  const prompts: ImplementationPrompt[] = [];

  for (const block of promptBlocks) {
    const titleMatch = block.match(/###\s+\d+\.\s+\[(\w+)\]\s+(.+)/);
    if (!titleMatch) continue;

    const severity = titleMatch[1];
    const title = titleMatch[2].trim();
    const roleMatch = block.match(/\*\*Role:\*\*\s*(\w+)/);
    const filesMatch = block.match(/\*\*Files:\*\*\s*(.+)/);
    const descMatch = block.match(/\*\*Description:\*\*\s*([\s\S]*?)(?=\n\*\*|$)/);
    const acceptMatch = block.match(/\*\*Acceptance:\*\*\s*([\s\S]*?)(?=\n\*\*|$)/);

    prompts.push({
      severity,
      title,
      role: roleMatch ? roleMatch[1].trim() : 'builder',
      files: filesMatch ? filesMatch[1].split(',').map(f => f.trim()) : [],
      description: descMatch ? descMatch[1].trim() : block,
      acceptance: acceptMatch ? acceptMatch[1].trim() : '',
      priority: severity === 'CRITICAL' ? 10 : severity === 'HIGH' ? 7 : severity === 'MEDIUM' ? 4 : 2,
    });
  }

  return prompts;
}

/**
 * Extract named sections from the scratchpad.
 * Sections are identified by "## <Role>: <Topic>" headers.
 */
export function parseScratchpadSections(content: string): Array<{ role: string; topic: string; body: string }> {
  const sections: Array<{ role: string; topic: string; body: string }> = [];
  const sectionRegex = /^## (\w[\w\s]*?):\s*(.+)$/gm;
  let match;
  const positions: Array<{ role: string; topic: string; start: number }> = [];

  while ((match = sectionRegex.exec(content)) !== null) {
    positions.push({ role: match[1].trim(), topic: match[2].trim(), start: match.index + match[0].length });
  }

  for (let i = 0; i < positions.length; i++) {
    const end = i + 1 < positions.length ? positions[i + 1].start - positions[i + 1].role.length - positions[i + 1].topic.length - 5 : content.length;
    sections.push({
      role: positions[i].role,
      topic: positions[i].topic,
      body: content.slice(positions[i].start, end).trim(),
    });
  }

  return sections;
}
