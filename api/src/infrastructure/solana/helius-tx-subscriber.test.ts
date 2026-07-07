import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable in-memory WebSocket standing in for undici's (hoisted: vi.mock factories run before imports).
// Tests drive `open()` / `message()` / server `close` and inspect the JSON-RPC frames the subscriber `send`s.
const h = vi.hoisted(() => {
  type Listener = (ev: { data?: unknown }) => void;
  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly readyState = FakeWebSocket.OPEN;
    readonly sent: Array<Record<string, unknown>> = [];
    private readonly listeners = new Map<string, Listener[]>();
    constructor(readonly url: string) {
      sockets.push(this);
    }
    addEventListener(type: string, cb: Listener): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
    }
    send(data: string): void {
      this.sent.push(JSON.parse(data));
    }
    close(): void {
      this.emit('close', {});
    }
    emit(type: string, ev: { data?: unknown }): void {
      for (const cb of this.listeners.get(type) ?? []) cb(ev);
    }
    open(): void {
      this.emit('open', {});
    }
    message(obj: unknown): void {
      this.emit('message', { data: JSON.stringify(obj) });
    }
  }
  const sockets: FakeWebSocket[] = [];
  return { FakeWebSocket, sockets };
});
vi.mock('undici', () => ({ WebSocket: h.FakeWebSocket }));

import {
  HeliusTxSubscriber,
  isSubscriptionBlind,
  parseSubAck,
  parseTxNotification,
  WS_BLIND_MISS_THRESHOLD,
} from './helius-tx-subscriber';
import { WS_PING_INTERVAL_MS } from './ws-keepalive';

// REAL subscription response observed on the Developer plan (2026-06-24).
const SUB_ACK = { jsonrpc: '2.0', id: 1, result: 3084839 };

// Notification in Helius's DOCUMENTED FORMAT (transactionSubscribe).
const TX_NOTIF = {
  jsonrpc: '2.0',
  method: 'transactionNotification',
  params: {
    subscription: 4743323479349712,
    result: {
      signature:
        '5moMXe6VW7L7aQZskcAkKGQ1y19qqUT1teQKBNAAmipzdxdqVLAdG47WrsByFYNJSAGa9TByv15oygnqYvP6Hn2p',
      transaction: {
        transaction: ['...base64...'],
        meta: {
          logMessages: ['Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo invoke [1]'],
          postTokenBalances: [],
        },
      },
      slot: 224341380,
    },
  },
};

describe('helius-tx-subscriber — frame parsing (documented format + real ack)', () => {
  it('parseSubAck extracts id + subId from the confirmation', () => {
    expect(parseSubAck(SUB_ACK)).toEqual({ id: 1, subId: 3084839 });
  });

  it('parseSubAck returns null on a notification (not an ack)', () => {
    expect(parseSubAck(TX_NOTIF)).toBeNull();
  });

  it('parseTxNotification extracts subId, signature and logs', () => {
    const n = parseTxNotification(TX_NOTIF);
    expect(n).not.toBeNull();
    expect(n?.subId).toBe(4743323479349712);
    expect(n?.signature).toBe(
      '5moMXe6VW7L7aQZskcAkKGQ1y19qqUT1teQKBNAAmipzdxdqVLAdG47WrsByFYNJSAGa9TByv15oygnqYvP6Hn2p',
    );
    expect(n?.logs).toContain('Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo invoke [1]');
  });

  it('parseTxNotification returns null on an ack (not a notification)', () => {
    expect(parseTxNotification(SUB_ACK)).toBeNull();
  });

  it('parseTxNotification tolerates absent logs (→ [])', () => {
    const noMeta = {
      method: 'transactionNotification',
      params: { subscription: 7, result: { signature: 'sig', transaction: {} } },
    };
    expect(parseTxNotification(noMeta)?.logs).toEqual([]);
  });
});

