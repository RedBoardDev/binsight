import type { ClosedPosition, OpenPosition, WalletState } from '@binsight/shared';
import { SOL_MINT } from '@binsight/solana-core';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '@/application/event-bus';
import { HealthMonitor } from '@/application/health-monitor';
import type { OpenTransitions, SyncResult } from '@/application/position-sync-service';
import type { RealizedPnlResult } from '@/application/realized-pnl';
import type { OnchainPositionValue, OnchainWalletSnapshot, SnapshotPlan } from '@/domain/dlmm';
import type { IngestResult, PositionStore } from '@/domain/ports';
import { Semaphore } from '@/util/concurrency';
import { Engine, type EngineDeps } from './index';
import { WalletActor, type WalletActorDeps } from './wallet-actor';

// The WalletActor contract: ingest → snapshot → projection → realized run ONE STEP AT A TIME per
// wallet. Every case below is an interleaving that used to lose or corrupt data when those steps raced
// each other in the old runtime. The fakes hand out deferred promises so each interleaving is forced
// deterministically — no sleeps, no reliance on scheduling luck.

const WALLET = 'Leader1111111111111111111111111111111111111';
const POS = 'Pos1111111111111111111111111111111111111111';
const POS2 = 'Pos2222222222222222222222222222222222222222';
const POS3 = 'Pos3333333333333333333333333333333333333333';
const TOKEN = 'Tok1111111111111111111111111111111111111111';
const POOL = 'Pool11111111111111111111111111111111111111';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
} as unknown as Logger;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain every pending microtask (a macrotask runs only once the microtask queue is empty). Real
 *  timers only — the fake-timer suites use advanceTimersByTimeAsync instead. */
const flush = () => new Promise<void>((r) => setImmediate(r));

const PLAN = { positionKeys: [] } as unknown as SnapshotPlan;

function rawPosition(): OnchainPositionValue {
  return {
    positionAddress: POS,
    lbPair: POOL,
    tokenXMint: TOKEN,
    tokenYMint: SOL_MINT,
    amountX: 1_000_000n, // 1.0 token @ 6 dp
    amountY: 0n,
    feeX: 0n,
    feeY: 0n,
    decimalsX: 6,
    decimalsY: 9,
    activeId: 0,
    binStep: 100,
    lowerBinId: -100,
    upperBinId: 100,
    lamports: 0n,
  };
}

function snapshot(
  opts: { positionsComplete?: boolean; withPosition?: boolean } = {},
): OnchainWalletSnapshot & { plan: SnapshotPlan } {
  return {
    owner: WALLET,
    slot: 100,
    slotSkew: 0,
    nativeLamports: 0n,
    idleTokens: [],
    positions: opts.withPosition ? [rawPosition()] : [],
    complete: true,
    positionsComplete: opts.positionsComplete ?? true,
    plan: PLAN,
  };
}

function openRow(
  positionAddress = POS,
  rangeStatus: OpenPosition['rangeStatus'] = 'in',
): OpenPosition {
  return {
    positionAddress,
    wallet: WALLET,
    poolAddress: POOL,
    tokenX: 'TOK',
    tokenY: 'SOL',
    tokenXMint: TOKEN,
    strategy: null,
    sizeSol: 0.001,
    pnlSol: 0,
    pnlPctSol: 0,
    claimedFeesSol: 0,
    unclaimedFeesSol: 0,
    rangeStatus,
    minPrice: 0,
    maxPrice: 1,
    poolPrice: 0.001,
    outOfRangeSince: null,
    openedAt: null,
    updatedAt: 1,
  };
}

function closedRow(positionAddress = POS): ClosedPosition {
  return {
    positionAddress,
    wallet: WALLET,
    poolAddress: POOL,
    tokenX: 'TOK',
    tokenY: 'SOL',
    tokenXMint: TOKEN,
    strategy: null,
    pnlSol: 0.1,
    pnlPctSol: 10,
    feesSol: 0,
    depositSol: 1,
    withdrawSol: 1.1,
    openedAt: 1,
    closedAt: 2,
    durationSeconds: 1,
  };
}

