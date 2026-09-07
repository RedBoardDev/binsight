/**
 * Copy-bot · OPEN build-routing threshold (pure). The DLMM SDK's atomic `initializePositionAndAddLiquidityByWeight`
 * bundles position-init + bin-array-init + the deposit in ONE tx and CHUNKS that into [pre, main, post] transactions
 * once the distribution spans `MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX` (26) bins — and the deposit (`main`, the native
 * addLiquidityOneSide / addLiquidityByWeight) is NOT the first tx. Publishing only the first tx would create an EMPTY
 * position with no liquidity. So a WIDE open must be sequenced: publish `pre` (create + wrap), then `main`+`post`
 * (deposit + unwrap) once the create lands. A narrow open (≤25 bins) stays the proven atomic single-tx open.
 */

/** SDK `MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX`: at/above this bin count the atomic by-weight open chunks into multiple
 *  txs (the deposit is not the first), so it must be sequenced as create → deposit. Mirrors @meteora-ag/dlmm. */
export const ATOMIC_BY_WEIGHT_BIN_LIMIT = 26;

/** A DLMM single position spans at most this many bins (SDK `DEFAULT_BIN_PER_POSITION`). A wider span can't be a
 *  single createEmptyPosition + single deposit chunk → such an open is skipped (never a partial deposit). */
export const MAX_SINGLE_POSITION_BINS = 70;

/** True when an open of `binCount` bins chunks the atomic by-weight open → must be sequenced (create → deposit)
 *  rather than published as one tx. False for a narrow open that fits the proven atomic single-tx path. */
export function isWideOpen(binCount: number): boolean {
  return binCount >= ATOMIC_BY_WEIGHT_BIN_LIMIT;
}

/** Basis points per percent — our execution config carries slippage in BPS (like the Jupiter swap tolerance). */
const BPS_PER_PERCENT = 100;

/**
 * Convert our config's `slippageBps` into the PERCENTAGE the DLMM SDK's deposit `slippage` param expects. The SDK
 * normalizes tolerance across pools by converting that percentage → an active-bin count via the pool's binStep
 * (`ceil(pct / (binStep/100))`); omitting it falls back to the SDK default of 3 bins, which is 0.03% on a binStep-1
 * pool but 3% on binStep-100 — NOT price-normalized, so a fast pool drifts >3 bins between build and land and the
 * deposit fails deterministically (ULTRACODE #47). Passing a config-driven percent makes the tolerance consistent.
 */
export function activeBinSlippagePctFromBps(slippageBps: number): number {
  return slippageBps / BPS_PER_PERCENT;
}