describe('helius-tx-subscriber — full-tx reshape (WS fast-path, finding #32)', () => {
  const DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
  // A jsonParsed + transactionDetails:full notification: result.transaction = { transaction:{message,signatures},
  // meta:{innerInstructions,...} }. This is what Helius delivers under the subscription options we send — so the
  // fast-path can classify from the payload WITHOUT re-fetching the tx over RPC.
  const TX_NOTIF_FULL = {
    jsonrpc: '2.0',
    method: 'transactionNotification',
    params: {
      subscription: 99,
      result: {
        signature: 'SIGFULL',
        slot: 224341380,
        transaction: {
          transaction: { message: { accountKeys: [], instructions: [] }, signatures: ['SIGFULL'] },
          meta: {
            err: null,
            logMessages: [`Program ${DLMM} invoke [1]`],
            innerInstructions: [
              { index: 0, instructions: [{ programId: DLMM, data: 'deadbeef' }] },
            ],
          },
          version: 0,
        },
      },
    },
  };

  it('reshapes a full jsonParsed payload into a ParsedTransactionWithMeta (the #117 gate survives the transport)', () => {
    // WHY (#32): the WS already carries the full tx — classify must decode from THESE bytes, not re-buy it over
    // RPC. The reshape must preserve exactly what the DLMM gate reads: meta.innerInstructions + transaction.signatures.
    const n = parseTxNotification(TX_NOTIF_FULL);
    expect(n?.tx).not.toBeNull();
    expect(n?.tx?.meta?.innerInstructions).toHaveLength(1); // the truncation-proof DLMM signal (#117) is intact
    expect(n?.tx?.transaction?.signatures?.[0]).toBe('SIGFULL');
    // Not delivered by the notification → null, and the poll never backfills it: a WS-seen sig is deduped, so the
    // contiguous poll never re-classifies it. No live consumer reads the tracker's openedAt/closedAt (reconcile
    // uses Mirror.openedAt), so the null is tolerated on the WS path.
    expect(n?.tx?.blockTime).toBeNull();
  });

  it('returns tx:null for an INCOMPLETE payload → classify falls back to the RPC fetch (never-miss preserved)', () => {
    // WHY (never-miss): trusting an incomplete payload could read a real close as non-DLMM and burn it in `seen`
    // (the poll never re-classifies a seen sig) → a permanently missed close. So an incomplete payload MUST refetch.
    // (a) meta without an innerInstructions array (the documented summary/log-only fixture) → cannot gate → refetch.
    expect(parseTxNotification(TX_NOTIF)?.tx).toBeNull();
    // (b) a base64 tx tuple (not the jsonParsed { message, signatures } object) → no signatures array → refetch.
    const base64Payload = {
      method: 'transactionNotification',
      params: {
        subscription: 7,
        result: {
          signature: 'sig',
          transaction: {
            transaction: ['...base64...', 'base64'],
            meta: { innerInstructions: [], logMessages: [] },
          },
        },
      },
    };
    expect(parseTxNotification(base64Payload)?.tx).toBeNull();
  });
});

describe('helius-tx-subscriber — unwatch (Inc.3b S4 leader-set changes)', () => {
  const log = pino({ level: 'silent' });
  const ack = (id: number, subId: number) => ({ jsonrpc: '2.0', id, result: subId });
  const notif = (subId: number, signature: string) => ({
    jsonrpc: '2.0',
    method: 'transactionNotification',
    params: {
      subscription: subId,
      result: { signature, transaction: { meta: { logMessages: [] } } },
    },
  });
  /** subIds this fake ever acked, per wallet: reqId of the subscribe frame for `wallet` → ack it with `subId`. */
  const ackWallet = (ws: (typeof h.sockets)[number], wallet: string, subId: number): void => {
    const frame = ws.sent.find(
      (f) =>
        f.method === 'transactionSubscribe' &&
        (f.params as Array<{ accountInclude?: string[] }>)[0]?.accountInclude?.[0] === wallet,
    );
    if (!frame) throw new Error(`no subscribe frame for ${wallet}`);
    ws.message(ack(frame.id as number, subId));
  };

  let sub: HeliusTxSubscriber;
  beforeEach(() => {
    vi.useFakeTimers(); // reconnect backoff + heartbeat run on timers — keep them deterministic and inert
    h.sockets.length = 0;
  });
  afterEach(() => {
    sub.stop();
    vi.useRealTimers();
  });

  it('unwatch sends transactionUnsubscribe and DROPS further notifications for that wallet only', () => {
    // WHY: on a leader-set shrink the hub unwatches the removed leader; a notification still in flight for it must
    // never reach a detector (the leader is drained), while the remaining leaders' delivery is untouched.
    const seenA: string[] = [];
    const seenB: string[] = [];
    sub = new HeliusTxSubscriber('ws://test', log);
    sub.watch('WALLET_A', (sig) => seenA.push(sig));
    sub.watch('WALLET_B', (sig) => seenB.push(sig));
    sub.start();
    const ws = h.sockets[0];
    if (!ws) throw new Error('no socket');
    ws.open();
    ackWallet(ws, 'WALLET_A', 11);
    ackWallet(ws, 'WALLET_B', 22);

    sub.unwatch('WALLET_A');
    const unsub = ws.sent.find((f) => f.method === 'transactionUnsubscribe');
    expect(unsub?.params).toEqual([11]); // the live server-side subscription is torn down, not just ignored

    ws.message(notif(11, 'sigA'));
    ws.message(notif(22, 'sigB'));
    expect(seenA).toEqual([]); // unwatched → dropped
    expect(seenB).toEqual(['sigB']); // untouched
  });

  it('after a reconnect, ONLY the remaining watched wallets are re-subscribed', () => {
    // WHY: reconnects replay `watched` — a stale entry would silently re-subscribe a removed leader forever,
    // resurrecting detection (and cost) for a leader no user copies.
    sub = new HeliusTxSubscriber('ws://test', log);
    sub.watch('WALLET_A', () => {});
    sub.watch('WALLET_B', () => {});
    sub.start();
    const ws1 = h.sockets[0];
    if (!ws1) throw new Error('no socket');
    ws1.open();
    sub.unwatch('WALLET_A');

    ws1.close(); // server drop → backoff reconnect
    vi.advanceTimersByTime(5_000);
    const ws2 = h.sockets[1];
    if (!ws2) throw new Error('no reconnect socket');
    ws2.open();
    const resubbed = ws2.sent
      .filter((f) => f.method === 'transactionSubscribe')
      .map((f) => (f.params as Array<{ accountInclude?: string[] }>)[0]?.accountInclude?.[0]);
    expect(resubbed).toEqual(['WALLET_B']);
  });

  it('a subscription ack arriving AFTER unwatch does not resurrect delivery (pre-ack race)', () => {
    // WHY: unwatch can race the subscribe ack; a late ack must not re-register the sub → notifications for it
    // would otherwise flow to a drained leader's (gone) callback path.
    const seen: string[] = [];
    sub = new HeliusTxSubscriber('ws://test', log);
    sub.watch('WALLET_A', (sig) => seen.push(sig));
    sub.start();
    const ws = h.sockets[0];
    if (!ws) throw new Error('no socket');
    ws.open(); // subscribe sent, ack NOT yet received
    sub.unwatch('WALLET_A');
    const frame = ws.sent.find((f) => f.method === 'transactionSubscribe');
    ws.message(ack(frame?.id as number, 33)); // late ack
    ws.message(notif(33, 'sigLate'));
    expect(seen).toEqual([]);
  });
});

