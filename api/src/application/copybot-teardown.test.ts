import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_USER_ID } from '@/copybot/journal-store';
import { DUST_LAMPORTS } from '@/domain/copybot/teardown';
import type { CopybotActivationRepository } from '@/infrastructure/persistence/copybot-activation-repository';
import { type CopybotTeardownDeps, CopybotTeardownService } from './copybot-teardown';

const log = pino({ level: 'silent' });

type Row = { withdrawalAckAt: number | null; exportAckAt: number | null; privyWalletId: string };

/** A minimal fake of the activation repo — the teardown service only reads the ack stamps + the Privy wallet id. */
function activationRepo(row: Row | null, address: string | null): CopybotActivationRepository {
  return {
    find: async () => (row ? { ...row } : null),
    resolveSignableWallet: async () =>
      row && address ? { walletId: row.privyWalletId, address, signingDisabled: true } : null,
  } as unknown as CopybotActivationRepository;
}

interface Scenario {
  row?: Row | null;
  address?: string | null;
  balance?: number;
  /** LIVE balance AFTER the force-close (positions → idle SOL). Defaults to `balance` (no drain modelled). */
  balanceAfterStop?: number;
  openBefore?: number;
  openAfterStop?: number;
  privyThrows?: boolean;
}

/** Build the service with spies + an ordered call log; `stopBot` mutates the open-mirror count (force-close). */
function makeService(s: Scenario = {}) {
  const calls: string[] = [];
  const row: Row | null =
    s.row === undefined
      ? { withdrawalAckAt: null, exportAckAt: null, privyWalletId: 'pw_1' }
      : s.row;
  let openCount = s.openBefore ?? 0;
  let balanceLamports = s.balance ?? 0;
  const deps: CopybotTeardownDeps = {
    activation: activationRepo(row, s.address === undefined ? 'WALLET' : s.address),
    openMirrorCount: vi.fn(async () => {
      calls.push('count');
      return openCount;
    }),
    balances: vi.fn(async () => balanceLamports),
    stopBot: vi.fn(async () => {
      calls.push('stop');
      openCount = s.openAfterStop ?? 0; // the stop=force-close path drains the open mirrors
      // The force-close converts positions → idle SOL, so the LIVE balance RISES after the stop (finding #141).
      if (s.balanceAfterStop !== undefined) balanceLamports = s.balanceAfterStop;
    }),
    deletePrivyUser: vi.fn(async () => {
      calls.push('privy');
      if (s.privyThrows) throw new Error('privy unavailable');
    }),
    deleteLocalCascade: vi.fn(async () => {
      calls.push('cascade');
    }),
    log,
  };
  return { service: new CopybotTeardownService(deps), deps, calls };
}

