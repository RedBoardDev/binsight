import { describe, expect, it } from 'vitest';
import { createJwt, verifyJwt } from './auth';

/**
 * The HS256 ticket is the ONLY local token left (sessions are 100% Privy): it carries the caller's
 * account id from the Bearer-guarded /auth/ws-ticket to the /live upgrade. A forgeable or immortal
 * ticket would be an unauthenticated WebSocket, so signing + expiry are what these tests lock.
 */

const secret = 'test-secret-key';
const TICKET_TTL_SECONDS = 60;

describe('auth — HS256 WS ticket signing', () => {
  it('signs and verifies a ticket round-trip (sub = the account id the socket scopes to)', () => {
    const p = verifyJwt(secret, createJwt(secret, 'u1', 0, 'ws', TICKET_TTL_SECONDS));
    expect(p?.sub).toBe('u1');
    expect(p ? p.exp > p.iat : false).toBe(true);
  });

  it('rejects a ticket signed with a different secret (no cross-deployment replay)', () => {
    expect(
      verifyJwt('other-secret', createJwt(secret, 'u1', 0, 'ws', TICKET_TTL_SECONDS)),
    ).toBeNull();
  });

  it('rejects a tampered payload (forged account id)', () => {
    const [h, , s] = createJwt(secret, 'u1', 0, 'ws', TICKET_TTL_SECONDS).split('.') as [
      string,
      string,
      string,
    ];
    const forged = Buffer.from(
      JSON.stringify({ sub: 'admin', iat: 1, exp: 9_999_999_999, ver: 0, jti: 'ws' }),
    ).toString('base64url');
    expect(verifyJwt(secret, `${h}.${forged}.${s}`)).toBeNull();
  });

  it('rejects an expired ticket (a leaked ticket dies within its short TTL)', () => {
    expect(verifyJwt(secret, createJwt(secret, 'u1', 0, 'ws', -1))).toBeNull();
  });

  it('rejects structurally-invalid tokens without throwing', () => {
    expect(verifyJwt(secret, 'not-a-token')).toBeNull();
    expect(verifyJwt(secret, 'a.b')).toBeNull();
  });
});
