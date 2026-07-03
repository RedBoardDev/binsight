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

import { HeliusTxSubscriber, parseSubAck, parseTxNotification } from './helius-tx-subscriber';

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
