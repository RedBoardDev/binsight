import { DLMM_PROGRAM_ID } from '@binsight/shared';
import type { Logger } from 'pino';
import type { WalletStreamCursor } from '@/infrastructure/persistence/wallet-stream-cursor-repository';

/**
 * Solana `logsSubscribe` backbone — the LATENCY path that tells the engine a watched wallet just did
 * something, so its delta ingest runs in seconds instead of waiting for the next poll.
 *
 * It is deliberately NOT the correctness backbone. `logsSubscribe` is a standard Solana method (it works
 * on every plan, unlike Helius's `transactionSubscribe`, which the free plan refuses outright), but it
 * offers no replay: a socket that drops loses everything that happened while it was down, and there is no
 * `fromSlot` to ask for it back. Correctness therefore rests on the engine's periodic signature poll,
 * which costs a single credit when nothing is new — cheaper and more dependable than any WS trick. What
 * this class still owns:
 *
 *  - one subscription PER WALLET (`mentions` accepts exactly one address), routed back by subscription id;
 *  - durable per-wallet checkpoint (`wallet_stream_cursor`) advanced on every notification (crash-safe);
 *  - signature dedup (bounded in-session set) for at-least-once delivery;
 *  - reconnect → resubscribe, then hand every cursored wallet to the recovery path, since anything that
 *    happened during the outage was simply not delivered;
 *  - server error frames are LOGGED. They used to be dropped on the floor, which is how a plan rejecting
 *    the subscription outright looked exactly like a healthy, silent socket for a week.
 *
 * A notification is only a TRIGGER: it advances the wallet's cursor and invokes its activity handler,
 * which runs the cheap delta ingest and close-detection downstream. The payload is never decoded here.
 */

// ── Tunable defaults (named — no magic numbers). All overridable via TransactionStreamConfig. ──
/** Keepalive ping cadence (Helius docs example pings every 30s to hold the socket open). */
const DEFAULT_PING_INTERVAL_MS = 30_000;
/** Bounded in-session dedup window (recent signatures). Survives reconnects; reset only by a restart. */
const DEFAULT_RECENT_SIG_CAPACITY = 10_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

/** Why a wallet's activity handler fired — lets downstream/tests tell a live notification apart from a
 *  gap-detector recovery (both run the same cheap delta ingest; the reason is for telemetry + assertions). */
export type StreamActivityReason = 'ws' | 'gap-backfill';

/** Invoked for each watched wallet a DLMM tx touches (or that the gap detector wants recovered). */
export type StreamActivityHandler = (wallet: string, reason: StreamActivityReason) => void;

/** The minimal cursor persistence the stream needs (the WalletStreamCursorRepository satisfies it). */
export interface WalletStreamCursorStore {
  get(wallet: string): Promise<WalletStreamCursor | null>;
  set(wallet: string, cursor: WalletStreamCursor): Promise<void>;
}

/** One WebSocket connection, abstracted so tests inject a mock and NO real socket is ever opened here. */
export interface WsTransport {
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: unknown) => void): void;
  send(data: string): void;
  /** Keepalive frame. */
  ping(): void;
  close(): void;
}

/** Creates a fresh transport per (re)connect — the ONLY place a real socket would be opened (production). */
export type WsTransportFactory = () => WsTransport;

