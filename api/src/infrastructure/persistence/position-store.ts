import type { ClosedPosition, OpenPosition, StrategyFamily } from '@binsight/shared';
import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { PositionStore } from '@/domain/ports';
import type { Database } from './database';
import {
  closedRow,
  fromExcluded,
  keepKnownIcon,
  keepKnownLabel,
  openRow,
  rowToOpen,
} from './position-rows';
import { positions as positionsTable } from './schema';

// Batched writes keep a large backfill (thousands of rows × ~30 columns) under Postgres's 65 535
// bind-parameter limit.
const WRITE_CHUNK = 500;

const t = positionsTable;

/** Pair labels are refreshed on every write, but never downgraded to a placeholder. */
const LABELS = {
  tokenX: keepKnownLabel(t.tokenX),
  tokenY: keepKnownLabel(t.tokenY),
  quoteSymbol: keepKnownLabel(t.quoteSymbol),
  tokenXIcon: keepKnownIcon(t.tokenXIcon),
  tokenYIcon: keepKnownIcon(t.tokenYIcon),
};

const IDENTITY = fromExcluded({
  tokenXMint: t.tokenXMint,
  tokenYMint: t.tokenYMint,
  quoteMint: t.quoteMint,
  quoteDecimals: t.quoteDecimals,
  quoteSide: t.quoteSide,
  valuationStatus: t.valuationStatus,
  economicStatus: t.economicStatus,
});

const CLOSED_FIGURES = fromExcluded({
  pnlSol: t.pnlSol,
  pnlPctSol: t.pnlPctSol,
  depositSol: t.depositSol,
  withdrawSol: t.withdrawSol,
  claimedFeesSol: t.claimedFeesSol,
  pnlQuote: t.pnlQuote,
  pnlPctQuote: t.pnlPctQuote,
  depositQuote: t.depositQuote,
  withdrawQuote: t.withdrawQuote,
  claimedFeesQuote: t.claimedFeesQuote,
  openedAt: t.openedAt,
  closedAt: t.closedAt,
  durationSeconds: t.durationSeconds,
});

const OPEN_FIGURES = fromExcluded({
  pnlSol: t.pnlSol,
  pnlPctSol: t.pnlPctSol,
  sizeSol: t.sizeSol,
  claimedFeesSol: t.claimedFeesSol,
  unclaimedFeesSol: t.unclaimedFeesSol,
  pnlQuote: t.pnlQuote,
  pnlPctQuote: t.pnlPctQuote,
  sizeQuote: t.sizeQuote,
  claimedFeesQuote: t.claimedFeesQuote,
  unclaimedFeesQuote: t.unclaimedFeesQuote,
  minPrice: t.minPrice,
  maxPrice: t.maxPrice,
  poolPrice: t.poolPrice,
  rangeStatus: t.rangeStatus,
  oorSince: t.oorSince,
});

/**
 * A closed row is rewritten only when a figure actually differs. Every closed figure is derived from
 * the position's on-chain legs, so a reprojection that learned nothing new is a no-op instead of a
 * rewrite of the wallet's entire history (it used to rewrite ~15k rows on every ingest).
 */
// Labels are compared as they WOULD be written (a placeholder never replaces a known label), or a row
// whose incoming symbol is a placeholder would be rewritten on every pass for nothing.
const CLOSED_CHANGED = sql`(${t.status}, ${t.tokenX}, ${t.tokenY}, ${t.quoteSymbol}, ${t.tokenXIcon}, ${t.tokenYIcon}, ${t.pnlSol}, ${t.depositSol}, ${t.withdrawSol}, ${t.claimedFeesSol}, ${t.pnlQuote}, ${t.depositQuote}, ${t.withdrawQuote}, ${t.claimedFeesQuote}, ${t.openedAt}, ${t.closedAt}, ${t.valuationStatus}, ${t.economicStatus})
  is distinct from
  ('closed', ${LABELS.tokenX}, ${LABELS.tokenY}, ${LABELS.quoteSymbol}, ${LABELS.tokenXIcon}, ${LABELS.tokenYIcon}, excluded.pnl_sol, excluded.deposit_sol, excluded.withdraw_sol, excluded.claimed_fees_sol, excluded.pnl_quote, excluded.deposit_quote, excluded.withdraw_quote, excluded.claimed_fees_quote, excluded.opened_at, excluded.closed_at, excluded.valuation_status, excluded.economic_status)`;

/** Postgres-backed position store (Drizzle): the write side the projection and the realized-PnL pass
 *  use. All writes are idempotent upserts by primary key. */
export class PostgresPositionStore implements PositionStore {
  constructor(private readonly db: Database) {}

