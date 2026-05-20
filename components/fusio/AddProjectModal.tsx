/**
 * AddProjectModal — captures a new project's workspace path + optional
 * per-project overrides for the integrations vault. Anything left empty
 * here falls back to the global Settings → Integrations values, so the
 * user only fills in fields that DIFFER per project.
 *
 * Posts to /api/projects (creates a per-project record in
 * data/projects.json) and dispatches `mc-set-session-workspace` so the
 * active chat picks up the new path immediately.
 */

'use client';

import { useState } from 'react';
import { Eye, EyeOff, X, FolderOpen } from 'lucide-react';

interface AddProjectModalProps {
  open: boolean;
  onClose: () => void;
  /** Called with the new workspace path once saved. */
  onCreated?: (path: string) => void;
}

interface ProjectOverrides {
  vercelToken: string;
  vercelTeamId: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  supabaseProjectRef: string;
  githubRepo: string;
  notes: string;
}

function emptyOverrides(): ProjectOverrides {
  return {
    vercelToken: '', vercelTeamId: '',
    supabaseUrl: '', supabaseAnonKey: '', supabaseServiceRoleKey: '', supabaseProjectRef: '',
    githubRepo: '',
    notes: '',
  };
}

function SecretInput({
  value, onChange, placeholder,
}: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [reveal, setReveal] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        type={reveal ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
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

export function AddProjectModal({ open, onClose, onCreated }: AddProjectModalProps) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [overrides, setOverrides] = useState<ProjectOverrides>(emptyOverrides());
  const [err, setErr] = useState<string | null>(null);

  if (!open) return null;

  const reset = () => {
    setName(''); setPath('');
    setOverrides(emptyOverrides());
    setErr(null);
  };

  const close = () => { reset(); onClose(); };

  const update = (patch: Partial<ProjectOverrides>) => setOverrides(prev => ({ ...prev, ...patch }));

  const save = () => {
    if (!path.trim()) { setErr('Workspace path is required.'); return; }
    const p = path.trim();
    const payload = {
      name: name.trim() || p.split(/[/\\]/).pop(),
      path: p,
      overrides,
    };
    // Close the modal IMMEDIATELY — saves to the API run in the background.
    // This avoids any "Saving…" stuck-state UX and any risk of a downstream
    // listener exception leaving the modal mounted.
    close();
    fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(async (res) => {
        if (!res.ok) {
          // Surface the failure as an alert — the modal is already closed
          // and we don't want to silently lose the user's input.
          let msg = 'Save failed';
          try { msg = (await res.json())?.error || msg; } catch { /* ignore */ }
          if (typeof window !== 'undefined') alert(`Project save failed: ${msg}`);
          return;
        }
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('mc-set-session-workspace', {
            detail: { workspace: p },
          }));
        }
        onCreated?.(p);
      })
      .catch((e) => {
        if (typeof window !== 'undefined') alert(`Project save failed: ${e?.message || e}`);
      });
  };

  return (
    <div
      onClick={close}
      className="modal-bg"
      style={{
        position: 'fixed', inset: 0, zIndex: 220,
        background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal"
        style={{
          width: 'min(680px, 100%)', maxHeight: 'calc(100vh - 32px)',
          background: 'var(--bg-surface, #0A0A0E)',
          border: '1px solid var(--line, rgba(255,255,255,0.08))',
          borderRadius: 14,
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div className="modal-head" style={{ padding: '16px 20px' }}>
          <h2 style={{ fontSize: 18, fontFamily: 'var(--font-display, system-ui)', color: 'var(--white)' }}>
            <em>Add project</em>
          </h2>
          <button className="close" onClick={close} title="Close" type="button">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ padding: '16px 20px', overflowY: 'auto', flex: 1 }}>
          <div className="modal-section">
            <div className="stitle">Project</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Display name (optional)"
                style={{
                  padding: '8px 10px',
                  background: 'var(--ink-2)', border: '1px solid var(--line)',
                  borderRadius: 8, color: 'var(--white)', fontSize: 13, outline: 'none',
                }}
              />
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/home/user/projects/myapp"
                style={{
                  padding: '8px 10px',
                  background: 'var(--ink-2)', border: '1px solid var(--line)',
                  borderRadius: 8, color: 'var(--white)',
                  fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none',
                }}
              />
            </div>
            <button
              type="button"
              onClick={async () => {
                if (!('showDirectoryPicker' in window)) {
                  alert('Folder picker not supported in this browser. Type the full path manually.');
                  return;
                }
                try {
                  const dir = await (window as any).showDirectoryPicker();
                  // We only get the directory NAME (browser sandbox) — not
                  // a full path. Pre-fill name; user types absolute path.
                  if (!name) setName(dir.name);
                } catch { /* cancelled */ }
              }}
              style={{
                marginTop: 6, padding: '6px 12px', borderRadius: 6,
                background: 'transparent', color: 'var(--cyan)',
                border: '1px solid var(--line)', cursor: 'pointer',
                fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.14em', textTransform: 'uppercase',
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              <FolderOpen size={12} /> Browse
            </button>
          </div>

          <div className="modal-section">
            <div className="stitle">Per-project overrides</div>
            <div style={{ fontSize: 11, color: 'var(--mist)', marginTop: -4, marginBottom: 10, lineHeight: 1.5 }}>
              Leave blank to inherit from Settings → Integrations. Fill anything that DIFFERS for this project
              (a different Supabase DB, a different Vercel team, etc.).
            </div>

            {/* Vercel */}
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em',
              textTransform: 'uppercase', color: 'var(--mist)', marginBottom: 4,
            }}>Vercel</div>
            <SecretInput
              value={overrides.vercelToken}
              onChange={(v) => update({ vercelToken: v })}
              placeholder="Vercel token (overrides global)"
            />
            <input
              type="text"
              value={overrides.vercelTeamId}
              onChange={(e) => update({ vercelTeamId: e.target.value })}
              placeholder="Vercel team ID"
              style={{
                marginTop: 6, width: '100%', padding: '8px 10px',
                background: 'var(--ink-2)', border: '1px solid var(--line)',
                borderRadius: 8, color: 'var(--white)', fontSize: 12, outline: 'none',
              }}
            />

            {/* Supabase */}
            <div style={{
              marginTop: 14,
              fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em',
              textTransform: 'uppercase', color: 'var(--mist)', marginBottom: 4,
            }}>Supabase</div>
            <input
              type="text"
              value={overrides.supabaseUrl}
              onChange={(e) => update({ supabaseUrl: e.target.value })}
              placeholder="https://<project>.supabase.co"
              style={{
                width: '100%', padding: '8px 10px', marginBottom: 6,
                background: 'var(--ink-2)', border: '1px solid var(--line)',
                borderRadius: 8, color: 'var(--white)', fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none',
              }}
            />
            <input
              type="text"
              value={overrides.supabaseProjectRef}
              onChange={(e) => update({ supabaseProjectRef: e.target.value })}
              placeholder="Project ref"
              style={{
                width: '100%', padding: '8px 10px', marginBottom: 6,
                background: 'var(--ink-2)', border: '1px solid var(--line)',
                borderRadius: 8, color: 'var(--white)', fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none',
              }}
            />
            <SecretInput
              value={overrides.supabaseAnonKey}
              onChange={(v) => update({ supabaseAnonKey: v })}
              placeholder="anon key (eyJ…)"
            />
            <div style={{ height: 6 }} />
            <SecretInput
              value={overrides.supabaseServiceRoleKey}
              onChange={(v) => update({ supabaseServiceRoleKey: v })}
              placeholder="service_role key (eyJ…)"
            />

            {/* GitHub */}
            <div style={{
              marginTop: 14,
              fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em',
              textTransform: 'uppercase', color: 'var(--mist)', marginBottom: 4,
            }}>GitHub</div>
            <input
              type="text"
              value={overrides.githubRepo}
              onChange={(e) => update({ githubRepo: e.target.value })}
              placeholder="owner/repo (used by Tools → GitHub)"
              style={{
                width: '100%', padding: '8px 10px',
                background: 'var(--ink-2)', border: '1px solid var(--line)',
                borderRadius: 8, color: 'var(--white)',
                fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none',
              }}
            />

            {/* Notes */}
            <div style={{
              marginTop: 14,
              fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em',
              textTransform: 'uppercase', color: 'var(--mist)', marginBottom: 4,
            }}>Notes</div>
            <textarea
              value={overrides.notes}
              onChange={(e) => update({ notes: e.target.value })}
              placeholder="Anything the agent should know about this project — build commands, deploy quirks, tribal knowledge."
              rows={3}
              style={{
                width: '100%', padding: '8px 10px',
                background: 'var(--ink-2)', border: '1px solid var(--line)',
                borderRadius: 8, color: 'var(--white)', fontSize: 12, outline: 'none', resize: 'vertical',
              }}
            />
          </div>

          {err && (
            <div style={{
              padding: '8px 12px', borderRadius: 8,
              background: 'rgba(204, 12, 32, 0.12)',
              border: '1px solid rgba(204, 12, 32, 0.4)',
              color: 'var(--red, #CC0C20)', fontSize: 12,
            }}>{err}</div>
          )}
        </div>

        <div className="modal-foot" style={{
          padding: '12px 20px', display: 'flex', justifyContent: 'flex-end', gap: 8,
          borderTop: '1px solid var(--line)',
        }}>
          <button className="cancel" onClick={close} type="button">Cancel</button>
          <button
            className="save"
            onClick={save}
            disabled={!path.trim()}
            type="button"
          >
            Create project
          </button>
        </div>
      </div>
    </div>
  );
}