const noTransitions = (t: Partial<OpenTransitions> = {}): OpenTransitions => ({
  opened: [],
  outOfRange: [],
  backInRange: [],
  vanished: [],
  ...t,
});

function syncResult(r: Partial<SyncResult> = {}): SyncResult {
  return { openPositions: [], closed: 0, closedRows: [], transitions: noTransitions(), ...r };
}

function ingestResult(r: Partial<IngestResult> = {}): IngestResult {
  return { txs: 0, legs: 0, flows: 0, swaps: 0, complete: true, wasComplete: true, ...r };
}

type Step<T> = T | Deferred<T>;
const settle = <T>(s: Step<T>): Promise<T> =>
  s && typeof s === 'object' && 'promise' in s ? s.promise : Promise.resolve(s as T);

/**
 * One actor over scriptable fakes. Each port pulls its next result from a queue (a plain value, or a
 * Deferred the test resolves when it wants) and falls back to a quiet default. `calls` records every
 * step in the order it STARTED, which is what the serialization assertions read.
 */
function harness(opts: { realizedEnabled?: boolean } = {}) {
  const calls: string[] = [];
  const q = {
    ingest: [] as Step<IngestResult>[],
    sync: [] as Step<SyncResult>[],
    refreshOpen: [] as Step<{ openPositions: OpenPosition[]; transitions: OpenTransitions }>[],
  };
  const chain = { positionsComplete: true };
  const defaultIngest = ingestResult();

  const ingest = vi.fn(async (_wallet: string) => {
    calls.push('ingest');
    return settle(q.ingest.shift() ?? defaultIngest);
  });
  const snapshotWallet = vi.fn(async (_owner: string, _plan?: SnapshotPlan) => {
    calls.push('snapshot');
    return snapshot({ positionsComplete: chain.positionsComplete });
  });
  const sync = vi.fn(async () => {
    calls.push('sync');
    return settle(q.sync.shift() ?? syncResult());
  });
  const refreshOpen = vi.fn(async () => {
    calls.push('refreshOpen');
    return settle(
      q.refreshOpen.shift() ?? {
        openPositions: [...actor.open.values()],
        transitions: noTransitions(),
      },
    );
  });
  const computeForWallet = vi.fn(async (): Promise<RealizedPnlResult | null> => {
    calls.push('fifo');
    return { byPosition: new Map([[POS, 0.1]]), tradingPnlSol: 0 };
  });
  const setAuthoritativePnlMany = vi.fn(async () => 1);
  const bus = new EventBus();
  const events: string[] = [];
  bus.on('opened', (p) => events.push(`opened:${p.positionAddress}`));
  bus.on('rangeChanged', (e) =>
    events.push(`${e.outOfRange ? 'out' : 'in'}:${e.position.positionAddress}`),
  );
  bus.on('closed', (c) => {
    events.push(`closed:${c.positionAddress}`);
    calls.push('closed-event');
  });
  const onState = vi.fn();

  const deps: WalletActorDeps = {
    ingest: { ingest },
    onchain: {
      snapshotWallet,
      invalidateIdle: vi.fn(),
      positionBins: vi.fn(),
      positionHistory: vi.fn(),
      decimalsOf: vi.fn(),
    },
    prices: { getPricesSol: vi.fn(async () => new Map()), getSolUsd: vi.fn(async () => null) },
    positionSync: { sync, refreshOpen } as unknown as WalletActorDeps['positionSync'],
    realizedPnl: { computeForWallet } as unknown as WalletActorDeps['realizedPnl'],
    walletRealized: { set: vi.fn(async () => {}), sumFor: vi.fn(async () => 0) },
    store: { setAuthoritativePnlMany },
    bus,
    health: new HealthMonitor(),
    logger,
    backfillGate: new Semaphore(1),
    realizedEnabled: opts.realizedEnabled ?? false,
    isStreamConnected: () => true,
    onState,
  };
  const actor = new WalletActor(WALLET, [], deps);
  return {
    actor,
    calls,
    q,
    chain,
    events,
    ingest,
    snapshotWallet,
    sync,
    refreshOpen,
    computeForWallet,
    setAuthoritativePnlMany,
    onState,
  };
}

