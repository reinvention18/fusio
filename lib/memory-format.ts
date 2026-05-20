import type { RetrievalResult } from './memory-retrieve';

function escapeContent(text: string): string {
  if (!text) return '';
  return text.replace(/<\//g, '<\\/');
}

export interface FormatOpts {
  /** When true, uses a gentler note that defers to the active session context. */
  supplementary?: boolean;
}

export function formatRecalledContext(result: RetrievalResult, opts?: FormatOpts): string {
  if (result.mode === 'empty') return '';
  if (result.turns.length + result.episodes.length === 0) return '';

  const parts: string[] = [];
  parts.push('<recalled_context>');
  parts.push('<documents>');

  let index = 1;
  for (const turn of result.turns) {
    parts.push(`<document index="${index}">`);
    parts.push(`<source>${escapeContent(turn.source)}</source>`);
    parts.push('<document_content>');
    parts.push(escapeContent(turn.excerpt));
    parts.push('</document_content>');
    parts.push('</document>');
    index += 1;
  }

  for (const episode of result.episodes) {
    parts.push(`<document index="${index}" kind="episode">`);
    parts.push(`<source>${escapeContent(episode.source)}</source>`);
    parts.push('<document_content>');
    parts.push(`Title: ${escapeContent(episode.title)}`);
    parts.push(`Summary: ${escapeContent(episode.summary)}`);
    parts.push('</document_content>');
    parts.push('</document>');
    index += 1;
  }

  parts.push('</documents>');
  parts.push('<note>');
  if (opts?.supplementary) {
    parts.push(
      'These are older excerpts retrieved from long-term memory — context that has likely scrolled out of your active session window. Your active conversation context takes priority over these. Only use them if they are directly relevant to the current request. Do NOT change topic or re-introduce old work based on these excerpts.',
    );
  } else {
    parts.push(
      'These are retrieved excerpts from earlier in this same chat. They may be stale; prefer current conversation state on conflict. When you rely on a past decision, quote the matching &lt;source&gt; tag in your reply.',
    );
  }
  parts.push('</note>');
  parts.push('</recalled_context>');

  return parts.join('\n') + '\n\n';
}
