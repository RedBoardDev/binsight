import type { ClosedPosition } from '@binsight/shared';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from './database';
import { PostgresPositionQueries } from './position-queries';
import { PostgresPositionStore } from './position-store';
import * as schema from './schema';

const base: Omit<ClosedPosition, 'positionAddress' | 'pnlSol'> = {
  wallet: 'w',
  poolAddress: 'p',
  tokenX: 'MEME',
  tokenY: 'SOL',
  tokenXMint: 'mint',
  strategy: null,
  pnlPctSol: 0,
  feesSol: 0,
  depositSol: 10,
  withdrawSol: 9,
  openedAt: 1,
  closedAt: 2,
  durationSeconds: 1,
};

// Fresh in-memory Postgres (PGlite) per test, with the real Drizzle migrations applied.
async function setup() {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  const d = db as unknown as Database;
  return { store: new PostgresPositionStore(d), queries: new PostgresPositionQueries(d) };
}

const DAY = 86_400_000;

describe('PostgresPositionQueries — closed reads', () => {
  it('effective PnL is the FIFO market figure when present, else the legs pool mark', async () => {
    const { store, queries } = await setup();
    await store.upsertClosed([
      { ...base, positionAddress: 'A', pnlSol: -0.01 },
      { ...base, positionAddress: 'B', pnlSol: -0.028 },
    ]);
    await store.setAuthoritativePnlMany(new Map([['A', -0.19]]));
    expect((await queries.getClosedByAddress('A'))?.pnlSol).toBeCloseTo(-0.19);
    expect((await queries.getClosedByAddress('B'))?.pnlSol).toBeCloseTo(-0.028);
  });

  it('getClosedByAddress ignores open rows; walletOfPosition finds any row', async () => {
    const { store, queries } = await setup();
    await store.replaceOpenForWallet('w', [
      {
        wallet: 'w',
        positionAddress: 'O',
        poolAddress: 'p',
        tokenX: 'MEME',
        tokenY: 'SOL',
        tokenXMint: 'mint',
        strategy: null,
        sizeSol: 1,
        pnlSol: 0,
        pnlPctSol: 0,
        claimedFeesSol: 0,
        unclaimedFeesSol: 0,
        rangeStatus: 'in',
        minPrice: 0,
        maxPrice: 0,
        poolPrice: null,
        outOfRangeSince: null,
        openedAt: 1,
        updatedAt: 1,
      },
    ]);
    expect(await queries.getClosedByAddress('O')).toBeNull();
    expect(await queries.walletOfPosition('O')).toBe('w');
    expect(await queries.walletOfPosition('nope')).toBeNull();
  });

  it('getClosed pages, filters by result and matches the search literally', async () => {
    const { store, queries } = await setup();
    await store.upsertClosed([
      { ...base, positionAddress: 'W', tokenX: 'WIN', pnlSol: 1, closedAt: 3 },
      { ...base, positionAddress: 'L', tokenX: 'LOSS', pnlSol: -1, closedAt: 2 },
      { ...base, positionAddress: 'P', tokenX: '50%OFF', pnlSol: 0.5, closedAt: 1 },
    ]);
    const all = await queries.getClosed(['w'], { page: 1, pageSize: 2 });
    expect(all.total).toBe(3);
    expect(all.rows.map((r) => r.positionAddress)).toEqual(['W', 'L']); // recent first
    expect((await queries.getClosed(['w'], { page: 2, pageSize: 2 })).rows).toHaveLength(1);
    const wins = await queries.getClosed(['w'], { page: 1, pageSize: 10, result: 'win' });
    expect(wins.rows.map((r) => r.positionAddress).sort()).toEqual(['P', 'W']);
    // "%" is a LIKE wildcard; a user search for it must match literally, not everything.
    const pct = await queries.getClosed(['w'], { page: 1, pageSize: 10, q: '%' });
    expect(pct.rows.map((r) => r.positionAddress)).toEqual(['P']);
    expect(await queries.getClosed([], { page: 1, pageSize: 10 })).toEqual({ rows: [], total: 0 });
  });
});