describe('CopybotTeardownService — the ordered, fund-safe delete (SPEC §2.4 / #56)', () => {
  it('the SYSTEM user can NEVER be torn down — nothing runs', async () => {
    const { service, deps, calls } = makeService();
    expect(await service.teardown(SYSTEM_USER_ID, 'did:x')).toEqual({
      ok: false,
      reason: 'system_user',
    });
    expect(deps.stopBot).not.toHaveBeenCalled();
    expect(deps.deletePrivyUser).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('REFUSES open_mirrors (no ack) BEFORE stopping — never force-closes on a rejected gate', async () => {
    const { service, deps } = makeService({ openBefore: 1 });
    expect(await service.teardown('u1', 'did:1')).toEqual({ ok: false, reason: 'open_mirrors' });
    expect(deps.stopBot).not.toHaveBeenCalled();
    expect(deps.deletePrivyUser).not.toHaveBeenCalled();
  });

  it('REFUSES funds_remain when the balance is above dust and no ack is recorded', async () => {
    const { service, deps } = makeService({ balance: DUST_LAMPORTS + 1 });
    expect(await service.teardown('u1', 'did:1')).toEqual({ ok: false, reason: 'funds_remain' });
    expect(deps.stopBot).not.toHaveBeenCalled();
  });

  it('on PASS, runs in order: stop → confirm-closed → Privy delete (once) → local cascade', async () => {
    // A key-export ack lifts the entry gate AND the post-drain guard even with open mirrors + funds: the stop
    // force-closes the mirrors (positions → idle SOL) and, because the user holds the key, the delete then runs.
    const { service, deps, calls } = makeService({
      row: { withdrawalAckAt: null, exportAckAt: 123, privyWalletId: 'pw_1' },
      openBefore: 2,
      openAfterStop: 0,
      balance: 10 * DUST_LAMPORTS,
    });
    expect(await service.teardown('u1', 'did:1')).toEqual({ ok: true });
    // gate-count → stop → confirm-count → privy → cascade (the never-miss ordering).
    expect(calls).toEqual(['count', 'stop', 'count', 'privy', 'cascade']);
    expect(deps.deletePrivyUser).toHaveBeenCalledTimes(1);
    expect(deps.deletePrivyUser).toHaveBeenCalledWith('did:1');
    expect(deps.deleteLocalCascade).toHaveBeenCalledTimes(1);
  });

  it('a clean empty account (no ack, dust-empty, nothing open) passes and deletes', async () => {
    const { service } = makeService({ openBefore: 0, balance: 0, openAfterStop: 0 });
    expect(await service.teardown('u1', 'did:1')).toEqual({ ok: true });
  });

  it('force-close still IN FLIGHT (mirrors remain after stop) → in_progress, NO delete, NO cascade', async () => {
    const { service, deps } = makeService({
      row: { withdrawalAckAt: 1, exportAckAt: null, privyWalletId: 'pw_1' },
      openBefore: 3,
      openAfterStop: 1, // a close did not confirm yet → must NOT proceed to the irreversible delete
    });
    expect(await service.teardown('u1', 'did:1')).toEqual({ ok: false, reason: 'in_progress' });
    expect(deps.deletePrivyUser).not.toHaveBeenCalled();
    expect(deps.deleteLocalCascade).not.toHaveBeenCalled();
  });

  it('Privy delete FAILS → privy_delete_failed and the local cascade NEVER runs (no half-delete)', async () => {
    const { service, deps } = makeService({
      row: { withdrawalAckAt: 1, exportAckAt: null, privyWalletId: 'pw_1' },
      openBefore: 0,
      openAfterStop: 0,
      privyThrows: true,
    });
    expect(await service.teardown('u1', 'did:1')).toEqual({
      ok: false,
      reason: 'privy_delete_failed',
    });
    expect(deps.deleteLocalCascade).not.toHaveBeenCalled(); // account stays intact → idempotently retryable
  });

  it('an account never provisioned at Privy (no wallet id) SKIPS the Privy delete but still cascades locally', async () => {
    const { service, deps, calls } = makeService({
      row: { withdrawalAckAt: null, exportAckAt: null, privyWalletId: '' },
      openBefore: 0,
      balance: 0,
      openAfterStop: 0,
    });
    expect(await service.teardown('u1', 'did:1')).toEqual({ ok: true });
    expect(deps.deletePrivyUser).not.toHaveBeenCalled();
    expect(deps.deleteLocalCascade).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['count', 'stop', 'count', 'cascade']); // no 'privy' step
  });

  it('an export ack (no withdrawal) also lifts the gate over funds', async () => {
    const { service } = makeService({
      row: { withdrawalAckAt: null, exportAckAt: 999, privyWalletId: 'pw_1' },
      openBefore: 0,
      balance: 5 * DUST_LAMPORTS,
      openAfterStop: 0,
    });
    expect(await service.teardown('u1', 'did:1')).toEqual({ ok: true });
  });

  it('a STALE withdrawal ack over force-closed capital is BLOCKED post-drain — funds are never stranded (#141)', async () => {
    // The stranding scenario: the user withdrew fully long ago (sticky withdrawalAck), then RE-DEPOSITED and re-opened
    // mirrors — the capital is locked in POSITIONS, so the pre-stop idle balance reads empty and the entry gate waves
    // the delete through on the stale ack. The force-close then converts the positions into ~5 SOL of idle SOL; with
    // no key-export ack, a soft-detach here would permanently strand it. The post-drain re-read must refuse.
    const { service, deps } = makeService({
      row: { withdrawalAckAt: 123, exportAckAt: null, privyWalletId: 'pw_1' },
      openBefore: 2,
      openAfterStop: 0,
      balance: 0, // idle wallet empty pre-stop — the funds are inside the open positions
      balanceAfterStop: 5 * DUST_LAMPORTS, // …and the force-close drains them back into the idle wallet
    });
    expect(await service.teardown('u1', 'did:1')).toEqual({ ok: false, reason: 'funds_remain' });
    expect(deps.stopBot).toHaveBeenCalledTimes(1); // the force-close DID run (entry gate passed on the stale ack)
    expect(deps.deletePrivyUser).not.toHaveBeenCalled(); // …but the IRREVERSIBLE detach did NOT
    expect(deps.deleteLocalCascade).not.toHaveBeenCalled(); // account stays intact → user can withdraw + retry
  });

  it('a stale withdrawal ack over idle re-deposited funds is BLOCKED even with nothing to force-close', async () => {
    // No open mirrors → no drain, but the idle wallet holds re-deposited SOL the sticky ack cannot cover; the
    // entry gate short-circuits on the ack, so only the post-drain re-read catches it.
    const { service, deps } = makeService({
      row: { withdrawalAckAt: 123, exportAckAt: null, privyWalletId: 'pw_1' },
      openBefore: 0,
      openAfterStop: 0,
      balance: 5 * DUST_LAMPORTS,
    });
    expect(await service.teardown('u1', 'did:1')).toEqual({ ok: false, reason: 'funds_remain' });
    expect(deps.deletePrivyUser).not.toHaveBeenCalled();
    expect(deps.deleteLocalCascade).not.toHaveBeenCalled();
  });
});
