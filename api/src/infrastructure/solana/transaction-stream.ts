import { DLMM_PROGRAM_ID } from '@binsight/shared';
import type { Logger } from 'pino';
import type { StreamActivity, TransactionStreamPort } from '@/domain/ports';

/**
 * Solana `logsSubscribe` backbone — the LATENCY path that tells the engine a watched wallet just did
 * something, so its delta ingest runs in seconds instead of waiting for the next poll.
 *
 * It is deliberately NOT the correctness backbone. `logsSubscribe` works on every plan (Helius's
 * `transactionSubscribe` is refused on the free plan) but offers no replay: a socket that drops loses
 * whatever happened while it was down. Correctness rests on the engine's periodic signature poll, which
 * costs a single credit when nothing is new. What this class owns:
 *
 *  - one subscription PER WALLET (`mentions` takes exactly one address), routed back by subscription id;
 *  - per-wallet signature dedup for at-least-once delivery;
 *  - reconnect → resubscribe, then the reconnect callbacks (the engine re-polls every wallet, since
 *    anything that happened during the outage was simply not delivered);
 *  - liveness: a socket that has been silent for a while is probed, and closed if the probe gets no
 *    answer — a half-open socket otherwise reads as connected forever;
 *  - server error frames are LOGGED (a plan rejecting the subscription used to look like a healthy,
 *    silent socket).
 *
 * A notification is only a TRIGGER; its payload is never decoded here.
 */

const DEFAULT_RECENT_SIG_CAPACITY = 10_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
/** Probe after this long without any frame, and give the probe this long to be answered. */
const DEFAULT_SILENCE_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

/** One WebSocket connection, abstracted so tests inject a mock and NO real socket is ever opened here. */
export interface WsTransport {
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

/** Creates a fresh transport per (re)connect — the ONLY place a real socket would be opened. */
export type WsTransportFactory = () => WsTransport;

export interface TransactionStreamConfig {
  commitment: 'processed' | 'confirmed' | 'finalized';
  recentSigCapacity: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  silenceMs: number;
  probeTimeoutMs: number;
}

export const DEFAULT_STREAM_CONFIG: TransactionStreamConfig = {
  commitment: 'confirmed',
  recentSigCapacity: DEFAULT_RECENT_SIG_CAPACITY,
  backoffBaseMs: DEFAULT_BACKOFF_BASE_MS,
  backoffMaxMs: DEFAULT_BACKOFF_MAX_MS,
  silenceMs: DEFAULT_SILENCE_MS,
  probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
};

export interface TransactionStreamDeps {
  transportFactory: WsTransportFactory;
  logger: Logger;
  config?: Partial<TransactionStreamConfig>;
}

/** A parsed `logsNotification`, reduced to what the stream routes on. */
export interface ParsedLogsNotification {
  /** The subscription id the server assigned — how a notification maps back to its wallet. */
  subscription: number;
  signature: string;
  failed: boolean;
  touchesDlmm: boolean;
}

type ActivityHandler = (wallet: string, activity: StreamActivity) => void;

export class TransactionStream implements TransactionStreamPort {
  private readonly cfg: TransactionStreamConfig;
  private readonly logger: Logger;
  private readonly transportFactory: WsTransportFactory;

  /** wallet → its activity handler. Source of truth for the watched set. */
  private readonly watched = new Map<string, ActivityHandler>();
  /** Wallets subscribed (or with a subscribe in flight) on the CURRENT connection. */
  private readonly subscribed = new Set<string>();
  /** Bounded, insertion-ordered `wallet:signature` keys already handled (in-session dedup). */
  private readonly recent = new Set<string>();
  private readonly subToWallet = new Map<number, string>();
  /** in-flight request id → wallet, until the server confirms with `{id, result: subId}`. */
  private readonly reqToWallet = new Map<number, string>();

  private transport: WsTransport | null = null;
  private connected = false;
  private stopped = false;
  private backoffMs: number;
  private nextReqId = 1;
  private lastFrameAt = 0;
  private probeId: number | null = null;
  private probeSentAt = 0;

  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly reconnectCbs: Array<() => void> = [];
  private readonly connChangeCbs: Array<(connected: boolean) => void> = [];