describe('PostgresPositionQueries — statsAggregate (SQL, no row transfer)', () => {
  it('aggregates scalars + byPair in SQL', async () => {
    const { store, queries } = await setup();
    await store.upsertClosed([
      {
        ...base,
        positionAddress: 'A',
        pnlSol: 2,
        feesSol: 0.1,
        depositSol: 10,
        durationSeconds: 100,
        closedAt: DAY,
        tokenX: 'AAA',
      },
      {
        ...base,
        positionAddress: 'B',
        pnlSol: -1,
        feesSol: 0.2,
        depositSol: 20,
        durationSeconds: 300,
        closedAt: 2 * DAY,
        tokenX: 'AAA',
      },
      {
        ...base,
        positionAddress: 'C',
        pnlSol: 5,
        feesSol: 0,
        depositSol: 5,
        durationSeconds: 200,
        closedAt: 3 * DAY,
        tokenX: 'BBB',
      },
    ]);
    const s = await queries.statsAggregate(['w'], 0);
    expect(s.closedCount).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBeCloseTo((2 / 3) * 100, 6);
    expect(s.totalPnlSol).toBeCloseTo(6);
    expect(s.totalFeesSol).toBeCloseTo(0.3);
    expect(s.totalVolumeSol).toBeCloseTo(35);
    expect(s.avgInvestedSol).toBeCloseTo(35 / 3);
    expect(s.expectedValueSol).toBeCloseTo(2);
    expect(s.avgDurationSeconds).toBeCloseTo(200);
    // best→worst by pnl: BBB/SOL (+5, 1) then AAA/SOL (+2−1=+1, 2)
    expect(s.byPair).toEqual([
      { pair: 'BBB/SOL', pnlSol: 5, pnlQuote: 5, quoteSymbol: 'SOL', count: 1 },
      { pair: 'AAA/SOL', pnlSol: 1, pnlQuote: 1, quoteSymbol: 'SOL', count: 2 },
    ]);
  });

  it('uses native-quote sign for win/loss, excludes shells, and keeps SOL totals SOL-only', async () => {
    const { store, queries } = await setup();
    await store.upsertClosed([
      {
        ...base,
        positionAddress: 'SOL-WIN',
        pnlSol: 2,
        pnlQuote: 2,
        quoteSymbol: 'SOL',
        depositQuote: 10,
        economicStatus: 'funded',
      },
      {
        // A USDC loss whose SOL columns are all zero: only the native quote can decide win/loss, and
        // its magnitude must never be added to a SOL total.
        ...base,
        positionAddress: 'USDC-LOSS',
        tokenY: 'USDC',
        pnlSol: 0,
        depositSol: 0,
        withdrawSol: 0,
        pnlQuote: -22.298172993001714,
        pnlPctQuote: -2.688659,
        depositQuote: 829.3420988217779,
        withdrawQuote: 807.0439258287761,
        quoteSymbol: 'USDC',
        economicStatus: 'funded',
      },
      {
        // A position that never held liquidity is not a trade and must not dilute the win rate.
        ...base,
        positionAddress: 'SHELL',
        pnlSol: 0,
        pnlQuote: 0,
        depositSol: 0,
        depositQuote: 0,
        quoteSymbol: 'USDC',
        economicStatus: 'empty_shell',
      },
    ]);
    const s = await queries.statsAggregate(['w'], 0);
    expect(s.closedCount).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBe(50);
    expect(s.totalPnlSol).toBe(2); // the USDC loss is NOT subtracted from a SOL figure
    expect(s.totalVolumeSol).toBe(10);
    expect(s.byPair).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pair: 'MEME/USDC',
          pnlQuote: -22.298172993001714,
          quoteSymbol: 'USDC',
          count: 1,
        }),
      ]),
    );
  });

  it('buckets todayPnl by UTC midnight, not the server-local day (regression: R08)', async () => {
    // Only observable on a non-UTC host: with server-LOCAL midnight, a close that is "yesterday" in
    // UTC but still after the local midnight of a behind-UTC zone wrongly folds into Today. Pin the
    // TZ + the clock so the assertion can actually fail if the boundary regresses to setHours().
    const { store, queries } = await setup();
    const origTz = process.env.TZ;
    process.env.TZ = 'America/New_York'; // UTC−4 in June
    vi.useFakeTimers({ toFake: ['Date'] }); // fake Date only — leave PGlite's real timers alone
    vi.setSystemTime(new Date('2025-06-15T03:00:00Z')); // 23:00 on Jun 14 local (NY)
    try {
      await store.upsertClosed([
        // Jun 15 01:00 UTC — genuinely "today" (UTC).
        {
          ...base,
          positionAddress: 'TDY',
          pnlSol: 2,
          closedAt: Date.parse('2025-06-15T01:00:00Z'),
        },
        // Jun 14 12:00 UTC — "yesterday" (UTC), but after local-NY midnight of Jun 14.
        {
          ...base,
          positionAddress: 'YST',
          pnlSol: 9,
          closedAt: Date.parse('2025-06-14T12:00:00Z'),
        },
      ]);
      const s = await queries.statsAggregate(['w'], 0);
      expect(s.todayPnlSol).toBeCloseTo(2); // the local-midnight bug would yield 11 (folds YST in)
    } finally {
      vi.useRealTimers();
      if (origTz === undefined) delete process.env.TZ;
      else process.env.TZ = origTz;
    }
  });

  it('excludes break-even closes (PnL exactly 0) from winRate and the loss count (R20)', async () => {
    const { store, queries } = await setup();
    await store.upsertClosed([
      { ...base, positionAddress: 'W1', pnlSol: 2, closedAt: DAY }, // win
      { ...base, positionAddress: 'L1', pnlSol: -1, closedAt: DAY }, // loss
      { ...base, positionAddress: 'B1', pnlSol: 0, closedAt: DAY }, // break-even
    ]);
    const s = await queries.statsAggregate(['w'], 0);
    expect(s.closedCount).toBe(3);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1); // break-even is NOT a loss (the old closedCount−wins would say 2)
    expect(s.winRate).toBeCloseTo(50); // 1 / (1 win + 1 loss); old code diluted it to 1/3 ≈ 33%
  });

  it('windows by sinceMs (closed_at >= since)', async () => {
    const { store, queries } = await setup();
    await store.upsertClosed([
      { ...base, positionAddress: 'X', pnlSol: 1, closedAt: DAY },
      { ...base, positionAddress: 'Y', pnlSol: 10, closedAt: 5 * DAY },
    ]);
    const s = await queries.statsAggregate(['w'], 5 * DAY);
    expect(s.closedCount).toBe(1);
    expect(s.totalPnlSol).toBeCloseTo(10);
  });

  it('is empty for no wallets and for a wallet with no closes', async () => {
    const { queries } = await setup();
    expect((await queries.statsAggregate([], 0)).closedCount).toBe(0);
    expect((await queries.statsAggregate(['w'], 0)).closedCount).toBe(0);
  });
});

describe('PostgresPositionQueries — profitBuckets (SQL GROUP BY)', () => {
  it('groups realized pnl by floored bucket, ascending, preferring the FIFO figure', async () => {
    const { store, queries } = await setup();
    await store.upsertClosed([
      { ...base, positionAddress: 'A', pnlSol: 2, closedAt: DAY + 1 },
      { ...base, positionAddress: 'B', pnlSol: 3, closedAt: DAY + 5 },
      { ...base, positionAddress: 'C', pnlSol: -1, closedAt: 3 * DAY },
    ]);
    expect(await queries.profitBuckets(['w'], DAY)).toEqual([
      { t: DAY, realized: 5 },
      { t: 3 * DAY, realized: -1 },
    ]);
    // The authoritative FIFO figure replaces the pool mark in the curve.
    await store.setAuthoritativePnlMany(new Map([['C', -4]]));
    expect(await queries.profitBuckets(['w'], DAY)).toEqual([
      { t: DAY, realized: 5 },
      { t: 3 * DAY, realized: -4 },
    ]);
  });
});
