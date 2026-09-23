import type { OpenPosition, WalletState } from '@binsight/shared';
import { SOL_MINT } from '@binsight/solana-core';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '@/application/event-bus';
import { HealthMonitor } from '@/application/health-monitor';
import type { OnchainWalletSnapshot, SnapshotPlan } from '@/domain/dlmm';
import { Engine, type EngineDeps } from './index';

// VALUE-ON-DEMAND, with ZERO network (every dep is a stub/spy). The exact on-chain read runs on a
// per-wallet cadence (10 s with open positions, 60 s without); between two exact reads the shared
// price mark re-prices the CACHED holdings at the live Jupiter price for no RPC at all, and emits that
// approximation as non-'fresh' so the NetworthRecorder never persists it.

const W1 = 'Leader1111111111111111111111111111111111111';
const W2 = 'Leader2222222222222222222222222222222222222';
const TOKEN = 'Tok1111111111111111111111111111111111111111';
const TOKEN2 = 'Tok2222222222222222222222222222222222222222';
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

const posOf = (wallet: string) => `Pos-${wallet}`;
const mintOf = (wallet: string) => (wallet === W1 ? TOKEN : TOKEN2);

/** A 1-position SOL-quote snapshot (Y=SOL) holding 1.0 token-X — `withOpen=false` → an idle empty wallet. */
function snapshotOf(
  owner: string,
  withOpen: boolean,
): OnchainWalletSnapshot & { plan: SnapshotPlan } {
  return {
    owner,
    slot: 100,
    slotSkew: 0,
    nativeLamports: 0n,
    idleTokens: [],
    positions: withOpen
      ? [
          {
            positionAddress: posOf(owner),
            lbPair: POOL,
            tokenXMint: mintOf(owner),
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
          },
        ]
      : [],
    complete: true,
    positionsComplete: true,
    plan: { positionKeys: [] } as unknown as SnapshotPlan,
  };
}

function openRow(wallet: string): OpenPosition {
  return {
    positionAddress: posOf(wallet),
    wallet,
    poolAddress: POOL,
    tokenX: 'TOK',
    tokenY: 'SOL',
    tokenXMint: mintOf(wallet),
    strategy: null,
    sizeSol: 0.001,
    pnlSol: 0,
    pnlPctSol: 0,
    claimedFeesSol: 0,
    unclaimedFeesSol: 0,
    rangeStatus: 'in',
    minPrice: 0,
    maxPrice: 1,
    poolPrice: 0.001,
    outOfRangeSince: null,
    openedAt: null,
    updatedAt: 1,
  };
}

