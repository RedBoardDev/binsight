import type {
  ClosedPosition,
  OpenPosition,
  RangeStatus,
  Stats,
  StrategyFamily,
} from '@binsight/shared';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { PositionEconomics } from '@/domain/dlmm';
import type { PoolRef, PositionRepository } from '@/domain/ports';
import { toFiniteNumber as n } from '@/util/number';
import type { Database } from './database';
import { positions as positionsTable } from './schema';

// A close stays mutable for this long after closed_at so the Meteora indexer can settle the
// withdrawal/fees figures; after that the financials are frozen and the periodic resync no
// longer re-marks them. Must stay LARGER than the engine's CLOSE_SETTLE_MS (which fires the
// notification): the notification is sent on a value still inside this window, so what the user
// is told matches the figure that ultimately freezes.
const SETTLE_MS = 150_000;

// Insert in batches so a large backfill (thousands of closed positions × ~19 columns) never exceeds
// Postgres's 65535 bind-parameter limit — a single oversized insert fails the whole reconcile.
const INSERT_CHUNK = 500;

// Effective realized PnL = market reprice when present, else the raw pool mark.
const PNL = sql<number>`coalesce(${positionsTable.marketPnlSol}, ${positionsTable.pnlSol})`;
const IS_SOL_QUOTE = sql`(${positionsTable.quoteSymbol} = 'SOL' OR ${positionsTable.quoteSymbol} IS NULL)`;
// A SOL position may have an authoritative market reprice. Its native quote is SOL, so that override
// must win over pnl_quote too. Non-SOL positions use only their own quote and are never relabelled SOL.
const NATIVE_PNL = sql<number>`case when ${IS_SOL_QUOTE} then ${PNL} else coalesce(${positionsTable.pnlQuote}, 0) end`;
const NATIVE_PNL_PCT = sql<number>`case
  when ${IS_SOL_QUOTE} and ${positionsTable.depositSol} > 0
    then (${PNL} / ${positionsTable.depositSol}) * 100
  when ${IS_SOL_QUOTE} then ${positionsTable.pnlPctSol}
  else coalesce(${positionsTable.pnlPctQuote}, 0)
end`;
const NATIVE_FEES = sql<number>`case when ${IS_SOL_QUOTE} then ${positionsTable.claimedFeesSol} else coalesce(${positionsTable.claimedFeesQuote}, 0) end`;
const IS_ECONOMIC = sql`coalesce(${positionsTable.economicStatus}, 'funded') <> 'empty_shell'`;

type Row = typeof positionsTable.$inferSelect;

/** Postgres-backed position store (Drizzle). All writes are idempotent upserts by primary key. */
export class PostgresPositionRepository implements PositionRepository {
  constructor(private readonly db: Database) {}