type Harness = ReturnType<typeof harness>;

/** Boot the actor and let the backfill + first projection land. `wasComplete` picks between a known
 *  wallet (history already read before this process started) and a first-ever backfill. */
async function boot(
  h: Harness,
  opts: { wasComplete?: boolean; firstSync?: Step<SyncResult> } = {},
) {
  const wasComplete = opts.wasComplete ?? true;
  h.q.ingest.push(ingestResult({ txs: wasComplete ? 0 : 42, wasComplete }));
  if (opts.firstSync) h.q.sync.push(opts.firstSync);
  h.actor.start();
  await flush();
}

afterEach(() => vi.useRealTimers());

describe('WalletActor — one step at a time', () => {
  it('boot: live value first, then the projection once the history is in', async () => {
    // WHY: the live total must not wait for a (possibly hours-long) history backfill, but a projection
    // must: projecting half a history would close positions whose open isn't ingested yet.
    const h = harness();
    const backfill = deferred<IngestResult>();
    h.q.ingest.push(backfill);
    h.actor.start();
    await flush();
    expect(h.snapshotWallet).toHaveBeenCalledTimes(1); // the live value is up
    expect(h.onState).toHaveBeenCalledTimes(1);
    expect(h.sync).not.toHaveBeenCalled(); // …but nothing is projected mid-backfill

    backfill.resolve(ingestResult({ txs: 10, wasComplete: false }));
    await flush();
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.actor.reconciled).toBe(true);
  });

  it('(1) an ingest that lands while a projection is running is projected afterwards — no lost close', async () => {
    // WHY (the old `needsSync` race): the ingest ran concurrently with a projection, set "needs sync",
    // and the projection's completion then cleared that flag — the close the ingest had just written
    // was never projected, and its notification never went out. Now the ingest cannot start until the
    // projection finished (and cleared its own dirty flag), so what the ingest found gets a projection
    // of its own.
    const h = harness();
    const firstSync = deferred<SyncResult>();
    await boot(h, { firstSync });
    expect(h.sync).toHaveBeenCalledTimes(1); // the first projection is in flight

    h.actor.resync(); // a stream notification / poll wants an ingest right now
    await flush();
    expect(h.ingest).toHaveBeenCalledTimes(1); // only the backfill: the ingest WAITS for the projection

    h.q.ingest.push(ingestResult({ txs: 1 })); // …and it will find the close
    h.q.sync.push(syncResult({ closed: 1, closedRows: [closedRow()] }));
    firstSync.resolve(syncResult({ openPositions: [openRow()] }));
    await flush();

    expect(h.calls.slice(h.calls.indexOf('sync'))).toEqual([
      'sync', // the first projection…
      'ingest', // …then the deferred ingest…
      'snapshot',
      'sync', // …whose close gets a full projection of its own
      'closed-event',
    ]);
    expect(h.events).toContain(`closed:${POS}`);
  });

  it('coalesces a burst: many ingest requests during a running ingest are ONE follow-up ingest', async () => {
    // WHY: a burst of notifications for one wallet (a multi-tx rebalance) must not queue N
    // getSignaturesForAddress calls — the next ingest already reads everything since the cursor.
    const h = harness();
    await boot(h);
    h.ingest.mockClear();
    const running = deferred<IngestResult>();
    h.q.ingest.push(running);
    h.actor.resync();
    await flush();
    for (let i = 0; i < 5; i++) h.actor.resync();
    running.resolve(ingestResult());
    await flush();
    expect(h.ingest).toHaveBeenCalledTimes(2);
  });

  it('(2) the realized pass tops up the ingest, and a close it finds is projected BEFORE the FIFO runs', async () => {
    // WHY: the realized pass ingests first so the residual sale (usually seconds after the close) is in.
    // If that top-up also brings in the close itself, the FIFO must see it as CLOSED — reading the
    // positions table before the projection would report the position open, skip it, and leave the
    // close without authoritative PnL until some unrelated later pass. The old runtime ingested here
    // and never reprojected.
    const h = harness({ realizedEnabled: true });
    h.q.ingest.push(ingestResult({ txs: 0 })); // backfill of a known wallet: nothing new
    h.q.ingest.push(ingestResult({ txs: 1 })); // the realized top-up: the close lands here
    h.q.sync.push(syncResult({ openPositions: [openRow()] })); // first projection: POS open
    h.q.sync.push(syncResult({ closed: 1, closedRows: [closedRow()] })); // the close's projection
    h.actor.start();
    await flush();

    const fifo = h.calls.indexOf('fifo');
    const secondSync = h.calls.indexOf('sync', h.calls.indexOf('sync') + 1);
    expect(secondSync).toBeGreaterThan(-1);
    expect(fifo).toBeGreaterThan(secondSync); // projection first, FIFO second
    expect(h.calls.slice(h.calls.indexOf('sync') + 1, fifo)).toEqual([
      'ingest', // the realized top-up…
      'snapshot',
      'sync', // …its close projected…
      'closed-event',
    ]);
    expect(h.setAuthoritativePnlMany).toHaveBeenCalledWith(new Map([[POS, 0.1]]));
  });

  it('(4) a snapshot that missed a live position never projects — not the full sync, not the open refresh', async () => {
    // WHY: `positionsComplete: false` means some open position is absent from `positions`. Projecting
    // it would send that position to 'pending_close' (or, in a full sync, close it) — a phantom close
    // and a spurious notification. The live value still updates; the projection waits for a whole read.
    const h = harness();
    h.chain.positionsComplete = false;
    await boot(h);
    expect(h.snapshotWallet).toHaveBeenCalledTimes(2);
    expect(h.onState).toHaveBeenCalledTimes(2); // the value is still emitted
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.actor.reconciled).toBe(false);

    // The pending projection is not forgotten: the next complete read does it.
    h.chain.positionsComplete = true;
    h.actor.tick(Date.now() + 60_000);
    await flush();
    expect(h.sync).toHaveBeenCalledTimes(1);

    // Once reconciled, an incomplete read must not refresh the open set either.
    h.chain.positionsComplete = false;
    h.actor.tick(Date.now() + 60_000);
    await flush();
    expect(h.snapshotWallet).toHaveBeenCalledTimes(4);
    expect(h.refreshOpen).not.toHaveBeenCalled();
    expect(h.sync).toHaveBeenCalledTimes(1);
  });

  it('(5) an open position that vanished from the chain triggers an ingest and a FULL reprojection', async () => {
    // WHY: the cadence refresh only sees that the position is gone; its close (withdraw + close legs,
    // realized PnL, the close notification) only exists once the closing tx is ingested and the whole
    // wallet reprojected. Waiting for the 5-min poll would leave the card stuck in 'pending_close'.
    const h = harness();
    await boot(h, { firstSync: syncResult({ openPositions: [openRow()] }) });
    expect([...h.actor.open.keys()]).toEqual([POS]);

    h.q.refreshOpen.push({ openPositions: [], transitions: noTransitions({ vanished: [POS] }) });
    h.q.ingest.push(ingestResult({ txs: 1 }));
    h.q.sync.push(syncResult({ closed: 1, closedRows: [closedRow()] }));
    const before = h.calls.length;
    h.actor.tick(Date.now() + 10_000); // the open-position cadence
    await flush();

    expect(h.calls.slice(before)).toEqual([
      'snapshot',
      'refreshOpen', // sees POS gone…
      'ingest', // …fetches the close…
      'snapshot',
      'sync', // …and reprojects the whole wallet
      'closed-event',
    ]);
    expect(h.events).toContain(`closed:${POS}`);
  });

  it('(5b) a vanished position is reprojected in full at once even if the ingest found nothing', async () => {
    // WHY: the closing tx may already be ingested (its legs are in) — then no new tx will ever come to
    // trigger the reprojection. The vanish itself requests an ingest AND a full re-read right away,
    // never a cheap open refresh that would leave the position in limbo (up to a minute if it was
    // the wallet's last open position).
    const h = harness();
    await boot(h, { firstSync: syncResult({ openPositions: [openRow()] }) });
    h.q.refreshOpen.push({ openPositions: [], transitions: noTransitions({ vanished: [POS] }) });
    h.actor.tick(Date.now() + 10_000);
    await flush();
    expect(h.ingest).toHaveBeenCalledTimes(2); // backfill + the vanish-triggered ingest (0 txs)
    expect(h.sync).toHaveBeenCalledTimes(2); // the full reprojection followed immediately
    expect(h.refreshOpen).toHaveBeenCalledTimes(1);
  });

  it('(6a) a first-ever backfill announces nothing; the next projection does', async () => {
    // WHY: on a wallet's first-ever backfill every open position is "new" to the empty table — an
    // "opened" / "out of range" push for each would be a notification storm about old positions. Once
    // a projection this process trusts exists, a real open or range crossing must be announced.
    const h = harness();
    await boot(h, {
      wasComplete: false,
      firstSync: syncResult({
        openPositions: [openRow(POS, 'out_up')],
        transitions: noTransitions({ opened: [openRow(POS, 'out_up')] }),
      }),
    });
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual([]);

    h.q.ingest.push(ingestResult({ txs: 1 }));
    h.q.sync.push(
      syncResult({
        openPositions: [openRow(POS, 'in'), openRow(POS2)],
        transitions: noTransitions({ opened: [openRow(POS2)], backInRange: [openRow(POS)] }),
      }),
    );
    h.actor.resync();
    await flush();
    expect(h.events).toEqual([`opened:${POS2}`, `in:${POS}`]);
  });

  it('(6c) a failed backfill stays silent until a projection of the complete history', async () => {
    // WHY: when the backfill throws, the actor cannot tell a known wallet from a first-ever one, and
    // the resumed backfill will bring in OLDER open positions that are not news. It stays silent up
    // to and including the first projection of the complete history; the one after announces.
    const h = harness();
    const backfill = deferred<IngestResult>();
    h.q.ingest.push(backfill);
    h.q.sync.push(
      syncResult({
        openPositions: [openRow()],
        transitions: noTransitions({ opened: [openRow()] }),
      }),
    );
    h.actor.start();
    await flush();
    backfill.reject(new Error('rpc down'));
    await flush();
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual([]);

    h.q.ingest.push(ingestResult({ txs: 1 }));
    h.q.sync.push(
      syncResult({
        openPositions: [openRow(), openRow(POS2)],
        transitions: noTransitions({ opened: [openRow(POS2)] }),
      }),
    );
    h.actor.resync();
    await flush();
    expect(h.events).toEqual([]); // the history just completed: this projection is the baseline

    h.q.ingest.push(ingestResult({ txs: 1 }));
    h.q.sync.push(
      syncResult({
        openPositions: [openRow(), openRow(POS2), openRow(POS3)],
        transitions: noTransitions({ opened: [openRow(POS3)] }),
      }),
    );
    h.actor.resync();
    await flush();
    expect(h.events).toEqual([`opened:${POS3}`]);
  });

  it('(6b) a known wallet announces from its first projection (what changed while we were down)', async () => {
    // WHY: for a wallet whose history was already complete, the persisted open set IS a trusted
    // baseline: a position opened (or pushed out of range) while the process was down is real news.
    const h = harness();
    await boot(h, {
      wasComplete: true,
      firstSync: syncResult({
        openPositions: [openRow(POS, 'out_down')],
        transitions: noTransitions({
          opened: [openRow(POS2)],
          outOfRange: [openRow(POS, 'out_down')],
        }),
      }),
    });
    expect(h.events).toEqual([`opened:${POS2}`, `out:${POS}`]);
  });
});