export interface TransactionStreamConfig {
  commitment: 'processed' | 'confirmed' | 'finalized';
  pingIntervalMs: number;
  recentSigCapacity: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_STREAM_CONFIG: TransactionStreamConfig = {
  commitment: 'confirmed',
  pingIntervalMs: DEFAULT_PING_INTERVAL_MS,
  recentSigCapacity: DEFAULT_RECENT_SIG_CAPACITY,
  backoffBaseMs: DEFAULT_BACKOFF_BASE_MS,
  backoffMaxMs: DEFAULT_BACKOFF_MAX_MS,
};

export interface TransactionStreamDeps {
  transportFactory: WsTransportFactory;
  cursors: WalletStreamCursorStore;
  logger: Logger;
  config?: Partial<TransactionStreamConfig>;
}

/** A parsed `logsNotification`, reduced to what the stream routes and checkpoints on. */
export interface ParsedLogsNotification {
  /** The subscription id the server assigned — how a notification maps back to its wallet. */
  subscription: number;
  signature: string;
  slot: number;
  failed: boolean;
  touchesDlmm: boolean;
}

export class TransactionStream {
  private readonly cfg: TransactionStreamConfig;
  private readonly logger: Logger;
  private readonly transportFactory: WsTransportFactory;
  private readonly cursors: WalletStreamCursorStore;

  /** wallet → its activity handler. Source of truth for the watched set. */
  private readonly watched = new Map<string, StreamActivityHandler>();
  /** wallet → its in-flight (then resolved) cursor-seed load. Awaited before any subscribe so the
   *  recovery pass sees durable cursors rather than a half-loaded cache. */
  private readonly seeded = new Map<string, Promise<void>>();
  /** In-memory mirror of each wallet's durable cursor (seeded from the store on first watch). */
  private readonly cursorCache = new Map<string, WalletStreamCursor>();
  /** Bounded, insertion-ordered set of recently-handled signatures (in-session dedup). */
  private readonly recentSigs = new Set<string>();
  /** subscription id → wallet. `logsSubscribe` takes ONE address per subscription, so notifications are
   *  routed back by the id the server assigns, not by anything in the payload. */
  private readonly subToWallet = new Map<number, string>();
  /** in-flight request id → wallet, until the server confirms with `{id, result: subId}`. */
  private readonly reqToWallet = new Map<number, string>();

  private transport: WsTransport | null = null;
  private connected = false;
  private stopped = false;
  private backoffMs: number;
  private nextReqId = 1;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Serializes async processing (cursor writes + handler) so tests can deterministically await it. */
  private chain: Promise<void> = Promise.resolve();

  private readonly reconnectCbs: Array<() => void> = [];
  private readonly connChangeCbs: Array<(connected: boolean) => void> = [];

  constructor(deps: TransactionStreamDeps) {
    this.transportFactory = deps.transportFactory;
    this.cursors = deps.cursors;
    this.logger = deps.logger;
    this.cfg = { ...DEFAULT_STREAM_CONFIG, ...deps.config };
    this.backoffMs = this.cfg.backoffBaseMs;
  }

  // ── Lifecycle / engine wiring (the TransactionStreamPort surface) ─────────────────────────────────

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

  /** Watch a wallet (idempotent). Seeds its cursor from the durable store, then subscribes if live. */
  watch(wallet: string, onActivity: StreamActivityHandler): void {
    const isNew = !this.watched.has(wallet);
    this.watched.set(wallet, onActivity);
    if (isNew) this.seeded.set(wallet, this.seedCursor(wallet));
    // Each wallet needs its OWN subscription, so a new wallet is one extra subscribe — not a resubscribe
    // of the whole set.
    if (isNew && this.connected) this.scheduleSubscribe(wallet);
  }

  unwatch(wallet: string): void {
    if (!this.watched.delete(wallet)) return;
    this.seeded.delete(wallet);
    this.cursorCache.delete(wallet);
    // Release the server-side subscription, otherwise it keeps streaming to nobody and the account's
    // active-subscription count creeps up across watch/unwatch churn.
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
    // A subscribe whose confirmation is still in flight has no subscription id yet. Its reqToWallet
    // entry is deliberately KEPT so the confirmation handler can see the wallet is no longer watched and
    // release it there — dropping the entry now would strand a live subscription the server keeps
    // streaming to nobody.
  }

  /** Test/diagnostic seam: resolves once all in-flight notification processing has settled. */
  async idle(): Promise<void> {
    await this.chain;
  }

