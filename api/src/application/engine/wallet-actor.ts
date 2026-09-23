import type { ClosedPosition, OpenPosition } from '@binsight/shared';
import type { Logger } from 'pino';
import type { EventBus } from '@/application/event-bus';
import type { HealthMonitor } from '@/application/health-monitor';
import type { OpenTransitions, PositionSync } from '@/application/position-sync-service';
import type { RealizedPnlEngine } from '@/application/realized-pnl';
import type { OnchainValued, OnchainWalletSnapshot, SnapshotPlan } from '@/domain/dlmm';
import type {
  OnchainDlmmGateway,
  PositionStore,
  PriceGateway,
  WalletRealizedStore,
  WalletTxIngestPort,
} from '@/domain/ports';
import { mintsNeedingPrice, valueSnapshot } from '@/domain/snapshot-valuation';
import type { Semaphore } from '@/util/concurrency';
import { shouldRefreshRealized } from './utils';

/** Exact snapshot cadence while positions are open (fees accrue, bins move) and while none is. */
const OPEN_SNAPSHOT_MS = 10_000;
const IDLE_SNAPSHOT_MS = 60_000;
/** Re-run discovery at least this often even with no activity, so a missed open can't stay hidden. */
const SAFETY_REDISCOVER_MS = 600_000;
/** The no-miss backstop: one getSignaturesForAddress (a single credit when nothing is new). Brisk while
 *  the socket is down, since the poll is then the only thing watching. */
const POLL_CONNECTED_MS = 300_000;
const POLL_DISCONNECTED_MS = 30_000;
/** A residual is usually market-sold seconds after a close; re-run the realized pass on this bounded,
 *  front-loaded schedule so the real sale lands without waiting for the wallet's next close. */
const REALIZED_REFRESH_OFFSETS_MS = [25_000, 60_000, 150_000];
/** Settle lag after a stream notification, so getSignaturesForAddress already lists the new tx. */
const ACTIVITY_LAG_MS = 1_500;

export interface WalletActorDeps {
  ingest: WalletTxIngestPort;
  onchain: OnchainDlmmGateway;
  prices: PriceGateway;
  positionSync: PositionSync;
  realizedPnl: RealizedPnlEngine;
  walletRealized: WalletRealizedStore;
  store: Pick<PositionStore, 'setAuthoritativePnlMany'>;
  bus: EventBus;
  health: HealthMonitor;
  logger: Logger;
  /** Admission control for first-ever history backfills (they page a whole history). */
  backfillGate: Semaphore;
  realizedEnabled: boolean;
  isStreamConnected(): boolean;
  /** The wallet's live state changed — emit it. */
  onState(address: string): void;
}

type Job = 'ingest' | 'snapshot' | 'realized';

/**
 * Everything the engine does for one wallet, run ONE STEP AT A TIME: ingest new transactions →
 * snapshot the chain → project the positions table → realized PnL. Requests coalesce (a burst of
 * notifications is one ingest) and nothing interleaves: the close projections that used to be lost to a
 * flag cleared by a concurrent pass, a price mark reopening a just-closed row, or a realized top-up
 * ingesting a close nobody reprojected, all came from those steps racing each other.
 *
 * The one step that runs outside the queue is the first-ever history backfill — it can take hours on a
 * large wallet, and the wallet's live value must keep updating meanwhile. While it runs the queue only
 * snapshots (no ingest, no projection); the projection starts once the history is in.
 */
export class WalletActor {
  /** The persisted open set, as last projected — what clients see. */
  open = new Map<string, OpenPosition>();
  /** Valuation of the last exact snapshot (null until the first one). */
  onchain: OnchainValued | null = null;
  /** The last exact snapshot's raw holdings, re-priced by the shared price mark between reads. */
  lastSnapshot: OnchainWalletSnapshot | null = null;
  lastSnapshotAt = 0;
  /** A first projection has landed: history is queryable. */
  reconciled = false;
  /** Transactions ingested so far by the initial backfill ("indexing… (N txs)"). */
  ingestedTxs = 0;

  private readonly pending = new Set<Job>();
  private running = false;
  private stopped = false;
  private backfilling = false;
  /** The history is read to genesis (known once the first ingest returns). */
  private historyComplete: boolean | null = null;
  /** Open/range notifications only make sense against a projection this process can trust: never for
   *  the first-ever backfill of a wallet, whose whole open set would read as "just opened". */
  private announceTransitions = false;
  /** New legs were ingested since the last full projection. */
  private dirty = false;
  private plan: SnapshotPlan | null = null;
  private needsDiscovery = true;
  private lastDiscoveryAt = 0;
  private lastIngestAt = 0;
  private lastClosedCount = -1;
  private lastCloseAt = 0;
  private lastRealizedRunAt = 0;

