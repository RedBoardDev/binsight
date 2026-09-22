import {
  type OpenPosition,
  type RuntimeSettings,
  SOL_MINT,
  type WalletState,
} from '@binsight/shared';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '@/application/event-bus';
import { HealthMonitor } from '@/application/health-monitor';
import type { AppConfig } from '@/config/env';
import type { OnchainWalletSnapshot, SnapshotPlan } from '@/domain/dlmm';
import { Engine, type EngineDeps } from './index';

// Step 6 — VALUE-ON-DEMAND. Proves, with ZERO network (every dep is a stub/spy):
//   1. an idle wallet (0 open, no viewer) issues NO recurring on-chain read — the blind 30s
//      WALLET_BALANCE_REFRESH_MS getMultipleAccounts snapshot is gone;
//   2. the shared price tick re-marks a VIEWED open wallet from CACHED data + the live price WITHOUT
//      any snapshotWallet/getMultipleAccounts call (the gateway is asserted untouched);
//   3. that re-mark is emitted as an APPROXIMATE, NON-'fresh' state, so the NetworthRecorder never
//      persists it (only an exact read is authoritative).

const WALLET = 'Leader1111111111111111111111111111111111111';
const TOKEN = 'Tok1111111111111111111111111111111111111111';
const POS = 'Pos1111111111111111111111111111111111111111';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
} as unknown as Logger;

// The poll knobs are inert now (nothing polls) but still part of the RuntimeSettings wire contract.
const settings: RuntimeSettings = {
  meteoraTargetRps: 15,
  pollMinMs: 1_000,
  pollMaxMs: 30_000,
  pollIdleMs: 300_000,
  barkKey: '',
  presenceTimeoutSeconds: 30,
};

const noopAsync = () => Promise.resolve(undefined as never);

/** A 1-position SOL-quote snapshot (Y=SOL) holding 1.0 token-X — `withOpen=false` → an idle empty wallet. */
function snapshotFactory(withOpen: boolean): OnchainWalletSnapshot & { plan: SnapshotPlan } {
  const plan = {
    positionKeys: [],
    lbPairByPos: new Map(),
    coverageByPos: new Map(),
    lbPairKeys: [],
    binArrayKeys: [],
    binArrayMeta: [],
  } as unknown as SnapshotPlan;
  return {
    owner: WALLET,
    slot: 100,
    slotSkew: 0,
    nativeLamports: 0n,
    idleTokens: [],
    positions: withOpen
      ? [
          {
            positionAddress: POS,
            lbPair: 'Pool11111111111111111111111111111111111111',
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
          },
        ]
      : [],
    complete: true,
    plan,
  };
}