  constructor(deps: TransactionStreamDeps) {
    this.transportFactory = deps.transportFactory;
    this.logger = deps.logger;
    this.cfg = { ...DEFAULT_STREAM_CONFIG, ...deps.config };
    this.backoffMs = this.cfg.backoffBaseMs;
  }

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
    this.clearTimers();
    this.transport?.close();
    this.transport = null;
    this.setConnected(false);
  }

  /** Watch a wallet (idempotent); subscribes at once when live. */
  watch(wallet: string, onActivity: ActivityHandler): void {
    this.watched.set(wallet, onActivity);
    if (this.connected) this.subscribe(wallet);
  }

  unwatch(wallet: string): void {
    if (!this.watched.delete(wallet)) return;
    this.subscribed.delete(wallet);
    for (const [subId, w] of this.subToWallet) {
      if (w !== wallet) continue;
      this.send({
        jsonrpc: '2.0',
        id: this.nextReqId++,
        method: 'logsUnsubscribe',
        params: [subId],
      });
      this.subToWallet.delete(subId);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const t = this.transportFactory();
    this.transport = t;
    t.onOpen(() => this.onOpen(t));
    t.onMessage((data) => this.onMessage(t, data));
    t.onClose(() => this.onClose(t));
    t.onError((err) =>
      this.logger.debug({ err }, 'transaction-stream: socket error (close drives reconnect)'),
    );
  }

  private onOpen(t: WsTransport): void {
    if (t !== this.transport) return;
    this.setConnected(true);
    this.backoffMs = this.cfg.backoffBaseMs;
    this.lastFrameAt = Date.now();
    this.startLiveness();
    for (const wallet of this.watched.keys()) this.subscribe(wallet);
    for (const cb of this.reconnectCbs) cb();
  }

  private onClose(t: WsTransport): void {
    // A socket we already dropped (liveness) must not tear down its successor.
    if (t !== this.transport) return;
    this.transport = null;
    this.disconnected();
  }

  private disconnected(): void {
    this.setConnected(false);
    this.subscribed.clear();
    this.subToWallet.clear();
    this.reqToWallet.clear();
    this.probeId = null;
    this.clearTimers();
    if (this.stopped) return;
    const delay = Math.min(this.backoffMs, this.cfg.backoffMaxMs);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.backoffMs = Math.min(this.backoffMs * 2, this.cfg.backoffMaxMs);
  }

  private setConnected(c: boolean): void {
    if (this.connected === c) return;
    this.connected = c;
    for (const cb of this.connChangeCbs) cb(c);
  }

  /** One `logsSubscribe` per wallet per connection (a second one would double every notification). */
  private subscribe(wallet: string): void {
    if (!this.transport || !this.connected || this.subscribed.has(wallet)) return;
    this.subscribed.add(wallet);
    const id = this.nextReqId++;
    this.reqToWallet.set(id, wallet);
    this.send({
      jsonrpc: '2.0',
      id,
      method: 'logsSubscribe',
      params: [{ mentions: [wallet] }, { commitment: this.cfg.commitment }],
    });
  }

  private send(frame: Record<string, unknown>): void {
    if (!this.transport || !this.connected) return;
    this.transport.send(JSON.stringify(frame));
  }

  private onMessage(t: WsTransport, raw: string): void {
    if (t !== this.transport) return;
    this.lastFrameAt = Date.now();
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // Any answer to the liveness probe (an error is the expected one) proves the socket is alive.
    if (this.probeId !== null && msg.id === this.probeId) {
      this.probeId = null;
      return;
    }
    if (msg.error != null) {
      this.logger.error({ error: msg.error }, 'transaction-stream: server rejected a request');
      // A refused subscribe must not leave the wallet marked subscribed: retry it later.
      const wallet = typeof msg.id === 'number' ? this.reqToWallet.get(msg.id) : undefined;
      if (wallet != null) {
        this.reqToWallet.delete(msg.id as number);
        this.subscribed.delete(wallet);
        setTimeout(() => {
          if (t === this.transport && this.watched.has(wallet)) this.subscribe(wallet);
        }, this.cfg.backoffMaxMs).unref?.();
      }
      return;
    }
    if (typeof msg.result === 'number' && typeof msg.id === 'number') {
      const wallet = this.reqToWallet.get(msg.id);
      this.reqToWallet.delete(msg.id);
      if (wallet == null) return;
      if (this.watched.has(wallet)) {
        this.subToWallet.set(msg.result, wallet);
      } else {
        // Unwatched while the subscribe was in flight — release it rather than leak it.
        this.send({
          jsonrpc: '2.0',
          id: this.nextReqId++,
          method: 'logsUnsubscribe',
          params: [msg.result],
        });
      }
      return;
    }
    if (msg.method !== 'logsNotification') return;
    const n = parseLogsNotification(msg);
    if (n) this.handleNotification(n);
  }

  private handleNotification(n: ParsedLogsNotification): void {
    const wallet = this.subToWallet.get(n.subscription);
    const handler = wallet == null ? undefined : this.watched.get(wallet);
    if (wallet == null || !handler || n.failed) return; // a failed tx changed no state
    // Dedup per wallet: one transaction that mentions two watched wallets is news to both.
    const key = `${wallet}:${n.signature}`;
    if (this.recent.has(key)) return;
    this.remember(key);
    // Every mention is passed on, DLMM or not: a swap or transfer moves the wallet's token balances
    // even though it moves no position.
    handler(wallet, { touchesDlmm: n.touchesDlmm });
  }

  private remember(key: string): void {
    this.recent.add(key);
    if (this.recent.size > this.cfg.recentSigCapacity) {
      const oldest = this.recent.values().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }
  }

  /** A quiet socket is normal (quiet wallets) — so silence triggers a probe, and only an unanswered
   *  probe closes the socket. The probe is an unsubscribe of a subscription that doesn't exist, which
   *  every server answers with an error. */
  private startLiveness(): void {
    this.clearTimers();
    const tick = Math.max(1_000, Math.min(this.cfg.silenceMs, this.cfg.probeTimeoutMs) / 2);
    this.livenessTimer = setInterval(() => {
      const now = Date.now();
      if (this.probeId !== null) {
        if (now - this.probeSentAt >= this.cfg.probeTimeoutMs) {
          this.logger.warn('transaction-stream: liveness probe unanswered — reconnecting');
          const dead = this.transport;
          this.transport = null;
          dead?.close();
          this.disconnected();
        }
        return;
      }
      if (now - this.lastFrameAt >= this.cfg.silenceMs) {
        this.probeId = this.nextReqId++;
        this.probeSentAt = now;
        this.send({ jsonrpc: '2.0', id: this.probeId, method: 'logsUnsubscribe', params: [0] });
      }
    }, tick);
  }

  private clearTimers(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.livenessTimer = this.reconnectTimer = null;
  }
}

/**
 * Pure parser for a Solana `logsNotification` → subscription id, signature, whether the tx failed, and
 * whether its logs mention the DLMM program. Null when the message isn't a usable notification.
 */
export function parseLogsNotification(msg: unknown): ParsedLogsNotification | null {
  const params = (msg as { params?: unknown }).params as Record<string, unknown> | undefined;
  const subscription = params?.subscription;
  const result = params?.result as Record<string, unknown> | undefined;
  const value = result?.value as Record<string, unknown> | undefined;
  if (typeof subscription !== 'number' || !value) return null;
  const signature = value.signature;
  if (typeof signature !== 'string' || signature.length === 0) return null;
  const logs = Array.isArray(value.logs) ? (value.logs as unknown[]) : [];
  return {
    subscription,
    signature,
    failed: value.err != null,
    touchesDlmm: logs.some((l) => typeof l === 'string' && l.includes(DLMM_PROGRAM_ID)),
  };
}
