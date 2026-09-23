import type { OpenPosition, PortfolioTotals, WalletState } from '@binsight/shared';
import type { OnchainValued } from '@/domain/dlmm';
import { isOutOfRange } from '@/domain/position';

// Above this cross-chunk slot skew (large wallets, >100 getMultipleAccounts keys) the total is read
// across a few slots rather than one — surface it as "syncing" instead of a possibly-inconsistent number.
const SYNCING_SKEW_SLOTS = 25;

/**
 * A position's figure in SOL. SOL pools carry it directly; any other pool's native-quote figure is
 * converted at the rate its own valuation implies (its SOL-valued size over its quote-valued size), so
 * the portfolio totals never add USDC to SOL — nor count a USDC position's PnL as zero.
 */
function inSol(p: OpenPosition, solValue: number, quoteValue: number | undefined): number {
  if ((p.quoteSymbol ?? 'SOL') === 'SOL') return solValue;
  const rate = p.sizeQuote && p.sizeQuote > 0 ? p.sizeSol / p.sizeQuote : 0;
  return (quoteValue ?? 0) * rate;
}

/** Totals from the open positions + a plain idle figure (used as is before the first snapshot). */
export function buildTotals(positions: OpenPosition[], idleSol = 0): PortfolioTotals {
  let tvl = 0;
  let pnl = 0;
  let claimed = 0;
  let unclaimed = 0;
  let inRange = 0;
  let outOfRange = 0;
  for (const p of positions) {
    tvl += p.sizeSol;
    pnl += inSol(p, p.pnlSol, p.pnlQuote);
    claimed += inSol(p, p.claimedFeesSol, p.claimedFeesQuote);
    unclaimed += p.unclaimedFeesSol;
    if (isOutOfRange(p.rangeStatus)) outOfRange++;
    else if (p.rangeStatus === 'in') inRange++;
  }
  const uPnlPct = tvl > 0 ? (pnl / tvl) * 100 : 0;
  return {
    uPnlSol: pnl,
    uPnlPct,
    feesSol: claimed + unclaimed,
    claimedFeesSol: claimed,
    unclaimedFeesSol: unclaimed,
    tvlSol: tvl,
    idleSol,
    walletTotalSol: tvl + idleSol,
    // Position-only fallback, before any on-chain snapshot has landed: nothing was skipped for want of
    // a price, so the figure is complete for what it claims to cover.
    valuationStatus: 'complete',
    openCount: positions.length,
    inRangeCount: inRange,
    outOfRangeCount: outOfRange,
  };
}

/** Override each position's value/fees with the slot-consistent on-chain numbers (when present). */
function applyOnchain(positions: OpenPosition[], onchain: OnchainValued): OpenPosition[] {
  return positions.map((p) => {
    const size = onchain.sizeSolByPosition.get(p.positionAddress);
    if (size == null) return p;
    const fee = onchain.feeSolByPosition.get(p.positionAddress);
    return { ...p, sizeSol: size, unclaimedFeesSol: fee ?? p.unclaimedFeesSol };
  });
}

/**
 * WalletState with an authoritative, slot-consistent total. PnL / claimed fees / range counts come
 * from the Meteora-driven positions (deposit-basis data on-chain can't supply); TVL / idle / unclaimed
 * fees / walletTotal come from the on-chain snapshot — which makes double-counting structurally impossible.
 * Falls back to `buildTotals` until the first snapshot lands.
 */
export function buildWalletState(
  scope: string,
  positions: OpenPosition[],
  onchain: OnchainValued | null,
): WalletState {
  if (!onchain) {
    const sorted = [...positions].sort((a, b) => b.pnlSol - a.pnlSol);
    return {
      scope,
      totals: buildTotals(sorted, 0),
      openPositions: sorted,
      asOfSlot: null,
      freshness: 'syncing',
      updatedAt: Date.now(),
    };
  }
  const sorted = applyOnchain(positions, onchain).sort((a, b) => b.pnlSol - a.pnlSol);
  const base = buildTotals(sorted, onchain.idleSol);
  const totals: PortfolioTotals = {
    ...base,
    tvlSol: onchain.tvlSol,
    unclaimedFeesSol: onchain.unclaimedFeesSol,
    feesSol: base.claimedFeesSol + onchain.unclaimedFeesSol,
    walletTotalSol: onchain.walletTotalSol,
    valuationStatus: onchain.valuationStatus,
  };
  return {
    scope,
    totals,
    openPositions: sorted,
    asOfSlot: onchain.slot,
    // Freshness describes the AUTHORITY and currentness of the chain read: a cached price-only re-mark
    // is display-only, and an unfetched bin-array or undecodable mint really does mean "not yet". Price
    // coverage is reported separately by totals.valuationStatus — a couple of unpriced dust mints must
    // not leave a current, exact wallet stuck on "syncing" forever, which is what folding the two
    // together would now do, since the inventory covers every token held.
    freshness:
      !onchain.authoritative || !onchain.chainComplete || onchain.slotSkew > SYNCING_SKEW_SLOTS
        ? 'syncing'
        : 'fresh',
    updatedAt: Date.now(),
  };
}

/** Merge several wallets' on-chain valuations into one (for the aggregated "all" scope). */
export function combineOnchain(present: OnchainValued[]): OnchainValued | null {
  if (present.length === 0) return null;
  const sizeBy = new Map<string, number>();
  const feeBy = new Map<string, number>();
  let tvlSol = 0;
  let idleSol = 0;
  let unclaimedFeesSol = 0;
  let lockedRentSol = 0;
  let walletTotalSol = 0;
  let positionCount = 0;
  let slot = 0;
  let slotSkew = 0;
  for (const v of present) {
    tvlSol += v.tvlSol;
    idleSol += v.idleSol;
    unclaimedFeesSol += v.unclaimedFeesSol;
    lockedRentSol += v.lockedRentSol;
    walletTotalSol += v.walletTotalSol;
    positionCount += v.positionCount;
    slot = Math.max(slot, v.slot);
    slotSkew = Math.max(slotSkew, v.slotSkew);
    for (const [k, s] of v.sizeSolByPosition) sizeBy.set(k, s);
    for (const [k, f] of v.feeSolByPosition) feeBy.set(k, f);
  }
  return {
    slot,
    slotSkew,
    tvlSol,
    idleSol,
    unclaimedFeesSol,
    lockedRentSol,
    walletTotalSol,
    positionCount,
    // Each dimension aggregates on its own: the combined read is only as authoritative, as complete
    // and as fully priced as its weakest contributor.
    chainComplete: present.every((v) => v.chainComplete),
    valuationStatus: present.every((v) => v.valuationStatus === 'complete')
      ? 'complete'
      : 'partial',
    authoritative: present.every((v) => v.authoritative),
    complete: present.every((v) => v.complete),
    sizeSolByPosition: sizeBy,
    feeSolByPosition: feeBy,
  };
}
