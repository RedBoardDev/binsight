import {
  type ClosedPosition,
  type OpenPosition,
  SOL_MINT,
  type StrategyFamily,
  USDC_MINT,
} from '@binsight/shared';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { OnchainPositionValue, OnchainValued, OnchainWalletSnapshot } from '@/domain/dlmm';
import type { PositionPnl } from './dlmm-position-pnl';
import { type LegProjectionSource, PositionSync } from './position-sync-service';

const silent = pino({ level: 'silent' });

const proj = (over: Partial<PositionPnl>): PositionPnl => ({
  position: 'p',
  pool: 'pool',
  pnlSol: 0,
  depositSol: 1,
  withdrawSol: 0,
  claimedFeesSol: 0,
  pnlQuote: 0,
  depositQuote: 1,
  withdrawQuote: 0,
  claimedFeesQuote: 0,
  quoteMint: SOL_MINT,
  quoteSymbol: 'SOL',
  quoteDecimals: 9,
  quoteSide: 'Y',
  valuationStatus: 'complete',
  economicStatus: 'funded',
  legs: 1,
  tokenMint: 'MEMEmint',
  mintX: 'MEMEmint',
  mintY: SOL_MINT,
  solDenominated: true,
  openedAt: 1000,
  closedAt: 2000,
  durationSeconds: 1,
  ...over,
});

const opv = (positionAddress: string): OnchainPositionValue => ({
  positionAddress,
  lbPair: 'lb',
  tokenXMint: 'MEMEmint',
  tokenYMint: SOL_MINT,
  amountX: 0n,
  amountY: 0n,
  feeX: 0n,
  feeY: 0n,
  decimalsX: 6,
  decimalsY: 9,
  activeId: 0,
  binStep: 100,
  lowerBinId: -10,
  upperBinId: 10,
  lamports: 0n,
});

const valued = (over: Partial<OnchainValued> = {}): OnchainValued => ({
  slot: 1,
  slotSkew: 0,
  tvlSol: 5,
  idleSol: 0,
  unclaimedFeesSol: 0.1,
  lockedRentSol: 0,
  walletTotalSol: 5.1,
  positionCount: 1,
  chainComplete: true,
  valuationStatus: 'complete' as const,
  authoritative: true,
  complete: true,
  sizeSolByPosition: new Map([['OPEN', 5]]),
  feeSolByPosition: new Map([['OPEN', 0.1]]),
  ...over,
});

