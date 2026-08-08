import { DLMM_PROGRAM_ID, type RuntimeSettings } from '@binsight/shared';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '@/application/event-bus';
import { HealthMonitor } from '@/application/health-monitor';
import type { AppConfig } from '@/config/env';
import type { WalletStreamCursor } from '@/infrastructure/persistence/wallet-stream-cursor-repository';
import {
  TransactionStream,
  type WalletStreamCursorStore,
  type WsTransport,
} from '@/infrastructure/solana/transaction-stream';
import { Engine, type EngineDeps } from './index';

// Step 5b INTEGRATION test — proves the WIRING (engine ⇄ TransactionStream) with ZERO network: a real
// TransactionStream driven by a mock WS transport + an in-memory cursor store, plugged into a real Engine
// whose `walletTxIngest.ingest` is the spy. NO real Helius socket is ever opened (the real ws-transport adapter
// is never imported here). Two guarantees are locked:
//   1. a logsSubscribe notification for a wallet funnels into the engine's triggerOnchainSync
//      (= the SAME cursor-based delta ingest the deleted BACKSTOP sweep used to drive), and registration
//      routes to the STREAM;
//   2. the BACKSTOP_INGEST_MS fleet timer is GONE — idle time alone never triggers a periodic delta ingest.

const WALLET = 'Leader1111111111111111111111111111111111111';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
} as unknown as Logger;

/** A controllable WS transport — the test drives open/message; the stream never touches a socket. */
class FakeWsTransport implements WsTransport {
  readonly sent: string[] = [];
  private openCb?: () => void;
  private msgCb?: (data: string) => void;
  private closeCb?: () => void;

  onOpen(cb: () => void): void {
    this.openCb = cb;
  }
  onMessage(cb: (data: string) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  onError(): void {}
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {}
  close(): void {
    this.closeCb?.();
  }

  // ── test drivers ──
  open(): void {
    this.openCb?.();
  }
  emit(data: string): void {
    this.msgCb?.(data);
  }
}

/** In-memory durable cursor store (the WalletStreamCursorRepository's role) — no DB needed for the wiring. */
class FakeCursorStore implements WalletStreamCursorStore {
  private readonly store = new Map<string, WalletStreamCursor>();
  async get(wallet: string): Promise<WalletStreamCursor | null> {
    return this.store.get(wallet) ?? null;
  }
  async set(wallet: string, cursor: WalletStreamCursor): Promise<void> {
    this.store.set(wallet, { ...cursor });
  }
}

// The poll knobs are inert now (nothing polls) but still part of the RuntimeSettings wire contract.
const settings: RuntimeSettings = {
  meteoraTargetRps: 15,
  pollMinMs: 1_000,
  pollMaxMs: 30_000,
  pollIdleMs: 300_000,
  barkKey: '',
  presenceTimeoutSeconds: 30,
};

/** A do-nothing async fn (resolved) — used for every dep method the onchain wiring path doesn't exercise. */
const noopAsync = () => Promise.resolve(undefined as never);

function makeEngine() {
  const transports: FakeWsTransport[] = [];
  const stream = new TransactionStream({
    transportFactory: () => {
      const t = new FakeWsTransport();
      transports.push(t);
      return t;
    },
    cursors: new FakeCursorStore(),
    logger,
    // Push ping/gap timers far out so they never fire mid-test (the gap detector is proven in Step 5a;
    // here we assert the engine wiring, not re-test the detector).
    config: { pingIntervalMs: 1e9 },
  });

  // The single assertion target: triggerOnchainSync delta-ingests via walletTxIngest.ingest(wallet).
  // `nextTxs` lets a test choose how many NEW txs the delta reports — the signal the discovery gate keys off.
  let nextTxs = 0;
  const walletTxIngest = {
    ingest: vi.fn(async () => ({ legs: 0, txs: nextTxs, flows: 0, swaps: 0, complete: true })),
  };
  // Returns a minimal snapshot whose `.plan` doSnapshot caches — lets a test assert the discovery gate:
  // a real new-tx activity must FORCE a re-discovery (snapshotWallet called with NO cached plan).
  const snapshotWallet = vi.fn(async () => ({
    positions: [],
    nativeLamports: 0,
    idleTokens: [],
    slot: 1,
    plan: { positionKeys: [] },
  }));
  const appConfig = {
    BACKFILL_CONCURRENCY: 3,
    REALIZED_PNL_ENABLED: false,
    historyDays: 365,
  } as unknown as AppConfig;

  const deps: EngineDeps = {
    prices: {
      getPricesSol: vi.fn(async () => new Map()),
      getSolUsd: vi.fn(async () => null),
    } as unknown as EngineDeps['prices'],
    stream,
    onchain: {
      snapshotWallet,
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
    bus: new EventBus(),
    logger,
    appConfig,
    walletTxIngest: walletTxIngest as unknown as EngineDeps['walletTxIngest'],
    positionSync: {
      sync: vi.fn(async () => ({ open: 0, closed: 0, closedRows: [], openPositions: [] })),
      refreshOpen: vi.fn(async () => []),
    } as unknown as EngineDeps['positionSync'],
    realizedPnl: { computeForWallet: vi.fn() } as unknown as EngineDeps['realizedPnl'],
  };

  const engine = new Engine(deps);
  return {
    engine,
    stream,
    walletTxIngest,
    snapshotWallet,
    setNextTxs: (n: number) => {
      nextTxs = n;
    },
    transport: () => transports.at(-1)!,
  };
}

/** Build a logsNotification for the subscription bound to `wallet`, carrying a DLMM log. */
function notification(sig: string, slot: number, _wallet: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'logsNotification',
    params: {
      subscription: SUB_ID,
      result: {
        context: { slot },
        value: {
          signature: sig,
          err: null,
          logs: [`Program ${DLMM_PROGRAM_ID} invoke [1]`, 'Program log: Instruction: Swap'],
        },
      },
    },
  });
}

