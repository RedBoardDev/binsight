import { PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_USER_ID } from '@/copybot/journal-store';
import { resolveUserWallet } from './spawn-wallet';
import type { WalletBalanceCache } from './wallet-balance-cache';

const SYSTEM_OWNER = new PublicKey('Ybbt2Td4TjxwpzvuicbP9ANizBwAJzqjuRmRrvDh9zz');
const USER_OWNER = new PublicKey('8ryctvNwpJTuuap3wuNTfcyEx4DjSuXvhGXSDHNaU8sQ');
const SYSTEM_BALANCE_SOL = 10;

/** A recording balance cache: returns a fixed spendable SOL and captures (address, reserve). */
function fakeCache(spendableSol: number) {
  const calls: Array<{ address: string; reserveSol: number }> = [];
  const cache: WalletBalanceCache = {
    balanceSol: async (address, reserveSol) => {
      calls.push({ address, reserveSol });
      return spendableSol;
    },
  };
  return { cache, calls };
}

describe('resolveUserWallet — the per-runtime (ownerPk, balanceOf) at spawn (Inc.4c)', () => {
  it('SYSTEM: the bench wallet + the CONSTANT bench balance (no resolveOwner, no getBalance) — bench byte-identity', async () => {
    // WHY: the on-chain bench + --once run as SYSTEM and MUST stay byte-identical — SYSTEM never routes through the
    // activation lookup nor the live-balance cache, so no real-user code path can ever perturb the bench.
    const { cache, calls } = fakeCache(3);
    const resolveOwner = vi.fn(async () => USER_OWNER);
    const resolved = await resolveUserWallet({
      userId: SYSTEM_USER_ID,
      systemOwnerPk: SYSTEM_OWNER,
      systemBalanceSol: SYSTEM_BALANCE_SOL,
      resolveOwner,
      walletBalanceCache: cache,
      reserveSol: () => 0.05,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.ownerPk.equals(SYSTEM_OWNER)).toBe(true);
    expect(await resolved?.balanceOf()).toBe(SYSTEM_BALANCE_SOL); // the constant, unchanged
    expect(resolveOwner).not.toHaveBeenCalled(); // SYSTEM never hits the activation lookup
    expect(calls).toEqual([]); // nor the getBalance cache
  });

  it('a real user: their provisioned wallet + a getBalance-cache balanceOf (reserve applied per call)', async () => {
    // WHY: a live user sizes against their ACTUAL on-chain balance minus the reserve — balanceOf must route through
    // the cache keyed by THEIR address, threading the live reserve so a config edit takes effect.
    const { cache, calls } = fakeCache(2.95);
    const resolved = await resolveUserWallet({
      userId: 'user-a',
      systemOwnerPk: SYSTEM_OWNER,
      systemBalanceSol: SYSTEM_BALANCE_SOL,
      resolveOwner: async () => USER_OWNER,
      walletBalanceCache: cache,
      reserveSol: () => 0.05,
    });
    expect(resolved?.ownerPk.equals(USER_OWNER)).toBe(true);
    expect(await resolved?.balanceOf()).toBe(2.95);
    expect(calls).toEqual([{ address: USER_OWNER.toBase58(), reserveSol: 0.05 }]); // cache, keyed by THEIR wallet
  });

  it('the reserve is read LIVE on each balanceOf call (a config edit applies without respawn)', async () => {
    const { cache, calls } = fakeCache(4);
    let reserve = 0.05;
    const resolved = await resolveUserWallet({
      userId: 'user-a',
      systemOwnerPk: SYSTEM_OWNER,
      systemBalanceSol: SYSTEM_BALANCE_SOL,
      resolveOwner: async () => USER_OWNER,
      walletBalanceCache: cache,
      reserveSol: () => reserve,
    });
    await resolved?.balanceOf();
    reserve = 1; // the user raised their reserve
    await resolved?.balanceOf();
    expect(calls.map((c) => c.reserveSol)).toEqual([0.05, 1]); // the NEW reserve reached the cache
  });

  it('an unresolved user (not provisioned yet) → null → NOT spawnable this pass', async () => {
    // WHY: a user without a resolvable Privy wallet is skipped exactly like an inactive user (no runtime, no
    // fan-out entry) and retried next reload — never spawned against a wrong/empty wallet.
    const { cache } = fakeCache(0);
    const resolved = await resolveUserWallet({
      userId: 'user-unprovisioned',
      systemOwnerPk: SYSTEM_OWNER,
      systemBalanceSol: SYSTEM_BALANCE_SOL,
      resolveOwner: async () => null, // activation row missing/half-filled
      walletBalanceCache: cache,
      reserveSol: () => 0.05,
    });
    expect(resolved).toBeNull();
  });
});
