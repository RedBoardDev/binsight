import { afterEach, describe, expect, it, vi } from 'vitest';
import { WatchlistService } from '@/application/accounts/watchlist-service';
import { loadConfig } from '@/config/env';
import type { AccountRepository, AccountUser, ClosedQuery } from '@/domain/ports';
import { createJwt } from './auth';
import { buildServer, type ServerDeps } from './server';

const SECRET = 'a'.repeat(32);
const OWNER: AccountUser = {
  id: 'owner',
  address: 'So11111111111111111111111111111111111111112',
  isOwner: true,
  tokenVersion: 0,
};
const VIEWER: AccountUser = {
  id: 'viewer',
  address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  isOwner: false,
  tokenVersion: 0,
};

/**
 * Two pre-registered accounts, each with one live session (jti = `<id>-sess`) and watching its own
 * address. Only what the exercised routes read is implemented; anything else throws on use.
 */
function makeAccounts(): AccountRepository {
  const users = new Map([OWNER, VIEWER].map((u) => [u.id, u]));
  const sessions = new Map([...users.keys()].map((id) => [`${id}-sess`, id]));
  const repo: Partial<AccountRepository> = {
    async findById(id) {
      return users.get(id) ?? null;
    },
    async findByIdWithSession(id, jti) {
      return sessions.get(jti) === id ? (users.get(id) ?? null) : null;
    },
    async isSessionValid(jti) {
      return sessions.has(jti);
    },
    async watchedAddresses(userId) {
      const u = users.get(userId);
      return u ? [u.address] : [];
    },
    async listAccess() {
      return [];
    },
  };
  return repo as AccountRepository;
}

function build() {
  const config = loadConfig({
    AUTH_SECRET: SECRET,
    SOLANA_WS_URL: 'wss://rpc.example.com',
    WEB_ORIGINS: 'http://localhost:3000',
    LOG_LEVEL: 'error',
  });
  const accounts = makeAccounts();
  const getClosed = vi.fn(async (_wallets: string[], opts: ClosedQuery) => ({
    rows: [],
    total: 0,
    page: opts.page,
    pageSize: opts.pageSize,
  }));
  const deps = {
    config,
    bus: { on: () => {}, emit: () => {} },
    engine: {
      getState: (_wallets: string[], scope: string) => ({ scope }),
      healthSnapshot: () => ({ ok: true }),
      setViewedWallets: () => {},
      ingestStatus: () => ({ ready: true, indexedTxs: 0 }),
      refreshNow: () => {},
    },
    accounts,
    watchlist: new WatchlistService(
      accounts,
      { addWallet: async () => {}, removeWallet() {} },
      false,
    ),
    queries: { getClosed },
    meter: { stats: () => ({}), anomalies: () => [] },
    creditLedger: { since: async () => [] },
    presence: { activeDevices: () => [], heartbeat: () => {} },
    // Unused by the routes exercised here.
    store: {},
    configRepo: {},
    notifications: {},
    walletPnl: {},
    networthSnapshots: {},
    walletRealized: {},
    pushRepo: {},
    sendTestPush: async () => 0,
  } as unknown as ServerDeps;
  return { appP: buildServer(deps), getClosed };
}

const sessionOf = (u: AccountUser) => createJwt(SECRET, u.id, u.tokenVersion, `${u.id}-sess`);
const ticketOf = (u: AccountUser) =>
  createJwt(SECRET, u.id, u.tokenVersion, `${u.id}-sess`, 60, 'ws');
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

let open: Array<{ close(): Promise<unknown> }> = [];
async function app() {
  const built = build();
  const a = await built.appP;
  open.push(a);
  return { app: a, getClosed: built.getClosed };
}
afterEach(async () => {
  await Promise.all(open.map((a) => a.close()));
  open = [];
});

