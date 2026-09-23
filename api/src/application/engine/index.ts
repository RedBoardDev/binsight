import type { Health, WalletState } from '@binsight/shared';
import type { Logger } from 'pino';
import type { EventBus } from '@/application/event-bus';
import type { HealthMonitor } from '@/application/health-monitor';
import type { PositionSync } from '@/application/position-sync-service';
import type { RealizedPnlEngine } from '@/application/realized-pnl';
import type { OnchainWalletSnapshot } from '@/domain/dlmm';
import { liveMarkWallet } from '@/domain/live-mark';
import type {
  AccountRepository,
  OnchainDlmmGateway,
  PositionStore,
  PriceGateway,
  TransactionStreamPort,
  WalletRealizedStore,
  WalletTxIngestPort,
} from '@/domain/ports';
import { mintsNeedingPrice } from '@/domain/snapshot-valuation';
import { Semaphore } from '@/util/concurrency';
import { StateEmitter } from './emitter';
import type { StrategyService } from './strategy-service';
import { WalletActor } from './wallet-actor';

/** Shared price mark: re-price every open wallet's last exact snapshot at the live Jupiter price (zero
 *  RPC). It runs twice per exact-read period so each wallet gets a mark roughly half-way between two
 *  reads, whatever the phase of its own snapshot clock. */
const PRICE_MARK_INTERVAL_MS = 5_000;
/** A mark this soon after an exact read would only repeat it. */
const MARK_MIN_AGE_MS = 5_000;
const STRATEGY_BACKFILL_MS = 60_000;
/** Spread a fleet-wide resync (reconnect / manual refresh) so it doesn't hit the RPC budget at once. */
const RESYNC_STAGGER_MS = 50;

export interface EngineDeps {
  prices: PriceGateway;
  /** The WS backbone (`logsSubscribe`): a latency trigger for the delta ingest. */
  stream: TransactionStreamPort;
  onchain: OnchainDlmmGateway;
  health: HealthMonitor;
  strategy: StrategyService;
  store: PositionStore;
  accounts: Pick<AccountRepository, 'monitoredWallets'>;
  bus: EventBus;
  logger: Logger;
  walletTxIngest: WalletTxIngestPort;
  positionSync: PositionSync;
  realizedPnl: RealizedPnlEngine;
  walletRealized: WalletRealizedStore;
  /** How many first-ever history backfills may run at once (onboarding admission control). */
  backfillConcurrency: number;
  /** Master switch for the realized-PnL pass. */
  realizedPnlEnabled: boolean;
}

/** The fleet of monitored wallets: one {@link WalletActor} each, one shared clock, one price mark. */
export class Engine {
  private readonly actors = new Map<string, WalletActor>();
  private readonly emitter: StateEmitter;
  private readonly backfillGate: Semaphore;
  private tick: NodeJS.Timeout | null = null;
  private priceTick: NodeJS.Timeout | null = null;
  private priceMarking = false;
  private lastStrategyBackfillAt = 0;
  private viewed = new Set<string>();

  constructor(private readonly deps: EngineDeps) {
    this.emitter = new StateEmitter(this.actors, deps.stream, deps.bus, deps.health);
    this.backfillGate = new Semaphore(deps.backfillConcurrency);
  }

  async start(): Promise<void> {
    const { stream } = this.deps;
    // Nothing that happened while the socket was down was delivered: re-poll every wallet.
    stream.onReconnect(() => this.resyncAll());
    stream.start();
    for (const address of await this.deps.accounts.monitoredWallets())
      await this.addWallet(address);
    this.tick = setInterval(() => this.onTick(), 1000);
    this.priceTick = setInterval(() => void this.runPriceMark(), PRICE_MARK_INTERVAL_MS);
  }

  stop(): void {
    if (this.tick) clearInterval(this.tick);
    if (this.priceTick) clearInterval(this.priceTick);
    for (const actor of this.actors.values()) actor.stop();
    this.deps.stream.stop();
  }

