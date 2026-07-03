import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { PostgresAccountRepository } from './account-repository';
import type { Database } from './database';
import * as schema from './schema';
import { positions as positionsTable } from './schema';

async function setup() {
  const pg = drizzle(new PGlite(), { schema });
  await migrate(pg, { migrationsFolder: './drizzle' });
  const db = pg as unknown as Database;
  return { db, accounts: new PostgresAccountRepository(db) };
}

const did = (name: string) => `did:privy:${name}`;

describe('PostgresAccountRepository — accounts (Privy identity)', () => {
  it('createUser / findByPrivyId / findById round-trip (address starts null until custody fills it)', async () => {
    const { accounts } = await setup();
    const u = await accounts.createUser({ privyUserId: did('alice'), isOwner: false });
    expect(u.address).toBeNull();
    const byDid = await accounts.findByPrivyId(did('alice'));
    expect(byDid?.id).toBe(u.id);
    expect(byDid?.privyUserId).toBe(did('alice'));
    expect(byDid?.isOwner).toBe(false);
    expect((await accounts.findById(u.id))?.privyUserId).toBe(did('alice'));
    expect(await accounts.findByPrivyId(did('nobody'))).toBeNull();
  });

  it('one DID = one account: a duplicate privyUserId is rejected by the DB (identity uniqueness)', async () => {
    const { accounts } = await setup();
    await accounts.createUser({ privyUserId: did('alice'), isOwner: false });
    await expect(
      accounts.createUser({ privyUserId: did('alice'), isOwner: false }),
    ).rejects.toThrow();
  });
});

describe('PostgresAccountRepository — tenancy', () => {
  it('isolates watchlists between users and unions the monitored set', async () => {
    const { accounts } = await setup();
    const a = await accounts.createUser({ privyUserId: did('a'), isOwner: false });
    const b = await accounts.createUser({ privyUserId: did('b'), isOwner: false });
    await accounts.addWatch(a.id, { address: 'W1' });
    await accounts.addWatch(a.id, { address: 'W2' });
    await accounts.addWatch(b.id, { address: 'W2' });
    expect((await accounts.watchedAddresses(a.id)).sort()).toEqual(['W1', 'W2']);
    expect(await accounts.watchedAddresses(b.id)).toEqual(['W2']);
    expect(await accounts.countWatched(a.id)).toBe(2);
    expect(await accounts.isWatching(a.id, 'W1')).toBe(true);
    expect(await accounts.isWatching(b.id, 'W1')).toBe(false); // B cannot see A's wallet
    expect((await accounts.monitoredWallets()).sort()).toEqual(['W1', 'W2']);
  });

  it('removeWatch reports remaining watchers and KEEPS positions (shared cache) even when the last leaves', async () => {
    const { db, accounts } = await setup();
    const a = await accounts.createUser({ privyUserId: did('a'), isOwner: false });
    const b = await accounts.createUser({ privyUserId: did('b'), isOwner: false });
    await accounts.addWatch(a.id, { address: 'SHARED' });
    await accounts.addWatch(b.id, { address: 'SHARED' });
    await db.insert(positionsTable).values({
      positionAddress: 'P1',
      wallet: 'SHARED',
      poolAddress: 'pool',
      status: 'closed',
      updatedAt: Date.now(),
    });
    expect(await accounts.removeWatch(a.id, 'SHARED')).toBe(1); // B still watches it
    expect((await db.select().from(positionsTable)).length).toBe(1);
    expect(await accounts.removeWatch(b.id, 'SHARED')).toBe(0); // last watcher gone
    expect((await db.select().from(positionsTable)).length).toBe(1); // data KEPT, not evicted
  });
});

