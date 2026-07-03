#!/usr/bin/env node
/**
 * Web security guard (SPEC §2.2) — a dependency-free, CI-greppable assertion over the web app. Run it with the
 * web workspace script `yarn workspace @binsight/web check:security` (or, from repo root, `yarn guard:web-security`).
 * It exits non-zero on a violation so CI fails loud — wire it into CI right after the `web build` step.
 *
 * It asserts two invariants the SPEC names as the security barrier of the non-custodial web:
 *  1. web/next.config.ts still declares the KEY CSP directives (default-src, connect-src, frame-ancestors) — so a
 *     refactor can't silently drop the header that is the only thing bounding where an injected script may talk.
 *  2. No auth token is ever written to (local|session)Storage in web/src — Privy holds tokens IN MEMORY; persisting
 *     one to storage would make it stealable by any XSS. We flag `setItem` calls whose KEY names a token/secret.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..'); // web/scripts/ → web/
const repoRoot = join(webDir, '..');
const webSrc = join(webDir, 'src');
const nextConfig = join(webDir, 'next.config.ts');

/** CSP directives that MUST remain present in the Next config (the SPEC-named barrier). */
const REQUIRED_CSP_DIRECTIVES = ['default-src', 'connect-src', 'frame-ancestors'];
/** A (local|session)Storage.setItem whose KEY expression matches this is a forbidden token-in-storage write. */
const FORBIDDEN_KEY = /token|jwt|bearer|secret|credential|session|auth/i;
const SET_ITEM = /\b(?:local|session)Storage\.setItem\s*\(\s*([^,]+?)\s*,/g;

const failures = [];

// ── 1) CSP directives present in next.config.ts ──────────────────────────────────────────────────────
const configText = readFileSync(nextConfig, 'utf8');
for (const directive of REQUIRED_CSP_DIRECTIVES) {
  if (!configText.includes(directive)) {
    failures.push(`next.config.ts is missing the required CSP directive "${directive}"`);
  }
}

// ── 2) No token/secret written to web storage anywhere under web/src ──────────────────────────────────
/** Recursively collect .ts/.tsx files under a dir. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

for (const file of walk(webSrc)) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(SET_ITEM)) {
    if (FORBIDDEN_KEY.test(match[1])) {
      const rel = file.slice(repoRoot.length + 1);
      failures.push(`${rel}: storage write with a token-like key → ${match[0].trim()}…`);
    }
  }
}

if (failures.length > 0) {
  console.error('✖ web security guard FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  '✔ web security guard passed (CSP directives present; no token written to web storage).',
);
