/**
 * RemotePanel — embeds peer MC instances inside the local UI via iframe.
 * One tab per peer, with a reachability dot in each tab.
 *
 * Re-skinned for the AI Fusio design language: mono uppercase eyebrow on
 * tab strip, accent-tinted active state, host URL surfaced in mono.
 */
'use client';

import { useEffect, useState } from 'react';
import { Wifi, WifiOff, RefreshCw, ExternalLink } from 'lucide-react';

interface RemoteHost {
  id: string;
  label: string;
  url: string;
}

const FONT_MONO = 'var(--font-mono, ui-monospace, monospace)';
const FONT_SANS = 'var(--font-sans, system-ui)';

const eyebrow = (color: string = 'var(--mist, rgba(255,255,255,0.5))', size = 10): React.CSSProperties => ({
  fontFamily: FONT_MONO,
  fontSize: size,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color,
});

export default function RemotePanel() {
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reachable, setReachable] = useState<Record<string, boolean | 'checking'>>({});

  useEffect(() => {
    fetch('/api/remote/hosts')
      .then(r => r.json())
      .then(d => {
        const list: RemoteHost[] = d.hosts || [];
        setHosts(list);
        if (list.length) setActiveId(list[0].id);
        for (const h of list) {
          setReachable(prev => ({ ...prev, [h.id]: 'checking' }));
          fetch(h.url + '/', { method: 'HEAD', mode: 'no-cors' })
            .then(() => setReachable(prev => ({ ...prev, [h.id]: true })))
            .catch(() => setReachable(prev => ({ ...prev, [h.id]: false })));
        }
      })
      .catch(() => setHosts([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div
        style={{
          padding: 24,
          fontFamily: FONT_SANS,
          fontSize: 13,
          color: 'var(--mist, rgba(255,255,255,0.5))',
        }}
      >
        Loading peer Mission Control instances…
      </div>
    );
  }

  if (hosts.length === 0) {
    return (
      <div
        style={{
          padding: 32,
          maxWidth: 640,
          margin: '0 auto',
          fontFamily: FONT_SANS,
          fontSize: 13,
          color: 'var(--white, #fff)',
        }}
      >
        <div style={{ ...eyebrow('var(--mist, rgba(255,255,255,0.5))'), marginBottom: 6 }}>
          Monitor · Remote
        </div>
        <h2
          style={{
            fontFamily: 'var(--font-display, "Space Grotesk")',
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: '-0.015em',
            marginBottom: 12,
          }}
        >
          No remote MC configured
        </h2>
        <p style={{ color: 'var(--mist, rgba(255,255,255,0.5))', marginBottom: 14, lineHeight: 1.55 }}>
          Add a peer Mission Control instance by editing{' '}
          <code style={{ color: 'var(--cyan, #5EC4D9)', fontFamily: FONT_MONO, fontSize: 12 }}>
            ~/.config/mc-remote-hosts.json
          </code>
          . The trust file lists each other host's URL + a shared bearer token used by{' '}
          <code style={{ color: 'var(--cyan, #5EC4D9)', fontFamily: FONT_MONO, fontSize: 12 }}>
            /api/remote-chat
          </code>
          .
        </p>
        <pre
          style={{
            background: 'var(--ink, #0A0A0E)',
            border: '1px solid var(--line, rgba(255,255,255,0.08))',
            borderRadius: 8,
            padding: 12,
            fontFamily: FONT_MONO,
            fontSize: 12,
            color: 'var(--fog, rgba(255,255,255,0.78))',
            overflowX: 'auto',
          }}
        >
{`{
  "myToken": "<secret>",
  "myLabel": "This Machine",
  "myUrl": "http://<my-ip>:3001",
  "hosts": [
    { "id": "pc", "label": "Andrew's PC", "url": "http://<peer>:3001", "token": "<same secret>" }
  ]
}`}
        </pre>
        <p style={{ color: 'var(--mist, rgba(255,255,255,0.5))', marginTop: 12, lineHeight: 1.55 }}>
          Restart MC after editing. Once peers are configured, agents can call{' '}
          <code style={{ color: 'var(--cyan, #5EC4D9)', fontFamily: FONT_MONO, fontSize: 12 }}>
            mc_remote_ask
          </code>{' '}
          to talk to them.
        </p>
      </div>
    );
  }

  const active = hosts.find(h => h.id === activeId) || hosts[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 130px)', fontFamily: FONT_SANS }}>
      {/* Tab strip — one button per peer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px',
          borderBottom: '1px solid var(--line, rgba(255,255,255,0.08))',
          background: 'var(--ink, #0A0A0E)',
          flexShrink: 0,
        }}
      >
        {hosts.map(h => {
          const r = reachable[h.id];
          const isActive = h.id === active.id;
          return (
            <button
              key={h.id}
              type="button"
              onClick={() => setActiveId(h.id)}
              data-fusio
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 10px',
                fontFamily: FONT_MONO,
                fontSize: 10.5,
                letterSpacing: '0.1em',
                borderRadius: 6,
                background: isActive ? 'rgba(204, 12, 32, 0.12)' : 'var(--ink-3, #1B1B23)',
                color: isActive ? 'var(--red, #CC0C20)' : 'var(--mist, rgba(255,255,255,0.5))',
                border: `1px solid ${isActive ? 'rgba(204, 12, 32, 0.4)' : 'var(--line, rgba(255,255,255,0.08))'}`,
                cursor: 'pointer',
                transition: 'all 120ms ease-out',
              }}
              onMouseEnter={e => {
                if (!isActive) (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)';
              }}
              onMouseLeave={e => {
                if (!isActive) (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))';
              }}
            >
              {r === true ? (
                <Wifi style={{ width: 11, height: 11, color: 'var(--green, #4CC38A)' }} />
              ) : r === false ? (
                <WifiOff style={{ width: 11, height: 11, color: 'var(--red, #CC0C20)' }} />
              ) : (
                <RefreshCw style={{ width: 11, height: 11, animation: 'spin 1s linear infinite' }} />
              )}
              <span style={{ textTransform: 'uppercase' }}>{h.label}</span>
              <span style={{ ...eyebrow('var(--dim, rgba(255,255,255,0.32))', 9.5) }}>· {h.id}</span>
            </button>
          );
        })}
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 10.5,
            color: 'var(--mist, rgba(255,255,255,0.5))',
          }}
        >
          <span style={{ fontFamily: FONT_MONO, letterSpacing: '0.04em' }}>{active.url}</span>
          <a
            href={active.url}
            target="_blank"
            rel="noopener"
            title="Open peer in new tab"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              color: 'var(--mist, rgba(255,255,255,0.5))',
              textDecoration: 'none',
              transition: 'color 120ms ease-out',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--cyan, #5EC4D9)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--mist, rgba(255,255,255,0.5))'; }}
          >
            <ExternalLink style={{ width: 11, height: 11 }} />
            <span style={{ ...eyebrow('inherit', 9.5) }}>new tab</span>
          </a>
        </div>
      </div>
      {/* Embed only the peer's CHAT surface (nav/status/footer hidden via ?embed=1). */}
      <iframe
        key={active.id}
        src={`${active.url.replace(/\/+$/, '')}/?tab=chat&embed=1`}
        title={`${active.label} — Chat`}
        style={{
          flex: 1,
          width: '100%',
          background: 'var(--void, #050507)',
          border: 0,
        }}
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"
      />
    </div>
  );
}
