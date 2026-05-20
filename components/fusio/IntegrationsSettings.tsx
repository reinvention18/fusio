/**
 * IntegrationsSettings — full credentials + auth section for the Settings
 * modal. Fetches /api/integrations on mount (which auto-detects from the
 * user's existing env/credentials files), shows pre-filled inputs, lets
 * the user toggle subscription↔api-key for Anthropic + OpenAI/Codex, and
 * saves back to data/integrations.json.
 *
 * No master password — single-user local app. Values are masked behind
 * eye toggles. Use CredentialsPanel for shared/encrypted secrets.
 */

'use client';

import { useEffect, useState } from 'react';
import { Eye, EyeOff, Check, ExternalLink, RefreshCw } from 'lucide-react';

type AuthMode = 'subscription' | 'apikey' | 'none';

interface IntegrationsState {
  anthropic:  { mode: AuthMode; apiKey: string; subscriptionDetected: boolean };
  openai:     { mode: AuthMode; apiKey: string; subscriptionDetected: boolean; authMode?: string };
  vercel:     { token: string; teamId: string };
  supabase:   { url: string; anonKey: string; serviceRoleKey: string; projectRef: string; accessToken: string };
  github:     { token: string; username: string };
  tailscale:  { authKey: string; hostname: string; running: boolean };
  resend:     { apiKey: string };
  stripe:     { secretKey: string; publishableKey: string };
}

function maskKey(v: string): string {
  if (!v) return '';
  if (v.length <= 12) return v;
  return v.slice(0, 6) + '…' + v.slice(-4);
}