  constructor(
    readonly address: string,
    initialOpen: OpenPosition[],
    private readonly deps: WalletActorDeps,
  ) {
    for (const p of initialOpen) this.open.set(p.positionAddress, p);
  }

  /** Starts the wallet: the history backfill (if any history is still unread) then the regular loop. */
  start(): void {
    this.lastIngestAt = Date.now();
    this.backfilling = true;
    void this.deps.backfillGate
      .run(() => this.backfill())
      .finally(() => {
        this.backfilling = false;
        this.dirty = true;
        this.request('snapshot');
      });
    this.request('snapshot'); // the live value doesn't wait for the history
  }

  stop(): void {
    this.stopped = true;
    this.pending.clear();
  }

  /** The stream saw a transaction mentioning this wallet. */
  onActivity(touchesDlmm: boolean): void {
    // Any transaction may move token balances; only a DLMM one can move the position set.
    this.deps.onchain.invalidateIdle(this.address);
    if (touchesDlmm) this.needsDiscovery = true;
    setTimeout(() => this.request('ingest'), ACTIVITY_LAG_MS);
  }

  /** A client started viewing the wallet: re-read it now rather than show a stale total. */
  onViewerArrived(): void {
    if (Date.now() - this.lastSnapshotAt >= OPEN_SNAPSHOT_MS / 2) this.request('snapshot');
  }

  /** Re-poll now (reconnect, manual refresh). */
  resync(): void {
    this.request('ingest');
  }

  /** The 1 s engine tick: request whatever is due. */
  tick(now: number): void {
    const pollMs = this.deps.isStreamConnected() ? POLL_CONNECTED_MS : POLL_DISCONNECTED_MS;
    if (now - this.lastIngestAt >= pollMs) this.request('ingest');
    const snapshotMs = this.open.size > 0 ? OPEN_SNAPSHOT_MS : IDLE_SNAPSHOT_MS;
    if (now - this.lastSnapshotAt >= snapshotMs) this.request('snapshot');
    if (
      this.reconciled &&
      shouldRefreshRealized({
        now,
        lastCloseAt: this.lastCloseAt,
        lastRealizedRunAt: this.lastRealizedRunAt,
        offsetsMs: REALIZED_REFRESH_OFFSETS_MS,
      })
    ) {
      this.lastRealizedRunAt = now;
      this.request('realized');
    }
  }

