import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Content Security Policy (SPEC §2.2) ─────────────────────────────────────────────────────────────
// The web is non-custodial: the ONLY barrier between an injected script and a wallet withdrawal is this CSP's
// `connect-src` / `frame-src` (they bound where a script may talk / embed). XSS is otherwise accepted risk, so
// this header is the real security control here, not decoration.
//
// The origins the browser must reach are NEXT_PUBLIC_* vars inlined into the client bundle at BUILD time (see
// infrastructure/config.ts + realtime/live-client.ts), so we derive `connect-src` from the SAME env with the SAME
// localhost defaults. `new URL().origin` strips any path → a clean scheme://host:port CSP source.
const apiOrigin = new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787').origin;
const wsOrigin = new URL(process.env.NEXT_PUBLIC_API_WS_URL ?? 'ws://localhost:8787').origin;

// Privy embedded-wallet + auth requirements. Source: Privy's official Next.js CSP recipe
// (https://docs.privy.io/security/implementation-guide/content-security-policy, fetched via context7).
// This app configures ONLY embedded Solana wallets (providers.tsx — no WalletConnect/Coinbase external
// connectors), so we allow the embedded-wallet essentials and DELIBERATELY DROP the WalletConnect/Coinbase
// relay domains from Privy's full list, keeping connect-src (the exfiltration barrier) as tight as possible:
//   - https://auth.privy.io            — Privy auth + embedded-wallet iframe (frame-src) and its API (connect-src)
//   - https://*.rpc.privy.systems      — Privy's embedded-wallet RPC providers (connect-src)
//   - https://challenges.cloudflare.com — Cloudflare Turnstile CAPTCHA Privy may show on login (script-src + frame-src)
const PRIVY_AUTH = 'https://auth.privy.io';
const PRIVY_RPC = 'https://*.rpc.privy.systems';
const CLOUDFLARE_TURNSTILE = 'https://challenges.cloudflare.com';
// The position price chart falls back to a dexscreener embed for pools GeckoTerminal hasn't indexed yet
// (presentation/components/position-chart.tsx) → its iframe origin must be allowed in frame-src.
const DEXSCREENER = 'https://dexscreener.com';

// `next dev` + the React dev build use eval() (HMR / reconstructed server error stacks), so 'unsafe-eval' is
// required in DEVELOPMENT only. Production needs neither eval nor unsafe-eval in script-src.
const isDev = process.env.NODE_ENV === 'development';

// Kept in next.config.ts (NOT a proxy/nonce refactor): App-Router Next 16 WITHOUT a nonce injects inline
// bootstrap + hydration scripts and inline styles, so a config-header CSP MUST keep 'unsafe-inline' on
// script-src/style-src. The stricter alternative — a proxy minting a per-request nonce — forces EVERY page to
// dynamic rendering (kills static optimization), an architecture change we don't take here and moot since XSS
// is accepted risk. Ref: node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md ("Without Nonces").
const csp = [
  // Fallback for any resource type not explicitly named below.
  `default-src 'self'`,
  // Scripts: our bundle ('self') + Next's inline bootstrap/hydration ('unsafe-inline') + Turnstile widget; eval dev-only.
  `script-src 'self' 'unsafe-inline' ${CLOUDFLARE_TURNSTILE}${isDev ? " 'unsafe-eval'" : ''}`,
  // Styles: Tailwind/Next + the Privy modal inject inline styles → 'unsafe-inline' (styles cannot exfiltrate data).
  `style-src 'self' 'unsafe-inline'`,
  // Images: self + data/blob (generated PnL share cards) + ANY https host — token icons load from arbitrary
  // per-mint CDNs (position-row.tsx). Images can't execute, so `https:` is an acceptable width for token art.
  `img-src 'self' data: blob: https:`,
  `font-src 'self' data:`,
  // THE exfiltration barrier — a script may ONLY talk to: our API + WS origins, and Privy auth/RPC. Nothing else.
  `connect-src 'self' ${apiOrigin} ${wsOrigin} ${PRIVY_AUTH} ${PRIVY_RPC}`,
  // Iframes we embed: the Privy auth/embedded-wallet iframe, its Turnstile CAPTCHA, and the dexscreener chart fallback.
  `frame-src 'self' ${PRIVY_AUTH} ${CLOUDFLARE_TURNSTILE} ${DEXSCREENER}`,
  // Legacy fallback for frame-src/worker-src on older browsers — mirror the frame set.
  `child-src 'self' ${PRIVY_AUTH} ${CLOUDFLARE_TURNSTILE} ${DEXSCREENER}`,
  // Workers: the PWA service worker (/sw.js, same-origin) + blob workers.
  `worker-src 'self' blob:`,
  `manifest-src 'self'`,
  `object-src 'none'`,
  `base-uri 'self'`,
  `form-action 'self'`,
  // Anti-clickjacking: the authenticated dashboard (one-click actions incl. the GLOBAL KILL) must never be framed.
  `frame-ancestors 'none'`,
].join('; ');

// NB: no `upgrade-insecure-requests`. The API/WS origins are http/ws in dev (and can be self-hosted on http),
// which that directive would forcibly upgrade to https/wss and break; connect-src already pins the exact origins.

// Defence-in-depth response headers on every route.
const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];

const nextConfig: NextConfig = {
  // Self-contained server for the Docker image.
  output: 'standalone',
  // Monorepo: trace the workspace dependency (@binsight/shared) from the repo root into the bundle.
  outputFileTracingRoot: repoRoot,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
