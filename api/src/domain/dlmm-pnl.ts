import type { DlmmLeg } from '@binsight/solana-core';
import { SOL_MINT, USDC_MINT, USDT_MINT } from '@binsight/solana-core';
import type { PoolMeta, PositionEconomics, PositionEconomicsQuote, QuoteMeta } from './dlmm';

/**
 * Pure mark-to-pool PnL for a Meteora DLMM position, fully on-chain (no Meteora API, all history).
 *
 * Each deposit/withdraw/claim leg's non-SOL token amount is valued in SOL at the DLMM geometric bin
 * price of that very transaction (`(1 + binStep/10000)^activeBinId`), which is the historical price
 * at that block — so it never expires (recovers positions Meteora purges). Validated to the lamport
 * against Meteora's own pnl on a real position (GYMtBiHX) — see the unit tests.
 *
 *   PnL = Σ(withdrawals + claimed fees) − Σ(deposits), each leg at its own bin price.
 */

export interface QuoteConvention {
  quoteMint: string;
  baseMint: string;
  quoteSide: 'X' | 'Y';
  quoteDecimals: number;
  quoteSymbol: 'SOL' | 'USDC' | 'USDT';
}

const SUPPORTED_QUOTES = [
  { mint: SOL_MINT, decimals: 9, symbol: 'SOL' as const },
  { mint: USDC_MINT, decimals: 6, symbol: 'USDC' as const },
  { mint: USDT_MINT, decimals: 6, symbol: 'USDT' as const },
];

/** Resolve the native reporting quote without ever conflating different units. SOL keeps priority for
 * all historical SOL pools; otherwise USDC, then USDT. null means the pool remains visible/unpriced. */
export function quoteConventionOf(mintX: string, mintY: string): QuoteConvention | null {
  for (const quote of SUPPORTED_QUOTES) {
    if (mintY === quote.mint)
      return {
        quoteMint: mintY,
        baseMint: mintX,
        quoteSide: 'Y',
        quoteDecimals: quote.decimals,
        quoteSymbol: quote.symbol,
      };
    if (mintX === quote.mint)
      return {
        quoteMint: mintX,
        baseMint: mintY,
        quoteSide: 'X',
        quoteDecimals: quote.decimals,
        quoteSymbol: quote.symbol,
      };
  }
  return null;
}

/** SOL side of a pool, or null if neither token is SOL (a non-SOL-quote pool — valued in its quote). */
export function solSideOf(mintX: string, mintY: string): 'X' | 'Y' | null {
  if (mintY === SOL_MINT) return 'Y';
  if (mintX === SOL_MINT) return 'X';
  return null;
}

/** price = (1 + binStep/10000)^binId — Y-lamports per X-lamport (the canonical DLMM bin price). */
export function binPriceRaw(binId: number, binStep: number): number {
  return (1 + binStep / 10000) ** binId;
}

/** Value raw X/Y amounts in the selected native quote at one active bin. */
export function amountsValueQuote(
  amountX: bigint,
  amountY: bigint,
  activeBinId: number,
  meta: QuoteMeta,
): number {
  const price = binPriceRaw(activeBinId, meta.binStep);
  const x = Number(amountX);
  const y = Number(amountY);
  const rawQuote = meta.quoteSide === 'Y' ? x * price + y : x + y / price;
  return rawQuote / 10 ** meta.quoteDecimals;
}

/** Value one leg in the pool's native quote (SOL, USDC or USDT). */
export function legValueQuote(leg: DlmmLeg, meta: QuoteMeta): number | null {
  if (leg.activeBinId == null) {
    // A missing bin does not make the quote-side quantity unknown. Only the opposite side needs the
    // conversion price. This preserves exact wSOL/USDC fees while visibly marking mixed claims partial.
    if (meta.quoteSide === 'Y' && leg.amountX === 0n)
      return Number(leg.amountY) / 10 ** meta.quoteDecimals;
    if (meta.quoteSide === 'X' && leg.amountY === 0n)
      return Number(leg.amountX) / 10 ** meta.quoteDecimals;
    return null;
  }
  return amountsValueQuote(leg.amountX, leg.amountY, leg.activeBinId, meta);
}

