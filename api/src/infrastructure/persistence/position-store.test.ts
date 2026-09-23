import type { ClosedPosition, OpenPosition } from '@binsight/shared';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
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

const openBase: Omit<OpenPosition, 'positionAddress'> = {
  wallet: 'w',
  poolAddress: 'p',
  tokenX: 'MEME',
  tokenY: 'SOL',
  tokenXMint: 'mint',
  strategy: null,
  sizeSol: 10,
  pnlSol: 0,
  pnlPctSol: 0,
  claimedFeesSol: 0,
  unclaimedFeesSol: 0,
  rangeStatus: 'in',
  minPrice: 0,
  maxPrice: 0,
  poolPrice: null,
  outOfRangeSince: null,
  openedAt: 5,
  updatedAt: 5,
};

// Fresh in-memory Postgres (PGlite) per test, with the real Drizzle migrations applied.
async function newDb(): Promise<Database> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return db as unknown as Database;
}
async function setup() {
  const db = await newDb();
  return { db, store: new PostgresPositionStore(db), queries: new PostgresPositionQueries(db) };
}

/** The raw row — to observe columns the domain mappers hide (updated_at, market_pnl_sol, status). */
async function rawRow(db: Database, address: string) {
  const [r] = await db
    .select()
    .from(schema.positions)
    .where(eq(schema.positions.positionAddress, address));
  return r!;
}