// ── (3) The shared price mark lives on the Engine (one Jupiter fetch for the whole fleet) ──

describe('Engine price mark — display only', () => {
  beforeEach(() => vi.useFakeTimers());

  it('(3) a price mark never touches the position store (nor the projection)', async () => {
    // WHY: the mark holds amounts fixed and re-prices at the live Jupiter price — an approximation.
    // Persisting it once let a mark computed from a pre-close snapshot write a just-closed position back
    // as open. It must only EMIT; every write comes from an exact read's projection.
    const storeCalls: string[] = [];
    const store = new Proxy({} as PositionStore, {
      get: (_t, prop) => {
        if (prop === 'then') return undefined;
        return (..._args: unknown[]) => {
          storeCalls.push(String(prop));
          if (prop === 'getOpen' || prop === 'getOpenOrPendingClose') return Promise.resolve([]);
          return Promise.resolve(0);
        };
      },
    });
    const price = { v: 0.001 };
    const snapshotWallet = vi.fn(async () => snapshot({ withPosition: true }));
    const sync = vi.fn(async () => syncResult({ openPositions: [openRow()] }));
    const refreshOpen = vi.fn(async () => ({
      openPositions: [openRow()],
      transitions: noTransitions(),
    }));
    const bus = new EventBus();
    const states: WalletState[] = [];
    bus.on('state', (s) => states.push(s));
    const deps: EngineDeps = {
      prices: {
        getPricesSol: vi.fn(async () => new Map([[TOKEN, price.v]])),
        getSolUsd: vi.fn(async () => null),
      },
      stream: {
        watch: vi.fn(),
        unwatch: vi.fn(),
        isConnected: () => true,
        onReconnect: vi.fn(),
        onConnectionChange: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      },
      onchain: {
        snapshotWallet,
        invalidateIdle: vi.fn(),
        positionBins: vi.fn(),
        positionHistory: vi.fn(),
        decimalsOf: vi.fn(),
      },
      health: new HealthMonitor(),
      strategy: { backfill: vi.fn(async () => {}) } as unknown as EngineDeps['strategy'],
      store,
      accounts: { monitoredWallets: vi.fn(async () => [WALLET]) },
      bus,
      logger,
      walletTxIngest: { ingest: vi.fn(async () => ingestResult()) },
      positionSync: { sync, refreshOpen } as unknown as EngineDeps['positionSync'],
      realizedPnl: {
        computeForWallet: vi.fn(async () => null),
      } as unknown as EngineDeps['realizedPnl'],
      walletRealized: { set: vi.fn(async () => {}), sumFor: vi.fn(async () => 0) },
      backfillConcurrency: 1,
      realizedPnlEnabled: false,
    };
    const engine = new Engine(deps);
    await engine.start();
    await vi.advanceTimersByTimeAsync(5_000); // boot + first projection; the exact reads are at t=0
    // A viewer arrives half-way through the exact cadence → an exact read at t=5s, so the price tick
    // at t=10s falls half-way between two exact reads — exactly where the mark is meant to land.
    engine.setViewedWallets(new Set([WALLET]));
    await vi.advanceTimersByTimeAsync(1_000);

    storeCalls.length = 0;
    snapshotWallet.mockClear();
    sync.mockClear();
    refreshOpen.mockClear();
    states.length = 0;
    price.v = 0.002;
    await vi.advanceTimersByTimeAsync(4_000); // → t=10s: the price tick

    expect(states).toHaveLength(1); // the mark DID run and emit…
    expect(states[0]?.freshness).toBe('syncing'); // …as a display-only approximation
    expect(states[0]?.totals.walletTotalSol).toBeCloseTo(0.002, 9);
    expect(snapshotWallet).not.toHaveBeenCalled(); // zero RPC
    expect(storeCalls).toEqual([]); // never persisted
    expect(sync).not.toHaveBeenCalled();
    expect(refreshOpen).not.toHaveBeenCalled();
    engine.stop();
  });
});
