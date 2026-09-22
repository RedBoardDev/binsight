import { DLMM_PROGRAM_ID } from '@binsight/shared';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalletStreamCursor } from '@/infrastructure/persistence/wallet-stream-cursor-repository';
import {
  parseLogsNotification,
  type StreamActivityReason,
  TransactionStream,
  type TransactionStreamConfig,
  type WalletStreamCursorStore,
  type WsTransport,
} from './transaction-stream';

// ── Test doubles ──────────────────────────────────────────────────────────────────────────────────────
// These prove the stream's guarantees with ZERO network: a mock WS transport, an in-memory cursor store
// (the durability boundary), and a spy activity handler. No real connection is ever opened.

const errors: unknown[] = [];
const logger = {
  debug() {},
  info() {},
  warn() {},
  error(o: unknown) {
    errors.push(o);
  },
} as unknown as Logger;

const WALLET = 'WALLET_A';
const WALLET_B = 'WALLET_B';

/** A controllable WS transport — the test drives open/message/close; the stream never touches a socket. */
class FakeWsTransport implements WsTransport {
  readonly sent: string[] = [];
  pings = 0;
  closed = false;
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
  onError(): void {
    // The stream only debug-logs socket errors; reconnection is driven by onClose.
  }
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {
    this.pings++;
  }
  close(): void {
    this.closed = true;
    this.closeCb?.();
  }

  // ── test drivers ──
  open(): void {
    this.openCb?.();
  }
  emit(data: unknown): void {
    this.msgCb?.(typeof data === 'string' ? data : JSON.stringify(data));
  }
  drop(): void {
    this.closeCb?.();
  }
  /** Frames the stream sent, parsed. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
  /** The request id of the logsSubscribe frame for `wallet`, or undefined. */
  subscribeIdFor(wallet: string): number | undefined {
    const f = this.frames().find(
      (x) =>
        x.method === 'logsSubscribe' &&
        JSON.stringify((x.params as unknown[])?.[0]).includes(wallet),
    );
    return f?.id as number | undefined;
  }
}

class FakeCursorStore implements WalletStreamCursorStore {
  readonly store = new Map<string, WalletStreamCursor>();
  readonly setCalls: Array<{ wallet: string; cursor: WalletStreamCursor }> = [];

  async get(wallet: string): Promise<WalletStreamCursor | null> {
    return this.store.get(wallet) ?? null;
  }
  async set(wallet: string, cursor: WalletStreamCursor): Promise<void> {
    this.store.set(wallet, { ...cursor });
    this.setCalls.push({ wallet, cursor: { ...cursor } });
  }
}

interface Handled {
  wallet: string;
  reason: StreamActivityReason;
}

function harness(config?: Partial<TransactionStreamConfig>, cursors = new FakeCursorStore()) {
  const transports: FakeWsTransport[] = [];
  const handled: Handled[] = [];
  const stream = new TransactionStream({
    transportFactory: () => {
      const t = new FakeWsTransport();
      transports.push(t);
      return t;
    },
    cursors,
    logger,
    // Tiny backoff so a fake-timer tick reconnects instantly; loose ping so it never fires mid-test.
    config: { backoffBaseMs: 1, backoffMaxMs: 1, pingIntervalMs: 1e9, ...config },
  });
  return {
    stream,
    cursors,
    handled,
    transport: () => transports.at(-1)!,
    transports,
    watch: (wallet = WALLET) =>
      stream.watch(wallet, (w, reason) => handled.push({ wallet: w, reason })),
  };
}

/** A logsNotification frame for `subscription`, carrying a DLMM log unless told otherwise. */
const notification = (
  subscription: number,
  signature: string,
  slot: number,
  opts: { dlmm?: boolean; err?: unknown } = {},
) => ({
  jsonrpc: '2.0',
  method: 'logsNotification',
  params: {
    subscription,
    result: {
      context: { slot },
      value: {
        signature,
        err: opts.err ?? null,
        logs:
          opts.dlmm === false
            ? ['Program 11111111111111111111111111111111 invoke [1]']
            : [`Program ${DLMM_PROGRAM_ID} invoke [1]`, 'Program log: Instruction: Swap'],
      },
    },
  },
});

/** Confirm a subscribe request, binding `subId` to it. */
const confirm = (id: number, subId: number) => ({ jsonrpc: '2.0', id, result: subId });