function makeEngine(opts: { withOpen: boolean; wallets?: string[]; priceRef: { v: number } }) {
  const wallets = opts.wallets ?? [W1];
  const snapshotWallet = vi.fn(async (owner: string) => snapshotOf(owner, opts.withOpen));
  const getPricesSol = vi.fn(
    async (mints: string[]) => new Map(mints.map((m) => [m, opts.priceRef.v] as const)),
  );
  const bus = new EventBus();
  const states: WalletState[] = [];
  bus.on('state', (s) => states.push(s));

  const deps: EngineDeps = {
    prices: { getPricesSol, getSolUsd: vi.fn(async () => null) },
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
    store: {
      getOpen: vi.fn(async () => []),
      setAuthoritativePnlMany: vi.fn(async () => 0),
    } as unknown as EngineDeps['store'],
    accounts: { monitoredWallets: vi.fn(async () => wallets) },
    bus,
    logger,
    walletTxIngest: {
      ingest: vi.fn(async () => ({
        legs: 0,
        txs: 0,
        flows: 0,
        swaps: 0,
        complete: true,
        wasComplete: true,
      })),
    },
    positionSync: {
      sync: vi.fn(async (wallet: string) => ({
        openPositions: opts.withOpen ? [openRow(wallet)] : [],
        closed: 0,
        closedRows: [],
        transitions: { opened: [], outOfRange: [], backInRange: [], vanished: [] },
      })),
      refreshOpen: vi.fn(async (wallet: string) => ({
        openPositions: opts.withOpen ? [openRow(wallet)] : [],
        transitions: { opened: [], outOfRange: [], backInRange: [], vanished: [] },
      })),
    } as unknown as EngineDeps['positionSync'],
    realizedPnl: {
      computeForWallet: vi.fn(async () => null),
    } as unknown as EngineDeps['realizedPnl'],
    walletRealized: { set: vi.fn(async () => {}), sumFor: vi.fn(async () => 0) },
    backfillConcurrency: 3,
    realizedPnlEnabled: false,
  };

  const engine = new Engine(deps);
  return { engine, snapshotWallet, getPricesSol, states };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('value-on-demand', () => {
  it('an idle wallet (0 open) reads on the SLOW beat — never on the 10s one', async () => {
    // "idle = 0 RPC" went too far once: a wallet total is mostly idle SOL, which moves exactly when a
    // close returns liquidity, and reading nothing froze the headline Net Worth. An idle wallet reads
    // once a minute — two reads over two minutes — and never on the open-position beat.
    const h = makeEngine({ withOpen: false, priceRef: { v: 0.001 } });
    await h.engine.start();
    await vi.advanceTimersByTimeAsync(2_000); // boot: the live read + the post-backfill projection read
    h.snapshotWallet.mockClear();
    h.getPricesSol.mockClear();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(h.snapshotWallet).toHaveBeenCalledTimes(2); // 120s / 60s — NOT the 12 a 10s beat would give
    // Each exact read prices what it read; the shared price mark adds none of its own for a wallet
    // with nothing to re-mark.
    expect(h.getPricesSol).toHaveBeenCalledTimes(2);
    h.engine.stop();
  });

  it('an open wallet gets an EXACT read every 10s, viewer or not (fees accrue, bins move)', async () => {
    // WHY: the price mark only re-prices frozen amounts — without the exact read, a quiet open
    // position's unclaimed fees stay pinned from open until the next on-chain event.
    const h = makeEngine({ withOpen: true, priceRef: { v: 0.001 } });
    await h.engine.start();
    await vi.advanceTimersByTimeAsync(2_000);
    h.snapshotWallet.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.snapshotWallet).toHaveBeenCalledTimes(3);
    h.engine.stop();
  });

  it('between two exact reads the price mark re-prices from cache — zero RPC, emitted as NOT fresh', async () => {
    // WHY: the mark keeps a viewed wallet's value live at the Jupiter price for no Helius credit, but
    // it holds amounts fixed — an approximation. It must surface as 'syncing' so the NetworthRecorder
    // never records it; only the exact read is 'fresh'.
    const priceRef = { v: 0.001 };
    const h = makeEngine({ withOpen: true, priceRef });
    await h.engine.start();
    await vi.advanceTimersByTimeAsync(5_000);

    // A client opens the wallet half-way through the exact cadence → a refresh-on-view EXACT read.
    h.engine.setViewedWallets(new Set([W1]));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.states.at(-1)?.freshness).toBe('fresh');
    expect(h.states.at(-1)?.totals.walletTotalSol).toBeCloseTo(0.001, 9);

    // The price moves; the shared price tick (t=10s) lands 5s after that read.
    priceRef.v = 0.002;
    h.snapshotWallet.mockClear();
    h.states.length = 0;
    await vi.advanceTimersByTimeAsync(4_000);

    expect(h.snapshotWallet).not.toHaveBeenCalled(); // no RPC for the mark
    expect(h.states).toHaveLength(1);
    expect(h.states[0]?.totals.walletTotalSol).toBeCloseTo(0.002, 9); // re-priced at the live price
    expect(h.states[0]?.freshness).toBe('syncing'); // display-only, never persisted
    h.engine.stop();
  });

  it('marks each wallet half-way between two exact reads, never right after one', async () => {
    // WHY: re-pricing a read taken a moment ago is a wasted emit per viewer, but a mark that always
    // lands on a fresh read (both clocks in phase) would never run at all. The 5 s tick with a 5 s
    // minimum age gives exactly one mark between two 10 s reads, whatever their phase.
    const h = makeEngine({ withOpen: true, priceRef: { v: 0.001 } });
    await h.engine.start();
    await vi.advanceTimersByTimeAsync(2_000);
    h.snapshotWallet.mockClear();
    h.states.length = 0;

    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.snapshotWallet).toHaveBeenCalledTimes(2);
    expect(h.states.filter((s) => s.freshness === 'fresh')).toHaveLength(2); // the exact reads
    expect(h.states.filter((s) => s.freshness === 'syncing')).toHaveLength(2); // one mark each
    h.engine.stop();
  });

  it('one shared price fetch re-marks the whole fleet (not one Jupiter call per wallet)', async () => {
    // WHY: the mark runs every 10s; per-wallet price fetches would scale Jupiter traffic with the fleet
    // (and trip its rate limit). One fetch, over the union of the fleet's mints, serves every wallet.
    const h = makeEngine({ withOpen: true, wallets: [W1, W2], priceRef: { v: 0.001 } });
    await h.engine.start();
    await vi.advanceTimersByTimeAsync(5_000);
    h.engine.setViewedWallets(new Set([W1, W2])); // shift both exact reads half-way, as above
    await vi.advanceTimersByTimeAsync(1_000);
    h.getPricesSol.mockClear();
    h.states.length = 0;

    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.getPricesSol).toHaveBeenCalledTimes(1);
    expect([...(h.getPricesSol.mock.calls[0]?.[0] ?? [])].sort()).toEqual([TOKEN, TOKEN2].sort());
    expect(h.states.map((s) => s.scope).sort()).toEqual([W1, W2].sort());
    h.engine.stop();
  });
});
