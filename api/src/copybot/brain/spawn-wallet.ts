/**
 * Copy-bot · Inc.4c — resolve the (ownerPk, balanceOf) a runtime spawns against (INC4-PLAN §4c).
 *
 * SYSTEM keeps the configured bench wallet + the constant bench balance — BYTE-IDENTICAL to every prior increment
 * (the on-chain bench and `--once` run as SYSTEM). A REAL user resolves their provisioned Privy wallet address from
 * the activation row and gets a short-TTL `getBalance` cache (minus their SOL reserve) as `balanceOf`. A user with
 * no resolvable wallet yet (un/half-provisioned) is NOT spawnable — `resolveUserWallet` returns null and the caller
 * skips them exactly like an inactive user (retried on the next reload). No real user is provisioned+active yet, so
 * in production this only ever takes the SYSTEM branch; the real-user branch is exercised by tests this wave.
 */
import type { PublicKey } from '@solana/web3.js';
import { SYSTEM_USER_ID } from '@/copybot/journal-store';
import type { WalletBalanceCache } from './wallet-balance-cache';

export interface ResolvedUserWallet {
  /** The wallet this runtime signs/enumerates/sizes against. */
  ownerPk: PublicKey;
  /** Spendable SOL fed to `decideEntry` (async: a live user reads a cached on-chain balance). */
  balanceOf: () => Promise<number>;
}

export interface ResolveUserWalletDeps {
  userId: string;
  /** The SYSTEM (bench) wallet + its constant balance — used only for `SYSTEM_USER_ID`. */
  systemOwnerPk: PublicKey;
  systemBalanceSol: number;
  /** Resolve a real user's provisioned wallet address → its pubkey, or null when not provisioned yet. */
  resolveOwner: (userId: string) => Promise<PublicKey | null>;
  /** Shared short-TTL balance cache (SharedBrainDeps) — one entry per real wallet. */
  walletBalanceCache: WalletBalanceCache;
  /** The user's live SOL reserve (config-derived; read at each balance call so a config edit takes effect). */
  reserveSol: () => number;
}

/** Build the runtime's (ownerPk, balanceOf) at spawn. Returns null for an unresolved (not-yet-provisioned) user. */
export async function resolveUserWallet(
  deps: ResolveUserWalletDeps,
): Promise<ResolvedUserWallet | null> {
  if (deps.userId === SYSTEM_USER_ID) {
    // SYSTEM: the configured bench wallet + a CONSTANT balance — no cache, no getBalance (bench byte-identity).
    return { ownerPk: deps.systemOwnerPk, balanceOf: async () => deps.systemBalanceSol };
  }
  const ownerPk = await deps.resolveOwner(deps.userId);
  if (!ownerPk) return null; // not provisioned yet → not spawnable this pass
  const address = ownerPk.toBase58();
  return {
    ownerPk,
    balanceOf: () => deps.walletBalanceCache.balanceSol(address, deps.reserveSol()),
  };
}