describe('PostgresAccountRepository — invite codes', () => {
  it('creates and lists invites with note + optional expiry', async () => {
    const { accounts } = await setup();
    const expiresAt = Date.now() + 60_000;
    await accounts.createInvite({ code: 'c1', note: 'beta friend', expiresAt });
    await accounts.createInvite({ code: 'c2' });
    const byCode = new Map((await accounts.listInvites()).map((i) => [i.code, i]));
    expect(byCode.get('c1')?.note).toBe('beta friend');
    expect(byCode.get('c1')?.expiresAt).toBe(expiresAt);
    expect(byCode.get('c1')?.usedByUserId).toBeNull();
    expect(byCode.get('c2')?.expiresAt).toBeNull();
  });

  it('deleteInvite removes an unused code only; unknown codes report false', async () => {
    const { accounts } = await setup();
    await accounts.createInvite({ code: 'fresh' });
    expect(await accounts.deleteInvite('fresh')).toBe(true);
    expect(await accounts.listInvites()).toEqual([]);
    expect(await accounts.deleteInvite('never-existed')).toBe(false);
  });

  it('redeem creates the account AND stamps the code with it in one step (code → account trace)', async () => {
    const { accounts } = await setup();
    await accounts.createInvite({ code: 'golden' });
    const now = Date.now();
    const result = await accounts.redeemInviteAndCreateUser({
      code: 'golden',
      privyUserId: did('alice'),
      isOwner: true,
      now,
    });
    expect(result.ok).toBe(true);
    const user = result.ok ? result.user : null;
    expect(user?.isOwner).toBe(true);
    expect((await accounts.findByPrivyId(did('alice')))?.id).toBe(user?.id);
    const [invite] = await accounts.listInvites();
    expect(invite?.usedByUserId).toBe(user?.id); // the audit trail the gate exists for
    expect(invite?.usedAt).toBe(now);
  });

  it('redeem fails typed: unknown ⇒ not_found, burned ⇒ used, past-expiry ⇒ expired (code NOT burned)', async () => {
    const { accounts } = await setup();
    expect(
      await accounts.redeemInviteAndCreateUser({
        code: 'ghost',
        privyUserId: did('x'),
        isOwner: false,
        now: Date.now(),
      }),
    ).toEqual({ ok: false, reason: 'not_found' });

    await accounts.createInvite({ code: 'one-shot' });
    await accounts.redeemInviteAndCreateUser({
      code: 'one-shot',
      privyUserId: did('winner'),
      isOwner: false,
      now: Date.now(),
    });
    expect(
      await accounts.redeemInviteAndCreateUser({
        code: 'one-shot',
        privyUserId: did('late'),
        isOwner: false,
        now: Date.now(),
      }),
    ).toEqual({ ok: false, reason: 'used' });
    expect(await accounts.findByPrivyId(did('late'))).toBeNull(); // loser got NO account

    await accounts.createInvite({ code: 'stale', expiresAt: Date.now() - 1000 });
    expect(
      await accounts.redeemInviteAndCreateUser({
        code: 'stale',
        privyUserId: did('too-late'),
        isOwner: false,
        now: Date.now(),
      }),
    ).toEqual({ ok: false, reason: 'expired' });
    // An expired-redeem attempt must not stamp the code (it was never successfully used).
    const stale = (await accounts.listInvites()).find((i) => i.code === 'stale');
    expect(stale?.usedByUserId).toBeNull();
  });

  it('two concurrent redeems of ONE code: exactly one wins (the atomic UPDATE-claim invariant)', async () => {
    const { accounts } = await setup();
    await accounts.createInvite({ code: 'contested' });
    const now = Date.now();
    const [r1, r2] = await Promise.all([
      accounts.redeemInviteAndCreateUser({
        code: 'contested',
        privyUserId: did('racer-1'),
        isOwner: false,
        now,
      }),
      accounts.redeemInviteAndCreateUser({
        code: 'contested',
        privyUserId: did('racer-2'),
        isOwner: false,
        now,
      }),
    ]);
    const outcomes = [r1, r2];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(outcomes.filter((r) => !r.ok && r.reason === 'used')).toHaveLength(1);
    const users = await accounts.listAccounts();
    expect(users).toHaveLength(1); // never two accounts from one code
  });

  it('a failed account insert rolls the claim back — the code is never burned without an account', async () => {
    const { accounts } = await setup();
    await accounts.createUser({ privyUserId: did('taken'), isOwner: false });
    await accounts.createInvite({ code: 'rollback' });
    // Same DID again ⇒ the user INSERT violates the unique privy_user_id → whole transaction fails.
    await expect(
      accounts.redeemInviteAndCreateUser({
        code: 'rollback',
        privyUserId: did('taken'),
        isOwner: false,
        now: Date.now(),
      }),
    ).rejects.toThrow();
    const invite = (await accounts.listInvites()).find((i) => i.code === 'rollback');
    expect(invite?.usedByUserId).toBeNull(); // claim rolled back with the failed insert
  });

  it('a redeemed code cannot be deleted (the code → account audit trail is permanent)', async () => {
    const { accounts } = await setup();
    await accounts.createInvite({ code: 'kept' });
    await accounts.redeemInviteAndCreateUser({
      code: 'kept',
      privyUserId: did('member'),
      isOwner: false,
      now: Date.now(),
    });
    expect(await accounts.deleteInvite('kept')).toBe(false);
    expect((await accounts.listInvites()).map((i) => i.code)).toEqual(['kept']);
  });
});

