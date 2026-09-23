import type { ClosedPosition, OpenPosition, RangeStatus, StrategyFamily } from '@binsight/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { toFiniteNumber as n } from '@/util/number';
import { positions as positionsTable } from './schema';

/** Row mappers and SQL fragments shared by the position store and its read models. */

export type PositionRow = typeof positionsTable.$inferSelect;
type PositionInsert = typeof positionsTable.$inferInsert;

// Effective realized PnL = the authoritative FIFO figure when present, else the legs' pool mark.
export const PNL = sql<number>`coalesce(${positionsTable.marketPnlSol}, ${positionsTable.pnlSol})`;
export const IS_SOL_QUOTE = sql`(${positionsTable.quoteSymbol} = 'SOL' OR ${positionsTable.quoteSymbol} IS NULL)`;
// A SOL position's authoritative reprice is in its own quote, so it wins over pnl_quote too. Non-SOL
// positions use only their own quote and are never relabelled SOL.
export const NATIVE_PNL = sql<number>`case when ${IS_SOL_QUOTE} then ${PNL} else coalesce(${positionsTable.pnlQuote}, 0) end`;
export const NATIVE_PNL_PCT = sql<number>`case
  when ${IS_SOL_QUOTE} and ${positionsTable.depositSol} > 0
    then (${PNL} / ${positionsTable.depositSol}) * 100
  when ${IS_SOL_QUOTE} then ${positionsTable.pnlPctSol}
  else coalesce(${positionsTable.pnlPctQuote}, 0)
end`;
export const NATIVE_FEES = sql<number>`case when ${IS_SOL_QUOTE} then ${positionsTable.claimedFeesSol} else coalesce(${positionsTable.claimedFeesQuote}, 0) end`;
export const IS_ECONOMIC = sql`coalesce(${positionsTable.economicStatus}, 'funded') <> 'empty_shell'`;

/** The columns that identify a position and its pair — identical for an open and a closed row. */
export function identityRow(p: OpenPosition | ClosedPosition) {
  return {
    positionAddress: p.positionAddress,
    wallet: p.wallet,
    poolAddress: p.poolAddress,
    tokenX: p.tokenX,
    tokenY: p.tokenY,
    tokenXMint: p.tokenXMint,
    tokenYMint: p.tokenYMint ?? null,
    quoteMint: p.quoteMint ?? null,
    quoteSymbol: p.quoteSymbol ?? null,
    quoteDecimals: p.quoteDecimals ?? null,
    quoteSide: p.quoteSide ?? null,
    valuationStatus: p.valuationStatus ?? null,
    economicStatus: p.economicStatus ?? null,
    tokenXIcon: p.tokenXIcon ?? null,
    tokenYIcon: p.tokenYIcon ?? null,
  } satisfies Partial<PositionInsert>;
}

export function openRow(p: OpenPosition): PositionInsert {
  return {
    ...identityRow(p),
    status: 'open',
    pnlSol: p.pnlSol,
    pnlPctSol: p.pnlPctSol,
    sizeSol: p.sizeSol,
    claimedFeesSol: p.claimedFeesSol,
    unclaimedFeesSol: p.unclaimedFeesSol,
    pnlQuote: p.pnlQuote ?? null,
    pnlPctQuote: p.pnlPctQuote ?? null,
    sizeQuote: p.sizeQuote ?? null,
    claimedFeesQuote: p.claimedFeesQuote ?? null,
    unclaimedFeesQuote: p.unclaimedFeesQuote ?? null,
    minPrice: p.minPrice,
    maxPrice: p.maxPrice,
    poolPrice: p.poolPrice,
    rangeStatus: p.rangeStatus,
    oorSince: p.outOfRangeSince,
    openedAt: p.openedAt,
    updatedAt: p.updatedAt,
  };
}

export function closedRow(p: ClosedPosition, now: number): PositionInsert {
  return {
    ...identityRow(p),
    status: 'closed',
    pnlSol: p.pnlSol,
    pnlPctSol: p.pnlPctSol,
    depositSol: p.depositSol,
    withdrawSol: p.withdrawSol,
    claimedFeesSol: p.feesSol,
    pnlQuote: p.pnlQuote ?? null,
    pnlPctQuote: p.pnlPctQuote ?? null,
    depositQuote: p.depositQuote ?? null,
    withdrawQuote: p.withdrawQuote ?? null,
    claimedFeesQuote: p.feesQuote ?? null,
    openedAt: p.openedAt,
    closedAt: p.closedAt,
    durationSeconds: p.durationSeconds,
    updatedAt: now,
  };
}

/** `SET col = excluded.col` for every listed column of an upsert. */
export function fromExcluded(cols: Record<string, PgColumn>): Record<string, SQL> {
  return Object.fromEntries(
    Object.entries(cols).map(([key, col]) => [key, sql.raw(`excluded."${col.name}"`)]),
  );
}

/** A symbol that the metadata gateway could not resolve renders as a truncated mint ("AbCd…WxYz"). Never
 *  replace a known symbol (or icon) with that placeholder: one metadata outage would otherwise relabel
 *  a whole history. */
export function keepKnownLabel(col: PgColumn): SQL {
  const incoming = sql.raw(`excluded."${col.name}"`);
  return sql`case when position('…' in ${incoming}) > 0 and ${col} is not null then ${col} else ${incoming} end`;
}