describe('auth hook — a WebSocket ticket (aud "ws") opens /live and nothing else', () => {
  // The ticket travels in a URL (?token=), so it can leak into proxy logs and browser history. It is
  // signed with the same secret and names a real session: only its audience stops it acting as a
  // full 30-day session on every REST route.
  it('baseline: the same session as a normal token is accepted', async () => {
    const { app: a } = await app();
    const res = await a.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(sessionOf(VIEWER)),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ address: VIEWER.address, isOwner: false });
  });

  it('refuses a ws ticket on REST routes, including minting another ticket from it', async () => {
    const { app: a } = await app();
    const ticket = ticketOf(OWNER);
    for (const url of ['/auth/me', '/auth/verify', '/auth/ws-ticket', '/positions/closed']) {
      const res = await a.inject({ method: 'GET', url, headers: bearer(ticket) });
      expect(res.statusCode, url).toBe(401);
    }
    // An owner ticket must not reach the admin surface either.
    const admin = await a.inject({ method: 'GET', url: '/admin/access', headers: bearer(ticket) });
    expect(admin.statusCode).toBe(401);
  });

  it('the ticket issued by /auth/ws-ticket carries the ws audience and is refused by REST', async () => {
    const { app: a } = await app();
    const issued = await a.inject({
      method: 'GET',
      url: '/auth/ws-ticket',
      headers: bearer(sessionOf(VIEWER)),
    });
    expect(issued.statusCode).toBe(200);
    const { token, expiresInSeconds } = issued.json();
    expect(expiresInSeconds).toBe(60);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(payload.aud).toBe('ws');
    const me = await a.inject({ method: 'GET', url: '/auth/me', headers: bearer(token) });
    expect(me.statusCode).toBe(401);
  });

  it('/live accepts the ticket in ?token= and streams the initial state', async () => {
    const { app: a } = await app();
    await a.ready();
    // Listen from onInit: the server may push its first frame before injectWS resolves.
    let ws: import('ws').WebSocket | undefined;
    const first = new Promise<{ type: string; payload: unknown }>((resolve, reject) => {
      void a.injectWS(
        `/live?token=${ticketOf(VIEWER)}`,
        {},
        {
          onInit(socket) {
            ws = socket;
            socket.once('message', (raw: Buffer) => resolve(JSON.parse(raw.toString())));
            socket.once('close', (code: number) => reject(new Error(`closed ${code}`)));
          },
        },
      );
    });
    expect(await first).toEqual({ type: 'state', payload: { scope: 'all' } });
    ws?.terminate();
  });

  it('/live still refuses a ticket whose session was revoked (1008)', async () => {
    // The audience only narrows where a ticket works; it must not bypass the session allowlist.
    const { app: a } = await app();
    await a.ready();
    const revoked = createJwt(SECRET, VIEWER.id, VIEWER.tokenVersion, 'gone', 60, 'ws');
    const code = await new Promise<number>((resolve) => {
      void a.injectWS(
        `/live?token=${revoked}`,
        {},
        {
          onInit(socket) {
            socket.once('close', (c: number) => resolve(c));
          },
        },
      );
    });
    expect(code).toBe(1008);
  });
});

describe('/positions/closed — pagination parameters', () => {
  it('falls back to 20 rows when pageSize is not a number', async () => {
    // Number('x') is NaN and survives Math.min/max; handed to the query layer it made drizzle drop the
    // LIMIT entirely, i.e. a garbage query string dumped the whole history in one response.
    const { app: a, getClosed } = await app();
    const res = await a.inject({
      method: 'GET',
      url: '/positions/closed?pageSize=x&page=y',
      headers: bearer(sessionOf(VIEWER)),
    });
    expect(res.statusCode).toBe(200);
    expect(getClosed).toHaveBeenCalledTimes(1);
    const [wallets, opts] = getClosed.mock.calls[0]!;
    expect(wallets).toEqual([VIEWER.address]);
    expect(opts.pageSize).toBe(20);
    expect(opts.page).toBe(1);
  });

  it('clamps an oversized pageSize to the 100-row cap', async () => {
    const { app: a, getClosed } = await app();
    await a.inject({
      method: 'GET',
      url: '/positions/closed?pageSize=100000',
      headers: bearer(sessionOf(VIEWER)),
    });
    expect(getClosed.mock.calls[0]![1].pageSize).toBe(100);
  });
});

describe('owner-only plugin', () => {
  // Every owner route sits in one encapsulated plugin behind a single preHandler, so a new admin route
  // can't be left ungated by forgetting a per-route check. These are the two most sensitive reads:
  // the account/invite list and the RPC budget telemetry.
  it.each(['/admin/access', '/debug/rpc'])('%s: 403 for a signed-in non-owner', async (url) => {
    const { app: a } = await app();
    const res = await a.inject({ method: 'GET', url, headers: bearer(sessionOf(VIEWER)) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });

  it.each(['/admin/access', '/debug/rpc'])('%s: 200 for the owner', async (url) => {
    const { app: a } = await app();
    const res = await a.inject({ method: 'GET', url, headers: bearer(sessionOf(OWNER)) });
    expect(res.statusCode).toBe(200);
  });

  it('a mutating owner route is gated the same way', async () => {
    const { app: a } = await app();
    const res = await a.inject({
      method: 'POST',
      url: '/admin/access',
      headers: bearer(sessionOf(VIEWER)),
      payload: { address: VIEWER.address },
    });
    expect(res.statusCode).toBe(403);
  });
});
