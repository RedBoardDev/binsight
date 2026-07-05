/**
 * Copy-bot · Phase 1.2 (C) — isolated WebSocket client over Helius `transactionSubscribe` (LaserStream).
 *
 * Why a separate client: `transactionSubscribe` is a Helius (LaserStream) method, with a notification format
 * different from `logsSubscribe`. We do NOT touch the prod `HeliusSubscriber` (used by binsight's live) — we
 * isolate the bot's transport here. Available on the **Developer** plan (since April 2026), same endpoint
 * `wss://mainnet.helius-rpc.com`.
 *
 * Role: low-latency trigger. Completeness stays guaranteed by the LeaderDetector's cursor poll; this client
 * only delivers early (signature + logs) what the poll would re-cover. Resilience modeled on
 * `HeliusSubscriber` (backoff + jitter reconnect, anti-silence heartbeat, re-subscribe on reconnect).
 */
import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import type { Logger } from 'pino';
import { WebSocket } from 'undici';
import { isWsDead, WS_PING_INTERVAL_MS } from './ws-keepalive';
import {
  BACKOFF_BASE_MS,
  isSilentTooLong,
  nextBackoffMs,
  reconnectDelayMs,
} from './ws-reconnect-policy';

/** Called per tx of the watched wallet: the signature, the logs (DLMM pre-filter on the consumer side), and the
 *  full parsed tx reconstructed from the delivered payload — the fast-path classifies from it, skipping an RPC
 *  re-fetch (finding #32). `tx` is `null` when the payload is incomplete → the consumer falls back to the fetch. */
export type TxActivityCb = (
  signature: string,
  logs: string[],
  tx: ParsedTransactionWithMeta | null,
) => void;

/** Subscription confirmation `{ id, result: subscriptionId }` → null otherwise. (Pure, testable.) */
export function parseSubAck(msg: Record<string, unknown>): { id: number; subId: number } | null {
  if (typeof msg.id === 'number' && typeof msg.result === 'number') {
    return { id: msg.id, subId: msg.result };
  }
  return null;
}

export interface ParsedTxNotification {
  subId: number;
  signature: string;
  logs: string[];
  /** The full parsed tx reconstructed from the delivered payload — the WS fast-path classifies from it and
   *  skips the RPC re-fetch (finding #32). `null` when the payload is incomplete → the consumer RPC-fetches. */
  tx: ParsedTransactionWithMeta | null;
}

/**
 * Reshapes a `transactionNotification` result (encoding `jsonParsed` + transactionDetails `full`) into the
 * `ParsedTransactionWithMeta` the detection pipeline already consumes, so the WS fast-path can classify from the
 * DELIVERED bytes instead of re-fetching the tx over RPC (finding #32). PURE, testable.
 *
 * Returns `null` unless the payload is STRUCTURALLY COMPLETE for the #117 DLMM gate: `meta.innerInstructions`
 * (an array — the truncation-proof DLMM signal that classify decodes) AND the inner `transaction.signatures`
 * (an array, i.e. the jsonParsed tx object, not a base64 tuple) must BOTH be present. An incomplete payload
 * yields `null` so the caller falls back to the authoritative RPC fetch — the never-miss guarantee is preserved,
 * never weakened. The notification carries no `blockTime` → `null` (non-load-bearing for the open/close
 * decision; the cursor poll re-covers the audit-grade timestamp).
 */
export function reshapeFullTx(result: Record<string, unknown>): ParsedTransactionWithMeta | null {
  const wsTx = result.transaction as Record<string, unknown> | undefined;
  const meta = wsTx?.meta as Record<string, unknown> | undefined;
  const inner = wsTx?.transaction as Record<string, unknown> | undefined;
  if (!meta || !Array.isArray(meta.innerInstructions)) return null;
  if (!inner || Array.isArray(inner) || !Array.isArray(inner.signatures)) return null;
  return {
    slot: typeof result.slot === 'number' ? result.slot : 0,
    blockTime: null,
    transaction: inner,
    meta,
    version: wsTx?.version,
  } as unknown as ParsedTransactionWithMeta;
}

/** Extracts (subId, signature, logs, tx) from a Helius `transactionNotification` → null if it is not one.
 *  Documented format: params.result.{signature, transaction.transaction, transaction.meta}. (Pure, testable.) */
export function parseTxNotification(msg: Record<string, unknown>): ParsedTxNotification | null {
  if (msg.method !== 'transactionNotification') return null;
  const params = msg.params as Record<string, unknown> | undefined;
  const result = params?.result as Record<string, unknown> | undefined;
  const subId = params?.subscription;
  if (result === undefined || typeof subId !== 'number') return null;
  const signature = (result.signature as string) ?? '';
  if (!signature) return null;
  const transaction = result.transaction as Record<string, unknown> | undefined;
  const meta = transaction?.meta as Record<string, unknown> | undefined;
  const logs = (meta?.logMessages as string[]) ?? [];
  return { subId, signature, logs, tx: reshapeFullTx(result) };
}