describe('PostgresPositionStore — upsertClosed', () => {
  it('derives pnlPctSol in percent points (not a fraction) so colour thresholds read it', async () => {
    const { store, queries } = await setup();
    // +0.0946 SOL on a 5 SOL deposit = +1.89%, which must clear a 0.5% green threshold.
    await store.upsertClosed([{ ...base, positionAddress: 'E', depositSol: 5, pnlSol: 0.0946 }]);
    expect((await queries.getClosedByAddress('E'))?.pnlPctSol).toBeCloseTo(1.892, 2);
  });

  it('does not rewrite a closed row when nothing changed (updated_at untouched)', async () => {
    // WHY: every ingest reprojects the wallet's whole closed history. Rewriting identical rows used to
    // touch ~15k rows per ingest; the IS DISTINCT FROM guard makes a reprojection that learned nothing a
    // no-op. updated_at is the observable proof that no UPDATE landed.
    const { db, store } = await setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      await store.upsertClosed([{ ...base, positionAddress: 'N', pnlSol: -1 }]);
      expect((await rawRow(db, 'N')).updatedAt).toBe(1_000_000);
      vi.setSystemTime(2_000_000);
      await store.upsertClosed([{ ...base, positionAddress: 'N', pnlSol: -1 }]);
      expect((await rawRow(db, 'N')).updatedAt).toBe(1_000_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes a late change of a closed figure — there is no settle-freeze any more', async () => {
    // WHY: closed figures are derived from the position's on-chain legs, so a later difference means
    // the ingest learned something (a leg that arrived late). The old settle-freeze would have kept the
    // stale figure forever.
    const { db, store, queries } = await setup();
    const closedAt = Date.now() - 3_600_000; // long past any former settle window
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      await store.upsertClosed([{ ...base, positionAddress: 'L', closedAt, pnlSol: -0.0146 }]);
      vi.setSystemTime(2_000_000);
      await store.upsertClosed([
        { ...base, positionAddress: 'L', closedAt, pnlSol: 0.06, feesSol: 0.06 },
      ]);
    } finally {
      vi.useRealTimers();
    }
    const read = await queries.getClosedByAddress('L');
    expect(read?.pnlSol).toBeCloseTo(0.06);
    expect(read?.feesSol).toBeCloseTo(0.06);
    expect((await rawRow(db, 'L')).updatedAt).toBe(2_000_000);
  });

  it('never writes market_pnl_sol — the realized-PnL pass owns that column', async () => {
    // WHY: the projection reprojects the legs' pool mark on every ingest; if it touched market_pnl_sol
    // it would erase the FIFO's authoritative figure between two realized passes.
    const { db, store, queries } = await setup();
    await store.upsertClosed([{ ...base, positionAddress: 'M', pnlSol: -0.01 }]);
    await store.setAuthoritativePnlMany(new Map([['M', -0.19174]]));
    await store.upsertClosed([{ ...base, positionAddress: 'M', pnlSol: -0.02 }]); // a changed pool mark
    expect((await rawRow(db, 'M')).marketPnlSol).toBeCloseTo(-0.19174);
    expect((await rawRow(db, 'M')).pnlSol).toBeCloseTo(-0.02);
    expect((await queries.getClosedByAddress('M'))?.pnlSol).toBeCloseTo(-0.19174); // effective = FIFO
  });

  it('never replaces a known symbol/icon with a truncated-mint placeholder', async () => {
    // WHY: an unresolved symbol renders as "AbCd…WxYz". One metadata outage during a reprojection would
    // otherwise relabel a wallet's entire history with placeholders.
    const { store, queries } = await setup();
    await store.upsertClosed([
      {
        ...base,
        positionAddress: 'S',
        pnlSol: 1,
        tokenX: 'BONK',
        quoteSymbol: 'SOL',
        tokenXIcon: 'https://icon/bonk.png',
      },
    ]);
    await store.upsertClosed([
      {
        ...base,
        positionAddress: 'S',
        pnlSol: 2, // a real change rides along, so the row IS rewritten
        tokenX: 'DezX…B263',
        quoteSymbol: 'So11…1112',
        tokenXIcon: undefined,
      },
    ]);
    const read = await queries.getClosedByAddress('S');
    expect(read?.pnlSol).toBeCloseTo(2);
    expect(read?.tokenX).toBe('BONK');
    expect(read?.quoteSymbol).toBe('SOL');
    expect(read?.tokenXIcon).toBe('https://icon/bonk.png');
  });

  it('a real symbol does replace an earlier placeholder', async () => {
    // The other half of the rule: the guard only protects known labels, it never pins a placeholder.
    const { store, queries } = await setup();
    await store.upsertClosed([{ ...base, positionAddress: 'P', pnlSol: 1, tokenX: 'DezX…B263' }]);
    await store.upsertClosed([{ ...base, positionAddress: 'P', pnlSol: 1, tokenX: 'BONK' }]);
    expect((await queries.getClosedByAddress('P'))?.tokenX).toBe('BONK');
  });

  it('closes a row that was open', async () => {
    const { store, queries } = await setup();
    await store.replaceOpenForWallet('w', [{ ...openBase, positionAddress: 'O' }]);
    await store.upsertClosed([{ ...base, positionAddress: 'O', pnlSol: 0.5 }]);
    expect(await store.getOpen('w')).toEqual([]);
    expect((await queries.getClosedByAddress('O'))?.pnlSol).toBeCloseTo(0.5);
  });

  it('chunks inserts so a multi-thousand-row history backfill (over the PG bind-param limit) lands', async () => {
    const { store, queries } = await setup();
    // 4000 rows × ~19 columns = ~76k bind params > Postgres' 65535 limit — a single insert would
    // fail (this is the bug that truncated a real wallet's history to one surviving small batch).
    const big = Array.from({ length: 4000 }, (_, i) => ({
      ...base,
      positionAddress: `BIG${i}`,
      pnlSol: 0,
    }));
    await store.upsertClosed(big);
    const { total } = await queries.getClosed(['w'], { page: 1, pageSize: 1 });
    expect(total).toBe(4000);
  });
});

