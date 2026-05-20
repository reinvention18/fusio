/** @type {import('next').NextConfig} */
//
// allowedDevOrigins — Next dev rejects cross-origin requests by default for
// hot-reload security. If you reach this dev server from a different host
// (a Tailscale hostname, a LAN IP, a phone PWA), add that origin here OR
// set the MC_ALLOWED_DEV_ORIGINS env var (comma-separated list of origins).
//
// Examples:
//   MC_ALLOWED_DEV_ORIGINS="https://my-box.tail123abc.ts.net,https://192.168.1.50:3443"
//
const allowedDevOrigins = (process.env.MC_ALLOWED_DEV_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins,
  serverExternalPackages: ['better-sqlite3', '@huggingface/transformers', 'onnxruntime-node', 'sharp'],
  outputFileTracingIncludes: {
    '/**/*': ['./node_modules/better-sqlite3/build/Release/*.node'],
  },
  // CRITICAL: data/ is 645MB at runtime (chat history, mem.db, subagent records).
  // Without this, Next.js's outputFileTracer scans every byte on every build,
  // hanging the build for 20+ minutes. data/ is created at runtime — never
  // needed at build time.
  outputFileTracingExcludes: {
    '*': [
      './data/**',
      './data/**/*',
      './.next/cache/**',
      './certs/**',
      './logs/**',
      './*.log',
    ],
  },
  // Skip the in-build typecheck and lint — they choke on the 7000-line
  // ChatPanel.tsx and balloon build time to 25+ minutes / 18GB RSS. We run
  // `tsc --noEmit -p tsconfig.json` separately for type safety; this just
  // unblocks the production build path.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // Disable minification — SWC minifier hits a pathological loop on the huge
  // ChatPanel.tsx file (23+ minutes, 17GB heap). Bundle is ~2-3× larger but
  // for a self-hosted single-tenant tool that's an acceptable tradeoff for
  // builds that finish in under a minute. Revisit when ChatPanel is split.
  webpack: (config, { dev, isServer }) => {
    if (!dev) {
      config.optimization = {
        ...config.optimization,
        minimize: false,
      };
    }
    // Force native-only Node packages to be externalized for the SERVER bundle
    // even in dev. Without this, webpack's static analysis drags better-sqlite3
    // into the edge runtime where it can't resolve `fs` and the whole dev
    // server returns 500s. `serverExternalPackages` alone isn't reliable in
    // dev when these are reached through dynamic import().
    const externalsList = config.externals || [];
    const nativeOnly = ['better-sqlite3', '@huggingface/transformers', 'onnxruntime-node', 'sharp'];
    const NODE_BUILTINS = new Set([
      'fs','fs/promises','path','os','child_process','crypto','http','https','net','dns','tls',
      'stream','stream/web','stream/promises','util','events','buffer','url','querystring',
      'zlib','readline','assert','perf_hooks','worker_threads','cluster','dgram','tty','vm',
      'process','module','timers','timers/promises','async_hooks','inspector','v8','string_decoder',
      'punycode','repl','sys','constants','wasi','console',
    ]);

    if (isServer) {
      // Treat node builtins (both bare and `node:` scheme) and native-only
      // packages as externals so webpack doesn't try to bundle them.
      // serverExternalPackages alone is unreliable when reached through
      // dynamic import() — this catches every path.
      config.externals = [
        ...(Array.isArray(externalsList) ? externalsList : [externalsList]),
        ({ request }, callback) => {
          if (!request) return callback();
          if (request.startsWith('node:')) return callback(null, 'commonjs ' + request);
          if (NODE_BUILTINS.has(request)) return callback(null, 'commonjs ' + request);
          if (nativeOnly.some(name => request === name || request.startsWith(name + '/'))) {
            return callback(null, 'commonjs ' + request);
          }
          callback();
        },
      ];
    } else {
      // Client bundle: stub node builtins. Anything that REALLY runs only
      // on the server should be in a server component / route handler.
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        ...Object.fromEntries(Array.from(NODE_BUILTINS).map(b => [b, false])),
      };
    }
    return config;
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
};

module.exports = nextConfig;
