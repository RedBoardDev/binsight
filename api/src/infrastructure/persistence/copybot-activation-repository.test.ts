import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { CopybotActivationRepository } from './copybot-activation-repository';
import type { Database } from './database';
import * as schema from './schema';
import { copybotActivation, users } from './schema';

// Real Drizzle migrations on in-memory Postgres — the repository runs the exact SQL it runs in production, so the
// coffre's resolveSignableWallet path (users ⋈ copybot_activation) is proven against the real schema.
const db = await (async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: './drizzle' });
  return d as unknown as Database;
})();

const repo = new CopybotActivationRepository(db);
const USER = 'user-activation-repo-1';
const WALLET_ID = 'privy-wallet-abc';
const ADDRESS = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';

beforeEach(async () => {
  await db.delete(copybotActivation);
  await db.delete(users);
  await db.insert(users).values({
    id: USER,
    privyUserId: `did:privy:${USER}`,
    address: null,
    isOwner: false,
    createdAt: Date.now(),
  });
});

describe('CopybotActivationRepository', () => {
  it('provision creates the row (signing disabled, step consent) and fills users.address + wallet id', async () => {
    const state = await repo.provision({
      userId: USER,
      privyWalletId: WALLET_ID,
      address: ADDRESS,
      policyId: 'pol-1',
    });
    expect(state.signingDisabled).toBe(true); // starts ON — the SYSTEM reconciler clears it later
    expect(state.activationStep).toBe('consent');
    expect(state.privyWalletId).toBe(WALLET_ID);
    expect(state.policyId).toBe('pol-1');
    const [u] = await db.select().from(users).where(eq(users.id, USER));
    expect(u?.address).toBe(ADDRESS);
    expect(u?.privyWalletId).toBe(WALLET_ID);
  });

  it('provision is idempotent — a second call returns the existing row, never a duplicate', async () => {
    const first = await repo.provision({
      userId: USER,
      privyWalletId: WALLET_ID,
      address: ADDRESS,
      policyId: 'pol-1',
    });
    const second = await repo.provision({
      userId: USER,
      privyWalletId: 'other',
      address: 'other',
      policyId: 'pol-2',
    });
    expect(second.privyWalletId).toBe(first.privyWalletId); // unchanged (the retry did not overwrite)
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('resolveSignableWallet returns the (walletId, address, signingDisabled) triple the coffre needs', async () => {
    await repo.provision({
      userId: USER,
      privyWalletId: WALLET_ID,
      address: ADDRESS,
      policyId: null,
    });
    const w = await repo.resolveSignableWallet(USER);
    expect(w).toEqual({ walletId: WALLET_ID, address: ADDRESS, signingDisabled: true });
  });

  it('resolveSignableWallet is null for an un-provisioned user (fail-closed — nothing signs)', async () => {
    expect(await repo.resolveSignableWallet(USER)).toBeNull();
    expect(await repo.resolveSignableWallet('nobody')).toBeNull();
  });

  it('markConsentComplete sets signer_added and advances to deposit', async () => {
    await repo.provision({
      userId: USER,
      privyWalletId: WALLET_ID,
      address: ADDRESS,
      policyId: null,
    });
    await repo.markConsentComplete(USER, Date.now());
    const s = await repo.find(USER);
    expect(s?.signerAdded).toBe(true);
    expect(s?.activationStep).toBe('deposit');
  });

  it('markExportAck stamps export_ack_at and advances to done', async () => {
    await repo.provision({
      userId: USER,
      privyWalletId: WALLET_ID,
      address: ADDRESS,
      policyId: null,
    });
    const now = Date.now();
    await repo.markExportAck(USER, now);
    const s = await repo.find(USER);
    expect(s?.exportAckAt).toBe(now);
    expect(s?.activationStep).toBe('done');
  });

  it('applySigningGate clears signing_disabled and stamps funded_at ONCE', async () => {
    await repo.provision({
      userId: USER,
      privyWalletId: WALLET_ID,
      address: ADDRESS,
      policyId: null,
    });
    const t1 = Date.now();
    await repo.applySigningGate(USER, { clearSigningDisabled: true, funded: true }, t1);
    let s = await repo.find(USER);
    expect(s?.signingDisabled).toBe(false);
    expect(s?.fundedAt).toBe(t1);
    // A later gate pass must NOT re-stamp funded_at (it records the FIRST funding).
    await repo.applySigningGate(USER, { clearSigningDisabled: true, funded: true }, t1 + 5000);
    s = await repo.find(USER);
    expect(s?.fundedAt).toBe(t1);
  });

  it('markWithdrawalAck stamps withdrawal_ack_at (the teardown gate reads it — SPEC §2.4)', async () => {
    await repo.provision({
      userId: USER,
      privyWalletId: WALLET_ID,
      address: ADDRESS,
      policyId: null,
    });
    expect((await repo.find(USER))?.withdrawalAckAt).toBeNull();
    const now = Date.now();
    await repo.markWithdrawalAck(USER, now);
    expect((await repo.find(USER))?.withdrawalAckAt).toBe(now);
  });

  it('markSigningRevoked disables signing AND clears signer_added (STICKY — blocks the reconciler + re-activation)', async () => {
    // Provision + advance to a signable baseline (signer added, signing cleared).
    await repo.provision({
      userId: USER,
      privyWalletId: WALLET_ID,
      address: ADDRESS,
      policyId: null,
    });
    await repo.markConsentComplete(USER, Date.now());
    await repo.applySigningGate(USER, { clearSigningDisabled: true, funded: true }, Date.now());
    const before = await repo.find(USER);
    expect(before?.signerAdded).toBe(true);
    expect(before?.signingDisabled).toBe(false);
    // Revoke (#21): the coffre session signer is gone → signing disabled AND consent invalidated.
    await repo.markSigningRevoked(USER, Date.now());
    const after = await repo.find(USER);
    expect(after?.signingDisabled).toBe(true);
    // signer_added=false makes it STICKY: signingReady() can no longer auto-clear it (re-activation needs re-consent).
    expect(after?.signerAdded).toBe(false);
  });
});