describe('helius-tx-subscriber — WS-blind signal (silent subscription drop, #201)', () => {
  const log = pino({ level: 'silent' });
  const ack = (id: number, subId: number) => ({ jsonrpc: '2.0', id, result: subId });
  const notif = (subId: number, signature: string) => ({
    jsonrpc: '2.0',
    method: 'transactionNotification',
    params: {
      subscription: subId,
      result: { signature, transaction: { meta: { logMessages: [] } } },
    },
  });
  // A benign keepalive reply: an inbound frame that is NEITHER an ack NOR a notification (a JSON-RPC error for the
  // unknown `ping` method). It advances CONNECTION liveness (resets unansweredPings) but is NOT subscription
  // activity — the crux of #201: this must never make a dead subscription look healthy.
  const keepaliveReply = (id: number) => ({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'Method not found' },
  });
  const ackWallet = (ws: (typeof h.sockets)[number], wallet: string, subId: number): void => {
    const frame = ws.sent.find(
      (f) =>
        f.method === 'transactionSubscribe' &&
        (f.params as Array<{ accountInclude?: string[] }>)[0]?.accountInclude?.[0] === wallet,
    );
    if (!frame) throw new Error(`no subscribe frame for ${wallet}`);
    ws.message(ack(frame.id as number, subId));
  };

  let sub: HeliusTxSubscriber | undefined;
  beforeEach(() => {
    vi.useFakeTimers(); // heartbeat + reconnect run on timers — keep them deterministic
    h.sockets.length = 0;
    sub = undefined;
  });
  afterEach(() => {
    sub?.stop(); // the pure-function test creates no subscriber
    vi.useRealTimers();
  });

  it('isSubscriptionBlind trips only when connected AND watching AND the miss streak hits the threshold', () => {
    // WHY: a dropped subscription is a DISTINCT failure from a dropped connection — it must not fire while
    // disconnected (that is a connection alert) nor with nothing to watch, and only after enough poll-only events
    // to rule out the benign WS-outran-RPC re-observation.
    expect(isSubscriptionBlind(true, 1, WS_BLIND_MISS_THRESHOLD)).toBe(true);
    expect(isSubscriptionBlind(true, 1, WS_BLIND_MISS_THRESHOLD - 1)).toBe(false);
    expect(isSubscriptionBlind(false, 1, WS_BLIND_MISS_THRESHOLD)).toBe(false); // not connected
    expect(isSubscriptionBlind(true, 0, WS_BLIND_MISS_THRESHOLD)).toBe(false); // nothing watched
  });

  it('fires onWsBlind(true) after a run of poll-only misses, then onWsBlind(false) when a notification arrives', () => {
    // WHY (#201): the poll surfacing leader events the WS never delivered is the ONLY proof a subscription was
    // silently dropped; a real notification proves it is delivering again and must clear the signal.
    const blindEvents: boolean[] = [];
    sub = new HeliusTxSubscriber('ws://test', log);
    sub.watch('WALLET_A', () => {});
    sub.onWsBlind((b) => blindEvents.push(b));
    sub.start();
    const ws = h.sockets[0];
    if (!ws) throw new Error('no socket');
    ws.open();
    ackWallet(ws, 'WALLET_A', 11);

    for (let i = 0; i < WS_BLIND_MISS_THRESHOLD - 1; i++) sub.noteMissedByWs();
    expect(blindEvents).toEqual([]); // under the threshold — not yet blind (tolerates the RPC-lag re-observation)
    sub.noteMissedByWs();
    expect(blindEvents).toEqual([true]); // threshold reached → blind

    ws.message(notif(11, 'sigA')); // the subscription delivered → recovered
    expect(blindEvents).toEqual([true, false]);
  });

  it('a keepalive reply keeps the CONNECTION alive but does NOT clear a blind subscription (the #201 crux)', () => {
    // WHY: the whole bug is that keepalive traffic makes a dead subscription look healthy. A keepalive reply must
    // advance connection liveness WITHOUT counting as subscription activity, so blindness is not falsely cleared.
    const blindEvents: boolean[] = [];
    sub = new HeliusTxSubscriber('ws://test', log);
    sub.watch('WALLET_A', () => {});
    sub.onWsBlind((b) => blindEvents.push(b));
    sub.start();
    const ws = h.sockets[0];
    if (!ws) throw new Error('no socket');
    ws.open();
    ackWallet(ws, 'WALLET_A', 11);
    const activityAtConnect = sub.subscriptionActivityAt();

    for (let i = 0; i < WS_BLIND_MISS_THRESHOLD; i++) sub.noteMissedByWs();
    expect(blindEvents).toEqual([true]);

    vi.advanceTimersByTime(1_000);
    ws.message(keepaliveReply(999)); // connection liveness only
    expect(blindEvents).toEqual([true]); // STILL blind — a keepalive reply is not a delivery
    expect(sub.subscriptionActivityAt()).toBe(activityAtConnect); // and it did not count as subscription activity
  });

  it('subscriptionActivityAt advances on a delivered notification, never on a keepalive reply', () => {
    sub = new HeliusTxSubscriber('ws://test', log);
    sub.watch('WALLET_A', () => {});
    sub.start();
    const ws = h.sockets[0];
    if (!ws) throw new Error('no socket');
    const t0 = Date.now();
    ws.open();
    ackWallet(ws, 'WALLET_A', 11);
    expect(sub.subscriptionActivityAt()).toBe(t0); // seeded at connect

    vi.advanceTimersByTime(1_000);
    ws.message(keepaliveReply(999));
    expect(sub.subscriptionActivityAt()).toBe(t0); // keepalive reply → unchanged (connection liveness only)

    vi.advanceTimersByTime(1_000);
    ws.message(notif(11, 'sigA'));
    expect(sub.subscriptionActivityAt()).toBe(t0 + 2_000); // real delivery → advanced
  });

  it('an idle subscription (no misses) is never flagged blind, even across a heartbeat tick', () => {
    // WHY (#52 lesson): silence alone is legitimate (an idle leader). Only poll-confirmed misses may trip blind —
    // otherwise the signal would cry wolf on every quiet leader and mask the real one.
    const blindEvents: boolean[] = [];
    sub = new HeliusTxSubscriber('ws://test', log);
    sub.watch('WALLET_A', () => {});
    sub.onWsBlind((b) => blindEvents.push(b));
    sub.start();
    const ws = h.sockets[0];
    if (!ws) throw new Error('no socket');
    ws.open();
    ackWallet(ws, 'WALLET_A', 11);

    vi.advanceTimersByTime(WS_PING_INTERVAL_MS); // one heartbeat tick, no misses
    ws.message(keepaliveReply(999)); // the keepalive is answered → connection healthy
    expect(blindEvents).toEqual([]); // never blind while idle
  });

  it('disconnect clears an active blind signal (a down socket is a connection failure, not a blind subscription)', () => {
    const blindEvents: boolean[] = [];
    sub = new HeliusTxSubscriber('ws://test', log);
    sub.watch('WALLET_A', () => {});
    sub.onWsBlind((b) => blindEvents.push(b));
    sub.start();
    const ws = h.sockets[0];
    if (!ws) throw new Error('no socket');
    ws.open();
    ackWallet(ws, 'WALLET_A', 11);
    for (let i = 0; i < WS_BLIND_MISS_THRESHOLD; i++) sub.noteMissedByWs();
    expect(blindEvents).toEqual([true]);

    ws.close(); // server drop → the blind signal must clear (connection-change alert takes over)
    expect(blindEvents).toEqual([true, false]);
  });
});
