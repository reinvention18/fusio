// HTTPS proxy for Mission Control PWA.
// Terminates TLS and proxies to Next.js on :3001 so Chrome will install
// the app as a PWA (Chrome requires HTTPS for the install prompt).
//
// SETUP
//   1. Generate certs for whatever hostname the mobile device will hit:
//      • Tailscale: `sudo tailscale cert <your-tailscale-hostname>`
//      • Or any other source (Let's Encrypt, mkcert, self-signed).
//   2. Drop the cert + key into the certs/ directory beside this file
//      as `certs/tls.crt` and `certs/tls.key`. (The certs/ dir is in
//      .gitignore so your certs never get committed.)
//   3. Optional env vars (override defaults):
//      • MC_HTTPS_PORT  (default 3443)
//      • MC_NEXT_PORT   (default 3001)
//      • MC_CERT_PATH   (default certs/tls.crt)
//      • MC_KEY_PATH    (default certs/tls.key)
//      • MC_PWA_URL     (the public URL to print at boot — purely cosmetic)
//   4. `node https-proxy.js` (PM2 runs this as the `mc-https` app via
//      ecosystem.config.js).

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const HTTPS_PORT = parseInt(process.env.MC_HTTPS_PORT || '3443', 10);
const NEXT_PORT = parseInt(process.env.MC_NEXT_PORT || '3001', 10);
const CERT_DIR = path.join(__dirname, 'certs');
const CERT_PATH = process.env.MC_CERT_PATH || path.join(CERT_DIR, 'tls.crt');
const KEY_PATH = process.env.MC_KEY_PATH || path.join(CERT_DIR, 'tls.key');
const PWA_URL = process.env.MC_PWA_URL || `https://<your-host>:${HTTPS_PORT}`;

if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
  console.error('[mc-https] cert or key missing. Expected:');
  console.error('  cert: ' + CERT_PATH);
  console.error('  key:  ' + KEY_PATH);
  console.error('See the header comment in https-proxy.js for setup instructions.');
  process.exit(1);
}

const options = {
  cert: fs.readFileSync(CERT_PATH),
  key: fs.readFileSync(KEY_PATH),
};

const server = https.createServer(options, (req, res) => {
  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: NEXT_PORT,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: req.headers.host,
        'x-forwarded-proto': 'https',
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    }
  );

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    res.writeHead(502);
    res.end('Bad Gateway — is Next.js running on port ' + NEXT_PORT + '?');
  });

  req.pipe(proxyReq, { end: true });
});

// Also handle WebSocket upgrades (for HMR in dev mode)
server.on('upgrade', (req, socket, head) => {
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: NEXT_PORT,
    path: req.url,
    method: 'GET',
    headers: req.headers,
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
      Object.entries(proxyRes.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') +
      '\r\n\r\n'
    );
    proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on('error', () => {
    socket.end();
  });

  proxyReq.end();
});

server.listen(HTTPS_PORT, '0.0.0.0', () => {
  console.log(`\n  HTTPS proxy running on ${PWA_URL}`);
  console.log(`  Proxying to http://127.0.0.1:${NEXT_PORT}\n`);
  console.log(`  Open this URL on your mobile device to install the PWA.\n`);
});