  private async seedCursor(wallet: string): Promise<void> {
    try {
      const c = await this.cursors.get(wallet);
      // Don't clobber a cursor a live notification already advanced while the load was in flight.
      if (c && !this.cursorCache.has(wallet)) this.cursorCache.set(wallet, c);
    } catch (err) {
      this.logger.warn({ err, wallet }, 'transaction-stream: cursor seed failed');
    }
  }

  // ── Connection ────────────────────────────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return;
    const t = this.transportFactory();
    this.transport = t;
    t.onOpen(() => this.onOpen());
    t.onMessage((data) => this.onMessage(data));
    t.onClose(() => this.onClose());
    t.onError((err) =>
      this.logger.debug({ err }, 'transaction-stream: socket error (close drives reconnect)'),
    );
  }

  private onOpen(): void {
    this.setConnected(true);
    this.backoffMs = this.cfg.backoffBaseMs;
    this.startTimers();
    // Gate the (re)subscribe behind cursor seeding, and serialize it on the same chain as notification
    // processing so `idle()` settles it deterministically.
    this.chain = this.chain
      .then(async () => {
        await this.awaitSeeds();
        for (const wallet of this.watched.keys()) this.subscribe(wallet);
        // logsSubscribe has NO replay: whatever happened while the socket was down was simply never
        // delivered, and no `fromSlot` can ask for it back. Every cursored wallet therefore goes through
        // the recovery path on EVERY reconnect — it is one `getSignaturesForAddress` against a cursor,
        // so a no-op costs a single credit and a real gap is closed immediately.
        for (const wallet of this.watched.keys()) {
          if (this.cursorCache.has(wallet)) this.fireRecovery(wallet);
        }
        for (const cb of this.reconnectCbs) cb();
      })
      .catch((err) => this.logger.error({ err }, 'transaction-stream: open handling failed'));
  }

  /** Subscribe ONE newly-watched wallet while live, seeding-gated + serialized on the processing chain. */
  private scheduleSubscribe(wallet: string): void {
    this.chain = this.chain
      .then(async () => {
        await this.awaitSeeds();
        this.subscribe(wallet);
      })
      .catch((err) => this.logger.error({ err }, 'transaction-stream: subscribe failed'));
  }

  private async awaitSeeds(): Promise<void> {
    await Promise.all([...this.seeded.values()]);
  }

