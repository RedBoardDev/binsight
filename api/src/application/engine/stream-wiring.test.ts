import { DLMM_PROGRAM_ID, TransactionStream, type WsTransport } from '@binsight/solana-core';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '@/application/event-bus';
import { HealthMonitor } from '@/application/health-monitor';
import type { SnapshotPlan } from '@/domain/dlmm';
import type { IngestResult } from '@/domain/ports';
import { Engine, type EngineDeps } from './index';

// INTEGRATION test of the WIRING (Engine ⇄ TransactionStream) with ZERO network: a real
// TransactionStream driven by a fake WS transport, plugged into a real Engine whose ingest and chain
// reads are spies. No real socket is ever opened. What is locked:
//   1. a logsSubscribe notification for a wallet — DLMM or not — funnels into that wallet's delta
//      ingest, after a short settle lag;
//   2. only a DLMM notification (or an ingest that found new txs) forces a position re-discovery;
//   3. the periodic poll is the no-miss backstop (logsSubscribe has no replay): it runs in silence,
//      runs briskly while the socket is down, and a reconnect re-polls every wallet.

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

/** The subscription id the fake server hands back for the wallet's logsSubscribe. */
const SUB_ID = 1;
/** The discovery plan every snapshot returns — reused by a snapshot that does NOT rediscover. */
const PLAN = { positionKeys: [] } as unknown as SnapshotPlan;