  private openRow(p: OpenPosition, now = p.updatedAt) {
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
      updatedAt: now,
    };
  }

  async upsertClosed(positions: ClosedPosition[]): Promise<void> {
    if (positions.length === 0) return;
    const now = Date.now();
    const rows = positions.map((p) => ({
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
      marketPnlSol: p.pnlSource === 'market' ? p.pnlSol : null,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
      durationSeconds: p.durationSeconds,
      updatedAt: now,
    }));
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const batch = rows.slice(i, i + INSERT_CHUNK);
      await this.db.transaction(async (tx) => {
        await tx
          .insert(positionsTable)
          .values(batch)
          .onConflictDoUpdate({
            target: positionsTable.positionAddress,
            set: {
              status: sql`'closed'`,
              tokenXMint: sql`excluded.token_x_mint`,
              tokenYMint: sql`excluded.token_y_mint`,
              quoteMint: sql`excluded.quote_mint`,
              quoteSymbol: sql`excluded.quote_symbol`,
              quoteDecimals: sql`excluded.quote_decimals`,
              quoteSide: sql`excluded.quote_side`,
              valuationStatus: sql`excluded.valuation_status`,
              economicStatus: sql`excluded.economic_status`,
              tokenXIcon: sql`excluded.token_x_icon`,
              tokenYIcon: sql`excluded.token_y_icon`,
              pnlSol: sql`excluded.pnl_sol`,
              pnlPctSol: sql`excluded.pnl_pct_sol`,
              depositSol: sql`excluded.deposit_sol`,
              withdrawSol: sql`excluded.withdraw_sol`,
              claimedFeesSol: sql`excluded.claimed_fees_sol`,
              pnlQuote: sql`excluded.pnl_quote`,
              pnlPctQuote: sql`excluded.pnl_pct_quote`,
              depositQuote: sql`excluded.deposit_quote`,
              withdrawQuote: sql`excluded.withdraw_quote`,
              claimedFeesQuote: sql`excluded.claimed_fees_quote`,
              closedAt: sql`excluded.closed_at`,
              durationSeconds: sql`excluded.duration_seconds`,
              updatedAt: sql`excluded.updated_at`,
              // keep an existing market reprice; the periodic pool-price resync passes null here.
              marketPnlSol: sql`coalesce(excluded.market_pnl_sol, ${positionsTable.marketPnlSol})`,
            },
            // Freeze the realized figures once the close has settled: allow the first close write
            // (status still 'open'/'pending_close') and any re-mark within SETTLE_MS of closed_at.
            setWhere: sql`${positionsTable.status} <> 'closed' OR excluded.updated_at - coalesce(${positionsTable.closedAt}, 0) < ${SETTLE_MS}`,
          });
        // Historical SOL financials deliberately freeze after settlement, but quote identity and the
        // native USDC/USDT projection are independently correctable facts. A second conflict pass in
        // the same transaction lets the on-chain reprojector repair old rows without reopening the
        // settled SOL figures or clobbering market_pnl_sol.
        await tx
          .insert(positionsTable)
          .values(batch)
          .onConflictDoUpdate({
            target: positionsTable.positionAddress,
            set: {
              tokenX: sql`excluded.token_x`,
              tokenY: sql`excluded.token_y`,
              tokenXMint: sql`excluded.token_x_mint`,
              tokenYMint: sql`excluded.token_y_mint`,
              quoteMint: sql`excluded.quote_mint`,
              quoteSymbol: sql`excluded.quote_symbol`,
              quoteDecimals: sql`excluded.quote_decimals`,
              quoteSide: sql`excluded.quote_side`,
              valuationStatus: sql`excluded.valuation_status`,
              economicStatus: sql`excluded.economic_status`,
              tokenXIcon: sql`excluded.token_x_icon`,
              tokenYIcon: sql`excluded.token_y_icon`,
              pnlQuote: sql`excluded.pnl_quote`,
              pnlPctQuote: sql`excluded.pnl_pct_quote`,
              depositQuote: sql`excluded.deposit_quote`,
              withdrawQuote: sql`excluded.withdraw_quote`,
              claimedFeesQuote: sql`excluded.claimed_fees_quote`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
      });
    }
  }

  async replaceOpenForWallet(wallet: string, positions: OpenPosition[]): Promise<void> {
    const keep = positions.map((p) => p.positionAddress);
    await this.db.transaction(async (tx) => {
      if (positions.length > 0) {
        await tx
          .insert(positionsTable)
          .values(positions.map((p) => this.openRow(p)))
          .onConflictDoUpdate({
            target: positionsTable.positionAddress,
            set: {
              status: sql`'open'`,
              tokenXMint: sql`excluded.token_x_mint`,
              tokenYMint: sql`excluded.token_y_mint`,
              quoteMint: sql`excluded.quote_mint`,
              quoteSymbol: sql`excluded.quote_symbol`,
              quoteDecimals: sql`excluded.quote_decimals`,
              quoteSide: sql`excluded.quote_side`,
              valuationStatus: sql`excluded.valuation_status`,
              economicStatus: sql`excluded.economic_status`,
              tokenXIcon: sql`excluded.token_x_icon`,
              tokenYIcon: sql`excluded.token_y_icon`,
              pnlSol: sql`excluded.pnl_sol`,
              pnlPctSol: sql`excluded.pnl_pct_sol`,
              sizeSol: sql`excluded.size_sol`,
              claimedFeesSol: sql`excluded.claimed_fees_sol`,
              unclaimedFeesSol: sql`excluded.unclaimed_fees_sol`,
              pnlQuote: sql`excluded.pnl_quote`,
              pnlPctQuote: sql`excluded.pnl_pct_quote`,
              sizeQuote: sql`excluded.size_quote`,
              claimedFeesQuote: sql`excluded.claimed_fees_quote`,
              unclaimedFeesQuote: sql`excluded.unclaimed_fees_quote`,
              minPrice: sql`excluded.min_price`,
              maxPrice: sql`excluded.max_price`,
              poolPrice: sql`excluded.pool_price`,
              rangeStatus: sql`excluded.range_status`,
              oorSince: sql`excluded.oor_since`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
      }
      // Positions previously open for this wallet but no longer present: mark for reconciliation
      // (status stays until the close is confirmed & fetched). Set-based, single statement.
      await tx
        .update(positionsTable)
        .set({ status: 'pending_close', updatedAt: Date.now() })
        .where(
          and(
            eq(positionsTable.wallet, wallet),
            eq(positionsTable.status, 'open'),
            keep.length > 0 ? notInArray(positionsTable.positionAddress, keep) : undefined,
          ),
        );
    });
  }

  async getOpen(wallet: string): Promise<OpenPosition[]> {
    const rows = await this.db
      .select()
      .from(positionsTable)
      .where(and(eq(positionsTable.wallet, wallet), eq(positionsTable.status, 'open')))
      .orderBy(desc(positionsTable.pnlSol));
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
      .from(positionsTable)
      .where(
        and(
          eq(positionsTable.wallet, wallet),
          inArray(positionsTable.status, ['open', 'pending_close']),
        ),
      )
      .orderBy(desc(positionsTable.pnlSol));
    return rows.map(rowToOpen);
  }

  async positionStatusForWallet(
    wallet: string,
  ): Promise<Map<string, { status: string; closedAt: number | null }>> {
    const rows = await this.db
      .select({
        a: positionsTable.positionAddress,
        s: positionsTable.status,
        c: positionsTable.closedAt,
      })
      .from(positionsTable)
      .where(eq(positionsTable.wallet, wallet));
    return new Map(rows.map((r) => [r.a, { status: r.s, closedAt: r.c }]));
  }

  async getClosed(
    wallets: string[],
    opts: {
      page: number;
      pageSize: number;
      q?: string;
      sort?: 'recent' | 'pnl' | 'fees' | 'duration';
      dir?: 'asc' | 'desc';
      result?: 'all' | 'win' | 'loss';
    },
  ): Promise<{ rows: ClosedPosition[]; total: number }> {
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

  async pendingClosePools(wallet: string): Promise<PoolRef[]> {
    const rows = await this.db
      .selectDistinct({
        poolAddress: positionsTable.poolAddress,
        tokenX: positionsTable.tokenX,
        tokenY: positionsTable.tokenY,
        tokenXMint: positionsTable.tokenXMint,
        tokenYMint: positionsTable.tokenYMint,
        tokenXIcon: positionsTable.tokenXIcon,
        tokenYIcon: positionsTable.tokenYIcon,
      })
      .from(positionsTable)
      .where(and(eq(positionsTable.wallet, wallet), eq(positionsTable.status, 'pending_close')));
    return rows.map((r) => ({
      poolAddress: r.poolAddress,
      tokenX: r.tokenX ?? '?',
      tokenY: r.tokenY ?? 'SOL',
      tokenXMint: r.tokenXMint ?? '',
      tokenXIcon: r.tokenXIcon ?? undefined,
      tokenYIcon: r.tokenYIcon ?? undefined,
      tokenYMint: r.tokenYMint ?? '',
    }));
  }

  /**
   * Closed positions to rebuild PURELY on-chain. Default: only the ones Meteora can't price (pnl=0,
   * never enriched). `all: true` returns EVERY closed position — Meteora's datapi has corrupt values
   * (e.g. deposit=0 → bogus +PnL), so a full on-chain rebuild is the only fully-trustworthy source.
   */
  async onchainCandidates(
    wallet: string,
    opts: { all?: boolean } = {},
  ): Promise<{ positionAddress: string; mint: string; closedAt: number }[]> {
    const conds = [
      eq(positionsTable.wallet, wallet),
      eq(positionsTable.status, 'closed'),
      isNotNull(positionsTable.closedAt),
    ];
    if (!opts.all) {
      conds.push(isNull(positionsTable.marketPnlSol), eq(positionsTable.pnlSol, 0));
    }
    // This residual reprice path is SOL-denominated. USDC positions have their own authoritative
    // native-quote projection and must not be misrouted through a token→SOL FIFO repair.
    conds.push(IS_SOL_QUOTE);
    const rows = await this.db
      .select({
        a: positionsTable.positionAddress,
        m: positionsTable.tokenXMint,
        c: positionsTable.closedAt,
      })
      .from(positionsTable)
      .where(and(...conds));
    return rows
      .filter((r) => r.m && r.c != null)
      .map((r) => ({ positionAddress: r.a, mint: r.m as string, closedAt: r.c as number }));
  }

  async setAuthoritativePnl(positionAddress: string, pnlSol: number): Promise<void> {
    await this.db
      .update(positionsTable)
      .set({ marketPnlSol: pnlSol })
      .where(
        and(
          eq(positionsTable.positionAddress, positionAddress),
          eq(positionsTable.status, 'closed'),
        ),
      );
  }

  /** Persist market_pnl_sol for many closed positions in ONE atomic statement (UPDATE … FROM VALUES) —
   *  same effect as setAuthoritativePnl per entry, but a mid-loop crash can't leave mixed generations
   *  and it's a single write, not N. */
  async setAuthoritativePnlMany(byPosition: Map<string, number>): Promise<void> {
    if (byPosition.size === 0) return;
    const rows = [...byPosition].map(([addr, pnl]) => sql`(${addr}, ${pnl}::double precision)`);
    await this.db.execute(sql`
      update ${positionsTable} as p
      set market_pnl_sol = v.pnl
      from (values ${sql.join(rows, sql`, `)}) as v(address, pnl)
      where p.position_address = v.address and p.status = 'closed'
    `);
  }

  async closedEconomicsForWallet(wallet: string): Promise<Map<string, PositionEconomics>> {
    const rows = await this.db
      .select({
        a: positionsTable.positionAddress,
        d: positionsTable.depositSol,
        w: positionsTable.withdrawSol,
        f: positionsTable.claimedFeesSol,
        p: positionsTable.pnlSol,
      })
      .from(positionsTable)
      .where(and(eq(positionsTable.wallet, wallet), eq(positionsTable.status, 'closed')));
    return new Map(
      rows.map((r) => [
        r.a,
        { depositSol: n(r.d), withdrawSol: n(r.w), claimedFeesSol: n(r.f), pnlSol: n(r.p) },
      ]),
    );
  }

  async repairClosedEconomicsMany(byPosition: Map<string, PositionEconomics>): Promise<void> {
    if (byPosition.size === 0) return;
    // Plain UPDATE … FROM (VALUES …) — a deliberate ground-truth rewrite of the four legs-derived
    // columns. Unlike upsertClosed it has NO settle-freeze setWhere, so it corrects rows frozen past
    // SETTLE_MS; the status='closed' guard keeps it off open positions, and market_pnl_sol is untouched.
    const values = [...byPosition].map(
      ([addr, e]) =>
        sql`(${addr}, ${e.depositSol}::double precision, ${e.withdrawSol}::double precision, ${e.claimedFeesSol}::double precision, ${e.pnlSol}::double precision)`,
    );
    await this.db.execute(sql`
      update ${positionsTable} as p
      set deposit_sol = v.deposit, withdraw_sol = v.withdraw, claimed_fees_sol = v.claimed, pnl_sol = v.pnl
      from (values ${sql.join(values, sql`, `)}) as v(address, deposit, withdraw, claimed, pnl)
      where p.position_address = v.address and p.status = 'closed'
    `);
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

  async setStrategy(positionAddress: string, family: StrategyFamily): Promise<void> {
    await this.db
      .update(positionsTable)
      .set({ strategy: family })
      .where(eq(positionsTable.positionAddress, positionAddress));
  }

  async getStrategies(wallet?: string): Promise<Map<string, StrategyFamily>> {
    // Scope to one wallet on the hot per-sync path (idx_positions_wallet) instead of scanning the whole
    // positions table; no wallet = the full set (boot-time StrategyService cache seed).
    const rows = await this.db
      .select({ a: positionsTable.positionAddress, s: positionsTable.strategy })
      .from(positionsTable)
      .where(
        and(
          sql`${positionsTable.strategy} is not null`,
          wallet ? eq(positionsTable.wallet, wallet) : undefined,
        ),
      );
    return new Map(rows.map((r) => [r.a, r.s as StrategyFamily]));
  }

  async addressesMissingStrategy(limit: number): Promise<string[]> {
    // OPEN positions missing their strategy ONLY. Strategy is resolved from the position's open tx
    // (an expensive getParsedTransaction), then persisted and travels with the position into closed
    // history — so resolving it WHILE the position is open is the cheap, correct moment. We deliberately
    // do NOT bulk-backfill the closed-history tail: a wallet can hold tens of thousands of closed
    // positions, and re-paging each one's open tx burned millions of getParsedTransaction credits just
    // to label already-closed rows. A historical closed position simply shows no strategy badge.
    const rows = await this.db
      .select({ a: positionsTable.positionAddress })
      .from(positionsTable)
      .where(and(isNull(positionsTable.strategy), eq(positionsTable.status, 'open')))
      .orderBy(desc(positionsTable.openedAt))
      .limit(limit);
    return rows.map((r) => r.a);
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

function rowToOpen(r: Row): OpenPosition {
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

function rowToClosed(r: Row): ClosedPosition {
  // Effective PnL = market-valued PnL when enriched (stored in market_pnl_sol), else Meteora's raw
  // pool mark as the fallback until the market value arrives.
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
    // Percent points (e.g. 1.89 == +1.89%) — same unit as Meteora's pnlSolPctChange and the open
    // side, so the UI's percent formatting and colour thresholds read it correctly.
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
    pnlSource: market != null ? 'market' : 'pool',
  };
}
