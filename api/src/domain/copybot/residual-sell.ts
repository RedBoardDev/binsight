/**
 * Copy-bot · fast residual sell (PURE core, no I/O). When the leader closes, our close removes liquidity and
 * returns SOL + a residual NON-SOL token leg; we immediately swap that residual back to SOL (Jupiter, built by
 * the brain → verified by Wall B → signed+landed by the vault). This module holds the deterministic decisions
 * around that swap; the Jupiter quote/route fetch is the I/O layer.
 *
 * "Fast and never fails": skip true dust (Jupiter errors on tiny amounts → wasted attempt), and never accept a
 * route below a slippage floor (protects against MEV / a bad route while still being permissive enough to land).
 */

const BPS_DENOMINATOR = 10_000n; // basis-points base (100% = 10000 bps)
// A3-01: the config schema's inclusive upper bound for slippageBps. At/above BPS_DENOMINATOR (100%) minOutWithSlippage
// zeroes or inverts the min-out floor (accept any output → a drain) and throws — which would WEDGE two-sided/reshape
// settlement and defeat the residual-sweep. Bounding here (single source) rejects such a config at parse (fail-closed).
export const MAX_SLIPPAGE_BPS = Number(BPS_DENOMINATOR) - 1; // 9999 (< 100%)

export interface ResidualSellDecision {
  sell: boolean;
  /** present only when sell=false — why we skip the swap. */
  reason?: 'no_residual' | 'dust';
}

/**
 * Decide whether the residual token leg is worth swapping. Below `dustThresholdRaw` (raw token units) we skip:
 * the swap would either fail or cost more in fees than it returns. Pure.
 */
export function decideResidualSell(
  tokenBalanceRaw: bigint,
  dustThresholdRaw: bigint,
): ResidualSellDecision {
  if (tokenBalanceRaw <= 0n) return { sell: false, reason: 'no_residual' };
  if (tokenBalanceRaw <= dustThresholdRaw) return { sell: false, reason: 'dust' };
  return { sell: true };
}

export interface OwnerTokenBalance {
  mint: string;
  amountRaw: bigint;
}

/**
 * Select which of the wallet's token balances to sweep back to SOL (the no-miss safety net behind the
 * close-triggered sell): every non-SOL mint above dust. Pure; reuses `decideResidualSell` for the per-token cutoff.
 *
 * wSOL is DELIBERATELY excluded (verified against the Meteora DLMM SDK, not a bug): the WSOL ATA is a single
 * canonical per-owner address, its create is idempotent (a stranded ATA never blocks a later open), and every
 * SOL-paired op (a wide/two-sided open's `pre`-wrap, and every close/remove) ends with the SDK's `post` step doing
 * `closeAccount(entire WSOL ATA -> owner)`, reclaiming the WHOLE balance — stranded WSOL included — as native SOL.
 * Since start/stop = force-close, even a STOP reabsorbs it. So a leftover-WSOL residual is self-healing on the next
 * open/close; the ONLY truly-stranded case is a wallet that performs no further SOL-op ever (dormant). A standalone
 * recovery-unwrap tx is deliberately NOT added: it would race the SHARED, fungible WSOL ATA — a balance read cannot
 * separate stranded WSOL from an in-flight open's freshly-wrapped, not-yet-deposited WSOL — so it could drain a live
 * open's capital to recover a residual the same op reabsorbs for free. Recovery is delegated to the SDK's next-op
 * native unwrap by design. See ULTRACODE-REVIEW WSOL (#7).
 */
export function planWalletSweep(
  balances: OwnerTokenBalance[],
  wsolMint: string,
  dustThresholdRaw: bigint,
): OwnerTokenBalance[] {
  return balances.filter(
    (b) => b.mint !== wsolMint && decideResidualSell(b.amountRaw, dustThresholdRaw).sell,
  );
}

/**
 * Minimum acceptable output (in lamports) for a quoted swap output, given a slippage tolerance in bps. The
 * landed tx must return at least this much SOL or it reverts — the "never sell into a terrible route" floor.
 * Pure, bigint-exact (floor division).
 */
export function minOutWithSlippage(quotedOutLamports: bigint, slippageBps: number): bigint {
  // Reject BOTH ends: < 0 is nonsensical, and >= 100% (10000 bps) would zero or invert the floor — i.e. accept any
  // output, including a near-total drain. That defeats this module's whole purpose, so it's a config error → fail loud.
  if (slippageBps < 0 || slippageBps >= Number(BPS_DENOMINATOR))
    throw new Error('slippageBps must be in [0, 10000)');
  const keptBps = BPS_DENOMINATOR - BigInt(slippageBps);
  return (quotedOutLamports * keptBps) / BPS_DENOMINATOR;
}