beforeEach(() => {
  vi.useFakeTimers();
  errors.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('logsSubscribe request shape', () => {
  it('subscribes ONE address per subscription — mentions accepts no more', async () => {
    const h = harness();
    h.watch(WALLET);
    h.watch(WALLET_B);
    h.stream.start();
    h.transport().open();
    await h.stream.idle();

    const subs = h
      .transport()
      .frames()
      .filter((f) => f.method === 'logsSubscribe');
    expect(subs).toHaveLength(2);
    for (const s of subs) {
      const filter = (s.params as unknown[])[0] as { mentions: string[] };
      expect(filter.mentions).toHaveLength(1);
    }
    expect(
      subs.map((s) => ((s.params as unknown[])[0] as { mentions: string[] }).mentions[0]).sort(),
    ).toEqual([WALLET, WALLET_B]);
  });

  it('subscribes a wallet watched while already live, without resubscribing the others', async () => {
    const h = harness();
    h.watch(WALLET);
    h.stream.start();
    h.transport().open();
    await h.stream.idle();
    const before = h
      .transport()
      .frames()
      .filter((f) => f.method === 'logsSubscribe').length;

    h.watch(WALLET_B);
    await h.stream.idle();

    const after = h
      .transport()
      .frames()
      .filter((f) => f.method === 'logsSubscribe');
    expect(after).toHaveLength(before + 1);
    expect(JSON.stringify(after.at(-1))).toContain(WALLET_B);
  });
});

describe('routing by subscription id', () => {
  it('delivers a DLMM notification to the right wallet and checkpoints it', async () => {
    const h = harness();
    h.watch(WALLET);
    h.watch(WALLET_B);
    h.stream.start();
    h.transport().open();
    await h.stream.idle();

    const idA = h.transport().subscribeIdFor(WALLET)!;
    const idB = h.transport().subscribeIdFor(WALLET_B)!;
    h.transport().emit(confirm(idA, 101));
    h.transport().emit(confirm(idB, 202));

    h.transport().emit(notification(202, 'sigB', 5_000));
    await h.stream.idle();

    expect(h.handled).toEqual([{ wallet: WALLET_B, reason: 'ws' }]);
    expect(h.cursors.store.get(WALLET_B)).toEqual({ lastSignature: 'sigB', lastSlot: 5_000 });
    expect(h.cursors.store.has(WALLET)).toBe(false);
  });

  it('ignores a notification for an unknown subscription', async () => {
    const h = harness();
    h.watch(WALLET);
    h.stream.start();
    h.transport().open();
    await h.stream.idle();

    h.transport().emit(notification(999, 'sigX', 1));
    await h.stream.idle();
    expect(h.handled).toEqual([]);
  });
});

describe('filtering', () => {
  const live = async () => {
    const h = harness();
    h.watch(WALLET);
    h.stream.start();
    h.transport().open();
    await h.stream.idle();
    h.transport().emit(confirm(h.transport().subscribeIdFor(WALLET)!, 1));
    return h;
  };

  it('ignores a tx that never touched the DLMM program', async () => {
    const h = await live();
    h.transport().emit(notification(1, 'sigOther', 10, { dlmm: false }));
    await h.stream.idle();
    expect(h.handled).toEqual([]);
  });

  it('ignores a FAILED tx — it changed no state to ingest', async () => {
    const h = await live();
    h.transport().emit(notification(1, 'sigFailed', 10, { err: { InstructionError: [0, 'X'] } }));
    await h.stream.idle();
    expect(h.handled).toEqual([]);
  });

  it('handles a duplicate signature exactly once (at-least-once delivery)', async () => {
    const h = await live();
    for (let i = 0; i < 3; i++) h.transport().emit(notification(1, 'sigDup', 10));
    await h.stream.idle();
    expect(h.handled).toEqual([{ wallet: WALLET, reason: 'ws' }]);
  });
});

describe('server error frames are surfaced', () => {
  it('logs a rejected request instead of discarding it', async () => {
    // WHY: this exact silence cost a week. A plan refusing the subscription answered with an error frame
    // the stream dropped on the floor, so a socket that would never deliver anything looked perfectly
    // healthy — no log, no reconnect, no alert.
    const h = harness();
    h.watch(WALLET);
    h.stream.start();
    h.transport().open();
    await h.stream.idle();

    h.transport().emit({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'transactionSubscribe is not available on the free plan' },
    });

    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0])).toContain('not available on the free plan');
  });
});

