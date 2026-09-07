import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@/config/env';
import type {
  AccountRepository,
  AccountUser,
  InviteEntry,
  InviteRedeemFailure,
} from '@/domain/ports';
import { verifyJwt } from './auth';
import type { PrivyVerifier } from './privy-auth';
import { buildServer, type ServerDeps } from './server';

/**
 * The onRequest guard is the multi-tenant boundary: 100% Privy tokens + the invite gate. These tests
 * lock its three-state contract — no/bad token ⇒ 401 (nothing leaks), verified-but-accountless ⇒
 * 403 needsInvite everywhere except the two gate endpoints, account ⇒ req.account — plus the
 * single-use invite semantics and the owner bootstrap (OWNER_PRIVY_DID).
 */

const OWNER_DID = 'did:privy:owner000000000000000000';
const ALICE_DID = 'did:privy:alice000000000000000000';
const BOB_DID = 'did:privy:bob00000000000000000000';
const AUTH_SECRET = 'a'.repeat(32);
/** Server-generated invite codes are 6 random bytes hex-encoded. */
const INVITE_CODE_HEX_LENGTH = 12;

/** Fake verifier: a token is the DID it authenticates ('did:privy:...'), anything else fails. */
const fakeVerifier: PrivyVerifier = {
  verify: async (token) => (token.startsWith('did:privy:') ? { did: token } : null),
};

/**
 * In-memory AccountRepository covering only what the guard/gate/watch paths touch. Anything else is
 * intentionally absent — a hit would throw and surface an unexpected dependency. Redeem mirrors the
 * real repo's atomic-claim semantics (first caller burns the code; typed failures for the rest).
 */
function makeAccounts(): AccountRepository {
  const byDid = new Map<string, AccountUser>();
  const byId = new Map<string, AccountUser>();
  const invites = new Map<string, InviteEntry>();
  const watches = new Map<string, Set<string>>();
  let seq = 0;

  const repo: Partial<AccountRepository> = {
    async findByPrivyId(did) {
      return byDid.get(did) ?? null;
    },
    async findById(id) {
      return byId.get(id) ?? null;
    },
    async createInvite({ code, note, expiresAt }) {
      invites.set(code, {
        code,
        note: note ?? '',
        createdAt: Date.now(),
        expiresAt: expiresAt ?? null,
        usedByUserId: null,
        usedAt: null,
      });
    },
    async listInvites() {
      return [...invites.values()];
    },
    async deleteInvite(code) {
      const inv = invites.get(code);
      if (!inv || inv.usedByUserId !== null) return false;
      invites.delete(code);
      return true;
    },
    async redeemInviteAndCreateUser({ code, privyUserId, isOwner, now }) {
      const fail = (reason: InviteRedeemFailure) => ({ ok: false as const, reason });
      const inv = invites.get(code);
      if (!inv) return fail('not_found');
      if (inv.usedByUserId !== null) return fail('used');
      if (inv.expiresAt !== null && inv.expiresAt <= now) return fail('expired');
      const user: AccountUser = {
        id: `u${++seq}`,
        privyUserId,
        address: null,
        isOwner,
        createdAt: now,
      };
      inv.usedByUserId = user.id;
      inv.usedAt = now;
      byDid.set(privyUserId, user);
      byId.set(user.id, user);
      watches.set(user.id, new Set());
      return { ok: true as const, user };
    },
    async addWatch(userId, w) {
      (watches.get(userId) ?? watches.set(userId, new Set()).get(userId)!).add(w.address);
    },
    async countWatched(userId) {
      return watches.get(userId)?.size ?? 0;
    },
    async isWatching(userId, address) {
      return watches.get(userId)?.has(address) ?? false;
    },
    async watchedAddresses(userId) {
      return [...(watches.get(userId) ?? [])];
    },
    async watchedBy() {
      return [];
    },
    async monitoredWallets() {
      return [];
    },
  };
  return repo as AccountRepository;
}

function build() {
  const config = loadConfig({
    AUTH_SECRET,
    PRIVY_APP_ID: 'test-app',
    OWNER_PRIVY_DID: OWNER_DID,
    SOLANA_WS_URL: 'wss://rpc.example.com',
    WEB_ORIGINS: 'http://localhost:3000',
  });
  const accounts = makeAccounts();
  const deps = {
    config,
    privyVerifier: fakeVerifier,
    bus: { on: () => {}, emit: () => {} },
    engine: { addWallet: vi.fn(async () => {}), ingestStatus: () => ({ ready: true }) },
    accounts,
    presence: { activeDevices: () => [] },
    pushRepo: { save: vi.fn(async () => {}) },
    vapidPublicKey: '',
    sendTestPush: async () => 0,
    // The rest are unused by the routes these tests exercise.
    repo: {},
    configRepo: {},
    backfill: {},
    walletPnl: {},
    networthSnapshots: {},
    notifications: {},
    gecko: {},
  } as unknown as ServerDeps;
  return { app: buildServer(deps), accounts };
}

