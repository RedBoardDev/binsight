import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DLMM_PROGRAM_ID } from '../constants';
import type { StreamActivity } from '../types';
import {
  parseLogsNotification,
  TransactionStream,
  type TransactionStreamConfig,
  type WsTransport,
} from './transaction-stream';

// ── Test doubles ──────────────────────────────────────────────────────────────────────────────────────
// These prove the stream's guarantees with ZERO network: a mock WS transport the test drives by hand, and
// a spy activity handler. No real connection is ever opened (the Helius transport is never imported).

const errors: unknown[] = [];
const warnings: unknown[] = [];
const logger = {
  debug() {},
  info() {},
  warn(o: unknown) {
    warnings.push(o);
  },
  error(o: unknown) {
    errors.push(o);
  },
} as unknown as Logger;

const WALLET = 'WALLET_A';
const WALLET_B = 'WALLET_B';

/** A controllable WS transport — the test drives open/message/close; the stream never touches a socket. */
class FakeWsTransport implements WsTransport {
  readonly sent: string[] = [];
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
  /** The server (or network) dropping the socket — as opposed to the stream closing it. */
  drop(): void {
    this.closeCb?.();
  }
  /** Frames the stream sent, parsed. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
  framesOf(method: string): Array<Record<string, unknown>> {
    return this.frames().filter((f) => f.method === method);
  }
  /** The request id of the logsSubscribe frame for `wallet`, or undefined. */
  subscribeIdFor(wallet: string): number | undefined {
    const f = this.framesOf('logsSubscribe').find((x) =>
      JSON.stringify((x.params as unknown[])?.[0]).includes(wallet),
    );
    return f?.id as number | undefined;
  }
  /** The liveness probe: an unsubscribe of subscription 0, which no watch ever creates. */
  probes(): Array<Record<string, unknown>> {
    return this.framesOf('logsUnsubscribe').filter((f) => JSON.stringify(f.params) === '[0]');
  }
}

interface Handled {
  wallet: string;
  activity: StreamActivity;
}

/** Liveness is pushed out of reach by default so it never fires in a test that isn't about it. */
function harness(config?: Partial<TransactionStreamConfig>) {
  const transports: FakeWsTransport[] = [];
  const handled: Handled[] = [];
  const stream = new TransactionStream({
    transportFactory: () => {
      const t = new FakeWsTransport();
      transports.push(t);
      return t;
    },
    logger,
    // Tiny backoff so a fake-timer tick reconnects at once.
    config: { backoffBaseMs: 1, backoffMaxMs: 1, silenceMs: 1e9, probeTimeoutMs: 1e9, ...config },
  });
  const h = {
    stream,
    handled,
    transports,
    transport: () => transports.at(-1)!,
    watch: (wallet = WALLET) =>
      stream.watch(wallet, (w, activity) => handled.push({ wallet: w, activity })),
    /** Confirm `wallet`'s pending subscribe on the current socket, binding it to `subId`. */
    confirm: (wallet: string, subId: number) =>
      h.transport().emit(confirm(h.transport().subscribeIdFor(wallet)!, subId)),
  };
  return h;
}

/** Start, open, and confirm each wallet's subscription as sub id 1, 2, … in order. */
function live(wallets: string[] = [WALLET], config?: Partial<TransactionStreamConfig>) {
  const h = harness(config);
  for (const w of wallets) h.watch(w);
  h.stream.start();
  h.transport().open();
  for (const [i, w] of wallets.entries()) h.confirm(w, i + 1);
  return h;
}