function openRow(): OpenPosition {
  return {
    positionAddress: POS,
    wallet: WALLET,
    poolAddress: 'Pool11111111111111111111111111111111111111',
    tokenX: 'TOK',
    tokenY: 'SOL',
    tokenXMint: TOKEN,
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

function makeEngine(opts: { withOpen: boolean; priceRef: { v: number } }) {
  const snapshotWallet = vi.fn(async () => snapshotFactory(opts.withOpen));
  const getPricesSol = vi.fn(async () => new Map([[TOKEN, opts.priceRef.v]]));

  const streamStub = {
    watch: vi.fn(),
    unwatch: vi.fn(),
    isConnected: () => true,
    onReconnect: vi.fn(),
    onConnectionChange: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };

  const appConfig = {
    BACKFILL_CONCURRENCY: 3,
    REALIZED_PNL_ENABLED: false,
    historyDays: 365,
  } as unknown as AppConfig;

  const bus = new EventBus();
  const states: WalletState[] = [];
  bus.on('state', (s) => states.push(s));

  const deps: EngineDeps = {
    prices: { getPricesSol, getSolUsd: vi.fn(async () => null) } as unknown as EngineDeps['prices'],
    stream: streamStub as unknown as EngineDeps['stream'],
    onchain: {
      snapshotWallet,
      invalidateIdle: vi.fn(),
      positionBins: vi.fn(),
      positionHistory: vi.fn(),
      decimalsOf: vi.fn(),
    } as unknown as EngineDeps['onchain'],
    health: new HealthMonitor(),
    strategy: { init: noopAsync, backfill: noopAsync } as unknown as EngineDeps['strategy'],
    repo: { getOpen: vi.fn(async () => []) } as unknown as EngineDeps['repo'],
    config: {
      getSettings: () => settings,
      listNotifRules: () => [],
      init: noopAsync,
    } as unknown as EngineDeps['config'],
    accounts: {
      monitoredWallets: vi.fn(async () => [WALLET]),
    } as unknown as EngineDeps['accounts'],
    bus,
    logger,
    appConfig,
    walletTxIngest: {
      ingest: vi.fn(async () => ({ legs: 0, txs: 0, flows: 0, swaps: 0, complete: true })),
    } as unknown as EngineDeps['walletTxIngest'],
    positionSync: {
      sync: vi.fn(async () => ({
        open: opts.withOpen ? 1 : 0,
        closed: 0,
        closedRows: [],
        openPositions: opts.withOpen ? [openRow()] : [],
      })),
      refreshOpen: vi.fn(async () => (opts.withOpen ? [openRow()] : [])),
    } as unknown as EngineDeps['positionSync'],
    realizedPnl: { computeForWallet: vi.fn() } as unknown as EngineDeps['realizedPnl'],
    walletRealized: {
      set: async () => {},
      sumFor: async () => 0,
    } as unknown as EngineDeps['walletRealized'],
  };

  const engine = new Engine(deps);
  return { engine, snapshotWallet, getPricesSol, states };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Step 6: value-on-demand', () => {
  it('an idle wallet (0 open, no viewer) reads on the SLOW beat — never on the 10s one', async () => {
    // The blind 30s timer is gone, but "idle = 0 RPC" went too far: a wallet total is mostly idle SOL,
    // which moves exactly when a close returns liquidity. Reading nothing left the headline Net Worth
    // frozen at its last value, and the curve unsampled, for as long as nothing was open. An idle wallet
    // now reads once a minute — two reads over two minutes — and still never on the open-position beat.
    const h = makeEngine({ withOpen: false, priceRef: { v: 0.001 } });
    await h.engine.start();
    await vi.advanceTimersByTimeAsync(2_000); // drain the initial backfill (its single doSnapshot)
    expect(h.snapshotWallet).toHaveBeenCalledTimes(1);
    h.snapshotWallet.mockClear();
    h.getPricesSol.mockClear();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(h.snapshotWallet).toHaveBeenCalledTimes(2); // 120s / 60s — NOT the 12 a 10s beat would give
    // Each snapshot prices what it read, so there are exactly as many price fetches as snapshots. The
    // shared price-mark tick still contributes none of its own: it skips the un-viewed wallet.
    expect(h.getPricesSol).toHaveBeenCalledTimes(2);
    h.engine.stop();
  });

  it('a viewed open wallet per 10s tick: ONE aligned exact fee/size read, then a fresh-price re-mark', async () => {
    // WHY: ccf00d8 aligned the open-position EXACT read (fees/size — the `doSnapshot` gate) to the 10s
    // shared price-mark cadence, so a VIEWED open wallet costs exactly ONE gateway read per 10s tick
    // (bounded to viewed wallets — the idle test proves un-viewed ones still cost 0 recurring RPC). The
    // zero-RPC price-mark then re-prices off the Jupiter price and emits LAST as the display-only,
    // NON-'fresh' approximate state, so the NetworthRecorder never persists it.
    const priceRef = { v: 0.001 };
    const h = makeEngine({ withOpen: true, priceRef });
    await h.engine.start();
    await vi.advanceTimersByTimeAsync(2_000); // backfill → caches lastSnapshot + open row

    // A client opens the wallet → refresh-on-connect EXACT read (allowed), emitted 'fresh'.
    h.engine.setViewedWallets(new Set([WALLET]));
    await vi.advanceTimersByTimeAsync(50);
    const exactCalls = h.snapshotWallet.mock.calls.length;
    expect(h.states.at(-1)!.freshness).toBe('fresh'); // exact read persists
    expect(h.states.at(-1)!.totals.walletTotalSol).toBeCloseTo(0.001, 9);

    // Price moves; advance one 10s tick → the aligned exact fee/size read fires once, then the price-mark.
    priceRef.v = 0.002;
    h.states.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.snapshotWallet).toHaveBeenCalledTimes(exactCalls + 1); // exactly ONE aligned exact read per tick
    expect(h.getPricesSol).toHaveBeenCalled(); // the free Jupiter fetch DID run
    const marked = h.states.at(-1)!;
    expect(marked.totals.walletTotalSol).toBeCloseTo(0.002, 9); // re-priced at the fresh price
    expect(marked.freshness).not.toBe('fresh'); // price-mark emits LAST ⇒ display-only, not persisted
    h.engine.stop();
  });
});