type App = Awaited<ReturnType<typeof build>['app']>;

const bearer = (did: string) => ({ authorization: `Bearer ${did}` });

async function seedInvite(accounts: AccountRepository, code: string, expiresAt?: number | null) {
  await accounts.createInvite({ code, expiresAt: expiresAt ?? null });
}

async function redeem(app: App, did: string, code: string) {
  return app.inject({
    method: 'POST',
    url: '/auth/redeem-invite',
    headers: bearer(did),
    payload: { code },
  });
}

describe('onRequest guard — Privy Bearer boundary', () => {
  it('leaves /health and /config/app public (readable before any session exists)', async () => {
    const { app } = build();
    const a = await app;
    expect((await a.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const flags = await a.inject({ method: 'GET', url: '/config/app' });
    expect(flags.statusCode).toBe(200);
    expect(flags.json()).toEqual({}); // openAccess flag is gone; empty forward-compat envelope
  });

  it('401s any protected route without a token, and with a token Privy rejects', async () => {
    const a = await build().app;
    for (const headers of [undefined, { authorization: 'Bearer forged-token' }]) {
      const res = await a.inject({ method: 'GET', url: '/auth/verify', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('403s a VERIFIED login with no account everywhere except the gate endpoints (invite wall)', async () => {
    const a = await build().app;
    for (const [method, url] of [
      ['GET', '/wallets'],
      ['GET', '/state'],
      ['GET', '/auth/ws-ticket'],
      ['GET', '/admin/invites'],
    ] as const) {
      const res = await a.inject({ method, url, headers: bearer(ALICE_DID) });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'no account', needsInvite: true });
    }
  });

  it('tells an accountless login it needs an invite via /auth/me (the gate is discoverable)', async () => {
    const a = await build().app;
    const res = await a.inject({ method: 'GET', url: '/auth/me', headers: bearer(ALICE_DID) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ registered: false, needsInvite: true });
  });
});

describe('POST /auth/redeem-invite — the account-creation gate', () => {
  it('creates the account on a valid code, then the same token passes the guard everywhere', async () => {
    const { app, accounts } = build();
    const a = await app;
    await seedInvite(accounts, 'code-alice');
    const res = await redeem(a, ALICE_DID, 'code-alice');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      account: { id: expect.any(String), address: null, isOwner: false },
    });
    const me = await a.inject({ method: 'GET', url: '/auth/me', headers: bearer(ALICE_DID) });
    expect(me.json()).toEqual({ registered: true, address: null, isOwner: false });
    // The invite wall is gone for this identity — a formerly-403 route now serves it.
    expect(
      (await a.inject({ method: 'GET', url: '/wallets', headers: bearer(ALICE_DID) })).statusCode,
    ).toBe(200);
  });

  it('validates the body shape (missing/non-string code ⇒ 400, nothing consumed)', async () => {
    const a = await build().app;
    for (const payload of [{}, { code: 42 }, { code: '' }, undefined]) {
      const res = await a.inject({
        method: 'POST',
        url: '/auth/redeem-invite',
        headers: bearer(ALICE_DID),
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_code' });
    }
  });

  it('answers typed failures: unknown ⇒ invalid_code, burned ⇒ code_used, past-expiry ⇒ code_expired', async () => {
    const { app, accounts } = build();
    const a = await app;
    const unknown = await redeem(a, ALICE_DID, 'never-created');
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({ error: 'invalid_code' });

    await seedInvite(accounts, 'one-shot');
    await redeem(a, ALICE_DID, 'one-shot');
    const used = await redeem(a, BOB_DID, 'one-shot');
    expect(used.statusCode).toBe(409);
    expect(used.json()).toEqual({ error: 'code_used' });

    await seedInvite(accounts, 'too-late', Date.now() - 1000);
    const expired = await redeem(a, BOB_DID, 'too-late');
    expect(expired.statusCode).toBe(400);
    expect(expired.json()).toEqual({ error: 'code_expired' });
  });

  it('two concurrent redeems of ONE code: exactly one account is created (single-use invariant)', async () => {
    const { app, accounts } = build();
    const a = await app;
    await seedInvite(accounts, 'contested');
    const [r1, r2] = await Promise.all([
      redeem(a, ALICE_DID, 'contested'),
      redeem(a, BOB_DID, 'contested'),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([200, 409]); // one winner, one typed code_used
  });

  it('409s an already-registered caller without consuming the code (no silent double-account)', async () => {
    const { app, accounts } = build();
    const a = await app;
    await seedInvite(accounts, 'first');
    await seedInvite(accounts, 'second');
    await redeem(a, ALICE_DID, 'first');
    const again = await redeem(a, ALICE_DID, 'second');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'already_registered' });
    const second = (await accounts.listInvites()).find((i) => i.code === 'second');
    expect(second?.usedByUserId).toBeNull(); // the spare code survives for someone else
  });

  it('bootstraps the owner: the OWNER_PRIVY_DID identity redeems into an isOwner account', async () => {
    const { app, accounts } = build();
    const a = await app;
    await seedInvite(accounts, 'owner-code');
    const res = await redeem(a, OWNER_DID, 'owner-code');
    expect(res.json().account.isOwner).toBe(true);
    const me = await a.inject({ method: 'GET', url: '/auth/me', headers: bearer(OWNER_DID) });
    expect(me.json()).toEqual({ registered: true, address: null, isOwner: true });
  });
});

describe('/admin/invites — owner-only invite administration', () => {
  /** Owner + a plain member, both registered. */
  async function withOwnerAndMember() {
    const { app, accounts } = build();
    const a = await app;
    await seedInvite(accounts, 'owner-code');
    await seedInvite(accounts, 'member-code');
    await redeem(a, OWNER_DID, 'owner-code');
    await redeem(a, ALICE_DID, 'member-code');
    return { a, accounts };
  }

  it('403s every invite-admin verb for a non-owner account (the operator surface stays closed)', async () => {
    const { a } = await withOwnerAndMember();
    for (const [method, url] of [
      ['GET', '/admin/invites'],
      ['POST', '/admin/invites'],
      ['DELETE', '/admin/invites/whatever'],
    ] as const) {
      const res = await a.inject({ method, url, headers: bearer(ALICE_DID), payload: {} });
      expect(res.statusCode).toBe(403);
    }
  });

  it('generates codes SERVER-side (12 hex chars, never client-chosen) with note + expiry', async () => {
    const { a } = await withOwnerAndMember();
    const res = await a.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: bearer(OWNER_DID),
      payload: { note: 'for a friend', expiresAt: Date.now() + 60_000 },
    });
    expect(res.statusCode).toBe(200);
    const { ok, code } = res.json();
    expect(ok).toBe(true);
    expect(code).toMatch(new RegExp(`^[0-9a-f]{${INVITE_CODE_HEX_LENGTH}}$`));
    // The generated code is immediately redeemable end-to-end.
    expect((await redeem(a, BOB_DID, code)).statusCode).toBe(200);
  });

  it('rejects a non-numeric expiresAt (input validation, not a silent NaN expiry)', async () => {
    const { a } = await withOwnerAndMember();
    const res = await a.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: bearer(OWNER_DID),
      payload: { expiresAt: 'tomorrow' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists invites with their used/unused state; deletes unused only (used = audit trail)', async () => {
    const { a } = await withOwnerAndMember();
    const created = await a.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: bearer(OWNER_DID),
      payload: {},
    });
    const code = created.json().code as string;
    const list = await a.inject({
      method: 'GET',
      url: '/admin/invites',
      headers: bearer(OWNER_DID),
    });
    const byCode = new Map(list.json().map((i: { code: string; used: boolean }) => [i.code, i]));
    expect((byCode.get('owner-code') as { used: boolean }).used).toBe(true);
    expect((byCode.get(code) as { used: boolean }).used).toBe(false);
    // Used code cannot be deleted (404); the fresh one can.
    const delUsed = await a.inject({
      method: 'DELETE',
      url: '/admin/invites/owner-code',
      headers: bearer(OWNER_DID),
    });
    expect(delUsed.statusCode).toBe(404);
    const delFresh = await a.inject({
      method: 'DELETE',
      url: `/admin/invites/${code}`,
      headers: bearer(OWNER_DID),
    });
    expect(delFresh.statusCode).toBe(200);
  });
});

describe('GET /auth/ws-ticket — the browser WS credential', () => {
  it('mints a short-lived HS256 ticket carrying the caller account id (what /live scopes on)', async () => {
    const { app, accounts } = build();
    const a = await app;
    await seedInvite(accounts, 'code-alice');
    const account = (await redeem(a, ALICE_DID, 'code-alice')).json().account;
    const res = await a.inject({
      method: 'GET',
      url: '/auth/ws-ticket',
      headers: bearer(ALICE_DID),
    });
    expect(res.statusCode).toBe(200);
    const { token, expiresInSeconds } = res.json();
    expect(expiresInSeconds).toBe(60);
    const payload = verifyJwt(AUTH_SECRET, token);
    expect(payload?.sub).toBe(account.id);
  });
});
