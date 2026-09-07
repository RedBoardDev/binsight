/**
 * Copy-bot · Inc.4c — short-TTL wallet SOL-balance cache (PURE, testable; injected clock + fetcher).
 *
 * A real user's `balanceOf` (fed to `decideEntry`) is their live on-chain SOL minus the configured `solReserveSol`.
 * Reading `getBalance` on every open decision would pay an RPC RTT on the hot path AND multiply cost by open rate;
 * a short TTL bounds staleness (a deposit/withdrawal/close reflects within the TTL) while sparing back-to-back opens
 * the round-trip. SYSTEM never uses this (its balance is the constant bench value) — the cache is per REAL wallet.
 *
 * The raw lamports are cached per address; the reserve is applied per call (it is config-derived and can change
 * live, so it is never baked into the cached value). A FAILED fetch is not cached — the next call retries.
 */
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

// Wallet SOL-balance staleness bound: long enough to spare a `getBalance` RTT on back-to-back opens in a burst,
// short enough that a fresh deposit/withdrawal/close reflects well within the 30s reconcile cadence.
export const WALLET_BALANCE_TTL_MS = 8_000;

export interface WalletBalanceCache {
  /** Spendable SOL for `address` = cached `getBalance` (SOL) − `reserveSol`, floored at 0. Served from cache
   *  within the TTL, otherwise refetched. */
  balanceSol(address: string, reserveSol: number): Promise<number>;
}

export function createWalletBalanceCache(deps: {
  /** Live lamports for an address (a `conn.getBalance(new PublicKey(address))` in prod; a fake in tests). */
  fetchLamports: (address: string) => Promise<number>;
  ttlMs: number;
  /** Injectable clock (tests). */
  nowMs?: () => number;
}): WalletBalanceCache {
  const now = deps.nowMs ?? Date.now;
  const cache = new Map<string, { lamports: number; expiresAt: number }>();
  return {
    async balanceSol(address: string, reserveSol: number): Promise<number> {
      const t = now();
      const entry = cache.get(address);
      let lamports: number;
      if (entry && t < entry.expiresAt) {
        lamports = entry.lamports;
      } else {
        // A failed fetch propagates and is NOT cached (never freeze a transient RPC error for the whole TTL).
        lamports = await deps.fetchLamports(address);
        cache.set(address, { lamports, expiresAt: t + deps.ttlMs });
      }
      return Math.max(0, lamports / LAMPORTS_PER_SOL - reserveSol);
    },
  };
}