function makeEngine() {
  const transports: FakeWsTransport[] = [];
  const stream = new TransactionStream({
    transportFactory: () => {
      const t = new FakeWsTransport();
      transports.push(t);
      return t;
    },
    logger,
    // Push the liveness probe far out so it never fires mid-test (it is proven in the stream's own
    // suite; here we assert the engine wiring).
    config: { silenceMs: 1e9, probeTimeoutMs: 1e9 },
  });

  // `nextTxs` lets a test choose how many NEW txs the delta reports — the signal the actor keys off.
  let nextTxs = 0;
  const ingest = vi.fn(
    async (_wallet: string): Promise<IngestResult> => ({
      legs: 0,
      txs: nextTxs,
      flows: 0,
      swaps: 0,
      complete: true,
      wasComplete: true,
    }),
  );
  const snapshotWallet = vi.fn(async (owner: string, _plan?: SnapshotPlan) => ({
    owner,
    positions: [],
    nativeLamports: 0n,
    idleTokens: [],
    slot: 1,
    slotSkew: 0,
    complete: true,
    positionsComplete: true,
    plan: PLAN,
  }));
  const invalidateIdle = vi.fn();

  const deps: EngineDeps = {
    prices: { getPricesSol: vi.fn(async () => new Map()), getSolUsd: vi.fn(async () => null) },
    stream,
    onchain: {
      snapshotWallet,
      invalidateIdle,
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
    accounts: { monitoredWallets: vi.fn(async () => [WALLET]) },
    bus: new EventBus(),
    logger,
    walletTxIngest: { ingest },
    positionSync: {
      sync: vi.fn(async () => ({
        openPositions: [],
        closed: 0,
        closedRows: [],
        transitions: { opened: [], outOfRange: [], backInRange: [], vanished: [] },
      })),
      refreshOpen: vi.fn(async () => ({
        openPositions: [],
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
  return {
    engine,
    stream,
    ingest,
    snapshotWallet,
    invalidateIdle,
    setNextTxs: (n: number) => {
      nextTxs = n;
    },
    transport: () => transports.at(-1)!,
  };
}

type Harness = ReturnType<typeof makeEngine>;

/** A logsNotification for the wallet's subscription; `dlmm: false` → a plain swap/transfer. */
function notification(sig: string, slot: number, opts: { dlmm?: boolean } = {}): string {
  const logs =
    opts.dlmm === false
      ? ['Program 11111111111111111111111111111111 invoke [1]']
      : [`Program ${DLMM_PROGRAM_ID} invoke [1]`, 'Program log: Instruction: RemoveLiquidity'];
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'logsNotification',
    params: {
      subscription: SUB_ID,
      result: { context: { slot }, value: { signature: sig, err: null, logs } },
    },
  });
}

/** Confirm the wallet's in-flight logsSubscribe so notifications route to it. */
function confirmSubscription(t: FakeWsTransport): void {
  const frame = t.sent.map((x) => JSON.parse(x)).find((f) => f.method === 'logsSubscribe');
  if (frame) t.emit(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: SUB_ID }));
}

/**
 * Start the engine, connect the stream, and settle the boot work (the history backfill + the
 * on-connect fleet resync each ingest once). Returns with the spies CLEARED, so any later call is
 * unambiguously attributable to the action under test.
 */
async function startSettled(h: Harness) {
  await h.engine.start();
  h.transport().open();
  confirmSubscription(h.transport());
  await vi.advanceTimersByTimeAsync(2_000);
  h.ingest.mockClear();
  h.snapshotWallet.mockClear();
  h.invalidateIdle.mockClear();
}

/** Let the actor's post-notification settle lag elapse (the tx must be listed by the RPC first). */
const ACTIVITY_LAG_MS = 1_500;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('TransactionStream is wired as the on-chain trigger', () => {
  it('a DLMM notification for a wallet funnels into its delta ingest, after the settle lag', async () => {
    // WHY: the stream is the LATENCY path — a leader open/close seen on the socket must reach the
    // ingest in seconds. The lag exists because getSignaturesForAddress may not list the just-confirmed
    // tx yet; an ingest fired instantly would page nothing and the close would wait for the next poll.
    const h = makeEngine();
    await startSettled(h);
    expect(h.transport().sent.some((s) => s.includes('logsSubscribe') && s.includes(WALLET))).toBe(
      true,
    );

    h.transport().emit(notification('sigClose', 1_000));
    expect(h.invalidateIdle).toHaveBeenCalledWith(WALLET); // balances moved: drop the idle cache now

    await vi.advanceTimersByTimeAsync(ACTIVITY_LAG_MS - 100);
    expect(h.ingest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.ingest).toHaveBeenCalledTimes(1);
    expect(h.ingest).toHaveBeenCalledWith(WALLET);
    h.engine.stop();
  });

  it('a NON-DLMM mention (swap, transfer) also ingests — it moves the wallet’s balances and swap legs', async () => {
    // WHY: the stream hands over every notification. A market sale of a close's residual is a plain
    // swap: dropping it would leave the idle balance stale and the realized PnL without its exit.
    const h = makeEngine();
    await startSettled(h);

    h.transport().emit(notification('sigSwap', 1_000, { dlmm: false }));
    await vi.advanceTimersByTimeAsync(ACTIVITY_LAG_MS);
    expect(h.invalidateIdle).toHaveBeenCalledWith(WALLET);
    expect(h.ingest).toHaveBeenCalledTimes(1);
    h.engine.stop();
  });

  it('only a DLMM notification forces a re-discovery; a swap reuses the cached plan', async () => {
    // WHY: re-discovery (getProgramAccounts) is the expensive part of a snapshot. A DLMM tx may have
    // opened a position the cached plan doesn't know — skipping discovery there is the old
    // "opens never surface" bug. A plain swap cannot change the position set, so paying for it is waste.
    const h = makeEngine();
    await startSettled(h);

    h.transport().emit(notification('sigSwap', 1_000, { dlmm: false }));
    await vi.advanceTimersByTimeAsync(60_000); // the next (idle-cadence) exact read
    expect(h.snapshotWallet).toHaveBeenCalled();
    expect(h.snapshotWallet).toHaveBeenLastCalledWith(WALLET, PLAN);

    h.snapshotWallet.mockClear();
    h.transport().emit(notification('sigDlmm', 2_000));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.snapshotWallet).toHaveBeenCalled();
    expect(h.snapshotWallet.mock.calls[0]).toEqual([WALLET, undefined]); // no plan → rediscover
    h.engine.stop();
  });

  it('an ingest that found new txs re-reads the chain AT ONCE, with a fresh discovery', async () => {
    // WHY: new transactions may have opened or closed a position. Waiting for the 60s idle beat would
    // leave a fresh open invisible for a minute; reusing the plan would miss it entirely.
    const h = makeEngine();
    await startSettled(h);

    h.setNextTxs(1);
    h.transport().emit(notification('sigOpen', 3_000));
    await vi.advanceTimersByTimeAsync(ACTIVITY_LAG_MS);
    expect(h.snapshotWallet).toHaveBeenCalledWith(WALLET, undefined);
    h.engine.stop();
  });

  it('a periodic safety ingest runs even with total silence — the stream cannot be the no-miss guarantee', async () => {
    // WHY: `logsSubscribe` has NO replay. Anything that happens while the socket is down, or any
    // notification it drops, is never delivered. The backstop is this poll: one getSignaturesForAddress
    // against the durable cursor, a single credit when nothing is new. Deleting it reintroduces a
    // forbidden miss — which is why this asserts the poll FIRES.
    const h = makeEngine();
    await startSettled(h);

    await vi.advanceTimersByTimeAsync(290_000);
    expect(h.ingest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.ingest).toHaveBeenCalledTimes(1);
    expect(h.ingest).toHaveBeenCalledWith(WALLET);
    h.engine.stop();
  });

  it('while the socket is down the poll runs briskly, and the reconnect re-polls every wallet', async () => {
    // WHY: with the socket down the poll is the ONLY thing watching, so it runs every 30s instead of
    // every 5 min. And a reconnect cannot ask for what it missed, so it re-polls at once.
    const h = makeEngine();
    await startSettled(h);

    h.transport().close(); // drop; the stream schedules a reconnect on a fresh (unopened) transport
    await vi.advanceTimersByTimeAsync(31_000);
    expect(h.ingest).toHaveBeenCalledTimes(1);

    h.ingest.mockClear();
    const next = h.transport();
    next.open(); // reconnected: resubscribe, then the fleet resync
    expect(next.sent.some((s) => s.includes('logsSubscribe') && s.includes(WALLET))).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.ingest).toHaveBeenCalledTimes(1);
    h.engine.stop();
  });

  it('a removed wallet is unsubscribed and its late notifications trigger nothing', async () => {
    // WHY: a wallet dropped from every watchlist must stop costing credits — no subscription left
    // open, and no ingest from a notification already in flight.
    const h = makeEngine();
    await startSettled(h);

    h.engine.removeWallet(WALLET);
    expect(h.transport().sent.some((s) => s.includes('logsUnsubscribe'))).toBe(true);
    h.transport().emit(notification('sigLate', 4_000));
    await vi.advanceTimersByTimeAsync(ACTIVITY_LAG_MS);
    expect(h.ingest).not.toHaveBeenCalled();
    h.engine.stop();
  });
});
