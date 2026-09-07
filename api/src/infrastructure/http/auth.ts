import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * WS ticket signing — a browser WebSocket cannot send an Authorization header, so /live is
 * authenticated by a short-lived HS256 ticket minted at GET /auth/ws-ticket (behind the Privy
 * Bearer guard) and passed as ?token=. This tiny signer is all that remains of the old local auth:
 * API sessions themselves are 100% Privy now. The signing key is AUTH_SECRET.
 */

export interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
  /** Legacy claim kept for wire-compat with existing verifiers; tickets always carry 0. */
  ver: number;
  /** Legacy claim kept for wire-compat; tickets carry a fixed marker (no session table backs them). */
  jti: string;
}

const b64url = (b: Buffer): string => b.toString('base64url');
const hmac = (secret: string, data: string): Buffer =>
  createHmac('sha256', secret).update(data).digest();

export function createJwt(
  secret: string,
  sub: string,
  ver: number,
  jti: string,
  ttlSeconds: number,
): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    Buffer.from(JSON.stringify({ sub, iat: now, exp: now + ttlSeconds, ver, jti })),
  );
  const sig = b64url(hmac(secret, `${header}.${payload}`));
  return `${header}.${payload}.${sig}`;
}

export function verifyJwt(secret: string, token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  const expected = b64url(hmac(secret, `${header}.${payload}`));
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as JwtPayload;
    if (typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) return null;
    // Normalise ver/jti so callers can treat them as plain values (tokens always carry them now).
    if (typeof data.ver !== 'number') data.ver = 0;
    if (typeof data.jti !== 'string') data.jti = '';
    return data;
  } catch {
    return null;
  }
}