/** The subscription id the fake server hands back for the wallet's logsSubscribe. */
const SUB_ID = 1;

/** Confirm the wallet's in-flight logsSubscribe so notifications route to it. */
function confirmSubscription(t: { sent: string[]; emit: (d: string) => void }): void {
  const frame = t.sent.map((x) => JSON.parse(x)).find((f) => f.method === 'logsSubscribe');
  if (frame) t.emit(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: SUB_ID }));
}

/**
 * Start the engine, connect the stream, and settle the connect-time work (the historical backfill + the
 * onReconnect fleet resync both delta-ingest once on boot). Returns with `walletTxIngest.ingest` CLEARED, so any
 * subsequent call is unambiguously attributable to the action under test.
 */
async function startSettled(h: ReturnType<typeof makeEngine>) {
  await h.engine.start();
  h.transport().open();
  await h.stream.idle();
  confirmSubscription(h.transport());
  await vi.advanceTimersByTimeAsync(2_000); // drain backfill + the on-connect resync + one engine tick
  h.walletTxIngest.ingest.mockClear();
  h.snapshotWallet.mockClear();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Step 5b: TransactionStream is wired as the on-chain trigger', () => {
  it('a stream notification for a wallet funnels into triggerOnchainSync (delta ingest), via the STREAM', async () => {
    // WHY: the no-miss design swapped the TRIGGER (was an unconditional fleet timer) for live WS activity.
    // The contract that must hold: a logsSubscribe notification → the SAME cursor-based delta ingest
    // (triggerOnchainSync → walletTxIngest.ingest(wallet)). If this regresses, a leader open/close detected on
    // the socket would never reach ingestion — a forbidden miss.
    const h = makeEngine();
    await startSettled(h);

    // Registration went to the transactionSubscribe stream (the wallet is in a real subscribe frame).
    expect(h.transport().sent.some((s) => s.includes(WALLET))).toBe(true);

    // Drive a DLMM notification for the wallet → handler → onStreamActivity → triggerOnchainSync (after the
    // short settle lag the engine applies so the just-confirmed tx is visible to getSignaturesForAddress).
    h.transport().emit(notification('sigOpen', 1_000, WALLET));
    await h.stream.idle();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(h.walletTxIngest.ingest).toHaveBeenCalledTimes(1);
    expect(h.walletTxIngest.ingest).toHaveBeenCalledWith(WALLET);

    h.engine.stop();
  });

  it('a periodic safety ingest runs even with total silence — the stream cannot be the no-miss guarantee', async () => {
    // WHY: `logsSubscribe` is the only WS method available on every plan, and it has NO replay. Anything
    // that happens while the socket is down is never delivered and cannot be requested afterwards, so a
    // WS-only trigger would silently lose it. The backstop is this poll: one getSignaturesForAddress
    // against the durable cursor, a single credit when nothing is new. Deleting it would reintroduce a
    // forbidden miss — which is why this asserts the poll FIRES, not that it is absent.
    const h = makeEngine();
    await startSettled(h);

    // Just under the connected cadence: nothing yet.
    await vi.advanceTimersByTimeAsync(290_000);
    expect(h.walletTxIngest.ingest).not.toHaveBeenCalled();

    // Past it: exactly one catch-up, with no stream activity whatsoever.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.walletTxIngest.ingest).toHaveBeenCalledTimes(1);
    expect(h.walletTxIngest.ingest).toHaveBeenCalledWith(WALLET);

    h.engine.stop();
  });

  it('one delta ingest covers legs, cash-flows and swaps — no second paging pass', async () => {
    // WHY: cash-flows and swap legs used to be paged separately through the Enhanced API at 100 credits
    // per page, billed even when nothing was new — ~200cr burned per EMPTY resync, and a flapping socket
    // did that on every reconnect. They now come out of the SAME transaction fetch the leg ingest already
    // performs, so an empty resync costs one getSignaturesForAddress and nothing else. This test pins the
    // "exactly one ingest call per activity" contract that makes that true.
    const h = makeEngine();
    await startSettled(h);

    h.setNextTxs(0);
    h.transport().emit(notification('sigNoop', 1_000, WALLET));
    await h.stream.idle();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.walletTxIngest.ingest).toHaveBeenCalledTimes(1);

    h.setNextTxs(1);
    h.transport().emit(notification('sigReal', 2_000, WALLET));
    await h.stream.idle();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.walletTxIngest.ingest).toHaveBeenCalledTimes(2);
    expect(h.walletTxIngest.ingest).toHaveBeenLastCalledWith(WALLET);

    h.engine.stop();
  });

  it('a real new-tx WS activity FORCES a re-discovery — newly-opened positions are actually found', async () => {
    // WHY (regression): the open-detection bug. The legacy logsSubscribe path set needsDiscovery on every
    // open/add/remove, so the next snapshot re-ran getProgramAccountsV2 and FOUND the new position. The
    // transactionStream path lost that — discovery then only ran on the 10-min SAFETY_REDISCOVER_MS, so a
    // freshly-OPENED position never surfaced (open:0 for every wallet, regardless of duration). After boot
    // caches a snapshot plan, a real new-tx activity MUST snapshot with NO cached plan (rediscover) — if it
    // reuses the cached plan, discovery is skipped and the open is never found: the regression is back.
    const h = makeEngine();
    await startSettled(h); // boot runs a discovery and caches a snapshot plan
    h.snapshotWallet.mockClear();

    h.setNextTxs(1); // a real open/add/remove landed in the delta
    h.transport().emit(notification('sigOpen', 3_000, WALLET));
    await h.stream.idle();
    await vi.advanceTimersByTimeAsync(1_500);

    // Re-discovery forced: snapshotWallet called with an UNDEFINED plan (not the cached one) → gPAv2 re-runs.
    expect(h.snapshotWallet).toHaveBeenCalledWith(WALLET, undefined);

    h.engine.stop();
  });
});