  async upsertClosed(positions: ClosedPosition[]): Promise<void> {
    if (positions.length === 0) return;
    const now = Date.now();
    const rows = positions.map((p) => closedRow(p, now));
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      await this.db
        .insert(t)
        .values(rows.slice(i, i + WRITE_CHUNK))
        .onConflictDoUpdate({
          target: t.positionAddress,
          set: {
            status: sql`'closed'`,
            ...LABELS,
            ...IDENTITY,
            ...CLOSED_FIGURES,
            updatedAt: sql`excluded.updated_at`,
            // market_pnl_sol is the realized-PnL pass's column; the projection never writes it.
          },
          setWhere: CLOSED_CHANGED,
        });
    }
  }

  async replaceOpenForWallet(
    wallet: string,
    positions: OpenPosition[],
    stillOpen: string[] = [],
  ): Promise<void> {
    const keep = [...positions.map((p) => p.positionAddress), ...stillOpen];
    await this.db.transaction(async (tx) => {
      for (let i = 0; i < positions.length; i += WRITE_CHUNK) {
        await tx
          .insert(t)
          .values(positions.slice(i, i + WRITE_CHUNK).map(openRow))
          .onConflictDoUpdate({
            target: t.positionAddress,
            set: {
              status: sql`'open'`,
              ...LABELS,
              ...IDENTITY,
              ...OPEN_FIGURES,
              updatedAt: sql`excluded.updated_at`,
            },
            // A closed position account can never reopen: an open write for it is always stale.
            setWhere: sql`${t.status} <> 'closed'`,
          });
      }
      // Positions previously open for this wallet but no longer on-chain wait in 'pending_close' until
      // the sync that projects their close. Set-based, single statement.
      await tx
        .update(t)
        .set({ status: 'pending_close', updatedAt: Date.now() })
        .where(
          and(
            eq(t.wallet, wallet),
            eq(t.status, 'open'),
            keep.length > 0 ? notInArray(t.positionAddress, keep) : undefined,
          ),
        );
    });
  }

  async getOpen(wallet: string): Promise<OpenPosition[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.wallet, wallet), eq(t.status, 'open')))
      .orderBy(desc(t.pnlSol));
    return rows.map(rowToOpen);
  }

  async getOpenOrPendingClose(wallet: string): Promise<OpenPosition[]> {
    // 'pending_close' = a position that disappeared from the on-chain open set but whose close hasn't
    // been fetched/reprojected yet. It's still logically an OPEN position for the purpose of detecting the
    // open→closed transition that fires a close notification: if the cadence refreshOpen marks it
    // pending_close BEFORE the ingest-triggered sync computes the prior-open set, a plain `getOpen` (which
    // filters to 'open' only) would drop it and the sync would never emit `closed` — a silently-lost push.
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.wallet, wallet), inArray(t.status, ['open', 'pending_close'])))
      .orderBy(desc(t.pnlSol));
    return rows.map(rowToOpen);
  }

  async positionStatusForWallet(
    wallet: string,
  ): Promise<Map<string, { status: string; closedAt: number | null }>> {
    const rows = await this.db
      .select({
        a: t.positionAddress,
        s: t.status,
        c: t.closedAt,
      })
      .from(t)
      .where(eq(t.wallet, wallet));
    return new Map(rows.map((r) => [r.a, { status: r.s, closedAt: r.c }]));
  }

  /** Persist the realized-PnL pass's market_pnl_sol for many closed positions. Only rows whose value
   *  changed are written; returns how many did. Chunked: two bind parameters per row. */
  async setAuthoritativePnlMany(byPosition: Map<string, number>): Promise<number> {
    const entries = [...byPosition];
    let changed = 0;
    for (let i = 0; i < entries.length; i += WRITE_CHUNK * 10) {
      const rows = entries
        .slice(i, i + WRITE_CHUNK * 10)
        .map(([addr, pnl]) => sql`(${addr}, ${pnl}::double precision)`);
      const res = await this.db.execute(sql`
        update ${t} as p
        set market_pnl_sol = v.pnl
        from (values ${sql.join(rows, sql`, `)}) as v(address, pnl)
        where p.position_address = v.address and p.status = 'closed'
          and p.market_pnl_sol is distinct from v.pnl
      `);
      changed += affectedRows(res);
    }
    return changed;
  }

  async setStrategy(positionAddress: string, family: StrategyFamily): Promise<void> {
    await this.db
      .update(positionsTable)
      .set({ strategy: family })
      .where(eq(t.positionAddress, positionAddress));
  }

  /** Strategy family of each given position that has one (primary-key lookups). */
  async strategiesOf(positions: string[]): Promise<Map<string, StrategyFamily>> {
    const out = new Map<string, StrategyFamily>();
    for (let i = 0; i < positions.length; i += WRITE_CHUNK * 10) {
      const rows = await this.db
        .select({ a: t.positionAddress, s: t.strategy })
        .from(t)
        .where(inArray(t.positionAddress, positions.slice(i, i + WRITE_CHUNK * 10)));
      for (const r of rows) if (r.s) out.set(r.a, r.s as StrategyFamily);
    }
    return out;
  }

  async addressesMissingStrategy(limit: number): Promise<string[]> {
    // OPEN positions missing their strategy ONLY. Strategy is resolved from the position's open tx
    // (an expensive getParsedTransaction), then persisted and travels with the position into closed
    // history — so resolving it WHILE the position is open is the cheap, correct moment. We deliberately
    // do NOT bulk-backfill the closed-history tail: a wallet can hold tens of thousands of closed
    // positions, and re-paging each one's open tx burned millions of getParsedTransaction credits just
    // to label already-closed rows. A historical closed position simply shows no strategy badge.
    const rows = await this.db
      .select({ a: t.positionAddress })
      .from(t)
      .where(and(isNull(t.strategy), eq(t.status, 'open')))
      .orderBy(desc(t.openedAt))
      .limit(limit);
    return rows.map((r) => r.a);
  }
}

/** Rows touched by an UPDATE, across the postgres.js and PGlite drivers. */
function affectedRows(res: unknown): number {
  const r = res as { count?: number; affectedRows?: number };
  return Number(r.count ?? r.affectedRows ?? 0);
}