  private request(job: Job): void {
    if (this.stopped) return;
    this.pending.add(job);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped) {
        const job = this.nextJob();
        if (!job) break;
        this.pending.delete(job);
        await this.run(job);
      }
    } finally {
      this.running = false;
    }
  }

  /** Ingest before snapshot before realized — each step reads what the previous one wrote. An ingest
   *  requested during the backfill waits for it (the backfill is reading the same history). */
  private nextJob(): Job | undefined {
    if (this.pending.has('ingest') && !this.backfilling) return 'ingest';
    if (this.pending.has('snapshot')) return 'snapshot';
    if (this.pending.has('realized') && this.reconciled && !this.backfilling) return 'realized';
    return undefined;
  }

  private async run(job: Job): Promise<void> {
    try {
      if (job === 'ingest') await this.ingest();
      else if (job === 'snapshot') await this.snapshot();
      else await this.realized();
    } catch (err) {
      this.deps.logger.warn({ err, wallet: this.address, job }, 'wallet step failed — retried');
    }
  }

  private async backfill(): Promise<void> {
    try {
      const r = await this.deps.ingest.ingest(this.address, {
        onProgress: (txs) => {
          this.ingestedTxs = txs;
        },
      });
      this.historyComplete = r.complete;
      this.announceTransitions = r.wasComplete;
      this.deps.logger.info({ wallet: this.address, txs: r.txs }, 'wallet history ingested');
    } catch (err) {
      // The regular poll resumes it from the cursor.
      this.deps.logger.error(
        { err, wallet: this.address },
        'wallet backfill failed — resuming later',
      );
    }
  }

  private async ingest(): Promise<void> {
    this.lastIngestAt = Date.now();
    const run = () => this.deps.ingest.ingest(this.address);
    // An unfinished history is a backfill (possibly a whole history): it takes an admission slot.
    const r = this.historyComplete === false ? await this.deps.backfillGate.run(run) : await run();
    this.historyComplete = r.complete;
    if (r.txs > 0) {
      this.dirty = true;
      // New transactions may have opened or closed positions and moved token balances.
      this.needsDiscovery = true;
      this.deps.onchain.invalidateIdle(this.address);
      this.request('snapshot');
    }
  }

  private async snapshot(): Promise<void> {
    const now = Date.now();
    const rediscover =
      this.needsDiscovery ||
      this.plan === null ||
      now - this.lastDiscoveryAt >= SAFETY_REDISCOVER_MS;
    this.lastSnapshotAt = now;
    let snap: Awaited<ReturnType<OnchainDlmmGateway['snapshotWallet']>>;
    try {
      snap = await this.deps.onchain.snapshotWallet(
        this.address,
        rediscover ? undefined : (this.plan ?? undefined),
      );
    } catch (err) {
      this.deps.health.record('rpc', false, err instanceof Error ? err.message : String(err));
      throw err; // keep the last good total; the next tick retries
    }
    if (rediscover) {
      this.needsDiscovery = false;
      this.lastDiscoveryAt = now;
    }
    this.plan = snap.plan;
    this.lastSnapshot = snap;
    this.deps.health.record('rpc', true);
    this.deps.health.setChainTip(snap.slot);
    this.onchain = valueSnapshot(
      snap,
      await this.deps.prices.getPricesSol(mintsNeedingPrice(snap)),
    );

    // Project only once the history is in (a projection from half a history would close positions
    // whose open is not ingested yet), and only from a snapshot that saw every live position.
    if (!this.backfilling && snap.positionsComplete) {
      if (this.dirty) await this.projectAll(snap, this.onchain);
      else if (this.reconciled) await this.projectOpen(snap, this.onchain);
    }
    this.deps.onState(this.address);
  }

  private async projectAll(snap: OnchainWalletSnapshot, valued: OnchainValued): Promise<void> {
    const res = await this.deps.positionSync.sync(this.address, snap, valued);
    this.dirty = false;
    const firstProjection = !this.reconciled;
    this.reconciled = true;
    this.applyOpen(res.openPositions, res.transitions);
    // Newly closed = open in the persisted set just before this sync: on a restart, that is exactly
    // the positions that closed while the process was down.
    for (const row of res.closedRows) this.deps.bus.emit('closed', row);
    if (res.closed !== this.lastClosedCount) {
      this.lastClosedCount = res.closed;
      this.deps.bus.emit('closedChanged', { wallet: this.address });
      this.lastRealizedRunAt = Date.now();
      this.request('realized');
      // Arm the deferred realized refresh only for a live close, never for the first projection.
      if (!firstProjection && res.closedRows.length > 0) this.lastCloseAt = Date.now();
    }
    // Only a projection of the WHOLE history can be diffed meaningfully: an older open position that a
    // resumed backfill brings in later is not "just opened".
    if (this.historyComplete) this.announceTransitions = true;
  }

  private async projectOpen(snap: OnchainWalletSnapshot, valued: OnchainValued): Promise<void> {
    const res = await this.deps.positionSync.refreshOpen(this.address, snap, valued);
    this.applyOpen(res.openPositions, res.transitions);
    // A position left the chain but its close isn't projected yet: fetch the close now.
    if (res.transitions.vanished.length > 0) {
      this.dirty = true;
      this.request('ingest');
      this.request('snapshot'); // reproject even if the ingest finds nothing new (legs already in)
    }
  }

  private applyOpen(positions: OpenPosition[], t: OpenTransitions): void {
    this.open = new Map(positions.map((p) => [p.positionAddress, p]));
    if (!this.announceTransitions) return;
    for (const p of t.opened) this.deps.bus.emit('opened', p);
    for (const p of t.outOfRange)
      this.deps.bus.emit('rangeChanged', { position: p, outOfRange: true });
    for (const p of t.backInRange)
      this.deps.bus.emit('rangeChanged', { position: p, outOfRange: false });
  }

  /** The authoritative realized PnL of the wallet's closed positions (chained FIFO over the persisted
   *  legs and swaps). Tops the ingest up first — the residual sale usually lands seconds after the
   *  close — and projects what that found, so the FIFO reads current rows. */
  private async realized(): Promise<void> {
    if (!this.deps.realizedEnabled) return;
    await this.ingest();
    if (this.dirty && this.lastSnapshot) {
      this.pending.delete('snapshot'); // this pass is that snapshot
      await this.snapshot();
    }
    const result = await this.deps.realizedPnl.computeForWallet(this.address);
    // null = the history isn't complete yet: never overwrite good figures with a partial walk.
    if (result == null || result.byPosition.size === 0) return;
    const changed = await this.deps.store.setAuthoritativePnlMany(result.byPosition);
    await this.deps.walletRealized.set(this.address, result.tradingPnlSol);
    if (changed > 0) this.deps.bus.emit('closedChanged', { wallet: this.address });
    this.deps.logger.info(
      { wallet: this.address, changed, tradingPnlSol: result.tradingPnlSol },
      'realized-pnl: market_pnl_sol persisted',
    );
  }
}

export type { ClosedPosition };