describe('PostgresPositionStore — replaceOpenForWallet', () => {
  it('moves positions no longer listed to pending_close, and keeps stillOpen ones untouched', async () => {
    // WHY stillOpen: a snapshot's live position that the projection couldn't value this round is still
    // open on-chain; demoting it to pending_close would fire a false close downstream.
    const { db, store } = await setup();
    await store.replaceOpenForWallet('w', [
      { ...openBase, positionAddress: 'A' },
      { ...openBase, positionAddress: 'B' },
      { ...openBase, positionAddress: 'C' },
    ]);
    await store.replaceOpenForWallet('w', [{ ...openBase, positionAddress: 'A' }], ['B']);
    expect((await rawRow(db, 'A')).status).toBe('open');
    expect((await rawRow(db, 'B')).status).toBe('open');
    expect((await rawRow(db, 'C')).status).toBe('pending_close');
    expect((await store.getOpen('w')).map((p) => p.positionAddress).sort()).toEqual(['A', 'B']);
    expect((await store.getOpenOrPendingClose('w')).map((p) => p.positionAddress).sort()).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('an empty open set demotes every open row of that wallet only', async () => {
    const { db, store } = await setup();
    await store.replaceOpenForWallet('w', [{ ...openBase, positionAddress: 'A' }]);
    await store.replaceOpenForWallet('other', [
      { ...openBase, wallet: 'other', positionAddress: 'Z' },
    ]);
    await store.replaceOpenForWallet('w', []);
    expect((await rawRow(db, 'A')).status).toBe('pending_close');
    expect((await rawRow(db, 'Z')).status).toBe('open');
  });

  it('never reopens a row whose status is closed', async () => {
    // WHY: a position account, once closed, can never reopen. An open write for it is necessarily a
    // stale snapshot racing the close projection; accepting it would resurrect a closed position (and
    // later fire a second close notification).
    const { db, store, queries } = await setup();
    await store.upsertClosed([{ ...base, positionAddress: 'X', pnlSol: 0.3 }]);
    await store.replaceOpenForWallet('w', [
      { ...openBase, positionAddress: 'X', pnlSol: 9, sizeSol: 9 },
    ]);
    expect((await rawRow(db, 'X')).status).toBe('closed');
    expect(await store.getOpen('w')).toEqual([]);
    expect((await queries.getClosedByAddress('X'))?.pnlSol).toBeCloseTo(0.3);
  });

  it('refreshes a pending_close row back to open when the snapshot lists it again', async () => {
    // A position that briefly vanished from one snapshot (RPC hiccup) must come back, unlike a closed one.
    const { db, store } = await setup();
    await store.replaceOpenForWallet('w', [{ ...openBase, positionAddress: 'A' }]);
    await store.replaceOpenForWallet('w', []);
    expect((await rawRow(db, 'A')).status).toBe('pending_close');
    await store.replaceOpenForWallet('w', [{ ...openBase, positionAddress: 'A', pnlSol: 1 }]);
    expect((await rawRow(db, 'A')).status).toBe('open');
    expect((await store.getOpen('w'))[0]?.pnlSol).toBeCloseTo(1);
  });

  it('positionStatusForWallet reports status + closedAt of every row of the wallet', async () => {
    const { store } = await setup();
    await store.upsertClosed([{ ...base, positionAddress: 'C', pnlSol: 0, closedAt: 42 }]);
    await store.replaceOpenForWallet('w', [{ ...openBase, positionAddress: 'O' }]);
    const m = await store.positionStatusForWallet('w');
    expect(m.get('C')).toEqual({ status: 'closed', closedAt: 42 });
    expect(m.get('O')).toEqual({ status: 'open', closedAt: null });
  });
});

describe('PostgresPositionStore — setAuthoritativePnlMany', () => {
  it('writes market_pnl_sol and returns only the number of rows that changed', async () => {
    // WHY the count: the realized pass decides whether to re-emit the wallet's history from it. A pass
    // that recomputed the same figures must report 0 so nothing is re-broadcast.
    const { store, queries } = await setup();
    await store.upsertClosed([
      { ...base, positionAddress: 'M1', pnlSol: -0.01 },
      { ...base, positionAddress: 'M2', pnlSol: -0.02 },
    ]);
    await store.replaceOpenForWallet('w', [{ ...openBase, positionAddress: 'OPEN' }]);
    expect(
      await store.setAuthoritativePnlMany(
        new Map([
          ['M1', 1.5],
          ['M2', -3.25],
          ['OPEN', 7], // an open row is never given a realized figure
          ['MISSING', 1], // unknown address: nothing to change
        ]),
      ),
    ).toBe(2);
    const rows = (await queries.getClosed(['w'], { page: 1, pageSize: 10 })).rows;
    const byAddr = new Map(rows.map((r) => [r.positionAddress, r.pnlSol]));
    expect(byAddr.get('M1')).toBeCloseTo(1.5);
    expect(byAddr.get('M2')).toBeCloseTo(-3.25);

    // Same figures again → nothing changed; one moved → exactly one.
    expect(
      await store.setAuthoritativePnlMany(
        new Map([
          ['M1', 1.5],
          ['M2', -3.25],
        ]),
      ),
    ).toBe(0);
    expect(
      await store.setAuthoritativePnlMany(
        new Map([
          ['M1', 1.5],
          ['M2', -3],
        ]),
      ),
    ).toBe(1);
  });

  it('handles more than one chunk (> 1000 rows) and counts across chunks', async () => {
    // WHY: two bind parameters per row; a large wallet's FIFO reprices thousands of positions at once.
    const { store, queries } = await setup();
    const N = 2500;
    await store.upsertClosed(
      Array.from({ length: N }, (_, i) => ({ ...base, positionAddress: `R${i}`, pnlSol: 0 })),
    );
    const figures = new Map(Array.from({ length: N }, (_, i) => [`R${i}`, i + 0.5] as const));
    expect(await store.setAuthoritativePnlMany(figures)).toBe(N);
    expect((await queries.getClosedByAddress('R2499'))?.pnlSol).toBeCloseTo(2499.5);
    expect((await queries.getClosedByAddress('R0'))?.pnlSol).toBeCloseTo(0.5);
    expect(await store.setAuthoritativePnlMany(figures)).toBe(0);
  });

  it('an empty map writes nothing', async () => {
    const { store } = await setup();
    expect(await store.setAuthoritativePnlMany(new Map())).toBe(0);
  });
});

describe('PostgresPositionStore — strategy', () => {
  it('strategiesOf returns the family of each listed position that has one', async () => {
    // WHY: the projection re-attaches strategies to the rows it rebuilds from legs; it must ask only
    // for the positions it projects (primary-key lookups), not scan the whole table.
    const { store, queries } = await setup();
    await store.upsertClosed([
      { ...base, positionAddress: 'S1', pnlSol: 0.1 },
      { ...base, positionAddress: 'S2', pnlSol: 0.1 },
      { ...base, positionAddress: 'S3', pnlSol: 0.1 },
    ]);
    expect((await store.strategiesOf(['S1', 'S2'])).size).toBe(0); // unresolved → absent
    await store.setStrategy('S1', 'BidAsk');
    await store.setStrategy('S3', 'Spot');
    const m = await store.strategiesOf(['S1', 'S2', 'NOPE']);
    expect([...m]).toEqual([['S1', 'BidAsk']]); // S3 not asked for, S2 unresolved, NOPE unknown
    expect(await store.strategiesOf([])).toEqual(new Map());
    expect((await queries.getClosedByAddress('S1'))?.strategy).toBe('BidAsk'); // travels onto reads
  });

  it('a strategy survives a later closed rewrite', async () => {
    // The upsert's SET list does not include strategy: a reprojection must not wipe a resolved family.
    const { store } = await setup();
    await store.upsertClosed([{ ...base, positionAddress: 'S', pnlSol: 0 }]);
    await store.setStrategy('S', 'Curve');
    await store.upsertClosed([{ ...base, positionAddress: 'S', pnlSol: 5 }]);
    expect((await store.strategiesOf(['S'])).get('S')).toBe('Curve');
  });

  it('addressesMissingStrategy returns OPEN positions only — never the closed-history tail (RPC drain guard)', async () => {
    const { store } = await setup();
    // WHY open-only: strategy is resolved from the open tx (an expensive getParsedTransaction) while a
    // position is OPEN, then persisted and travels into closed history. Returning the closed tail here
    // made the backfill re-page tens of thousands of closed positions' open txs — millions of Helius
    // credits to label already-closed rows. Closed positions missing strategy must NOT be listed.
    await store.upsertClosed([
      { ...base, positionAddress: 'M1', pnlSol: 0 },
      { ...base, positionAddress: 'M2', pnlSol: 0 },
    ]);
    await store.replaceOpenForWallet('w', [{ ...openBase, positionAddress: 'O1' }]);
    expect(await store.addressesMissingStrategy(10)).toEqual(['O1']);
    await store.setStrategy('O1', 'Spot');
    expect(await store.addressesMissingStrategy(10)).toEqual([]);
  });
});