/** Value one leg's raw token amounts in SOL via its bin price. */
export function legValueSol(leg: DlmmLeg, meta: PoolMeta): number | null {
  return legValueQuote(leg, {
    binStep: meta.binStep,
    quoteSide: meta.solSide,
    quoteDecimals: 9,
  });
}

/** Split a position's legs in its native quote. Values from different quote mints must never be summed
 * until an explicitly timestamped normalization has been applied. */
export function positionEconomicsQuote(legs: DlmmLeg[], meta: QuoteMeta): PositionEconomicsQuote {
  let depositQuote = 0;
  let withdrawQuote = 0;
  let claimedFeesQuote = 0;
  let unpricedLegs = 0;
  for (const leg of legs) {
    const fullyValued = legValueQuote(leg, meta);
    // If the historical event has no price anchor, its quote-side raw amount is still exact. Keep
    // that certain component and flag only the opposite-side conversion as missing. This is crucial
    // for old ClaimFee events: e.g. 0.112397677 wSOL remains known even when 896.784 base tokens do not.
    const value =
      fullyValued ??
      Number(meta.quoteSide === 'Y' ? leg.amountY : leg.amountX) / 10 ** meta.quoteDecimals;
    if (fullyValued == null) {
      unpricedLegs++;
    }
    if (leg.kind === 'deposit') depositQuote += value;
    else if (leg.kind === 'withdraw') withdrawQuote += value;
    else claimedFeesQuote += value;
  }
  return {
    depositQuote,
    withdrawQuote,
    claimedFeesQuote,
    pnlQuote: withdrawQuote + claimedFeesQuote - depositQuote,
    valuationStatus: unpricedLegs === 0 ? 'complete' : 'partial',
    unpricedLegs,
  };
}

/** Split a position's legs into deposit / withdraw / claimed-fee SOL totals (one source of truth). */
export function positionEconomics(legs: DlmmLeg[], meta: PoolMeta): PositionEconomics {
  const quote = positionEconomicsQuote(legs, {
    binStep: meta.binStep,
    quoteSide: meta.solSide,
    quoteDecimals: 9,
  });
  const depositSol = quote.depositQuote;
  const withdrawSol = quote.withdrawQuote;
  const claimedFeesSol = quote.claimedFeesQuote;
  return {
    depositSol,
    withdrawSol,
    claimedFeesSol,
    pnlSol: withdrawSol + claimedFeesSol - depositSol,
  };
}

/** Open-position PnL in a native quote: realized legs + current liquidity + unclaimed fees - deposits. */
export function openUnrealizedPnlQuote(
  econ: Pick<PositionEconomicsQuote, 'depositQuote' | 'withdrawQuote' | 'claimedFeesQuote'>,
  live: { sizeQuote: number; unclaimedFeesQuote: number },
): number {
  return (
    econ.withdrawQuote +
    econ.claimedFeesQuote +
    live.sizeQuote +
    live.unclaimedFeesQuote -
    econ.depositQuote
  );
}

/**
 * Live unrealized SOL PnL of an OPEN position = the "open = snapshot ⊕ legs" model.
 *   uPnL = (realized so far: withdrawals + claimed fees) + (if closed now: live liquidity + unclaimed fees)
 *          − cost basis (deposits)
 * `econ` comes from the leg history (cost basis); `live` from the current on-chain snapshot.
 */
export function openUnrealizedPnlSol(
  econ: Pick<PositionEconomics, 'depositSol' | 'withdrawSol' | 'claimedFeesSol'>,
  live: { sizeSol: number; unclaimedFeesSol: number },
): number {
  return (
    econ.withdrawSol + econ.claimedFeesSol + live.sizeSol + live.unclaimedFeesSol - econ.depositSol
  );
}
