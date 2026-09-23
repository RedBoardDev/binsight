import type { ClosedPosition, Stats } from '@binsight/shared';
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { ClosedPage, ClosedQuery, PositionQueries } from '@/domain/ports';
import { toFiniteNumber as n } from '@/util/number';
import type { Database } from './database';
import {
  IS_ECONOMIC,
  IS_SOL_QUOTE,
  NATIVE_FEES,
  NATIVE_PNL,
  NATIVE_PNL_PCT,
  PNL,
  rowToClosed,
} from './position-rows';
import { positions as positionsTable } from './schema';

/** Read models over the positions table: closed history, per-position lookups and analytics. */
export class PostgresPositionQueries implements PositionQueries {
  constructor(private readonly db: Database) {}

  async getClosed(wallets: string[], opts: ClosedQuery): Promise<ClosedPage> {
    if (wallets.length === 0) return { rows: [], total: 0 };
    const conds = [eq(positionsTable.status, 'closed'), inArray(positionsTable.wallet, wallets)];
    if (opts.q) {
      // Escape LIKE wildcards (% _ \) so a user's search string is matched literally, never as a pattern.
      const q = `%${opts.q.replace(/[\\%_]/g, '\\$&')}%`;
      const match = or(ilike(positionsTable.tokenX, q), ilike(positionsTable.tokenY, q));
      if (match) conds.push(match);
    }
    if (opts.result === 'win') conds.push(sql`${NATIVE_PNL} > 0`);
    else if (opts.result === 'loss') conds.push(sql`${NATIVE_PNL} < 0`);
    const where = and(...conds);

    const sortCol = {
      recent: positionsTable.closedAt,
      // Across different quotes an absolute amount is not comparable. The existing wire key stays
      // stable, but the cross-quote order is the dimensionless native-quote ROI.
      pnl: NATIVE_PNL_PCT,
      fees: NATIVE_FEES,
      duration: positionsTable.durationSeconds,
    }[opts.sort ?? 'recent'];
    const order = opts.dir === 'asc' ? asc(sortCol) : desc(sortCol);

    const counted = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(positionsTable)
      .where(where);
    const rows = await this.db
      .select()
      .from(positionsTable)
      .where(where)
      .orderBy(order)
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize);
    return { rows: rows.map(rowToClosed), total: Number(counted[0]?.c ?? 0) };
  }

  async getClosedByAddress(positionAddress: string): Promise<ClosedPosition | null> {
    const [r] = await this.db
      .select()
      .from(positionsTable)
      .where(
        and(
          eq(positionsTable.positionAddress, positionAddress),
          eq(positionsTable.status, 'closed'),
        ),
      )
      .limit(1);
    return r ? rowToClosed(r) : null;
  }

  async walletOfPosition(positionAddress: string): Promise<string | null> {
    const [r] = await this.db
      .select({ wallet: positionsTable.wallet })
      .from(positionsTable)
      .where(eq(positionsTable.positionAddress, positionAddress))
      .limit(1);
    return r ? r.wallet : null;
  }

  async statsAggregate(
    wallets: string[],
    sinceMs: number,
  ): Promise<Omit<Stats, 'scope' | 'outsidePositionsPnlSol'>> {
    const empty: Omit<Stats, 'scope' | 'outsidePositionsPnlSol'> = {
      closedCount: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnlSol: 0,
      todayPnlSol: 0,
      totalFeesSol: 0,
      totalVolumeSol: 0,
      avgInvestedSol: 0,
      avgMonthlyProfitSol: 0,
      expectedValueSol: 0,
      profitFactor: 0,
      avgDurationSeconds: 0,
      byPair: [],
    };
    if (wallets.length === 0) return empty;

    // Position-close "today" uses UTC midnight, matching every server-side time bucket.
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const todayStartMs = startOfToday.getTime();
    const where = and(
      eq(positionsTable.status, 'closed'),
      inArray(positionsTable.wallet, wallets),
      IS_ECONOMIC,
      sinceMs > 0 ? gte(positionsTable.closedAt, sinceMs) : undefined,
    );

    // One scalar-aggregate pass — Postgres computes; we transfer ~10 numbers, not the closed rows.
    const [agg] = await this.db
      .select({
        closedCount: sql<number>`count(*)::int`,
        wins: sql<number>`count(*) filter (where ${NATIVE_PNL} > 0)::int`,
        losses: sql<number>`count(*) filter (where ${NATIVE_PNL} < 0)::int`,
        solClosedCount: sql<number>`count(*) filter (where ${IS_SOL_QUOTE})::int`,
        totalPnlSol: sql<number>`coalesce(sum(${PNL}) filter (where ${IS_SOL_QUOTE}), 0)::double precision`,
        todayPnlSol: sql<number>`coalesce(sum(${PNL}) filter (where ${IS_SOL_QUOTE} AND ${positionsTable.closedAt} >= ${todayStartMs}), 0)::double precision`,
        totalFeesSol: sql<number>`coalesce(sum(${positionsTable.claimedFeesSol}) filter (where ${IS_SOL_QUOTE}), 0)::double precision`,
        totalVolumeSol: sql<number>`coalesce(sum(${positionsTable.depositSol}) filter (where ${IS_SOL_QUOTE}), 0)::double precision`,
        grossProfit: sql<number>`coalesce(sum(${PNL}) filter (where ${IS_SOL_QUOTE} AND ${PNL} > 0), 0)::double precision`,
        grossLoss: sql<number>`coalesce(sum(${PNL}) filter (where ${IS_SOL_QUOTE} AND ${PNL} < 0), 0)::double precision`,
        avgDurationSeconds: sql<number>`coalesce(avg(${positionsTable.durationSeconds}), 0)::double precision`,
        minClosedAt: sql<number | null>`min(${positionsTable.closedAt})`,
        maxClosedAt: sql<number | null>`max(${positionsTable.closedAt})`,
      })
      .from(positionsTable)
      .where(where);

    const closedCount = n(agg?.closedCount);
    if (!agg || closedCount === 0) return empty;
    const wins = n(agg.wins);
    const losses = n(agg.losses);
    const totalPnl = n(agg.totalPnlSol);
    const totalVolume = n(agg.totalVolumeSol);
    const solClosedCount = n(agg.solClosedCount);
    const span =
      agg.minClosedAt != null && agg.maxClosedAt != null && closedCount > 1
        ? n(agg.maxClosedAt) - n(agg.minClosedAt)
        : 0;
    const months = Math.max(1, span / (30 * 86_400_000));

    // by-pair breakdown — GROUP BY in SQL, so only the (few hundred) distinct pairs cross the wire.
    const pairRows = await this.db
      .select({
        tokenX: positionsTable.tokenX,
        tokenY: positionsTable.tokenY,
        quoteSymbol: positionsTable.quoteSymbol,
        pnlQuote: sql<number>`coalesce(sum(${NATIVE_PNL}), 0)::double precision`,
        pnlSol: sql<number>`coalesce(sum(${PNL}) filter (where ${IS_SOL_QUOTE}), 0)::double precision`,
        count: sql<number>`count(*)::int`,
      })
      .from(positionsTable)
      .where(where)
      .groupBy(positionsTable.tokenX, positionsTable.tokenY, positionsTable.quoteSymbol)
      .orderBy(positionsTable.quoteSymbol, desc(sql`coalesce(sum(${NATIVE_PNL}), 0)`));
    const allPairs = pairRows.map((r) => ({
      pair: `${r.tokenX}/${r.tokenY}`,
      pnlSol: n(r.pnlSol),
      pnlQuote: n(r.pnlQuote),
      quoteSymbol: r.quoteSymbol ?? String(r.tokenY),
      count: n(r.count),
    }));
    // The UI shows only the best/worst handful; cap the payload to the extremes of the ranked list
    // (ordered best→worst) instead of shipping every distinct pair to every viewer.
    const byPair =
      allPairs.length > 40 ? [...allPairs.slice(0, 20), ...allPairs.slice(-20)] : allPairs;

    return {
      closedCount,
      wins,
      losses,
      // win rate over DECISIVE trades only — a break-even (PnL exactly 0, reachable for un-enriched
      // closes) is neither a win nor a loss, so it must not be counted as a loss nor dilute the rate.
      winRate: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0,
      totalPnlSol: totalPnl,
      todayPnlSol: n(agg.todayPnlSol),
      totalFeesSol: n(agg.totalFeesSol),
      totalVolumeSol: totalVolume,
      avgInvestedSol: solClosedCount > 0 ? totalVolume / solClosedCount : 0,
      avgMonthlyProfitSol: totalPnl / months,
      expectedValueSol: solClosedCount > 0 ? totalPnl / solClosedCount : 0,
      // gross profit ÷ gross loss; 0 when there are no losing trades (shown as "—").
      profitFactor: n(agg.grossLoss) < 0 ? n(agg.grossProfit) / Math.abs(n(agg.grossLoss)) : 0,
      avgDurationSeconds: n(agg.avgDurationSeconds),
      byPair,
    };
  }

  async profitBuckets(
    wallets: string[],
    bucketMs: number,
  ): Promise<{ t: number; realized: number }[]> {
    if (wallets.length === 0) return [];
    // The bucket expression appears only in SELECT; GROUP BY/ORDER BY reference it by ordinal (1) so
    // Postgres doesn't see three separately-parameterised copies (which fails with "must appear in GROUP BY").
    const bucket = sql<number>`(floor(${positionsTable.closedAt}::double precision / ${bucketMs}) * ${bucketMs})::bigint`;
    const rows = await this.db
      .select({ t: bucket, realized: sql<number>`coalesce(sum(${PNL}), 0)::double precision` })
      .from(positionsTable)
      .where(
        and(
          eq(positionsTable.status, 'closed'),
          inArray(positionsTable.wallet, wallets),
          isNotNull(positionsTable.closedAt),
          IS_ECONOMIC,
          IS_SOL_QUOTE,
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    return rows.map((r) => ({ t: n(r.t), realized: n(r.realized) }));
  }
}