export class HeliusTxSubscriber {
  private ws: WebSocket | undefined;
  private readonly watched = new Map<string, TxActivityCb>();
  private readonly subToWallet = new Map<number, string>();
  private readonly reqToWallet = new Map<number, string>();
  private nextReqId = 1;
  private backoffMs = BACKOFF_BASE_MS;
  private connected = false;
  private stopped = false;
  private lastMessageAt = 0;
  private unansweredPings = 0; // keepalives sent with no reply since the last inbound frame (#52 liveness)
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly reconnectCbs: Array<() => void> = [];
  private readonly connChangeCbs: Array<(connected: boolean) => void> = [];

  constructor(
    private readonly wsUrl: string,
    private readonly logger: Logger,
  ) {}

  onReconnect(cb: () => void): void {
    this.reconnectCbs.push(cb);
  }
  onConnectionChange(cb: (connected: boolean) => void): void {
    this.connChangeCbs.push(cb);
  }
  isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }
  watch(wallet: string, onActivity: TxActivityCb): void {
    this.watched.set(wallet, onActivity);
    if (this.connected) this.subscribe(wallet);
  }

  /** Stop watching a wallet (Inc.3b leader-set changes): drop it from `watched` (reconnects re-subscribe only
   *  remaining keys), send `transactionUnsubscribe` for its live subscription, and forget its sub/req mappings so
   *  any in-flight notification for it is dropped in `handleMessage`. Idempotent (unknown wallet = no-op). */
  unwatch(wallet: string): void {
    if (!this.watched.delete(wallet)) return;
    for (const [subId, w] of this.subToWallet) {
      if (w !== wallet) continue;
      this.subToWallet.delete(subId);
      this.unsubscribe(subId);
    }
    // A subscribe request still awaiting its ack: forget it, so the late ack never registers the wallet again
    // (handleMessage also re-checks `watched` — belt and suspenders).
    for (const [reqId, w] of this.reqToWallet) if (w === wallet) this.reqToWallet.delete(reqId);
  }

  private connect(): void {
    if (this.stopped) return;
    this.ws = new WebSocket(this.wsUrl);

    this.ws.addEventListener('open', () => {
      this.setConnected(true);
      this.backoffMs = BACKOFF_BASE_MS;
      this.lastMessageAt = Date.now();
      this.unansweredPings = 0;
      for (const wallet of this.watched.keys()) this.subscribe(wallet);
      for (const cb of this.reconnectCbs) cb(); // catches up via the poll on what may have slipped through during the outage
      this.startHeartbeat();
    });
    this.ws.addEventListener('message', (ev) => {
      this.lastMessageAt = Date.now();
      this.unansweredPings = 0; // any inbound frame (incl. a keepalive reply) proves the connection is alive
      this.handleMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
    });
    this.ws.addEventListener('close', () => this.scheduleReconnect());
    this.ws.addEventListener('error', () => {
      /* close handler drives reconnection */
    });
  }

  private setConnected(c: boolean): void {
    if (this.connected !== c) {
      this.connected = c;
      for (const cb of this.connChangeCbs) cb(c);
    }
  }

  private scheduleReconnect(): void {
    this.setConnected(false);
    this.subToWallet.clear();
    this.reqToWallet.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.stopped) return;
    const delay = reconnectDelayMs(this.backoffMs, this.nextReqId);
    this.logger.debug({ delay }, 'tx WS disconnected — reconnecting');
    setTimeout(() => this.connect(), delay);
    this.backoffMs = nextBackoffMs(this.backoffMs);
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.watched.size === 0) return;
      // Death by UNANSWERED keepalives (fast) or by a long silence backstop. A healthy idle connection replies to
      // the keepalive, so unansweredPings resets and neither trips — no more churning healthy connections (#52).
      if (isWsDead(this.unansweredPings) || isSilentTooLong(this.lastMessageAt, Date.now())) {
        this.logger.warn('tx WS keepalive unanswered / silent too long — forcing reconnect');
        this.ws?.close();
        return;
      }
      this.sendKeepalive();
    }, WS_PING_INTERVAL_MS);
  }

  /** Benign JSON-RPC frame to keep the connection alive (undici WS has no protocol ping). Its reply advances
   *  liveness; counting it as unanswered until then lets a dead socket be detected within a couple of ticks. */
  private sendKeepalive(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: this.nextReqId++, method: 'ping' }));
    this.unansweredPings += 1;
  }

  private unsubscribe(subId: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: this.nextReqId++,
        method: 'transactionUnsubscribe',
        params: [subId],
      }),
    );
  }

  private subscribe(wallet: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const id = this.nextReqId++;
    this.reqToWallet.set(id, wallet);
    this.ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'transactionSubscribe',
        params: [
          { accountInclude: [wallet], vote: false, failed: false },
          {
            commitment: 'confirmed',
            encoding: 'jsonParsed',
            transactionDetails: 'full',
            maxSupportedTransactionVersion: 0,
          },
        ],
      }),
    );
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const ack = parseSubAck(msg);
    if (ack) {
      const wallet = this.reqToWallet.get(ack.id);
      this.reqToWallet.delete(ack.id);
      if (wallet && this.watched.has(wallet)) this.subToWallet.set(ack.subId, wallet);
      return;
    }
    const notif = parseTxNotification(msg);
    if (!notif) return;
    const wallet = this.subToWallet.get(notif.subId);
    if (wallet) this.watched.get(wallet)?.(notif.signature, notif.logs, notif.tx);
  }
}
