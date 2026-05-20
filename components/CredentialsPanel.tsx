/**
 * CredentialsPanel — encrypted local credentials vault (AES-256-GCM, key derived
 * from a master password via PBKDF2, never stored on disk).
 *
 * Restructured for the AI Fusio design language: tokens come from /fusio/mc.css
 * (palette + fonts), uppercase mono eyebrows, compact cards. All crypto + state
 * logic identical to the prior version.
 */
'use client';
import { generateId } from '../lib/generateId';

import { useState, useEffect } from 'react';
import {
  Key, Plus, Trash2, Eye, EyeOff, Copy, Check, Lock, Unlock,
  FolderOpen, Search, Edit2, X, Shield, AlertTriangle, Database,
  Globe, Terminal, KeyRound,
} from 'lucide-react';

interface Credential {
  id: string;
  project: string;
  name: string;
  type: 'login' | 'api_key' | 'ssh' | 'database' | 'other';
  fields: Record<string, string>;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

interface EncryptedVault {
  salt: string;
  iv: string;
  data: string;
}

const CREDENTIAL_TYPES = {
  login:    { label: 'Login',    icon: Globe,    fields: ['username', 'password', 'url'] },
  api_key:  { label: 'API Key',  icon: KeyRound, fields: ['key', 'secret', 'endpoint'] },
  ssh:      { label: 'SSH/SFTP', icon: Terminal, fields: ['host', 'port', 'username', 'password', 'privateKey'] },
  database: { label: 'Database', icon: Database, fields: ['host', 'port', 'database', 'username', 'password'] },
  other:    { label: 'Other',    icon: Key,      fields: ['field1', 'field2', 'field3'] },
};

// ---- palette tokens (with fallbacks) -----------------------------------------
const VOID   = 'var(--bg-primary, #050507)';
const INK    = 'var(--bg-surface, #0A0A0E)';
const INK_2  = 'var(--bg-elevated, #131319)';
const INK_3  = 'var(--ink-3, #1B1B23)';
const LINE   = 'var(--border, rgba(255,255,255,0.08))';
const WHITE  = 'var(--text-primary, #FFFFFF)';
const FOG    = 'var(--fog, rgba(255,255,255,0.78))';
const MIST   = 'var(--mist, rgba(255,255,255,0.5))';
const DIM    = 'var(--dim, rgba(255,255,255,0.32))';
const RED    = 'var(--red, #CC0C20)';
const GREEN  = 'var(--green, #4CC38A)';
const CYAN   = 'var(--cyan, #5EC4D9)';
const AMBER  = 'var(--amber, #E8A23B)';
const VIOLET = 'var(--violet, #8B6FE8)';

const FONT_MONO    = 'var(--font-mono, ui-monospace, monospace)';
const FONT_SANS    = 'var(--font-sans, system-ui)';
const FONT_DISPLAY = 'var(--font-display, "Space Grotesk")';

const eyebrow = (color: string = MIST, size = 10): React.CSSProperties => ({
  fontFamily: FONT_MONO,
  fontSize: size,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color,
});

const fieldInput: React.CSSProperties = {
  width: '100%',
  background: INK_3,
  border: `1px solid ${LINE}`,
  borderRadius: 8,
  padding: '10px 12px',
  color: WHITE,
  fontFamily: FONT_SANS,
  fontSize: 13,
  outline: 'none',
};

// Crypto utilities (unchanged) -------------------------------------------------
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encrypt(data: string, password: string): Promise<EncryptedVault> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const encoder = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(data));
  return {
    salt: btoa(String.fromCharCode(...salt)),
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
  };
}