describe('PositionSync — chain → positions table', () => {
  it('routes a snapshot-present position to OPEN and an absent one to CLOSED, through the repo', async () => {
    const legPnl: LegProjectionSource = {
      pnlByPosition: vi.fn(async () => [
        proj({ position: 'OPEN', depositSol: 6 }),
        proj({
          position: 'CLOSED',
          pnlSol: 0.24,
          depositSol: 6,
          withdrawSol: 6.2,
          claimedFeesSol: 0.04,
        }),
      ]),
      pnlForPositions: vi.fn(async () => []),
    };
    const metadata = {
      resolve: vi.fn(
        async (mints: string[]) =>
          new Map(mints.map((m) => [m, { symbol: m === SOL_MINT ? 'SOL' : 'MEME' }])),
      ),
    };
    const replaceOpenForWallet = vi.fn<(wallet: string, rows: OpenPosition[]) => Promise<void>>(
      async () => {},
    );
    const upsertClosed = vi.fn<(rows: ClosedPosition[]) => Promise<void>>(async () => {});
    const repo = {
      replaceOpenForWallet,
      upsertClosed,
      getOpenOrPendingClose: vi.fn(async (): Promise<OpenPosition[]> => []),
      strategiesOf: vi.fn(async () => new Map<string, never>()),
    };

    const snapshot: OnchainWalletSnapshot = {
      owner: 'W',
      slot: 1,
      slotSkew: 0,
      nativeLamports: 0n,
      idleTokens: [],
      positions: [opv('OPEN')],
      complete: true,
      positionsComplete: true,
    };

    const sync = new PositionSync(legPnl, metadata, repo, silent);
    const res = await sync.sync('W', snapshot, valued());

    // No prior persisted open row for CLOSED (getOpenOrPendingClose → []), so it's NOT a newly-closed transition:
    // closedRows is empty even though the closed COUNT is 1 (this is the backfill-safety property).
    expect(res.closed).toBe(1);
    expect(res.closedRows).toEqual([]);
    // The open rows are returned so the engine can refresh its in-memory open set (the live /state).
    expect(res.openPositions).toHaveLength(1);
    expect(res.openPositions[0]!.positionAddress).toBe('OPEN');

    expect(replaceOpenForWallet).toHaveBeenCalledTimes(1);
    const [openWallet, openRows] = replaceOpenForWallet.mock.calls[0]!;
    expect(openWallet).toBe('W');
    expect(openRows).toHaveLength(1);
    expect(openRows[0]!.positionAddress).toBe('OPEN');
    expect(openRows[0]!.tokenX).toBe('MEME');
    expect(openRows[0]!.tokenY).toBe('SOL');
    expect(openRows[0]!.sizeSol).toBe(5);
    expect(openRows[0]!.pnlSol).toBeCloseTo(5 + 0.1 - 6, 9); // live size + unclaimed − deposit

    expect(upsertClosed).toHaveBeenCalledTimes(1);
    const closedRows = upsertClosed.mock.calls[0]![0];
    expect(closedRows).toHaveLength(1);
    expect(closedRows[0]!.positionAddress).toBe('CLOSED');
    expect(closedRows[0]!.pnlSol).toBeCloseTo(0.24, 9);
  });

  it('preserves the prior out-of-range timestamp from the existing open rows', async () => {
    const legPnl: LegProjectionSource = {
      pnlByPosition: vi.fn(async () => [proj({ position: 'OPEN', depositSol: 6 })]),
      pnlForPositions: vi.fn(async () => [proj({ position: 'OPEN', depositSol: 6 })]),
    };
    const metadata = {
      resolve: vi.fn(async (m: string[]) => new Map(m.map((x) => [x, { symbol: 'S' }]))),
    };
    const openRows: { positionAddress: string; rangeStatus?: string }[] = [];
    const repo = {
      replaceOpenForWallet: vi.fn(async (_w: string, rows: { positionAddress: string }[]) => {
        openRows.push(...rows);
      }),
      upsertClosed: vi.fn(async () => {}),
      getOpenOrPendingClose: vi.fn(async () => [
        { positionAddress: 'OPEN', outOfRangeSince: 1234 },
      ]),
      strategiesOf: vi.fn(async () => new Map()),
    };
    // active bin above range → out_up → OOR clock applies, must keep 1234 not reset to now
    const snapshot: OnchainWalletSnapshot = {
      owner: 'W',
      slot: 1,
      slotSkew: 0,
      nativeLamports: 0n,
      idleTokens: [],
      positions: [{ ...opv('OPEN'), activeId: 50 }],
      complete: true,
      positionsComplete: true,
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial repo stub for a focused unit test
    await new PositionSync(legPnl, metadata, repo as any, silent).sync('W', snapshot, valued());
    expect(openRows[0]).toMatchObject({ positionAddress: 'OPEN', outOfRangeSince: 1234 });
  });

  it('refreshOpen writes ONLY the open set (loads the open subset, never re-touches closed history)', async () => {
    const legPnl: LegProjectionSource = {
      pnlByPosition: vi.fn(async () => {
        throw new Error('refreshOpen must not load the full leg history');
      }),
      pnlForPositions: vi.fn(async () => [proj({ position: 'OPEN', depositSol: 6 })]),
    };
    const metadata = {
      resolve: vi.fn(async (m: string[]) => new Map(m.map((x) => [x, { symbol: 'S' }]))),
    };
    const replaceOpenForWallet = vi.fn(async () => {});
    const upsertClosed = vi.fn(async () => {});
    const repo = {
      replaceOpenForWallet,
      upsertClosed,
      getOpenOrPendingClose: vi.fn(async () => []),
      strategiesOf: vi.fn(async () => new Map<string, never>()),
    };
    const snapshot: OnchainWalletSnapshot = {
      owner: 'W',
      slot: 1,
      slotSkew: 0,
      nativeLamports: 0n,
      idleTokens: [],
      positions: [opv('OPEN')],
      complete: true,
      positionsComplete: true,
    };
    const { openPositions: open } = await new PositionSync(
      legPnl,
      metadata,
      // biome-ignore lint/suspicious/noExplicitAny: partial repo stub for a focused unit test
      repo as any,
      silent,
    ).refreshOpen('W', snapshot, valued());
    // refreshOpen returns the open rows so the engine can refresh its in-memory open set.
    expect(open).toHaveLength(1);
    expect(open[0]!.positionAddress).toBe('OPEN');
    expect(legPnl.pnlForPositions).toHaveBeenCalledWith(['OPEN']); // only the open subset's legs
    expect(replaceOpenForWallet).toHaveBeenCalledTimes(1);
    expect(upsertClosed).not.toHaveBeenCalled(); // the cadence NEVER re-writes the closed history
  });
});

/**
 * The close-notification wiring — PositionSync.sync.closedRows, the LIVE push/Bark/in-app path. A backfill
 * that spams, a duplicate, OR a silently-dropped close are all regressions here. We drive a stateful repo
 * that reproduces the REAL status machine (open → pending_close → closed) so the prior-open set evolves
 * exactly as production does, and mirror the engine seam that emits one `closed` per newly-closed row.
 */
describe('PositionSync — close-notification wiring (no backfill spam, no duplicates, no lost closes)', () => {
  const metadata = {
    resolve: vi.fn(async (m: string[]) => new Map(m.map((x) => [x, { symbol: 'S' }]))),
  };

  type Status = 'open' | 'pending_close' | 'closed';

  /** A repo mirroring the DB status machine: replaceOpenForWallet flags disappeared opens 'pending_close'
   *  (like the real set-diff) and upsertClosed settles them to 'closed'. getOpenOrPendingClose returns both
   *  open + pending_close — the prior-open set the sync must diff against. */
  const statefulRepo = (initialOpen: OpenPosition[]) => {
    const byAddr = new Map<string, { row: OpenPosition; status: Status }>();
    for (const p of initialOpen) byAddr.set(p.positionAddress, { row: p, status: 'open' });
    const withStatus = (...s: Status[]) =>
      [...byAddr.values()].filter((v) => s.includes(v.status)).map((v) => v.row);
    return {
      replaceOpenForWallet: vi.fn(async (_w: string, rows: OpenPosition[]) => {
        const keep = new Set(rows.map((r) => r.positionAddress));
        for (const r of rows) byAddr.set(r.positionAddress, { row: r, status: 'open' });
        for (const v of byAddr.values())
          if (v.status === 'open' && !keep.has(v.row.positionAddress)) v.status = 'pending_close';
      }),
      upsertClosed: vi.fn(async (rows: { positionAddress: string }[]) => {
        for (const r of rows) {
          const v = byAddr.get(r.positionAddress);
          if (v) v.status = 'closed';
        }
      }),
      getOpenOrPendingClose: vi.fn(async () => withStatus('open', 'pending_close')),
      strategiesOf: vi.fn(async () => new Map<string, never>()),
      /** Test-only helper to force the cadence's pending_close mark without a full refreshOpen. */
      _markPendingClose: (addr: string) => {
        const v = byAddr.get(addr);
        if (v) v.status = 'pending_close';
      },
    };
  };

  /** Mirror of the engine seam AFTER the #98 fix: sync, then emit one `closed` per newly-closed row —
   *  UNCONDITIONALLY (the prior-open diff is the sole spam guard). Returns the emitted closed addresses. */
  const runSync = async (
    sync: PositionSync,
    snapshot: OnchainWalletSnapshot,
  ): Promise<string[]> => {
    const res = await sync.sync('W', snapshot, valued());
    return res.closedRows.map((row) => row.positionAddress);
  };

  it('(a) the INITIAL backfill sync emits ZERO closed events even with a non-empty closed set', async () => {
    // Wallet onboarding: many historical closes land at once. Nothing was persisted as open before → the
    // prior-open diff flags ZERO newly-closed → no notifications. (This is the sole backfill-spam guard.)
    const legPnl: LegProjectionSource = {
      pnlByPosition: vi.fn(async () => [
        proj({ position: 'OPEN', depositSol: 6 }),
        proj({ position: 'HIST1', withdrawSol: 1 }),
        proj({ position: 'HIST2', withdrawSol: 1 }),
      ]),
      pnlForPositions: vi.fn(async () => []),
    };
    const repo = statefulRepo([]); // nothing persisted yet — true first sync
    // biome-ignore lint/suspicious/noExplicitAny: partial repo stub for a focused unit test
    const sync = new PositionSync(legPnl, metadata, repo as any, silent);

    const emitted = await runSync(sync, snap(['OPEN']));
    expect(emitted).toEqual([]); // no backfill spam
    // And even the raw closedRows are empty: no historical close was ever in the persisted open set.
    const res = await sync.sync('W', snap(['OPEN']), valued());
    expect(res.closed).toBe(2);
    expect(res.closedRows).toEqual([]);
  });

  it('(b)+(c) a position closing on a later live sync emits exactly ONE closed event, never again', async () => {
    // OPEN is persisted as open. On the next sync the snapshot no longer lists it → open→closed transition
    // → exactly one `closed`. The sync AFTER that must NOT re-emit: upsertClosed settled OPEN to 'closed',
    // so it's no longer in the prior-open set.
    const legPnl: LegProjectionSource = {
      pnlByPosition: vi.fn(async () => [
        proj({
          position: 'OPEN',
          pnlSol: 0.5,
          depositSol: 6,
          withdrawSol: 6.5,
          claimedFeesSol: 0.04,
        }),
      ]),
      pnlForPositions: vi.fn(async () => []),
    };
    const repo = statefulRepo([
      // biome-ignore lint/suspicious/noExplicitAny: minimal persisted-open stub (only address/oor read)
      { positionAddress: 'OPEN', outOfRangeSince: null } as any,
    ]);
    // biome-ignore lint/suspicious/noExplicitAny: partial repo stub for a focused unit test
    const sync = new PositionSync(legPnl, metadata, repo as any, silent);

    // Sync 1 — snapshot no longer contains OPEN → it closes → emit exactly one.
    const first = await sync.sync('W', snap([]), valued());
    expect(first.closedRows).toHaveLength(1); // (b) exactly one newly-closed row
    const payload = first.closedRows[0]!;
    // The emitted row is a real ClosedPosition carrying everything handleClosed reads.
    expect(payload).toMatchObject({
      wallet: 'W',
      positionAddress: 'OPEN',
      tokenX: 'S',
      tokenY: 'S',
    });
    expect(typeof payload.pnlSol).toBe('number');
    expect(typeof payload.feesSol).toBe('number');

    // Sync 2 — OPEN was settled to 'closed' by sync 1's upsertClosed, so it's no longer a transition.
    const second = await sync.sync('W', snap([]), valued());
    expect(second.closedRows).toEqual([]); // (c) no duplicate
    expect(await runSync(sync, snap([]))).toEqual([]);
  });

  it('(d) the FIRST sync after a restart emits closes for positions closed while the process was down', async () => {
    // Regression #98: `reconciled` is an in-memory flag reset to false on every boot, so the first post-
    // restart sync had wasReconciled=false. But that sync is EXACTLY the one detecting downtime closes —
    // whose open set was persisted before shutdown. The old gate suppressed them, silently, on every
    // deploy. With the gate removed, the persisted prior-open diff alone must still emit the close.
    const legPnl: LegProjectionSource = {
      pnlByPosition: vi.fn(async () => [
        proj({ position: 'DOWN', pnlSol: -0.2, depositSol: 6, withdrawSol: 5.8 }),
      ]),
      pnlForPositions: vi.fn(async () => []),
    };
    // DOWN was persisted 'open' before the crash; on-chain it closed during downtime.
    const repo = statefulRepo([
      // biome-ignore lint/suspicious/noExplicitAny: minimal persisted-open stub
      { positionAddress: 'DOWN', outOfRangeSince: null } as any,
    ]);
    // biome-ignore lint/suspicious/noExplicitAny: partial repo stub for a focused unit test
    const sync = new PositionSync(legPnl, metadata, repo as any, silent);

    // First sync after boot — snapshot no longer lists DOWN → it must emit exactly one close.
    expect(await runSync(sync, snap([]))).toEqual(['DOWN']);
  });

  it('(e) a close survives the pending_close race between the cadence refreshOpen and the ingest sync', async () => {
    // Regression #97: the 30s cadence refreshOpen can flag a just-closed position 'pending_close' BEFORE
    // the WS-triggered ingest sync reprojects it. If the prior-open set were built from status='open' only
    // (getOpen), the pending_close row would be dropped → no open→closed transition → the `closed` event is
    // silently lost (no push/Bark/in-app). getOpenOrPendingClose keeps it, so the transition still fires.
    const legPnl: LegProjectionSource = {
      pnlByPosition: vi.fn(async () => [
        proj({ position: 'RACE', pnlSol: 0.3, depositSol: 6, withdrawSol: 6.3 }),
      ]),
      pnlForPositions: vi.fn(async () => []),
    };
    const repo = statefulRepo([
      // biome-ignore lint/suspicious/noExplicitAny: minimal persisted-open stub
      { positionAddress: 'RACE', outOfRangeSince: null } as any,
    ]);
    // The cadence already marked RACE pending_close (position vanished on-chain, close not yet reprojected).
    repo._markPendingClose('RACE');
    // biome-ignore lint/suspicious/noExplicitAny: partial repo stub for a focused unit test
    const sync = new PositionSync(legPnl, metadata, repo as any, silent);

    // The ingest sync now reprojects RACE as closed → the close MUST still be emitted (was lost before).
    expect(await runSync(sync, snap([]))).toEqual(['RACE']);
  });
});

describe('PositionSync — labels, strategies and stillOpen', () => {
  const noPrior = async (): Promise<OpenPosition[]> => [];

  it('labels a USDC pool\'s quote side from the quote mint\'s metadata — "USDC", not a truncated mint', async () => {
    // WHY: only the base mints used to be resolved, so a non-SOL pool's quote label fell back to the
    // short-mint placeholder ("EPjF…Dt1v") on every row of its history.
    const legPnl: LegProjectionSource = {
      pnlByPosition: vi.fn(async () => [
        proj({
          position: 'U',
          quoteMint: USDC_MINT,
          quoteSymbol: 'USDC',
          quoteDecimals: 6,
          mintY: USDC_MINT,
          solDenominated: false,
        }),
      ]),
      pnlForPositions: vi.fn(async () => []),
    };
    const known: Record<string, string> = {
      MEMEmint: 'MEME',
      [USDC_MINT]: 'USDC',
      [SOL_MINT]: 'SOL',
    };
    const resolve = vi.fn(
      async (mints: string[]) =>
        new Map(mints.filter((m) => known[m]).map((m) => [m, { symbol: known[m]! }])),
    );
    const upsertClosed = vi.fn<(rows: ClosedPosition[]) => Promise<void>>(async () => {});
    const repo = {
      replaceOpenForWallet: vi.fn(async () => {}),
      upsertClosed,
      getOpenOrPendingClose: vi.fn(noPrior),
      strategiesOf: vi.fn(async () => new Map<string, StrategyFamily>()),
    };
    await new PositionSync(legPnl, { resolve }, repo, silent).sync(
      'W',
      { ...snap([]), positions: [] },
      valued(),
    );

    expect(resolve.mock.calls[0]![0]).toEqual(expect.arrayContaining(['MEMEmint', USDC_MINT]));
    const row = upsertClosed.mock.calls[0]![0][0]!;
    expect(row.tokenX).toBe('MEME');
    expect(row.tokenY).toBe('USDC');
    expect(row.quoteSymbol).toBe('USDC');
  });

  it('attaches strategies looked up for exactly the projected positions', async () => {
    // strategiesOf is a primary-key lookup of the projected set, not a scan of the table.
    const legPnl: LegProjectionSource = {
      pnlByPosition: vi.fn(async () => [proj({ position: 'OPEN' }), proj({ position: 'C1' })]),
      pnlForPositions: vi.fn(async () => []),
    };
    const upsertClosed = vi.fn<(rows: ClosedPosition[]) => Promise<void>>(async () => {});
    const strategiesOf = vi.fn(
      async (_p: string[]) =>
        new Map<string, StrategyFamily>([
          ['OPEN', 'Spot'],
          ['C1', 'BidAsk'],
        ]),
    );
    const res = await new PositionSync(
      legPnl,
      metadataOf('S'),
      {
        replaceOpenForWallet: vi.fn(async () => {}),
        upsertClosed,
        getOpenOrPendingClose: vi.fn(noPrior),
        strategiesOf,
      },
      silent,
    ).sync('W', snap(['OPEN']), valued());

    expect(strategiesOf).toHaveBeenCalledWith(['OPEN', 'C1']);
    expect(res.openPositions[0]!.strategy).toBe('Spot');
    expect(upsertClosed.mock.calls[0]![0][0]!.strategy).toBe('BidAsk');
  });

  it('passes live positions the projection could not build as stillOpen, on both paths', async () => {
    // WHY: a position whose legs are not ingested yet (or whose pool metadata failed) is still open
    // on-chain. Without stillOpen, replaceOpenForWallet would flag it pending_close — read downstream
    // as a close.
    const legPnl: LegProjectionSource = {
      pnlByPosition: vi.fn(async () => [proj({ position: 'OPEN' })]),
      pnlForPositions: vi.fn(async () => [proj({ position: 'OPEN' })]),
    };
    const replaceOpenForWallet = vi.fn(
      async (_w: string, _rows: OpenPosition[], _still?: string[]) => {},
    );
    const sync = new PositionSync(
      legPnl,
      metadataOf('S'),
      {
        replaceOpenForWallet,
        upsertClosed: vi.fn(async () => {}),
        getOpenOrPendingClose: vi.fn(noPrior),
        strategiesOf: vi.fn(async () => new Map<string, StrategyFamily>()),
      },
      silent,
    );
    await sync.sync('W', snap(['OPEN', 'NEW']), valued());
    await sync.refreshOpen('W', snap(['OPEN', 'NEW']), valued());
    for (const [, rows, still] of replaceOpenForWallet.mock.calls) {
      expect(rows.map((r) => r.positionAddress)).toEqual(['OPEN']);
      expect(still).toEqual(['NEW']);
    }
    expect(replaceOpenForWallet).toHaveBeenCalledTimes(2);
  });
});

describe('PositionSync — open-set transitions', () => {
  // opv(): bins −10..10 at binStep 100. activeId 0 → in range; 50 → out of range (above).
  const prior = (address: string, rangeStatus: OpenPosition['rangeStatus']) =>
    ({ positionAddress: address, rangeStatus, outOfRangeSince: null }) as OpenPosition;
  const makeSync = (projected: string[], priorRows: OpenPosition[]) =>
    new PositionSync(
      {
        pnlByPosition: vi.fn(async () => projected.map((position) => proj({ position }))),
        pnlForPositions: vi.fn(async (ps: string[]) =>
          projected.filter((p) => ps.includes(p)).map((position) => proj({ position })),
        ),
      },
      metadataOf('S'),
      {
        replaceOpenForWallet: vi.fn(async () => {}),
        upsertClosed: vi.fn(async () => {}),
        getOpenOrPendingClose: vi.fn(async () => priorRows),
        strategiesOf: vi.fn(async () => new Map<string, StrategyFamily>()),
      },
      silent,
    );

  it('reports opened, outOfRange, backInRange and vanished against the persisted open set', async () => {
    // These drive the position_open / oor_enter / oor_return notifications and the vanished-position
    // reprojection, so each must be exact — a missed one is a silent notification, an extra one spam.
    const sync = makeSync(
      ['NEW', 'GOES_OUT', 'COMES_BACK', 'STAYS'],
      [
        prior('GOES_OUT', 'in'),
        prior('COMES_BACK', 'out_up'),
        prior('STAYS', 'in'),
        prior('GONE', 'in'),
      ],
    );
    const snapshot = {
      ...snap([]),
      positions: [
        opv('NEW'),
        { ...opv('GOES_OUT'), activeId: 50 },
        opv('COMES_BACK'),
        opv('STAYS'),
      ],
    };
    const { transitions: t } = await sync.refreshOpen('W', snapshot, valued());
    expect(t.opened.map((p) => p.positionAddress)).toEqual(['NEW']);
    expect(t.outOfRange.map((p) => p.positionAddress)).toEqual(['GOES_OUT']);
    expect(t.backInRange.map((p) => p.positionAddress)).toEqual(['COMES_BACK']);
    expect(t.vanished).toEqual(['GONE']);
  });

  it('an unknown range on either side is not a crossing', async () => {
    const sync = makeSync(['A'], [prior('A', 'unknown')]);
    const { transitions: t } = await sync.refreshOpen(
      'W',
      { ...snap([]), positions: [{ ...opv('A'), activeId: 50 }] },
      valued(),
    );
    expect(t.outOfRange).toEqual([]);
    expect(t.backInRange).toEqual([]);
  });

  it('a vanished position that the full sync projects as closed is a close, not "vanished"', async () => {
    // The full sync knows the close; only the cadence refresh (which never reads closed legs) reports a
    // vanished position, so the actor can ingest + reproject it.
    const sync = makeSync(['GONE'], [prior('GONE', 'in')]);
    const res = await sync.sync('W', snap([]), valued());
    expect(res.closedRows.map((r) => r.positionAddress)).toEqual(['GONE']);
    expect(res.transitions.vanished).toEqual([]);
  });
});

function metadataOf(symbol: string) {
  return { resolve: vi.fn(async (m: string[]) => new Map(m.map((x) => [x, { symbol }]))) };
}

function snap(openAddrs: string[]): OnchainWalletSnapshot {
  return {
    owner: 'W',
    slot: 1,
    slotSkew: 0,
    nativeLamports: 0n,
    idleTokens: [],
    positions: openAddrs.map((a) => opv(a)),
    complete: true,
    positionsComplete: true,
  };
}
