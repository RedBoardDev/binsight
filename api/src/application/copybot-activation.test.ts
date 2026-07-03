import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_ACTIVATION_LAMPORTS } from '@/domain/copybot/activation';
import { CopybotActivationRepository } from '@/infrastructure/persistence/copybot-activation-repository';
import type { Database } from '@/infrastructure/persistence/database';
import * as schema from '@/infrastructure/persistence/schema';
import { copybotActivation, users } from '@/infrastructure/persistence/schema';
import {
  CopybotActivationService,
  type EmbeddedWalletResolver,
  type UserPolicyAdmin,
} from './copybot-activation';

const db = await (async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: './drizzle' });
  return d as unknown as Database;
})();

const repo = new CopybotActivationRepository(db);
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

const USER = 'user-activation-svc-1';
const DID = `did:privy:${USER}`;
const ADDRESS = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
const WALLET_ID = 'privy-wallet-svc';

// Mutable knobs so a single test can move the account across the signing gate.
let balance = 0;
let startedLeaders = 0;

const resolver: EmbeddedWalletResolver = {
  resolveEmbeddedWallet: vi.fn(async (input) => ({
    walletId: WALLET_ID,
    address: input.address ?? ADDRESS,
  })),
};
const policyAdmin: UserPolicyAdmin = {
  createUserPolicy: vi.fn(async () => ({ policyId: 'pol-svc' })),
};

const build = (opts?: { policyAdmin?: UserPolicyAdmin | undefined }) =>
  new CopybotActivationService({
    repo,
    walletResolver: resolver,
    policyAdmin: opts && 'policyAdmin' in opts ? opts.policyAdmin : policyAdmin,
    balances: async () => balance,
    startedLeaderCount: async () => startedLeaders,
    log,
  });

beforeEach(async () => {
  await db.delete(copybotActivation);
  await db.delete(users);
  await db.insert(users).values({
    id: USER,
    privyUserId: DID,
    address: null,
    isOwner: false,
    createdAt: Date.now(),
  });
  balance = 0;
  startedLeaders = 0;
  vi.clearAllMocks();
});

describe('CopybotActivationService.provision', () => {
  it('provisions once: resolves the wallet, creates the policy, writes the row + users columns', async () => {
    const svc = build();
    const view = await svc.provision(USER, DID, { address: ADDRESS });
    expect(resolver.resolveEmbeddedWallet).toHaveBeenCalledWith({ did: DID, address: ADDRESS });
    expect(policyAdmin.createUserPolicy).toHaveBeenCalledTimes(1);
    expect(view.activation?.privyWalletId).toBe(WALLET_ID);
    expect(view.activation?.policyId).toBe('pol-svc');
    expect(view.address).toBe(ADDRESS);
    expect(view.signingReady).toBe(false); // no signer yet, unfunded, no leader
  });

  it('is idempotent — a second provision does NOT re-resolve the wallet or re-create the policy', async () => {
    const svc = build();
    await svc.provision(USER, DID, { address: ADDRESS });
    vi.clearAllMocks();
    const again = await svc.provision(USER, DID, { address: ADDRESS });
    expect(resolver.resolveEmbeddedWallet).not.toHaveBeenCalled();
    expect(policyAdmin.createUserPolicy).not.toHaveBeenCalled();
    expect(again.activation?.privyWalletId).toBe(WALLET_ID);
  });

  it('with no policy admin configured, provisions policy-less (Wall B stays authoritative) and warns', async () => {
    const svc = build({ policyAdmin: undefined });
    const view = await svc.provision(USER, DID, { address: ADDRESS });
    expect(view.activation?.policyId).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('CopybotActivationService.state', () => {
  it('returns the full view shape for a provisioned account', async () => {
    const svc = build();
    await svc.provision(USER, DID, { address: ADDRESS });
    balance = MIN_ACTIVATION_LAMPORTS;
    const view = await svc.state(USER);
    expect(view).toMatchObject({
      address: ADDRESS,
      balanceLamports: MIN_ACTIVATION_LAMPORTS,
      balanceSol: 1,
      minActivationSol: 1,
    });
    expect(view.activation).not.toBeNull();
  });

  it('returns an empty view for an un-provisioned user (no row)', async () => {
    const svc = build();
    const view = await svc.state(USER);
    expect(view.activation).toBeNull();
    expect(view.address).toBeNull();
    expect(view.signingReady).toBe(false);
  });
});

describe('CopybotActivationService signing gate (SYSTEM reconciler)', () => {
  it('clears signing_disabled once consent + funding + a started leader all hold', async () => {
    const svc = build();
    await svc.provision(USER, DID, { address: ADDRESS });

    // Consent → signer added, wizard at deposit.
    const afterConsent = await svc.consentComplete(USER);
    expect(afterConsent.activation?.signerAdded).toBe(true);
    expect(afterConsent.activation?.activationStep).toBe('deposit');
    expect(afterConsent.activation?.signingDisabled).toBe(true); // still gated: unfunded + no leader

    // Fund but no leader ⇒ still gated, but funded_at is stamped.
    balance = MIN_ACTIVATION_LAMPORTS;
    const funded = await svc.state(USER);
    expect(funded.activation?.signingDisabled).toBe(true);
    expect(funded.activation?.fundedAt).not.toBeNull();

    // Start a leader ⇒ all three hold ⇒ signing_disabled clears.
    startedLeaders = 1;
    const ready = await svc.state(USER);
    expect(ready.signingReady).toBe(true);
    expect(ready.activation?.signingDisabled).toBe(false);
  });

  it('re-gates (signing_disabled back ON) if the account drops below the funded floor', async () => {
    const svc = build();
    await svc.provision(USER, DID, { address: ADDRESS });
    await svc.consentComplete(USER);
    balance = MIN_ACTIVATION_LAMPORTS;
    startedLeaders = 1;
    expect((await svc.state(USER)).activation?.signingDisabled).toBe(false);
    // Balance falls below 1 SOL ⇒ the reconciler disables signing again (a starved wallet only makes failed opens).
    balance = MIN_ACTIVATION_LAMPORTS - 1;
    expect((await svc.state(USER)).activation?.signingDisabled).toBe(true);
  });

  it('exportAck stamps the ack and advances the wizard to done', async () => {
    const svc = build();
    await svc.provision(USER, DID, { address: ADDRESS });
    const view = await svc.exportAck(USER);
    expect(view.activation?.exportAckAt).not.toBeNull();
    expect(view.activation?.activationStep).toBe('done');
  });
});
