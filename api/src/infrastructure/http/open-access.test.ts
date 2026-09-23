import { describe, expect, it, vi } from 'vitest';
import { WatchlistService } from '@/application/accounts/watchlist-service';
import { loadConfig } from '@/config/env';
import type { AccountRepository, AccountUser } from '@/domain/ports';
import { buildServer, type ServerDeps } from './server';

// Two real, distinct base58 pubkeys (decode to 32 bytes) so isValidSolanaAddress accepts them.
const WALLET_A = 'So11111111111111111111111111111111111111112';
const WALLET_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PASSWORD = 'password123';

/**
 * In-memory AccountRepository covering only the methods the auth/register/login/watch paths touch.
 * Anything else is intentionally absent — a hit would throw and surface an unexpected dependency.
 */
function makeAccounts(whitelist: ReadonlySet<string> = new Set()): AccountRepository {
  const byAddress = new Map<string, { user: AccountUser; passwordHash: string }>();
  const byId = new Map<string, { user: AccountUser; passwordHash: string }>();
  const watches = new Map<string, Set<string>>();
  const sessions = new Map<string, { userId: string; expiresAt: number }>();
  let seq = 0;

  const repo: Partial<AccountRepository> = {
    async createUser({ address, passwordHash, isOwner }) {
      const user: AccountUser = { id: `u${++seq}`, address, isOwner, tokenVersion: 0 };
      const stored = { user, passwordHash };
      byAddress.set(address, stored);
      byId.set(user.id, stored);
      watches.set(user.id, new Set());
      return user;
    },
    async findByAddress(address) {
      const s = byAddress.get(address);
      return s ? { user: s.user, passwordHash: s.passwordHash } : null;
    },
    async findById(id) {
      return byId.get(id)?.user ?? null;
    },
    async findByIdWithSession(id, jti) {
      const sess = sessions.get(jti);
      if (!sess || sess.userId !== id || sess.expiresAt < Date.now()) return null;
      return byId.get(id)?.user ?? null;
    },
    async createSession(jti, userId, expiresAt) {
      sessions.set(jti, { userId, expiresAt });
    },
    async deleteSession(jti) {
      sessions.delete(jti);
    },
    async addWatch(userId, w) {
      let set = watches.get(userId);
      if (!set) {
        set = new Set();
        watches.set(userId, set);
      }
      set.add(w.address);
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
    // Open mode never consults the whitelist; secure mode 403s a non-whitelisted address.
    async isWhitelisted(address) {
      return whitelist.has(address);
    },
    async monitoredWallets() {
      const all = new Set<string>();
      for (const set of watches.values()) for (const a of set) all.add(a);
      return [...all];
    },
  };
  return repo as AccountRepository;
}

function build(openAccess: boolean, opts: { ownerAddress?: string; whitelist?: string[] } = {}) {
  const config = loadConfig({
    AUTH_SECRET: 'a'.repeat(32),
    SOLANA_WS_URL: 'wss://rpc.example.com',
    WEB_ORIGINS: 'http://localhost:3000',
    OPEN_ACCESS_MODE: openAccess ? 'true' : 'false',
    OWNER_ADDRESS: opts.ownerAddress ?? '',
    LOG_LEVEL: 'error',
  });
  const accounts = makeAccounts(new Set(opts.whitelist));
  // The real WatchlistService: the single-wallet cap of open mode lives there, so faking it would
  // test the fake. Only the engine side (start/stop monitoring) is stubbed.
  const watchlist = new WatchlistService(
    accounts,
    { addWallet: vi.fn(async () => {}), removeWallet: vi.fn() },
    openAccess,
  );
  const deps = {
    config,
    bus: { on: () => {}, emit: () => {} },
    engine: { ingestStatus: () => ({ ready: true, indexedTxs: 0 }) },
    accounts,
    watchlist,
    presence: { activeDevices: () => [] },
    pushRepo: { save: vi.fn(async () => {}) },
    sendTestPush: async () => 0,
    // The rest are unused by the routes these tests exercise.
    store: {},
    queries: {},
    configRepo: {},
    walletPnl: {},
    networthSnapshots: {},
    walletRealized: {},
    notifications: {},
    meter: {},
    creditLedger: {},
  } as unknown as ServerDeps;
  return buildServer(deps);
}

async function register(app: Awaited<ReturnType<typeof build>>, address: string) {
  return app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { address, password: PASSWORD },
  });
}

describe('OPEN_ACCESS_MODE', () => {
  it('exposes the flag publicly at /config/app (no auth needed)', async () => {
    const open = await build(true);
    const secure = await build(false);
    const o = await open.inject({ method: 'GET', url: '/config/app' });
    const s = await secure.inject({ method: 'GET', url: '/config/app' });
    expect(o.statusCode).toBe(200);
    expect(o.json()).toEqual({ openAccess: true });
    expect(s.json()).toEqual({ openAccess: false });
  });

  it('open mode: registers with address + password only — no signature, no whitelist', async () => {
    const app = await build(true);
    const res = await register(app, WALLET_A);
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTypeOf('string');
    // The issued session is real: an authed route resolves the new account.
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${res.json().token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().address).toBe(WALLET_A);
  });

  it('open mode: caps the account at a single wallet (the registration address)', async () => {
    const app = await build(true);
    const token = (await register(app, WALLET_A)).json().token;
    const add = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { authorization: `Bearer ${token}` },
      payload: { address: WALLET_B },
    });
    expect(add.statusCode).toBe(409);
  });

  it('open mode: refuses push subscriptions (notifications disabled)', async () => {
    const app = await build(true);
    const token = (await register(app, WALLET_A)).json().token;
    const sub = await app.inject({
      method: 'POST',
      url: '/push/subscribe',
      headers: { authorization: `Bearer ${token}` },
      payload: { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } },
    });
    expect(sub.statusCode).toBe(403);
  });

  it('secure mode: registration still requires a wallet signature (address + password alone is rejected)', async () => {
    // Whitelisted, so the only thing missing is the proof of ownership — that alone must be fatal.
    const app = await build(false, { whitelist: [WALLET_A] });
    const res = await register(app, WALLET_A);
    expect(res.statusCode).toBe(400); // signature + nonce are mandatory
    // And no account was created as a side effect.
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { address: WALLET_A, password: PASSWORD },
    });
    expect(login.statusCode).toBe(401);
  });

  it('secure mode: a non-whitelisted address is refused before any signature is looked at', async () => {
    const app = await build(false);
    const res = await register(app, WALLET_A);
    expect(res.statusCode).toBe(403);
    expect(res.json().notWhitelisted).toBe(true);
  });

  it('open mode: the OWNER_ADDRESS cannot register without a signature (400 signatureRequired)', async () => {
    // Owner rights are granted by address. Were the open-mode shortcut (address + password) to apply
    // to it, anyone knowing the public owner address could claim the admin account before the owner.
    const app = await build(true, { ownerAddress: WALLET_B });
    const res = await register(app, WALLET_B);
    expect(res.statusCode).toBe(400);
    expect(res.json().signatureRequired).toBe(true);
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { address: WALLET_B, password: PASSWORD },
    });
    expect(login.statusCode).toBe(401); // nothing was created
    // Every other address keeps the open-mode shortcut.
    expect((await register(app, WALLET_A)).statusCode).toBe(200);
  });
});