/** Single secret input with eye toggle + copy. */
function SecretInput({
  value, onChange, placeholder, autoComplete = 'off',
}: { value: string; onChange: (v: string) => void; placeholder?: string; autoComplete?: string }) {
  const [reveal, setReveal] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        type={reveal ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        style={{
          width: '100%',
          padding: '8px 36px 8px 10px',
          background: 'var(--ink-2, #131319)',
          border: '1px solid var(--line, rgba(255,255,255,0.08))',
          borderRadius: 8,
          color: 'var(--white, #fff)',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          outline: 'none',
        }}
      />
      <button
        type="button"
        onClick={() => setReveal(r => !r)}
        title={reveal ? 'Hide' : 'Reveal'}
        style={{
          position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
          background: 'transparent', border: 'none',
          color: 'var(--mist)', cursor: 'pointer',
          padding: 4, display: 'flex', alignItems: 'center',
        }}
      >
        {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}

/** Section header — uppercase mono eyebrow. */
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="modal-section">
      <div className="stitle">{title}</div>
      {hint && (
        <div style={{
          fontSize: 11, color: 'var(--mist)', marginTop: -4, marginBottom: 8, lineHeight: 1.5,
        }}>
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}

/** Provider auth toggle: subscription vs API key. */
function AuthModeToggle({
  mode, onChange, subscriptionLabel, subscriptionDetected,
}: {
  mode: AuthMode;
  onChange: (m: AuthMode) => void;
  subscriptionLabel: string;
  subscriptionDetected: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
      <button
        type="button"
        onClick={() => onChange('subscription')}
        style={{
          flex: 1, padding: '7px 10px', borderRadius: 8,
          background: mode === 'subscription' ? 'var(--red, #CC0C20)' : 'var(--ink-2, #131319)',
          border: '1px solid ' + (mode === 'subscription' ? 'var(--red, #CC0C20)' : 'var(--line, rgba(255,255,255,0.08))'),
          color: mode === 'subscription' ? '#fff' : 'var(--mist)',
          fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase',
          cursor: 'pointer',
        }}
      >
        {subscriptionLabel}
        {subscriptionDetected && (
          <Check size={12} style={{ marginLeft: 6, verticalAlign: 'middle', color: '#4CC38A' }} />
        )}
      </button>
      <button
        type="button"
        onClick={() => onChange('apikey')}
        style={{
          flex: 1, padding: '7px 10px', borderRadius: 8,
          background: mode === 'apikey' ? 'var(--red, #CC0C20)' : 'var(--ink-2, #131319)',
          border: '1px solid ' + (mode === 'apikey' ? 'var(--red, #CC0C20)' : 'var(--line, rgba(255,255,255,0.08))'),
          color: mode === 'apikey' ? '#fff' : 'var(--mist)',
          fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase',
          cursor: 'pointer',
        }}
      >
        API key
      </button>
    </div>
  );
}

export function IntegrationsSettings() {
  const [state, setState] = useState<IntegrationsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/integrations', { cache: 'no-store' });
      const j = await r.json();
      if (j?.state) setState(j.state);
    } catch (e) { /* ignore */ }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!state) return;
    setSaving(true);
    try {
      const r = await fetch('/api/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state }),
      });
      const j = await r.json();
      if (j?.state) setState(j.state);
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 2200);
    } catch (e) { /* ignore */ }
    finally { setSaving(false); }
  };

  const update = <K extends keyof IntegrationsState>(key: K, patch: Partial<IntegrationsState[K]>) => {
    if (!state) return;
    setState({ ...state, [key]: { ...state[key], ...patch } });
  };

  if (loading || !state) {
    return <div style={{ color: 'var(--mist)', fontSize: 13, padding: 12 }}>Loading integrations…</div>;
  }

  return (
    <div>
      {/* Anthropic / Claude Code */}
      <Section
        title="Anthropic · Claude"
        hint="Pick how this Mission Control authenticates with Claude. Subscription uses your Claude Code login (no token needed); API key is a server-side fallback."
      >
        <AuthModeToggle
          mode={state.anthropic.mode}
          onChange={(m) => update('anthropic', { mode: m })}
          subscriptionLabel="Claude Code subscription"
          subscriptionDetected={state.anthropic.subscriptionDetected}
        />
        {state.anthropic.mode === 'subscription' ? (
          <div style={{ fontSize: 12, color: state.anthropic.subscriptionDetected ? 'var(--green, #4CC38A)' : 'var(--amber, #E8A23B)' }}>
            {state.anthropic.subscriptionDetected
              ? '✓ Claude Code session detected at ~/.claude/'
              : 'Not logged in. Run `claude login` in a terminal, then refresh.'}
            {!state.anthropic.subscriptionDetected && (
              <button
                type="button"
                onClick={load}
                style={{
                  marginLeft: 10, padding: '3px 8px', fontSize: 11,
                  background: 'transparent', color: 'var(--cyan)', border: '1px solid var(--line)',
                  borderRadius: 6, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}
              >
                <RefreshCw size={11} /> Re-check
              </button>
            )}
          </div>
        ) : (
          <SecretInput
            value={state.anthropic.apiKey}
            onChange={(v) => update('anthropic', { apiKey: v })}
            placeholder="sk-ant-api03-…"
          />
        )}
      </Section>

      {/* OpenAI / Codex */}
      <Section
        title="OpenAI · Codex"
        hint="ChatGPT subscription uses Codex CLI auth (~/.codex/auth.json); API key falls back to OPENAI_API_KEY."
      >
        <AuthModeToggle
          mode={state.openai.mode}
          onChange={(m) => update('openai', { mode: m })}
          subscriptionLabel={
            state.openai.authMode === 'chatgpt' ? 'ChatGPT subscription' : 'OpenAI subscription'
          }
          subscriptionDetected={state.openai.subscriptionDetected}
        />
        {state.openai.mode === 'subscription' ? (
          <div style={{ fontSize: 12, color: state.openai.subscriptionDetected ? 'var(--green, #4CC38A)' : 'var(--amber, #E8A23B)' }}>
            {state.openai.subscriptionDetected
              ? `✓ Codex session detected (auth_mode: ${state.openai.authMode || 'chatgpt'})`
              : 'Not logged in. Run `codex login` in a terminal, then refresh.'}
            {!state.openai.subscriptionDetected && (
              <button
                type="button"
                onClick={load}
                style={{
                  marginLeft: 10, padding: '3px 8px', fontSize: 11,
                  background: 'transparent', color: 'var(--cyan)', border: '1px solid var(--line)',
                  borderRadius: 6, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}
              >
                <RefreshCw size={11} /> Re-check
              </button>
            )}
          </div>
        ) : (
          <SecretInput
            value={state.openai.apiKey}
            onChange={(v) => update('openai', { apiKey: v })}
            placeholder="sk-…"
          />
        )}
      </Section>

      {/* Vercel */}
      <Section title="Vercel" hint="Token from vercel.com/account/tokens. Used for deploy & env-pull commands.">
        <SecretInput
          value={state.vercel.token}
          onChange={(v) => update('vercel', { token: v })}
          placeholder="vercel_token…"
        />
        <input
          type="text"
          value={state.vercel.teamId}
          onChange={(e) => update('vercel', { teamId: e.target.value })}
          placeholder="Team ID (optional)"
          style={{
            marginTop: 6, width: '100%', padding: '8px 10px',
            background: 'var(--ink-2, #131319)', border: '1px solid var(--line)',
            borderRadius: 8, color: 'var(--white)', fontSize: 12,
            fontFamily: 'var(--font-mono)', outline: 'none',
          }}
        />
      </Section>

      {/* Supabase */}
      <Section title="Supabase" hint="Project URL + anon + service role keys + access token (for CLI).">
        <input
          type="text"
          value={state.supabase.url}
          onChange={(e) => update('supabase', { url: e.target.value })}
          placeholder="https://<project>.supabase.co"
          style={{
            marginBottom: 6, width: '100%', padding: '8px 10px',
            background: 'var(--ink-2)', border: '1px solid var(--line)',
            borderRadius: 8, color: 'var(--white)', fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none',
          }}
        />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
          <input
            type="text"
            value={state.supabase.projectRef}
            onChange={(e) => update('supabase', { projectRef: e.target.value })}
            placeholder="Project ref"
            style={{
              padding: '8px 10px', background: 'var(--ink-2)', border: '1px solid var(--line)',
              borderRadius: 8, color: 'var(--white)', fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none',
            }}
          />
          <SecretInput
            value={state.supabase.accessToken}
            onChange={(v) => update('supabase', { accessToken: v })}
            placeholder="sbp_… access token"
          />
        </div>
        <SecretInput
          value={state.supabase.anonKey}
          onChange={(v) => update('supabase', { anonKey: v })}
          placeholder="anon key (eyJ…)"
        />
        <div style={{ height: 6 }} />
        <SecretInput
          value={state.supabase.serviceRoleKey}
          onChange={(v) => update('supabase', { serviceRoleKey: v })}
          placeholder="service_role key (eyJ…)"
        />
      </Section>

      {/* GitHub */}
      <Section
        title="GitHub"
        hint={state.github.username ? `Detected: gh CLI logged in as @${state.github.username}` : 'Personal access token (classic or fine-grained).'}
      >
        <SecretInput
          value={state.github.token}
          onChange={(v) => update('github', { token: v })}
          placeholder="ghp_… or github_pat_…"
        />
        <input
          type="text"
          value={state.github.username}
          onChange={(e) => update('github', { username: e.target.value })}
          placeholder="Username"
          style={{
            marginTop: 6, width: '100%', padding: '8px 10px',
            background: 'var(--ink-2)', border: '1px solid var(--line)',
            borderRadius: 8, color: 'var(--white)', fontSize: 12, outline: 'none',
          }}
        />
      </Section>

      {/* Tailscale */}
      <Section
        title="Tailscale"
        hint={state.tailscale.running ? `Connected as ${state.tailscale.hostname}` : 'Not running locally — set auth key for headless containers.'}
      >
        <SecretInput
          value={state.tailscale.authKey}
          onChange={(v) => update('tailscale', { authKey: v })}
          placeholder="tskey-auth-… (optional)"
        />
        <input
          type="text"
          value={state.tailscale.hostname}
          onChange={(e) => update('tailscale', { hostname: e.target.value })}
          placeholder="Hostname"
          style={{
            marginTop: 6, width: '100%', padding: '8px 10px',
            background: 'var(--ink-2)', border: '1px solid var(--line)',
            borderRadius: 8, color: 'var(--white)', fontSize: 12, outline: 'none',
          }}
        />
      </Section>

      {/* Resend */}
      <Section title="Resend (email)" hint="From resend.com/api-keys. Used by /api/notifications/send.">
        <SecretInput
          value={state.resend.apiKey}
          onChange={(v) => update('resend', { apiKey: v })}
          placeholder="re_…"
        />
      </Section>

      {/* Stripe */}
      <Section title="Stripe" hint="Secret key (server) + publishable key (client).">
        <SecretInput
          value={state.stripe.secretKey}
          onChange={(v) => update('stripe', { secretKey: v })}
          placeholder="sk_live_… or sk_test_…"
        />
        <div style={{ height: 6 }} />
        <SecretInput
          value={state.stripe.publishableKey}
          onChange={(v) => update('stripe', { publishableKey: v })}
          placeholder="pk_live_… or pk_test_…"
        />
      </Section>

      {/* Skills shortcut */}
      <Section
        title="Skills"
        hint="Add or manage installed skills. Each one becomes tap-to-inject in the right rail's Skills tab."
      >
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('mc-navigate', { detail: { tab: 'skills' } }));
            }}
            style={{
              padding: '7px 12px', borderRadius: 8,
              background: 'var(--ink-2)', color: 'var(--white)',
              border: '1px solid var(--line)', cursor: 'pointer',
              fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            Open Skills tab <ExternalLink size={11} />
          </button>
          <a
            href="https://github.com/anthropics/skills"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: '7px 12px', borderRadius: 8,
              background: 'transparent', color: 'var(--mist)',
              border: '1px solid var(--line)', textDecoration: 'none',
              fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            Browse skill registry <ExternalLink size={11} />
          </a>
        </div>
      </Section>

      {/* Save / status footer */}
      <div style={{
        position: 'sticky', bottom: 0, paddingTop: 12, marginTop: 8,
        borderTop: '1px solid var(--line)',
        background: 'var(--bg-surface, #0A0A0E)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
      }}>
        <div style={{ fontSize: 11, color: 'var(--mist)', fontFamily: 'var(--font-mono)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          {savedAt
            ? <span style={{ color: 'var(--green)' }}>✓ Saved</span>
            : 'Auto-loaded from your existing .env files'}
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          style={{
            padding: '8px 16px', borderRadius: 8,
            background: 'var(--red, #CC0C20)', color: '#fff',
            border: '1px solid var(--red)', cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.6 : 1,
            fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase',
          }}
        >
          {saving ? 'Saving…' : 'Save integrations'}
        </button>
      </div>
    </div>
  );
}
