/**
 * Key Facts Extractor — automatically captures important information from
 * chat conversations so it's never lost when messages scroll out of context.
 *
 * Captures: API keys, passwords, usernames, URLs, database credentials,
 * project names, domain names, important decisions, people's names with roles.
 */

export interface KeyFact {
  id: string;
  category: 'credential' | 'url' | 'person' | 'config' | 'decision' | 'reference';
  label: string;
  value: string;
  source: 'auto' | 'manual';
  extractedAt: number;
}

// ─── Pattern-based extraction ───────────────────────────────────────

const PATTERNS: Array<{
  category: KeyFact['category'];
  label: string;
  pattern: RegExp;
  valueGroup?: number;
}> = [
  // API keys (various formats)
  { category: 'credential', label: 'API Key', pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*["`']?([a-zA-Z0-9_\-]{20,})["`']?/gi, valueGroup: 1 },
  { category: 'credential', label: 'Anthropic Key', pattern: /(sk-ant-api\d+-[a-zA-Z0-9_\-]{20,})/g, valueGroup: 1 },
  { category: 'credential', label: 'OpenAI Key', pattern: /(sk-[a-zA-Z0-9]{20,})/g, valueGroup: 1 },
  { category: 'credential', label: 'Stripe Key', pattern: /(sk_(?:live|test)_[a-zA-Z0-9]{20,})/g, valueGroup: 1 },
  { category: 'credential', label: 'Stripe Key', pattern: /(pk_(?:live|test)_[a-zA-Z0-9]{20,})/g, valueGroup: 1 },
  { category: 'credential', label: 'Supabase Key', pattern: /(eyJ[a-zA-Z0-9_\-]{50,})/g, valueGroup: 1 },
  { category: 'credential', label: 'Bearer Token', pattern: /Bearer\s+([a-zA-Z0-9_\-\.]{20,})/g, valueGroup: 1 },
  { category: 'credential', label: 'SSH Key', pattern: /(ssh-(?:rsa|ed25519)\s+[A-Za-z0-9+\/=]{30,})/g, valueGroup: 1 },

  // Passwords and secrets
  { category: 'credential', label: 'Password', pattern: /(?:password|passwd|pwd)\s*[:=]\s*["`']?([^\s"`'\n]{4,})["`']?/gi, valueGroup: 1 },
  { category: 'credential', label: 'Secret', pattern: /(?:secret|secret_key)\s*[:=]\s*["`']?([^\s"`'\n]{8,})["`']?/gi, valueGroup: 1 },
  { category: 'credential', label: 'Access Token', pattern: /(?:access_token|auth_token|token)\s*[:=]\s*["`']?([a-zA-Z0-9_\-\.]{20,})["`']?/gi, valueGroup: 1 },

  // Database connection strings
  { category: 'credential', label: 'Database URL', pattern: /((?:postgres|mysql|mongodb|redis):\/\/[^\s"'`\n]+)/gi, valueGroup: 1 },
  { category: 'config', label: 'Connection String', pattern: /(?:connection_string|DATABASE_URL|SUPABASE_URL)\s*[:=]\s*["`']?([^\s"`'\n]{10,})["`']?/gi, valueGroup: 1 },

  // Usernames and logins
  { category: 'person', label: 'Username', pattern: /(?:username|user(?:name)?|login)\s*[:=]\s*["`']?([^\s"`'\n]{2,30})["`']?/gi, valueGroup: 1 },
  { category: 'person', label: 'Email', pattern: /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g, valueGroup: 1 },

  // URLs (important services, not generic)
  { category: 'url', label: 'Supabase URL', pattern: /(https:\/\/[a-z0-9]+\.supabase\.co[^\s"'`]*)/gi, valueGroup: 1 },
  { category: 'url', label: 'Vercel URL', pattern: /(https:\/\/[^\s"'`]*\.vercel\.app[^\s"'`]*)/gi, valueGroup: 1 },
  { category: 'url', label: 'Production URL', pattern: /(?:production|prod|live)\s*(?:url|domain|site)\s*[:=]?\s*(https?:\/\/[^\s"'`\n]+)/gi, valueGroup: 1 },
  { category: 'url', label: 'Staging URL', pattern: /(?:staging|stage|dev)\s*(?:url|domain|site)\s*[:=]?\s*(https?:\/\/[^\s"'`\n]+)/gi, valueGroup: 1 },

  // Config values
  { category: 'config', label: 'Port', pattern: /(?:port|PORT)\s*[:=]\s*(\d{2,5})/gi, valueGroup: 1 },
  { category: 'config', label: 'Project ID', pattern: /(?:project[_-]?id|SUPABASE_PROJECT_REF)\s*[:=]\s*["`']?([a-zA-Z0-9_\-]{6,})["`']?/gi, valueGroup: 1 },
  { category: 'config', label: 'Environment Variable', pattern: /(?:NEXT_PUBLIC_|VITE_|REACT_APP_)[A-Z_]+=([^\s\n]+)/g, valueGroup: 1 },
];

// Contextual patterns that need the surrounding text for labeling
const CONTEXTUAL_PATTERNS: Array<{
  category: KeyFact['category'];
  pattern: RegExp;
  extract: (match: RegExpMatchArray) => { label: string; value: string } | null;
}> = [
  // "the password is XYZ" or "password: XYZ"
  {
    category: 'credential',
    pattern: /(?:the\s+)?(?:password|key|token|secret)\s+(?:is|was|=|:)\s+["`']?([^\s"`'\n]{4,})["`']?/gi,
    extract: (m) => ({ label: 'Password/Key', value: m[1] }),
  },
  // "my name is John" or "I'm John"
  {
    category: 'person',
    pattern: /(?:my name is|i'm|i am|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)(?:\s+and\b|\s*[,.\n]|$)/gi,
    extract: (m) => ({ label: 'Name', value: m[1].trim() }),
  },
  // "the project is called XYZ"
  {
    category: 'reference',
    pattern: /(?:project|app|repo|repository)\s+(?:is\s+)?(?:called|named)\s+["`']?([^\s"`'\n,\.]{2,30})["`']?/gi,
    extract: (m) => ({ label: 'Project Name', value: m[1] }),
  },
  // "the domain is example.com"
  {
    category: 'url',
    pattern: /(?:domain|site|website)\s+(?:is|=|:)\s+([a-zA-Z0-9][a-zA-Z0-9\-]*\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/gi,
    extract: (m) => ({ label: 'Domain', value: m[1] }),
  },
];

let idCounter = 0;
function makeId(): string {
  return `kf-${Date.now()}-${idCounter++}`;
}

/**
 * Extract key facts from a text string using pattern matching.
 * Returns newly found facts (deduped against existing).
 */
export function extractKeyFacts(
  text: string,
  existingFacts: KeyFact[] = [],
): KeyFact[] {
  const found: KeyFact[] = [];
  const existingValues = new Set(existingFacts.map(f => f.value.toLowerCase()));

  // Run regex patterns
  for (const { category, label, pattern, valueGroup } of PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const value = (valueGroup !== undefined ? match[valueGroup] : match[0]).trim();
      if (value && !existingValues.has(value.toLowerCase()) && value.length >= 4) {
        existingValues.add(value.toLowerCase());
        found.push({
          id: makeId(),
          category,
          label,
          value,
          source: 'auto',
          extractedAt: Date.now(),
        });
      }
    }
  }

  // Run contextual patterns
  for (const { category, pattern, extract } of CONTEXTUAL_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const result = extract(match);
      if (result && !existingValues.has(result.value.toLowerCase()) && result.value.length >= 2) {
        existingValues.add(result.value.toLowerCase());
        found.push({
          id: makeId(),
          category,
          label: result.label,
          value: result.value,
          source: 'auto',
          extractedAt: Date.now(),
        });
      }
    }
  }

  return found;
}

/**
 * Format key facts as a compact context string for injection into API calls.
 */
export function formatKeyFactsForContext(facts: KeyFact[]): string {
  if (facts.length === 0) return '';

  const grouped: Record<string, KeyFact[]> = {};
  for (const fact of facts) {
    if (!grouped[fact.category]) grouped[fact.category] = [];
    grouped[fact.category].push(fact);
  }

  const categoryLabels: Record<string, string> = {
    credential: '🔐 Credentials',
    url: '🔗 URLs',
    person: '👤 People',
    config: '⚙️ Config',
    decision: '✅ Decisions',
    reference: '📌 References',
  };

  const sections: string[] = [];
  for (const [cat, items] of Object.entries(grouped)) {
    const header = categoryLabels[cat] || cat;
    const lines = items.map(f => `  • ${f.label}: ${f.value}`);
    sections.push(`${header}\n${lines.join('\n')}`);
  }

  return `[Key Facts — auto-captured from this conversation, always use these exact values:]\n${sections.join('\n')}\n[End Key Facts]`;
}
