/**
 * OnboardingStrip — shown inside an empty chat. Three workspace-aware
 * example prompts the user can one-click to pre-fill the composer.
 */
'use client';
import { memo } from 'react';
import { Sparkles } from 'lucide-react';

export interface OnboardingStripProps {
  workspace?: string;
  onPick: (prompt: string) => void;
}

function suggestionsFor(workspace?: string): string[] {
  const ws = (workspace || '').toLowerCase();
  if (ws.includes('fieldrep') || ws.includes('revolvecore') || ws.includes('summit')) {
    return [
      'Add a test customer with 3 invoices to Summit Roofing',
      'List invoices over $10k across all companies',
      'Deploy the web PWA to production',
    ];
  }
  if (ws.includes('mission-control')) {
    return [
      'Summarize what changed in the chat area this week',
      'Run the type-checker and fix any errors',
      'Show me which chats still reference the old chat-sessions.json',
    ];
  }
  if (ws.includes('seo-workspace')) {
    return [
      'Research the top 5 keywords for revolve.construction',
      'Optimize the homepage for target keyword',
      'Draft a 1,500-word blog post on roof insurance claims',
    ];
  }
  return [
    'Summarize this repo and its main entry points',
    'Run the tests and show me any failures',
    'What changed in the last 10 commits?',
  ];
}

function Impl(p: OnboardingStripProps) {
  const suggestions = suggestionsFor(p.workspace);
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 14,
        padding: '32px 16px',
        fontFamily: 'var(--font-sans, system-ui)',
      }}
    >
      <div
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontFamily: 'var(--font-mono, ui-monospace)',
          fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase',
          color: 'var(--mist, rgba(255,255,255,0.5))',
        }}
      >
        <Sparkles style={{ width: 11, height: 11, color: 'var(--amber, #E8A23B)' }} />
        Try one to get going
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 480 }}>
        {suggestions.map((s, i) => (
          <button
            key={i}
            onClick={() => p.onPick(s)}
            data-fusio
            style={{
              textAlign: 'left',
              fontSize: 13,
              padding: '10px 14px',
              background: 'var(--ink-2, #131319)',
              border: '1px solid var(--line, rgba(255,255,255,0.08))',
              borderRadius: 8,
              color: 'var(--white, #fff)',
              cursor: 'pointer',
              transition: 'all 120ms ease-out',
              fontFamily: 'var(--font-sans, system-ui)',
            }}
            onMouseEnter={e => {
              const el = e.currentTarget as HTMLElement;
              el.style.borderColor = 'rgba(94, 196, 217, 0.5)';
              el.style.background = 'rgba(94, 196, 217, 0.04)';
            }}
            onMouseLeave={e => {
              const el = e.currentTarget as HTMLElement;
              el.style.borderColor = 'var(--line, rgba(255,255,255,0.08))';
              el.style.background = 'var(--ink-2, #131319)';
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

export const OnboardingStrip = memo(Impl);