async function decrypt(vault: EncryptedVault, password: string): Promise<string> {
  const salt = new Uint8Array(atob(vault.salt).split('').map(c => c.charCodeAt(0)));
  const iv = new Uint8Array(atob(vault.iv).split('').map(c => c.charCodeAt(0)));
  const data = new Uint8Array(atob(vault.data).split('').map(c => c.charCodeAt(0)));
  const key = await deriveKey(password, salt);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

export default function CredentialsPanel() {
  const [isLocked, setIsLocked] = useState(true);
  const [masterPassword, setMasterPassword] = useState('');
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [search, setSearch] = useState('');
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState<Record<string, boolean>>({});
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFirstTime, setIsFirstTime] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState('');

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editingCred, setEditingCred] = useState<Credential | null>(null);
  const [formData, setFormData] = useState({
    project: '',
    name: '',
    type: 'login' as Credential['type'],
    fields: {} as Record<string, string>,
    notes: '',
  });

  // Check if vault exists
  useEffect(() => {
    const vault = localStorage.getItem('credentialsVault');
    setIsFirstTime(!vault);
  }, []);

  // Lock after inactivity (5 min)
  useEffect(() => {
    if (isLocked) return;
    const timeout = setTimeout(() => { handleLock(); }, 5 * 60 * 1000);
    return () => clearTimeout(timeout);
  }, [isLocked, credentials]);

  const handleLock = () => {
    setIsLocked(true);
    setCredentials([]);
    setMasterPassword('');
    setShowPassword({});
  };

  const saveVault = async (creds: Credential[]) => {
    const sessionKey = sessionStorage.getItem('vaultSessionKey');
    if (!sessionKey) {
      setError('Session expired. Please unlock again.');
      handleLock();
      return;
    }
    try {
      const encrypted = await encrypt(JSON.stringify(creds), sessionKey);
      localStorage.setItem('credentialsVault', JSON.stringify(encrypted));
      setCredentials(creds);
    } catch (e) {
      setError('Failed to save vault');
    }
  };

  const handleUnlockWithSession = async () => {
    setError(null);
    if (isFirstTime) {
      if (masterPassword.length < 8) { setError('Password must be at least 8 characters'); return; }
      if (masterPassword !== confirmPassword) { setError('Passwords do not match'); return; }
      sessionStorage.setItem('vaultSessionKey', masterPassword);
      const encrypted = await encrypt(JSON.stringify([]), masterPassword);
      localStorage.setItem('credentialsVault', JSON.stringify(encrypted));
      setCredentials([]);
      setIsLocked(false);
      setIsFirstTime(false);
    } else {
      try {
        const vaultStr = localStorage.getItem('credentialsVault');
        if (!vaultStr) throw new Error('No vault found');
        const vault: EncryptedVault = JSON.parse(vaultStr);
        const decrypted = await decrypt(vault, masterPassword);
        sessionStorage.setItem('vaultSessionKey', masterPassword);
        setCredentials(JSON.parse(decrypted));
        setIsLocked(false);
      } catch (e) {
        setError('Invalid password');
      }
    }
    setMasterPassword('');
    setConfirmPassword('');
  };

  const addOrUpdateCredential = async () => {
    const now = new Date().toISOString();
    if (editingCred) {
      const updated = credentials.map(c =>
        c.id === editingCred.id ? { ...c, ...formData, updatedAt: now } : c
      );
      await saveVault(updated);
    } else {
      const newCred: Credential = {
        id: generateId(),
        ...formData,
        createdAt: now,
        updatedAt: now,
      };
      await saveVault([...credentials, newCred]);
    }
    closeModal();
  };

  const deleteCredential = async (id: string) => {
    if (!confirm('Delete this credential?')) return;
    const updated = credentials.filter(c => c.id !== id);
    await saveVault(updated);
  };

  const openModal = (cred?: Credential) => {
    if (cred) {
      setEditingCred(cred);
      setFormData({
        project: cred.project,
        name: cred.name,
        type: cred.type,
        fields: { ...cred.fields },
        notes: cred.notes || '',
      });
    } else {
      setEditingCred(null);
      setFormData({
        project: selectedProject || '',
        name: '',
        type: 'login',
        fields: {},
        notes: '',
      });
    }
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingCred(null);
    setFormData({ project: '', name: '', type: 'login', fields: {}, notes: '' });
  };

  const copyToClipboard = async (value: string, fieldId: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedField(fieldId);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const toggleShowPassword = (fieldId: string) => {
    setShowPassword(prev => ({ ...prev, [fieldId]: !prev[fieldId] }));
  };

  const projects = [...new Set(credentials.map(c => c.project))].sort();

  const filtered = credentials.filter(c => {
    if (selectedProject && c.project !== selectedProject) return false;
    if (search) {
      const sl = search.toLowerCase();
      return (
        c.name.toLowerCase().includes(sl) ||
        c.project.toLowerCase().includes(sl) ||
        Object.values(c.fields).some(v => v.toLowerCase().includes(sl))
      );
    }
    return true;
  });

  // ============================================================================
  // LOCKED SCREEN
  // ============================================================================
  if (isLocked) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: INK,
          border: `1px solid ${LINE}`,
          borderRadius: 12,
          fontFamily: FONT_SANS,
          color: WHITE,
        }}
      >
        <div style={{ maxWidth: 420, width: '100%', padding: 32, textAlign: 'center' }}>
          {/* Shield medallion */}
          <div
            style={{
              width: 56, height: 56,
              margin: '0 auto 20px',
              borderRadius: '50%',
              background: 'rgba(76, 195, 138, 0.12)',
              border: `1px solid rgba(76, 195, 138, 0.4)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Shield style={{ width: 26, height: 26, color: GREEN }} />
          </div>

          <div style={{ ...eyebrow(MIST), marginBottom: 6 }}>
            {isFirstTime ? 'Vault setup' : 'Secure vault'}
          </div>
          <h2
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: '-0.015em',
              color: WHITE,
              marginBottom: 8,
            }}
          >
            {isFirstTime ? 'Create your vault' : 'Unlock credentials vault'}
          </h2>
          <p style={{ color: MIST, fontSize: 13, marginBottom: 22, lineHeight: 1.5 }}>
            {isFirstTime
              ? 'Set a master password to encrypt your credentials. This password is never stored.'
              : 'Enter your master password to access stored credentials.'}
          </p>

          {error && (
            <div
              style={{
                marginBottom: 14,
                padding: '8px 12px',
                background: 'rgba(204, 12, 32, 0.12)',
                border: `1px solid rgba(204, 12, 32, 0.35)`,
                borderRadius: 8,
                color: RED,
                fontSize: 12,
                fontFamily: FONT_MONO,
                display: 'flex', alignItems: 'center', gap: 8,
              }}
            >
              <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0 }} />
              {error}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input
              type="password"
              value={masterPassword}
              onChange={e => setMasterPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleUnlockWithSession()}
              placeholder={isFirstTime ? 'Create master password' : 'Master password'}
              autoFocus
              style={{ ...fieldInput, padding: '12px 14px' }}
            />
            {isFirstTime && (
              <input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleUnlockWithSession()}
                placeholder="Confirm password"
                style={{ ...fieldInput, padding: '12px 14px' }}
              />
            )}
            <button
              type="button"
              onClick={handleUnlockWithSession}
              className="card-btn primary"
              style={{
                width: '100%',
                padding: '12px',
                background: GREEN,
                borderColor: GREEN,
                color: '#0a1612',
                fontSize: 13,
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <Unlock style={{ width: 14, height: 14 }} />
              {isFirstTime ? 'Create vault' : 'Unlock'}
            </button>
          </div>

          <p style={{ marginTop: 22, ...eyebrow(DIM, 9), letterSpacing: '0.12em' }}>
            AES-256-GCM · Password never stored · Local only
          </p>
        </div>
      </div>
    );
  }

  // ============================================================================
  // UNLOCKED — MAIN VIEW
  // ============================================================================
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        background: INK,
        border: `1px solid ${LINE}`,
        borderRadius: 12,
        overflow: 'hidden',
        fontFamily: FONT_SANS,
        color: WHITE,
      }}
    >
      {/* ---- LEFT SIDEBAR: PROJECTS ---- */}
      <div style={{ width: 224, borderRight: `1px solid ${LINE}`, display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            padding: '12px 14px',
            borderBottom: `1px solid ${LINE}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}
        >
          <div style={eyebrow(MIST)}>Projects</div>
          <button
            type="button"
            onClick={handleLock}
            title="Lock vault"
            style={{
              padding: 4, background: 'transparent', border: 'none', color: MIST, cursor: 'pointer',
              borderRadius: 4, transition: 'all 120ms ease-out',
              display: 'inline-flex',
            }}
            onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.color = RED; el.style.background = 'rgba(204, 12, 32, 0.12)'; }}
            onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.color = MIST; el.style.background = 'transparent'; }}
          >
            <Lock style={{ width: 14, height: 14 }} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {/* All credentials */}
          <ProjectButton
            active={!selectedProject}
            onClick={() => setSelectedProject(null)}
            icon={<Key style={{ width: 13, height: 13 }} />}
            label="All credentials"
            count={credentials.length}
            color={GREEN}
          />

          {projects.map(project => {
            const count = credentials.filter(c => c.project === project).length;
            return (
              <ProjectButton
                key={project}
                active={selectedProject === project}
                onClick={() => setSelectedProject(project)}
                icon={<FolderOpen style={{ width: 13, height: 13 }} />}
                label={project}
                count={count}
                color={CYAN}
              />
            );
          })}
        </div>

        <div style={{ padding: 8, borderTop: `1px solid ${LINE}` }}>
          <button
            type="button"
            onClick={() => openModal()}
            className="card-btn primary"
            style={{
              width: '100%', padding: '8px 12px',
              background: GREEN, borderColor: GREEN, color: '#0a1612',
              fontSize: 12,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
          >
            <Plus style={{ width: 13, height: 13 }} />
            Add credential
          </button>
        </div>
      </div>

      {/* ---- MAIN CONTENT ---- */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Head — search + encryption pill */}
        <div
          style={{
            padding: '12px 16px',
            borderBottom: `1px solid ${LINE}`,
            display: 'flex', alignItems: 'center', gap: 12,
          }}
        >
          <div style={{ position: 'relative', flex: 1, maxWidth: 420 }}>
            <Search style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, color: MIST }} />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search credentials…"
              style={{
                ...fieldInput,
                paddingLeft: 36,
                fontSize: 12.5,
              }}
            />
          </div>

          <span
            style={{
              ...eyebrow(GREEN, 9.5),
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '4px 10px',
              background: 'rgba(76, 195, 138, 0.1)',
              border: `1px solid rgba(76, 195, 138, 0.35)`,
              borderRadius: 6,
            }}
          >
            <Shield style={{ width: 11, height: 11 }} />
            Encrypted
          </span>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px 16px', color: MIST }}>
              <Key style={{ width: 36, height: 36, margin: '0 auto 16px', display: 'block', opacity: 0.5 }} />
              <p style={{ margin: 0, fontSize: 13 }}>No credentials found</p>
              <button
                type="button"
                onClick={() => openModal()}
                className="card-btn primary"
                style={{
                  marginTop: 16,
                  background: GREEN,
                  borderColor: GREEN,
                  color: '#0a1612',
                  fontSize: 11,
                  padding: '6px 14px',
                }}
              >
                Add your first credential
              </button>
            </div>
          ) : (
            filtered.map(cred => {
              const TypeIcon = CREDENTIAL_TYPES[cred.type]?.icon || Key;
              return (
                <div
                  key={cred.id}
                  style={{
                    background: INK_2,
                    border: `1px solid ${LINE}`,
                    borderRadius: 10,
                    padding: 14,
                    transition: 'border-color 120ms ease-out',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(94, 196, 217, 0.35)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = LINE; }}
                >
                  {/* Head row */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12, gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                      <div
                        style={{
                          width: 36, height: 36,
                          borderRadius: 8,
                          background: 'rgba(94, 196, 217, 0.12)',
                          border: `1px solid rgba(94, 196, 217, 0.3)`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <TypeIcon style={{ width: 16, height: 16, color: CYAN }} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 14,
                            fontWeight: 600,
                            color: WHITE,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {cred.name}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                          <span
                            style={{
                              ...eyebrow(FOG, 9),
                              padding: '1px 6px',
                              background: INK_3,
                              border: `1px solid ${LINE}`,
                              borderRadius: 4,
                            }}
                          >
                            {cred.project}
                          </span>
                          <span style={eyebrow(MIST, 9)}>
                            {CREDENTIAL_TYPES[cred.type]?.label}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <IconActionBtn onClick={() => openModal(cred)} title="Edit" color={CYAN}>
                        <Edit2 style={{ width: 13, height: 13 }} />
                      </IconActionBtn>
                      <IconActionBtn onClick={() => deleteCredential(cred.id)} title="Delete" color={RED}>
                        <Trash2 style={{ width: 13, height: 13 }} />
                      </IconActionBtn>
                    </div>
                  </div>

                  {/* Fields */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {Object.entries(cred.fields).filter(([_, v]) => v).map(([key, value]) => {
                      const fieldId = `${cred.id}-${key}`;
                      const isSecret = key.toLowerCase().includes('password') ||
                                       key.toLowerCase().includes('secret') ||
                                       key.toLowerCase().includes('key') ||
                                       key.toLowerCase().includes('private');
                      const isShown = showPassword[fieldId];

                      return (
                        <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                          <span
                            style={{
                              ...eyebrow(MIST, 9.5),
                              width: 88,
                              flexShrink: 0,
                            }}
                          >
                            {key}
                          </span>
                          <code
                            style={{
                              flex: 1,
                              background: INK,
                              border: `1px solid ${LINE}`,
                              padding: '4px 10px',
                              borderRadius: 6,
                              fontFamily: FONT_MONO,
                              fontSize: 12,
                              color: WHITE,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              minWidth: 0,
                            }}
                          >
                            {isSecret && !isShown ? '••••••••••••' : value}
                          </code>
                          {isSecret && (
                            <IconActionBtn onClick={() => toggleShowPassword(fieldId)} title={isShown ? 'Hide' : 'Show'} color={WHITE}>
                              {isShown ? <EyeOff style={{ width: 13, height: 13 }} /> : <Eye style={{ width: 13, height: 13 }} />}
                            </IconActionBtn>
                          )}
                          <IconActionBtn onClick={() => copyToClipboard(value, fieldId)} title="Copy" color={GREEN}>
                            {copiedField === fieldId
                              ? <Check style={{ width: 13, height: 13, color: GREEN }} />
                              : <Copy style={{ width: 13, height: 13 }} />}
                          </IconActionBtn>
                        </div>
                      );
                    })}
                  </div>

                  {cred.notes && (
                    <div
                      style={{
                        marginTop: 12,
                        paddingTop: 12,
                        borderTop: `1px solid ${LINE}`,
                        fontSize: 11.5,
                        color: MIST,
                        lineHeight: 1.5,
                      }}
                    >
                      {cred.notes}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ---- ADD/EDIT MODAL ---- */}
      {showModal && (
        <div
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 50,
            padding: 16,
          }}
        >
          <div
            className="card"
            style={{
              margin: 0,
              width: '100%',
              maxWidth: 560,
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              padding: 0,
              overflow: 'hidden',
            }}
          >
            {/* Modal head */}
            <div
              style={{
                padding: '14px 18px',
                borderBottom: `1px solid ${LINE}`,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}
            >
              <div>
                <div style={eyebrow(MIST)}>Credential</div>
                <div style={{ fontFamily: FONT_DISPLAY, fontSize: 15, fontWeight: 600, color: WHITE, marginTop: 2 }}>
                  {editingCred ? 'Edit credential' : 'Add credential'}
                </div>
              </div>
              <button
                type="button"
                onClick={closeModal}
                style={{
                  background: 'transparent', border: 'none', color: MIST, cursor: 'pointer',
                  padding: 4, borderRadius: 4, display: 'inline-flex',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = WHITE; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = MIST; }}
              >
                <X style={{ width: 16, height: 16 }} />
              </button>
            </div>

            <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto', flex: 1 }}>
              <FormField label="Project">
                <input
                  type="text"
                  value={formData.project}
                  onChange={e => setFormData({ ...formData, project: e.target.value })}
                  placeholder="e.g. WordPress, MyMobileApp, Revolve"
                  list="projects-list"
                  style={fieldInput}
                />
                <datalist id="projects-list">
                  {projects.map(p => <option key={p} value={p} />)}
                </datalist>
              </FormField>

              <FormField label="Name">
                <input
                  type="text"
                  value={formData.name}
                  onChange={e => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g. cPanel login, API key, SSH access"
                  style={fieldInput}
                />
              </FormField>

              <FormField label="Type">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
                  {Object.entries(CREDENTIAL_TYPES).map(([key, { label, icon: Icon }]) => {
                    const active = formData.type === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setFormData({ ...formData, type: key as Credential['type'], fields: {} })}
                        style={{
                          padding: '10px 6px',
                          borderRadius: 8,
                          background: active ? 'rgba(94, 196, 217, 0.12)' : INK_3,
                          border: `1px solid ${active ? 'rgba(94, 196, 217, 0.5)' : LINE}`,
                          color: active ? CYAN : MIST,
                          cursor: 'pointer',
                          transition: 'all 120ms ease-out',
                          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
                        }}
                      >
                        <Icon style={{ width: 16, height: 16 }} />
                        <span style={{ fontSize: 10.5, fontWeight: active ? 600 : 500 }}>{label}</span>
                      </button>
                    );
                  })}
                </div>
              </FormField>

              <FormField label="Fields">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {CREDENTIAL_TYPES[formData.type].fields.map(field => (
                    <div key={field}>
                      <div style={{ ...eyebrow(MIST, 9.5), marginBottom: 5 }}>{field}</div>
                      {field === 'privateKey' ? (
                        <textarea
                          value={formData.fields[field] || ''}
                          onChange={e => setFormData({
                            ...formData,
                            fields: { ...formData.fields, [field]: e.target.value },
                          })}
                          placeholder={`Enter ${field}…`}
                          rows={4}
                          style={{ ...fieldInput, fontFamily: FONT_MONO, fontSize: 12, resize: 'vertical' }}
                        />
                      ) : (
                        <input
                          type={field.includes('password') || field.includes('secret') || field.includes('key') ? 'password' : 'text'}
                          value={formData.fields[field] || ''}
                          onChange={e => setFormData({
                            ...formData,
                            fields: { ...formData.fields, [field]: e.target.value },
                          })}
                          placeholder={`Enter ${field}…`}
                          style={fieldInput}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </FormField>

              <FormField label="Notes (optional)">
                <textarea
                  value={formData.notes}
                  onChange={e => setFormData({ ...formData, notes: e.target.value })}
                  placeholder="Any additional notes…"
                  rows={2}
                  style={{ ...fieldInput, resize: 'vertical' }}
                />
              </FormField>
            </div>

            <div
              style={{
                padding: '14px 18px',
                borderTop: `1px solid ${LINE}`,
                display: 'flex', justifyContent: 'flex-end', gap: 8,
              }}
            >
              <button
                type="button"
                onClick={closeModal}
                className="card-btn"
                style={{ fontSize: 12, padding: '8px 16px' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={addOrUpdateCredential}
                disabled={!formData.project || !formData.name}
                className="card-btn primary"
                style={{
                  background: GREEN,
                  borderColor: GREEN,
                  color: '#0a1612',
                  fontSize: 12,
                  padding: '8px 16px',
                  opacity: (!formData.project || !formData.name) ? 0.5 : 1,
                  cursor: (!formData.project || !formData.name) ? 'not-allowed' : 'pointer',
                }}
              >
                {editingCred ? 'Save changes' : 'Add credential'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Local sub-components ----------------------------------------------------

function ProjectButton({
  active, onClick, icon, label, count, color,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
  color: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        textAlign: 'left',
        padding: '8px 10px',
        borderRadius: 6,
        background: active ? `${color}1A` : 'transparent',
        color: active ? color : WHITE,
        border: `1px solid ${active ? `${color}40` : 'transparent'}`,
        cursor: 'pointer',
        transition: 'all 120ms ease-out',
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 12,
        fontFamily: FONT_SANS,
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = INK_2; }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      <span style={{ color: active ? color : MIST, display: 'inline-flex' }}>{icon}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ ...eyebrow(active ? color : DIM, 9.5), opacity: 0.85 }}>{count}</span>
    </button>
  );
}

function IconActionBtn({
  onClick, title, children, color = MIST,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 26, height: 26, borderRadius: 6,
        background: 'transparent', color: MIST, border: 'none', cursor: 'pointer',
        transition: 'all 120ms ease-out',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = `${color}20`;
        el.style.color = color;
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = 'transparent';
        el.style.color = MIST;
      }}
    >
      {children}
    </button>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ ...eyebrow(MIST), marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}