  async addWallet(address: string): Promise<void> {
    if (this.actors.has(address)) return;
    const actor = new WalletActor(address, [], {
      ingest: this.deps.walletTxIngest,
      onchain: this.deps.onchain,
      prices: this.deps.prices,
      positionSync: this.deps.positionSync,
      realizedPnl: this.deps.realizedPnl,
      walletRealized: this.deps.walletRealized,
      store: this.deps.store,
      bus: this.deps.bus,
      health: this.deps.health,
      logger: this.deps.logger,
      backfillGate: this.backfillGate,
      realizedEnabled: this.deps.realizedPnlEnabled,
      isStreamConnected: () => this.deps.stream.isConnected(),
      onState: (a) => this.emitter.emitState(a),
    });
    // Registered BEFORE the first await, so a concurrent add of the same wallet is a no-op.
    this.actors.set(address, actor);
    for (const p of await this.deps.store.getOpen(address)) actor.open.set(p.positionAddress, p);
    if (this.actors.get(address) !== actor) return; // removed meanwhile
    this.deps.stream.watch(address, (_wallet, activity) => actor.onActivity(activity.touchesDlmm));
    actor.start();
  }

  removeWallet(address: string): void {
    const actor = this.actors.get(address);
    if (!actor) return;
    actor.stop();
    this.actors.delete(address);
    this.deps.stream.unwatch(address);
  }

  getState(wallets: string[], scope: string): WalletState {
    return this.emitter.getState(wallets, scope);
  }

  /** Current health — handed to a freshly connected client (health is emit-on-change). */
  healthSnapshot(): Health {
    return this.emitter.snapshotHealth();
  }

  /** Re-poll every wallet now (a manual refresh from a client). */
  refreshNow(): void {
    this.resyncAll();
  }

  /** The WS layer reports which wallets have a viewer; a wallet that gains one is re-read at once. */
  setViewedWallets(wallets: Set<string>): void {
    for (const w of wallets) if (!this.viewed.has(w)) this.actors.get(w)?.onViewerArrived();
    this.viewed = wallets;
  }

  /** Onboarding status: `ready` once the first projection landed; `indexedTxs` during the backfill. */
  ingestStatus(address: string): { ready: boolean; indexedTxs: number } {
    const actor = this.actors.get(address);
    return { ready: actor?.reconciled ?? false, indexedTxs: actor?.ingestedTxs ?? 0 };
  }

  private onTick(): void {
    const now = Date.now();
    for (const actor of this.actors.values()) actor.tick(now);
    if (now - this.lastStrategyBackfillAt >= STRATEGY_BACKFILL_MS) {
      this.lastStrategyBackfillAt = now;
      void this.deps.strategy.backfill();
    }
    this.emitter.emitHealth();
  }

  /**
   * Re-price every wallet with open positions from its last exact snapshot and ONE shared price fetch
   * (Jupiter, not a Helius credit). Amounts are held fixed, so this is an approximation: it is emitted
   * to live viewers and never persisted — the next exact read (≤10 s) supersedes it.
   */
  private async runPriceMark(): Promise<void> {
    if (this.priceMarking) return;
    const now = Date.now();
    const targets: { actor: WalletActor; snap: OnchainWalletSnapshot }[] = [];
    for (const actor of this.actors.values()) {
      const snap = actor.lastSnapshot;
      if (!snap || snap.positions.length === 0 || now - actor.lastSnapshotAt < MARK_MIN_AGE_MS)
        continue;
      targets.push({ actor, snap });
    }
    if (targets.length === 0) return;
    this.priceMarking = true;
    try {
      const mints = new Set<string>();
      for (const { snap } of targets) for (const m of mintsNeedingPrice(snap)) mints.add(m);
      const priceMap = await this.deps.prices.getPricesSol([...mints]);
      for (const { actor } of targets) {
        // Read the actor's state AFTER the await, so the snapshot and the open rows are one generation.
        const snap = actor.lastSnapshot;
        if (!snap) continue;
        const { valued, open } = liveMarkWallet(snap, [...actor.open.values()], priceMap);
        this.emitter.emitMarked(actor.address, open, valued);
      }
    } catch (err) {
      this.deps.logger.warn({ err }, 'price-mark tick failed — keeping last emitted state');
    } finally {
      this.priceMarking = false;
    }
  }

  private resyncAll(): void {
    let i = 0;
    for (const actor of this.actors.values()) {
      setTimeout(() => actor.resync(), i++ * RESYNC_STAGGER_MS);
    }
  }
}