describe('reconnect recovery (logsSubscribe has no replay)', () => {
  it('hands every cursored wallet to the recovery path on reconnect', async () => {
    // WHY: nothing that happened during the outage was delivered, and no `fromSlot` can ask for it back.
    // Recovery is one getSignaturesForAddress against the cursor — a no-op costs a single credit.
    const cursors = new FakeCursorStore();
    cursors.store.set(WALLET, { lastSignature: 'old', lastSlot: 100 });
    const h = harness(undefined, cursors);
    h.watch(WALLET);
    h.stream.start();
    h.transport().open();
    await h.stream.idle();
    h.handled.length = 0;

    h.transport().drop();
    await vi.advanceTimersByTimeAsync(5);
    h.transport().open();
    await h.stream.idle();

    expect(h.handled).toEqual([{ wallet: WALLET, reason: 'gap-backfill' }]);
  });

  it('re-subscribes every watched wallet after a drop', async () => {
    const h = harness();
    h.watch(WALLET);
    h.stream.start();
    h.transport().open();
    await h.stream.idle();

    h.transport().drop();
    await vi.advanceTimersByTimeAsync(5);
    h.transport().open();
    await h.stream.idle();

    // A brand-new transport is used per connect, so its frames are the post-reconnect ones only.
    expect(
      h
        .transport()
        .frames()
        .filter((f) => f.method === 'logsSubscribe'),
    ).toHaveLength(1);
  });
});

describe('unwatch releases the server-side subscription', () => {
  it('sends logsUnsubscribe for the wallet it dropped', async () => {
    const h = harness();
    h.watch(WALLET);
    h.stream.start();
    h.transport().open();
    await h.stream.idle();
    h.transport().emit(confirm(h.transport().subscribeIdFor(WALLET)!, 77));

    h.stream.unwatch(WALLET);

    const unsub = h
      .transport()
      .frames()
      .find((f) => f.method === 'logsUnsubscribe');
    expect(unsub?.params).toEqual([77]);
  });

  it('releases a subscription confirmed AFTER the wallet was unwatched', async () => {
    const h = harness();
    h.watch(WALLET);
    h.stream.start();
    h.transport().open();
    await h.stream.idle();
    const reqId = h.transport().subscribeIdFor(WALLET)!;

    h.stream.unwatch(WALLET);
    h.transport().emit(confirm(reqId, 88)); // late confirmation

    const unsubs = h
      .transport()
      .frames()
      .filter((f) => f.method === 'logsUnsubscribe');
    expect(unsubs.some((u) => JSON.stringify(u.params) === '[88]')).toBe(true);
  });
});

describe('cursor advances monotonically', () => {
  it('a later (older-slot) signature never rewinds the checkpoint', async () => {
    const h = harness();
    h.watch(WALLET);
    h.stream.start();
    h.transport().open();
    await h.stream.idle();
    h.transport().emit(confirm(h.transport().subscribeIdFor(WALLET)!, 1));

    h.transport().emit(notification(1, 'sigNew', 900));
    await h.stream.idle();
    h.transport().emit(notification(1, 'sigOld', 500));
    await h.stream.idle();

    expect(h.cursors.store.get(WALLET)).toEqual({ lastSignature: 'sigNew', lastSlot: 900 });
  });
});

describe('parseLogsNotification', () => {
  it('extracts subscription, signature, slot, failure and the DLMM touch', () => {
    const p = parseLogsNotification(notification(7, 'sig', 42));
    expect(p).toEqual({
      subscription: 7,
      signature: 'sig',
      slot: 42,
      failed: false,
      touchesDlmm: true,
    });
  });

  it('flags a failed tx and a non-DLMM tx', () => {
    expect(parseLogsNotification(notification(1, 's', 1, { err: 'boom' }))?.failed).toBe(true);
    expect(parseLogsNotification(notification(1, 's', 1, { dlmm: false }))?.touchesDlmm).toBe(
      false,
    );
  });

  it('returns null for a malformed or non-notification message', () => {
    expect(parseLogsNotification({})).toBeNull();
    expect(parseLogsNotification({ params: { subscription: 1 } })).toBeNull();
    expect(
      parseLogsNotification({ params: { subscription: 'x', result: { value: {} } } }),
    ).toBeNull();
    expect(
      parseLogsNotification({ params: { subscription: 1, result: { value: { signature: '' } } } }),
    ).toBeNull();
  });
});
