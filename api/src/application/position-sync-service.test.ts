import { type ClosedPosition, type OpenPosition, SOL_MINT } from '@binsight/shared';
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
      getStrategies: vi.fn(async () => new Map<string, never>()),
    };

    const snapshot: OnchainWalletSnapshot = {
      owner: 'W',
      slot: 1,
      slotSkew: 0,
      nativeLamports: 0n,
      idleTokens: [],
      positions: [opv('OPEN')],
      complete: true,
    };

    const sync = new PositionSync(legPnl, metadata, repo, silent);
    const res = await sync.sync('W', snapshot, valued());

    // No prior persisted open row for CLOSED (getOpenOrPendingClose → []), so it's NOT a newly-closed transition:
    // closedRows is empty even though the closed COUNT is 1 (this is the backfill-safety property).
    expect(res.open).toBe(1);
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
      getStrategies: vi.fn(async () => new Map()),
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
      getStrategies: vi.fn(async () => new Map<string, never>()),
    };
    const snapshot: OnchainWalletSnapshot = {
      owner: 'W',
      slot: 1,
      slotSkew: 0,
      nativeLamports: 0n,
      idleTokens: [],
      positions: [opv('OPEN')],
      complete: true,
    };
    const open = await new PositionSync(
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
      getStrategies: vi.fn(async () => new Map<string, never>()),
      /** Test-only helper to force the cadence's pending_close mark without a full refreshOpen. */
      _markPendingClose: (addr: string) => {
        const v = byAddr.get(addr);
        if (v) v.status = 'pending_close';
      },
    };
  };

  const snap = (openAddrs: string[]): OnchainWalletSnapshot => ({
    owner: 'W',
    slot: 1,
    slotSkew: 0,
    nativeLamports: 0n,
    idleTokens: [],
    positions: openAddrs.map((a) => opv(a)),
    complete: true,
  });

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