describe('PostgresAccountRepository — admin', () => {
  it('listAccounts returns each account with its DID and watched wallets', async () => {
    const { accounts } = await setup();
    const a = await accounts.createUser({ privyUserId: did('owner'), isOwner: true });
    await accounts.addWatch(a.id, { address: 'W1' });
    await accounts.addWatch(a.id, { address: 'W2' });
    const list = await accounts.listAccounts();
    expect(list).toHaveLength(1);
    expect(list[0]?.privyUserId).toBe(did('owner'));
    expect(list[0]?.isOwner).toBe(true);
    expect(list[0]?.address).toBeNull();
    expect([...(list[0]?.wallets ?? [])].sort()).toEqual(['W1', 'W2']);
  });

  it('deleteAccount returns orphans but KEEPS all position data (shared, not account-owned)', async () => {
    const { db, accounts } = await setup();
    const a = await accounts.createUser({ privyUserId: did('a'), isOwner: false });
    const b = await accounts.createUser({ privyUserId: did('b'), isOwner: false });
    await accounts.addWatch(a.id, { address: 'SOLO' });
    await accounts.addWatch(a.id, { address: 'SHARED' });
    await accounts.addWatch(b.id, { address: 'SHARED' });
    await db.insert(positionsTable).values([
      { positionAddress: 'P1', wallet: 'SOLO', poolAddress: 'p', status: 'closed', updatedAt: 1 },
      { positionAddress: 'P2', wallet: 'SHARED', poolAddress: 'p', status: 'closed', updatedAt: 1 },
    ]);
    const orphans = await accounts.deleteAccount(a.id);
    expect(orphans).toEqual(['SOLO']); // SHARED still watched by B → not orphan
    const remaining = (await db.select().from(positionsTable)).map((p) => p.wallet).sort();
    expect(remaining).toEqual(['SHARED', 'SOLO']); // ALL data kept (shared, not account-owned)
    expect(await accounts.findById(a.id)).toBeNull();
    expect(await accounts.findById(b.id)).not.toBeNull();
  });

  it('walletOverview reports watchers + open/closed counts + last sync per wallet', async () => {
    const { db, accounts } = await setup();
    const a = await accounts.createUser({ privyUserId: did('a'), isOwner: false });
    const b = await accounts.createUser({ privyUserId: did('b'), isOwner: false });
    await accounts.addWatch(a.id, { address: 'W1' });
    await accounts.addWatch(b.id, { address: 'W1' }); // 2 watchers on W1
    await accounts.addWatch(a.id, { address: 'W2' });
    await db.insert(positionsTable).values([
      { positionAddress: 'p1', wallet: 'W1', poolAddress: 'p', status: 'open', updatedAt: 100 },
      { positionAddress: 'p2', wallet: 'W1', poolAddress: 'p', status: 'closed', updatedAt: 200 },
    ]);
    const ov = await accounts.walletOverview();
    const w1 = ov.find((w) => w.address === 'W1');
    expect(w1?.watchers).toBe(2);
    expect(w1?.openPositions).toBe(1);
    expect(w1?.closedPositions).toBe(1);
    expect(w1?.lastUpdate).toBe(200);
    const w2 = ov.find((w) => w.address === 'W2');
    expect(w2?.watchers).toBe(1);
    expect(w2?.openPositions).toBe(0);
    expect(w2?.lastUpdate).toBeNull();
  });
});