  private onClose(): void {
    this.setConnected(false);
    // Subscription ids die with the socket; the next open re-subscribes from scratch.
    this.subToWallet.clear();
    this.reqToWallet.clear();
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

  /**
   * Subscribe one wallet. `logsSubscribe` accepts exactly ONE address in `mentions`, so the watched set
   * is N subscriptions rather than one multiplexed filter, and notifications are routed back by the
   * subscription id the server assigns in its confirmation frame.
   */
  private subscribe(wallet: string): void {
    if (!this.transport || !this.connected) return;
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

  // ── Message handling ────────────────────────────────────────────────────────────────────────────────

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // Server error frame. These used to be discarded silently, which is exactly how a plan refusing the
    // subscription outright presented as a healthy socket that simply never delivered anything.
    if (msg.error != null) {
      this.logger.error({ error: msg.error }, 'transaction-stream: server rejected a request');
      return;
    }
    // Subscription confirmation `{ id, result: <subId> }` — bind the id we will route notifications by.
    if (typeof msg.result === 'number' && typeof msg.id === 'number') {
      const wallet = this.reqToWallet.get(msg.id);
      this.reqToWallet.delete(msg.id);
      if (wallet == null) return;
      if (this.watched.has(wallet)) {
        this.subToWallet.set(msg.result, wallet);
      } else {
        // Unwatched while the subscribe was in flight — release it rather than leak a live subscription.
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
    const parsed = parseLogsNotification(msg);
    if (!parsed) return;
    // Serialize so each notification's durable cursor write + handler completes before the next — and so
    // tests can deterministically `await stream.idle()`.
    this.chain = this.chain
      .then(() => this.handleNotification(parsed))
      .catch((err) => {
        this.logger.error({ err }, 'transaction-stream: notification handling failed');
      });
  }

  private async handleNotification(n: ParsedLogsNotification): Promise<void> {
    const wallet = this.subToWallet.get(n.subscription);
    if (wallet == null || !this.watched.has(wallet)) return;
    // A failed tx changed no state — nothing to ingest.
    if (n.failed) return;
    // Trigger on ANY mention of the DLMM program. Deliberately broader than classifying the instruction:
    // a trigger we cannot classify still deserves a delta ingest, and the ingest is what decides what
    // actually happened. Being strict here would turn an unrecognised log into a silent miss.
    if (!n.touchesDlmm) return;
    // Dedup (at-least-once delivery): a signature handled this session is never handled twice.
    if (this.recentSigs.has(n.signature)) return;
    this.rememberSig(n.signature);
    await this.advanceCursor(wallet, n.signature, n.slot);
    this.watched.get(wallet)?.(wallet, 'ws');
  }

  /**
   * Advance a wallet's durable checkpoint MONOTONICALLY: a late/older signature (out-of-order arrival)
   * never rewinds `lastSlot`. Persisted per signature so the cursor is crash-safe.
   */
  private async advanceCursor(wallet: string, signature: string, slot: number): Promise<void> {
    const prev = this.cursorCache.get(wallet);
    if (prev && prev.lastSlot != null && slot < prev.lastSlot) return; // older — keep the higher watermark
    const next: WalletStreamCursor = { lastSignature: signature, lastSlot: slot };
    this.cursorCache.set(wallet, next);
    try {
      await this.cursors.set(wallet, next);
    } catch (err) {
      this.logger.warn(
        { err, wallet },
        'transaction-stream: cursor persist failed (will retry next tx)',
      );
    }
  }

  private rememberSig(signature: string): void {
    this.recentSigs.add(signature);
    if (this.recentSigs.size > this.cfg.recentSigCapacity) {
      // Evict the oldest (Set preserves insertion order) to keep the dedup window bounded.
      const oldest = this.recentSigs.values().next().value;
      if (oldest !== undefined) this.recentSigs.delete(oldest);
    }
  }

  /** Hand a wallet to the engine's recovery path — the same cheap delta ingest a live notification
   *  triggers, tagged so telemetry and tests can tell the two apart. */
  private fireRecovery(wallet: string): void {
    this.logger.info({ wallet }, 'transaction-stream: reconnected — recovering wallet');
    this.watched.get(wallet)?.(wallet, 'gap-backfill');
  }

  // ── Timers ────────────────────────────────────────────────────────────────────────────────────────

  private startTimers(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => this.transport?.ping(), this.cfg.pingIntervalMs);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = this.reconnectTimer = null;
  }
}

/**
 * Pure parser for a Solana `logsNotification` → the subscription it belongs to, the signature, the slot,
 * whether the tx failed, and whether its logs mention the DLMM program. Routing is by subscription id
 * because `logsSubscribe` carries no account list. Returns null when the message isn't a usable
 * notification.
 */
export function parseLogsNotification(msg: unknown): ParsedLogsNotification | null {
  const params = (msg as { params?: unknown }).params as Record<string, unknown> | undefined;
  const subscription = params?.subscription;
  const result = params?.result as Record<string, unknown> | undefined;
  const value = result?.value as Record<string, unknown> | undefined;
  const context = result?.context as Record<string, unknown> | undefined;
  if (typeof subscription !== 'number' || !value) return null;
  const signature = value.signature;
  if (typeof signature !== 'string' || signature.length === 0) return null;
  const logs = Array.isArray(value.logs) ? (value.logs as unknown[]) : [];
  return {
    subscription,
    signature,
    slot: typeof context?.slot === 'number' ? context.slot : 0,
    failed: value.err != null,
    touchesDlmm: logs.some((l) => typeof l === 'string' && l.includes(DLMM_PROGRAM_ID)),
  };
}