/** A logsNotification frame for `subscription`, carrying a DLMM log unless told otherwise. */
const notification = (
  subscription: number,
  signature: string,
  opts: { dlmm?: boolean; err?: unknown } = {},
) => ({
  jsonrpc: '2.0',
  method: 'logsNotification',
  params: {
    subscription,
    result: {
      context: { slot: 1 },
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

/** A server answer to request `id`, binding `subId` to it. */
const confirm = (id: number, subId: number) => ({ jsonrpc: '2.0', id, result: subId });

beforeEach(() => {
  vi.useFakeTimers();
  errors.length = 0;
  warnings.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('logsSubscribe request shape', () => {
  it('subscribes ONE address per subscription — mentions accepts no more', () => {
    // WHY: `logsSubscribe`'s `mentions` filter takes exactly one address; a multi-address filter is
    // rejected, so the stream must open one subscription per wallet and route by subscription id.
    const h = harness();
    h.watch(WALLET);
    h.watch(WALLET_B);
    h.stream.start();
    h.transport().open();

    const subs = h.transport().framesOf('logsSubscribe');
    expect(subs).toHaveLength(2);
    const mentions = subs.map(
      (s) => ((s.params as unknown[])[0] as { mentions: string[] }).mentions,
    );
    for (const m of mentions) expect(m).toHaveLength(1);
    expect(mentions.map((m) => m[0]).sort()).toEqual([WALLET, WALLET_B]);
    expect((subs[0]!.params as unknown[])[1]).toEqual({ commitment: 'confirmed' });
  });

  it('subscribes a wallet watched while already live, without resubscribing the others', () => {
    // WHY: a wallet added from the UI must stream at once, and must not re-subscribe the fleet.
    const h = live([WALLET]);
    h.watch(WALLET_B);

    const subs = h.transport().framesOf('logsSubscribe');
    expect(subs).toHaveLength(2);
    expect(JSON.stringify(subs.at(-1))).toContain(WALLET_B);
  });

  it('sends nothing before the socket opens, then subscribes every wallet watched meanwhile', () => {
    // WHY: watches registered at boot (before the socket is up) must not be lost or sent into a
    // socket that isn't open yet.
    const h = harness();
    h.stream.start();
    h.watch(WALLET);
    expect(h.transport().sent).toEqual([]);
    h.transport().open();
    expect(h.transport().subscribeIdFor(WALLET)).toBeDefined();
  });
});

describe('one subscription per wallet per connection', () => {
  it('watching the same wallet twice subscribes it once', () => {
    // WHY: two server-side subscriptions for one wallet would deliver every notification twice and
    // double the credits the socket burns. The second watch only replaces the handler.
    const h = harness();
    h.watch(WALLET);
    h.watch(WALLET);
    h.stream.start();
    h.transport().open();
    h.watch(WALLET); // again, while live

    expect(h.transport().framesOf('logsSubscribe')).toHaveLength(1);
  });

  it('a re-watch replaces the handler rather than adding a second one', () => {
    const h = live([WALLET]);
    const second: string[] = [];
    h.stream.watch(WALLET, (w) => second.push(w));

    h.transport().emit(notification(1, 'sig1'));
    expect(h.handled).toEqual([]);
    expect(second).toEqual([WALLET]);
  });

  it('re-subscribes every watched wallet exactly once on reconnect', () => {
    // WHY: subscriptions die with their socket, so a new connection must subscribe everything again —
    // but only once, even though the wallet was already subscribed on the previous connection.
    const h = live([WALLET, WALLET_B]);

    h.transport().drop();
    vi.advanceTimersByTime(5);
    expect(h.transports).toHaveLength(2);
    h.transport().open();
    h.watch(WALLET); // a re-watch right after the reconnect must not add a second subscription

    // A brand-new transport is used per connect, so its frames are the post-reconnect ones only.
    const subs = h.transport().framesOf('logsSubscribe');
    expect(subs).toHaveLength(2);
    expect(subs.map((s) => JSON.stringify(s.params)).sort()).toEqual(
      [WALLET, WALLET_B].map((w) =>
        JSON.stringify([{ mentions: [w] }, { commitment: 'confirmed' }]),
      ),
    );
  });

  it('routes by the NEW subscription id after a reconnect, not the old one', () => {
    // WHY: the server hands out fresh ids per connection; a stale id → wallet map would misroute.
    const h = live([WALLET]);
    h.transport().drop();
    vi.advanceTimersByTime(5);
    h.transport().open();
    h.confirm(WALLET, 42);

    h.transport().emit(notification(1, 'sigOldId'));
    h.transport().emit(notification(42, 'sigNewId'));
    expect(h.handled).toEqual([{ wallet: WALLET, activity: { touchesDlmm: true } }]);
  });
});

describe('delivery', () => {
  it('delivers a DLMM notification to the right wallet, flagged touchesDlmm', () => {
    const h = live([WALLET, WALLET_B]);
    h.transport().emit(notification(2, 'sigB'));
    expect(h.handled).toEqual([{ wallet: WALLET_B, activity: { touchesDlmm: true } }]);
  });

  it('delivers a NON-DLMM notification too, flagged touchesDlmm: false', () => {
    // WHY: a swap or a transfer moves the wallet's token balances even though it moves no position —
    // the engine needs the trigger to refresh the wallet, and uses the flag to skip position work.
    const h = live([WALLET]);
    h.transport().emit(notification(1, 'sigTransfer', { dlmm: false }));
    h.transport().emit(notification(1, 'sigDlmm'));
    expect(h.handled).toEqual([
      { wallet: WALLET, activity: { touchesDlmm: false } },
      { wallet: WALLET, activity: { touchesDlmm: true } },
    ]);
  });

  it('does NOT deliver a FAILED tx — it changed no state', () => {
    // WHY: a failed tx still pays fees and still "mentions" the wallet, but moves no balance and no
    // position; triggering an ingest for it would only spend credits.
    const h = live([WALLET]);
    h.transport().emit(notification(1, 'sigFailed', { err: { InstructionError: [0, 'X'] } }));
    expect(h.handled).toEqual([]);
  });

  it('ignores a notification for an unknown subscription', () => {
    const h = live([WALLET]);
    h.transport().emit(notification(999, 'sigX'));
    expect(h.handled).toEqual([]);
  });

  it('ignores a notification that arrives before its subscription is confirmed', () => {
    // WHY: until the `{id, result}` answer, the sub id belongs to no wallet — guessing would misroute.
    const h = harness();
    h.watch(WALLET);
    h.stream.start();
    h.transport().open();
    h.transport().emit(notification(1, 'sigEarly'));
    expect(h.handled).toEqual([]);
  });

  it('survives garbage frames', () => {
    const h = live([WALLET]);
    h.transport().emit('not json {');
    h.transport().emit({ jsonrpc: '2.0', method: 'somethingElse', params: {} });
    h.transport().emit(notification(1, 'sigAfter'));
    expect(h.handled).toHaveLength(1);
  });
});

describe('dedup per wallet:signature', () => {
  it('delivers a repeated signature for the same wallet exactly once (at-least-once delivery)', () => {
    const h = live([WALLET]);
    for (let i = 0; i < 3; i++) h.transport().emit(notification(1, 'sigDup'));
    expect(h.handled).toEqual([{ wallet: WALLET, activity: { touchesDlmm: true } }]);
  });

  it('delivers ONE signature to EVERY watched wallet it mentions', () => {
    // WHY: a transfer between two watched wallets is news to both — a global signature dedup would
    // silently starve the second wallet of its trigger.
    const h = live([WALLET, WALLET_B]);
    h.transport().emit(notification(1, 'sigShared'));
    h.transport().emit(notification(2, 'sigShared'));
    h.transport().emit(notification(2, 'sigShared'));
    expect(h.handled.map((x) => x.wallet)).toEqual([WALLET, WALLET_B]);
  });

  it('keeps deduping across a reconnect', () => {
    // WHY: the dedup set is in-session, not per-socket — a signature already handled needs no second
    // ingest just because the connection was replaced.
    const h = live([WALLET]);
    h.transport().emit(notification(1, 'sigSeen'));
    h.transport().drop();
    vi.advanceTimersByTime(5);
    h.transport().open();
    h.confirm(WALLET, 7);
    h.transport().emit(notification(7, 'sigSeen'));
    expect(h.handled).toHaveLength(1);
  });

  it('bounds the dedup memory, evicting the oldest signature first', () => {
    // WHY: a long-running process must not grow the set forever; an evicted signature redelivered is
    // merely a redundant (cheap) trigger, never a lost one.
    const h = live([WALLET], { recentSigCapacity: 2 });
    for (const s of ['s1', 's2', 's3']) h.transport().emit(notification(1, s));
    h.transport().emit(notification(1, 's3')); // still remembered
    h.transport().emit(notification(1, 's1')); // evicted → delivered again
    expect(h.handled).toHaveLength(4);
  });
});

describe('server error frames are surfaced', () => {
  it('logs a rejected request instead of discarding it', () => {
    // WHY: this exact silence cost a week. A plan refusing the subscription answered with an error frame
    // the stream dropped on the floor, so a socket that would never deliver anything looked perfectly
    // healthy — no log, no reconnect, no alert.
    const h = harness();
    h.watch(WALLET);
    h.stream.start();
    h.transport().open();

    h.transport().emit({
      jsonrpc: '2.0',
      id: h.transport().subscribeIdFor(WALLET),
      error: { code: -32600, message: 'transactionSubscribe is not available on the free plan' },
    });

    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0])).toContain('not available on the free plan');
  });
});

describe('reconnect', () => {
  it('reconnects after a drop and fires the reconnect + connection-change callbacks', () => {
    // WHY: logsSubscribe has no replay — whatever happened during the outage was simply not delivered,
    // so the engine re-polls every wallet on reconnect. The callback is how it learns.
    const h = harness();
    const reconnects: number[] = [];
    const changes: boolean[] = [];
    h.stream.onReconnect(() => reconnects.push(1));
    h.stream.onConnectionChange((c) => changes.push(c));
    h.watch(WALLET);
    h.stream.start();
    h.transport().open();
    expect(h.stream.isConnected()).toBe(true);

    h.transport().drop();
    expect(h.stream.isConnected()).toBe(false);
    vi.advanceTimersByTime(5);
    h.transport().open();

    expect(h.stream.isConnected()).toBe(true);
    expect(reconnects).toHaveLength(2); // first connect + reconnect
    expect(changes).toEqual([true, false, true]);
  });

  it('does not reconnect after stop()', () => {
    // WHY: a shutdown must not leave a socket reconnecting (and billing) behind it.
    const h = live([WALLET]);
    h.stream.stop();
    expect(h.transports[0]!.closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(h.transports).toHaveLength(1);
    expect(h.stream.isConnected()).toBe(false);
  });
});

describe('liveness probe', () => {
  // Probe after 10 s of silence; give it 4 s. The liveness timer ticks every 2 s.
  const cfg = { silenceMs: 10_000, probeTimeoutMs: 4_000 };

  it('probes a socket that has been silent for silenceMs, with an unsubscribe of id 0', () => {
    // WHY: a half-open socket reads as connected forever and delivers nothing. A quiet socket is also
    // normal (quiet wallets), so silence only triggers a PROBE — one every server must answer.
    const h = live([WALLET], cfg);
    vi.advanceTimersByTime(9_999);
    expect(h.transport().probes()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.transport().probes()).toHaveLength(1);
  });

  it('any traffic postpones the probe', () => {
    // WHY: a socket that is delivering frames is plainly alive; probing it would be noise.
    const h = live([WALLET], cfg);
    vi.advanceTimersByTime(8_000);
    h.transport().emit(notification(1, 'sigKeepAlive'));
    vi.advanceTimersByTime(8_000);
    expect(h.transport().probes()).toHaveLength(0);
    vi.advanceTimersByTime(2_000);
    expect(h.transport().probes()).toHaveLength(1);
  });

  it('an answered probe keeps the socket — and its error answer is not logged as a failure', () => {
    // WHY: the expected answer is an error ("invalid subscription id"); it proves the socket alive and
    // must neither close it nor raise a false "server rejected a request" alarm.
    const h = live([WALLET], cfg);
    vi.advanceTimersByTime(10_000);
    const probe = h.transport().probes()[0]!;
    h.transport().emit({
      jsonrpc: '2.0',
      id: probe.id,
      error: { code: -32602, message: 'Invalid subscription id' },
    });

    vi.advanceTimersByTime(5_000); // past the point an unanswered probe would have closed it
    expect(h.transport().closed).toBe(false);
    expect(h.transports).toHaveLength(1);
    expect(h.stream.isConnected()).toBe(true);
    expect(errors).toEqual([]);
  });

  it('an unanswered probe closes the socket within probeTimeoutMs and reconnects', () => {
    const h = live([WALLET], cfg);
    const reconnects: number[] = [];
    h.stream.onReconnect(() => reconnects.push(1));
    const first = h.transport();

    vi.advanceTimersByTime(10_000); // probe sent
    vi.advanceTimersByTime(3_999);
    expect(first.closed).toBe(false);
    vi.advanceTimersByTime(1); // probeTimeoutMs elapsed without an answer
    expect(first.closed).toBe(true);
    expect(h.stream.isConnected()).toBe(false);
    expect(warnings).toHaveLength(1);

    vi.advanceTimersByTime(1); // backoff
    expect(h.transports).toHaveLength(2);
    h.transport().open();
    expect(h.stream.isConnected()).toBe(true);
    expect(h.transport().framesOf('logsSubscribe')).toHaveLength(1);
    expect(reconnects).toHaveLength(1);
  });
});

describe('a replaced socket is ignored', () => {
  /** A stream whose first socket was killed by the liveness probe and replaced by a live second one. */
  function replaced() {
    const h = live([WALLET], { silenceMs: 10_000, probeTimeoutMs: 4_000 });
    const old = h.transport();
    vi.advanceTimersByTime(14_000); // probe + timeout → `old` closed
    vi.advanceTimersByTime(1); // backoff → second socket
    h.transport().open();
    h.confirm(WALLET, 2);
    return { h, old };
  }

  it("ignores the old socket's late notifications and confirmations", () => {
    // WHY: a socket the stream gave up on can still flush buffered frames. Its sub ids belong to a dead
    // connection — honouring them could misroute a notification or clobber the live id map.
    const { h, old } = replaced();
    old.emit(notification(1, 'sigLate'));
    old.emit(confirm(99, 1));
    expect(h.handled).toEqual([]);

    h.transport().emit(notification(2, 'sigLive'));
    expect(h.handled).toEqual([{ wallet: WALLET, activity: { touchesDlmm: true } }]);
  });

  it("ignores the old socket's late close — it must not tear down its successor", () => {
    // WHY: the real WebSocket fires `close` asynchronously, AFTER the replacement is up; acting on it
    // would drop the healthy socket and start a needless reconnect loop.
    const { h, old } = replaced();
    old.drop();
    expect(h.stream.isConnected()).toBe(true);
    vi.advanceTimersByTime(60);
    expect(h.transports).toHaveLength(2);
    expect(h.transport().closed).toBe(false);
  });

  it("ignores the old socket's late open", () => {
    // WHY: a late `open` would re-run the subscribe loop and double every subscription.
    const { h, old } = replaced();
    const before = h.transport().sent.length;
    old.open();
    expect(h.transport().sent).toHaveLength(before);
    expect(old.sent.filter((s) => s.includes('logsSubscribe'))).toHaveLength(1);
  });
});

describe('unwatch releases the server-side subscription', () => {
  it('sends logsUnsubscribe for the wallet it dropped, and stops delivering to it', () => {
    const h = harness();
    h.watch(WALLET);
    h.stream.start();
    h.transport().open();
    h.confirm(WALLET, 77);

    h.stream.unwatch(WALLET);

    expect(
      h
        .transport()
        .framesOf('logsUnsubscribe')
        .map((f) => f.params),
    ).toEqual([[77]]);
    h.transport().emit(notification(77, 'sigAfterUnwatch'));
    expect(h.handled).toEqual([]);
  });

  it('releases a subscription confirmed AFTER the wallet was unwatched', () => {
    // WHY: otherwise the server keeps a subscription nobody listens to — streaming (and billing)
    // bytes for a wallet the user removed.
    const h = harness();
    h.watch(WALLET);
    h.stream.start();
    h.transport().open();
    const reqId = h.transport().subscribeIdFor(WALLET)!;

    h.stream.unwatch(WALLET);
    h.transport().emit(confirm(reqId, 88)); // late confirmation

    const unsubs = h.transport().framesOf('logsUnsubscribe');
    expect(unsubs.map((u) => u.params)).toEqual([[88]]);
  });

  it('a wallet unwatched then re-watched on the same connection is subscribed again', () => {
    const h = live([WALLET]);
    h.stream.unwatch(WALLET);
    h.watch(WALLET);
    expect(h.transport().framesOf('logsSubscribe')).toHaveLength(2);
  });
});

describe('parseLogsNotification', () => {
  it('extracts subscription, signature, failure and the DLMM touch', () => {
    expect(parseLogsNotification(notification(7, 'sig'))).toEqual({
      subscription: 7,
      signature: 'sig',
      failed: false,
      touchesDlmm: true,
    });
  });

  it('flags a failed tx and a non-DLMM tx', () => {
    expect(parseLogsNotification(notification(1, 's', { err: 'boom' }))?.failed).toBe(true);
    expect(parseLogsNotification(notification(1, 's', { dlmm: false }))?.touchesDlmm).toBe(false);
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
