import { describe, expect, it } from 'vitest';
import { createWalletBalanceCache } from './wallet-balance-cache';

const SOL = 1_000_000_000; // lamports per SOL
const TTL = 8_000;
const ADDR_A = 'WalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_B = 'WalletBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** A fetcher that records calls and returns a scripted per-address lamports value. */
function scriptedFetcher(lamportsByAddr: Record<string, number>) {
  const calls: string[] = [];
  return {
    calls,
    fetchLamports: async (address: string): Promise<number> => {
      calls.push(address);
      return lamportsByAddr[address] ?? 0;
    },
  };
}

describe('createWalletBalanceCache', () => {
  it('hits within the TTL: a second read inside the window serves the cache (one getBalance)', async () => {
    // WHY: balanceOf runs on the OPEN hot path — paying a getBalance RTT per open (and per burst) would blow the
    // RPC budget exactly when the bot scales. The TTL must make back-to-back opens free.
    const f = scriptedFetcher({ [ADDR_A]: 3 * SOL });
    let clock = 1_000;
    const cache = createWalletBalanceCache({
      fetchLamports: f.fetchLamports,
      ttlMs: TTL,
      nowMs: () => clock,
    });

    expect(await cache.balanceSol(ADDR_A, 0)).toBe(3);
    clock += TTL - 1; // still inside the TTL
    expect(await cache.balanceSol(ADDR_A, 0)).toBe(3);
    expect(f.calls).toEqual([ADDR_A]); // ONE fetch, not two
  });

  it('refetches after the TTL expires (a deposit/withdrawal must reflect within the window)', async () => {
    // WHY: the cache is a staleness bound, not a snapshot — a fresh deposit or a close must be seen so sizing and
    // the insufficient-balance skip act on reality, never a stale figure.
    const lamports: Record<string, number> = { [ADDR_A]: 2 * SOL };
    const f = scriptedFetcher(lamports);
    let clock = 0;
    const cache = createWalletBalanceCache({
      fetchLamports: f.fetchLamports,
      ttlMs: TTL,
      nowMs: () => clock,
    });

    expect(await cache.balanceSol(ADDR_A, 0)).toBe(2);
    lamports[ADDR_A] = 5 * SOL; // a deposit landed
    clock += TTL; // TTL elapsed (>= expiresAt)
    expect(await cache.balanceSol(ADDR_A, 0)).toBe(5); // refetched → the new balance
    expect(f.calls).toEqual([ADDR_A, ADDR_A]);
  });

  it('subtracts the reserve and floors at 0 (never report spendable SOL you must keep)', async () => {
    // WHY: solReserveSol is the rent/fee buffer that must never be deployed — spendable = balance − reserve, and a
    // balance at/below the reserve is 0 spendable (the open then skips), never a negative that games sizing.
    const f = scriptedFetcher({ [ADDR_A]: 3 * SOL, [ADDR_B]: SOL / 100 }); // B holds 0.01 SOL
    const cache = createWalletBalanceCache({
      fetchLamports: f.fetchLamports,
      ttlMs: TTL,
      nowMs: () => 0,
    });

    expect(await cache.balanceSol(ADDR_A, 0.05)).toBeCloseTo(2.95, 9); // 3 − 0.05 reserve
    expect(await cache.balanceSol(ADDR_B, 0.05)).toBe(0); // 0.01 ≤ 0.05 reserve → floored, not negative
  });

  it('the reserve is applied per call, not baked into the cache (a config edit takes effect within the TTL)', async () => {
    // WHY: the reserve is config-derived and can change live; caching the RAW lamports (not the post-reserve value)
    // lets a reserve edit apply on the next call without waiting for the balance TTL.
    const f = scriptedFetcher({ [ADDR_A]: 4 * SOL });
    const cache = createWalletBalanceCache({
      fetchLamports: f.fetchLamports,
      ttlMs: TTL,
      nowMs: () => 0,
    });

    expect(await cache.balanceSol(ADDR_A, 0.05)).toBeCloseTo(3.95, 9);
    expect(await cache.balanceSol(ADDR_A, 1)).toBe(3); // same cached lamports, new reserve → recomputed
    expect(f.calls).toEqual([ADDR_A]); // still one fetch (reserve change never triggers a refetch)
  });

  it('per-address isolation: distinct wallets are cached independently (one fetch each)', async () => {
    // WHY: two users have DISTINCT Privy wallets — one wallet's balance must never be served for another.
    const f = scriptedFetcher({ [ADDR_A]: 3 * SOL, [ADDR_B]: 7 * SOL });
    const cache = createWalletBalanceCache({
      fetchLamports: f.fetchLamports,
      ttlMs: TTL,
      nowMs: () => 0,
    });

    expect(await cache.balanceSol(ADDR_A, 0)).toBe(3);
    expect(await cache.balanceSol(ADDR_B, 0)).toBe(7);
    expect(await cache.balanceSol(ADDR_A, 0)).toBe(3); // A still cached
    expect(f.calls).toEqual([ADDR_A, ADDR_B]); // one fetch per distinct wallet
  });

  it('a failed fetch is NOT cached — the next call retries (a transient RPC error never freezes for the TTL)', async () => {
    let fail = true;
    const calls: string[] = [];
    const cache = createWalletBalanceCache({
      fetchLamports: async (address: string): Promise<number> => {
        calls.push(address);
        if (fail) throw new Error('rpc down');
        return 3 * SOL;
      },
      ttlMs: TTL,
      nowMs: () => 0,
    });

    await expect(cache.balanceSol(ADDR_A, 0)).rejects.toThrow('rpc down');
    fail = false;
    expect(await cache.balanceSol(ADDR_A, 0)).toBe(3); // retried (not a cached rejection)
    expect(calls).toEqual([ADDR_A, ADDR_A]);
  });
});
