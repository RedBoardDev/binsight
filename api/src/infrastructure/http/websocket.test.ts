import { describe, expect, it } from 'vitest';
import type { AccountRepository, AccountUser } from '@/domain/ports';
import { accountStillValid, liveToken } from './websocket';

/** Minimal AccountRepository stub exposing only what accountStillValid reads. */
function accounts(user: AccountUser | null): Pick<AccountRepository, 'findById'> {
  return { findById: async () => user };
}

const USER: AccountUser = {
  id: 'U',
  privyUserId: 'did:privy:u',
  address: null,
  isOwner: false,
  createdAt: 0,
};

describe('liveToken — /live auth: native Authorization header vs browser ws-ticket (S10)', () => {
  it('prefers the Authorization: Bearer header (native — keeps the token out of the URL)', () => {
    expect(liveToken('Bearer abc.def.ghi', 'ticket')).toBe('abc.def.ghi');
  });

  it('falls back to the ?token= query when there is no Bearer header (browser ws-ticket)', () => {
    expect(liveToken(undefined, 'ticket')).toBe('ticket');
    expect(liveToken('Basic xyz', 'ticket')).toBe('ticket'); // non-Bearer scheme → use the ticket
  });

  it('is undefined when neither a Bearer header nor a query token is present', () => {
    expect(liveToken(undefined, undefined)).toBeUndefined();
    expect(liveToken('Bearer   ', undefined)).toBeUndefined(); // empty bearer → not a token
  });
});

describe('accountStillValid — live-socket revalidation (deletion must reach an open socket)', () => {
  // Sessions are 100% Privy and the WS ticket expires seconds after connect, so account deletion is
  // the ONE server-side revocation left — without this check a deleted account's socket would keep
  // streaming its old watchlist forever (/live authenticates only once, at upgrade).
  it('true while the account still exists', async () => {
    expect(await accountStillValid(accounts(USER), 'U')).toBe(true);
  });

  it('false once the account is deleted (access revoked) — the socket gets closed', async () => {
    expect(await accountStillValid(accounts(null), 'U')).toBe(false);
  });
});