export function keepKnownIcon(col: PgColumn): SQL {
  return sql`coalesce(${sql.raw(`excluded."${col.name}"`)}, ${col})`;
}

export function rowToOpen(r: PositionRow): OpenPosition {
  return {
    positionAddress: r.positionAddress,
    wallet: r.wallet,
    poolAddress: r.poolAddress,
    tokenX: String(r.tokenX),
    tokenY: String(r.tokenY),
    tokenXMint: r.tokenXMint ?? '',
    tokenYMint: r.tokenYMint ?? undefined,
    quoteMint: r.quoteMint ?? undefined,
    quoteSymbol: r.quoteSymbol ?? String(r.tokenY),
    quoteDecimals: r.quoteDecimals ?? undefined,
    quoteSide: (r.quoteSide as 'X' | 'Y') ?? undefined,
    valuationStatus: (r.valuationStatus as 'complete' | 'partial' | 'unpriced') ?? undefined,
    economicStatus: (r.economicStatus as 'funded' | 'empty_shell') ?? undefined,
    tokenXIcon: r.tokenXIcon ?? undefined,
    tokenYIcon: r.tokenYIcon ?? undefined,
    strategy: (r.strategy as StrategyFamily) ?? null,
    sizeSol: n(r.sizeSol),
    pnlSol: n(r.pnlSol),
    pnlPctSol: n(r.pnlPctSol),
    claimedFeesSol: n(r.claimedFeesSol),
    unclaimedFeesSol: n(r.unclaimedFeesSol),
    sizeQuote: r.sizeQuote == null ? n(r.sizeSol) : n(r.sizeQuote),
    pnlQuote: r.pnlQuote == null ? n(r.pnlSol) : n(r.pnlQuote),
    pnlPctQuote: r.pnlPctQuote == null ? n(r.pnlPctSol) : n(r.pnlPctQuote),
    claimedFeesQuote: r.claimedFeesQuote == null ? n(r.claimedFeesSol) : n(r.claimedFeesQuote),
    unclaimedFeesQuote:
      r.unclaimedFeesQuote == null ? n(r.unclaimedFeesSol) : n(r.unclaimedFeesQuote),
    rangeStatus: (r.rangeStatus as RangeStatus) ?? 'unknown',
    minPrice: n(r.minPrice),
    maxPrice: n(r.maxPrice),
    poolPrice: r.poolPrice == null ? null : n(r.poolPrice),
    outOfRangeSince: r.oorSince == null ? null : n(r.oorSince),
    openedAt: r.openedAt == null ? null : n(r.openedAt),
    updatedAt: n(r.updatedAt),
  };
}

export function rowToClosed(r: PositionRow): ClosedPosition {
  // Effective PnL = the authoritative FIFO figure when computed, else the legs' pool mark.
  const market = r.marketPnlSol == null ? null : n(r.marketPnlSol);
  const pnlSol = market ?? n(r.pnlSol);
  const depositSol = n(r.depositSol);
  const quoteIsSol = r.quoteSymbol == null || r.quoteSymbol === 'SOL';
  const pnlQuote = quoteIsSol || r.pnlQuote == null ? pnlSol : n(r.pnlQuote);
  const depositQuote = r.depositQuote == null ? depositSol : n(r.depositQuote);
  return {
    positionAddress: r.positionAddress,
    wallet: r.wallet,
    poolAddress: r.poolAddress,
    tokenX: String(r.tokenX),
    tokenY: String(r.tokenY),
    tokenXMint: r.tokenXMint ?? '',
    tokenYMint: r.tokenYMint ?? undefined,
    quoteMint: r.quoteMint ?? undefined,
    quoteSymbol: r.quoteSymbol ?? String(r.tokenY),
    quoteDecimals: r.quoteDecimals ?? undefined,
    quoteSide: (r.quoteSide as 'X' | 'Y') ?? undefined,
    valuationStatus: (r.valuationStatus as 'complete' | 'partial' | 'unpriced') ?? undefined,
    economicStatus: (r.economicStatus as 'funded' | 'empty_shell') ?? undefined,
    tokenXIcon: r.tokenXIcon ?? undefined,
    tokenYIcon: r.tokenYIcon ?? undefined,
    strategy: (r.strategy as StrategyFamily) ?? null,
    pnlSol,
    // Percent points (1.89 == +1.89%), the same unit as the open side.
    pnlPctSol: depositSol > 0 ? (pnlSol / depositSol) * 100 : n(r.pnlPctSol),
    feesSol: n(r.claimedFeesSol),
    depositSol,
    withdrawSol: n(r.withdrawSol),
    pnlQuote,
    pnlPctQuote:
      depositQuote > 0
        ? (pnlQuote / depositQuote) * 100
        : r.pnlPctQuote == null
          ? n(r.pnlPctSol)
          : n(r.pnlPctQuote),
    feesQuote: r.claimedFeesQuote == null ? n(r.claimedFeesSol) : n(r.claimedFeesQuote),
    depositQuote,
    withdrawQuote: r.withdrawQuote == null ? n(r.withdrawSol) : n(r.withdrawQuote),
    openedAt: r.openedAt == null ? null : n(r.openedAt),
    closedAt: r.closedAt == null ? null : n(r.closedAt),
    durationSeconds: r.durationSeconds == null ? null : n(r.durationSeconds),
    minPrice: r.minPrice == null ? undefined : n(r.minPrice),
    maxPrice: r.maxPrice == null ? undefined : n(r.maxPrice),
  };
}
