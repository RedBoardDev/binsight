import type {
  Health,
  OpenPosition,
  PositionBins,
  PositionHistory,
  WalletState,
} from '@binsight/shared';
import type { Logger } from 'pino';
import type { EventBus } from '@/application/event-bus';
import type { HealthMonitor } from '@/application/health-monitor';
import type { PositionSync } from '@/application/position-sync-service';
import type { RealizedPnlEngine } from '@/application/realized-pnl';
import type { AppConfig } from '@/config/env';
import type { OnchainWalletSnapshot } from '@/domain/dlmm';
import { liveMarkWallet } from '@/domain/live-mark';
import type {
  AccountRepository,
  ConfigRepository,
  OnchainDlmmGateway,
  PositionRepository,
  PriceGateway,
  StreamActivityReason,
  TransactionStreamPort,
  WalletRealizedStore,
  WalletTxIngestPort,
} from '@/domain/ports';
import { mintsNeedingPrice, valueSnapshot } from '@/domain/snapshot-valuation';
import { KeyedSerializer, Semaphore } from '@/util/concurrency';
import { StateEmitter } from './emitter';
import { makeRuntime, type WalletRuntime } from './runtime';
import type { StrategyService } from './strategy-service';
import { clamp, shouldRefreshOpenSnapshot, shouldRefreshRealized } from './utils';

const INITIAL_LAG_MS = 1500;
// Shared price-mark cadence: ONE engine-wide timer re-marks every VIEWED wallet's OPEN positions from
// cached on-chain data + the live Jupiter price (zero RPC). Replaces the blind per-wallet 30s
// WALLET_BALANCE_REFRESH_MS getMultipleAccounts snapshot. Above the 5s Jupiter price-cache TTL so each
// tick reflects a freshly fetched price; idle/un-viewed wallets are skipped → they cost 0 recurring RPC.
const PRICE_MARK_INTERVAL_MS = 10_000;
const STRATEGY_BACKFILL_MS = 60_000;
// Safety net: re-run snapshot discovery at least this often even with no WS activity, so a silently
// dropped open/close (WS reconnect gap) can't keep a stale position set indefinitely.
const SAFETY_REDISCOVER_MS = 600_000;
// Spread a fleet-wide resync burst (WS reconnect / manual refresh) across this step per wallet so it
// doesn't hit the shared RPC budget all in one tick.
const POLL_STAGGER_MS = 50;
// On-chain source: the OPEN-position refresh cadence. Drives BOTH (a) the periodic EXACT on-chain read
// (onTick → doSnapshot) that grows a live position's unclaimed fees + rebalances its bin liquidity — the
// 10s price-mark only RE-PRICES frozen amounts and can't do that — and (b) the open-only reproject that
// PERSISTS the result so the HTTP-polling widget sees it (reads only the open subset's legs, never the
// closed history). 10s aligns the exact fee/size read with the 10s price-mark so every field of an open
// position refreshes on the same beat. Cost: one getMultipleAccounts (cached plan, no 10-credit gPA) per
// OPEN-position wallet per tick — trivial here (the bot's dominant cost is the Enhanced realized-PnL
// ingest, ~95%, not these reads); bound to a viewed/requested set at large scale. The wallet's token
// balances are NOT part of that per-tick read: they only move when it transacts, so the gateway serves
// them from a cache invalidated on activity (see IDLE_TTL_MS). Folding them in would have made the tick
// cost scale with the account count — measured at 5 getMultipleAccounts on a 301-account wallet.
const SYNC_INTERVAL_MS = 10_000;
// How long an in-flight snapshot may run before a new one is allowed past the single-flight guard.
// Generous next to a normal pass (well under a second) so it only ever fires on a genuinely wedged one.
const SNAPSHOT_STUCK_MS = 120_000;
// Snapshot beat for a wallet with NO open positions. Its total is almost all idle SOL, which moves when
// a position closes and the liquidity lands — so it cannot be left unread, but it does not need 10s.
const IDLE_SYNC_INTERVAL_MS = 60_000;
// After a close the residual is usually market-sold within seconds; Helius indexes that swap in ~1-2s
// (measured), so the realized pass fired at close-detection can run BEFORE the sell exists and overstate
// PnL (residual still marked as held). Re-run it on a small front-loaded schedule after each close so the
// real sale value converges without waiting for the wallet's next close. Bounded → ≤ this many extra
// passes per close. Front-loaded because the bottleneck is the close→sell delay, not indexing.
const REALIZED_REFRESH_OFFSETS_MS = [25_000, 60_000, 150_000];
// Safety delta-ingest cadence — the no-miss backstop, adaptive on WS health. One getSignaturesForAddress
// against the wallet's cursor, so a tick that finds nothing costs a single credit (~300/day/wallet while
// connected). Faster when the socket is down, since the poll is then the only thing watching at all.
const INGEST_POLL_CONNECTED_MS = 300_000;
const INGEST_POLL_DISCONNECTED_MS = 30_000;

/** Engine dependencies — one options object instead of 16 positional ctor args. */
export interface EngineDeps {
  prices: PriceGateway;
  /** The WS backbone (Helius transactionSubscribe) — the trigger for triggerOnchainSync, replacing the
   *  old unconditional BACKSTOP_INGEST_MS sweep. */
  stream: TransactionStreamPort;
  onchain: OnchainDlmmGateway;
  health: HealthMonitor;
  strategy: StrategyService;
  repo: PositionRepository;
  config: ConfigRepository;
  accounts: AccountRepository;
  bus: EventBus;
  logger: Logger;
  appConfig: AppConfig;
  walletTxIngest: WalletTxIngestPort;
  positionSync: PositionSync;
  realizedPnl: RealizedPnlEngine;
  walletRealized: WalletRealizedStore;
}

export class Engine {
  private readonly wallets = new Map<string, WalletRuntime>();
  private readonly emitter: StateEmitter;
  private tick: NodeJS.Timeout | null = null;
  // Shared price-mark timer (one for the whole engine) + a single-flight guard so two ticks never overlap
  // the Jupiter fetch. The value-on-demand replacement for the deleted per-wallet 30s snapshot timer.
  private priceTick: NodeJS.Timeout | null = null;
  private priceMarking = false;
  private effectiveRps = 0;
  private lastBackfillAt = 0;
  // Serializes all ingests for one wallet (backfill + WS deltas + gap-backfill recoveries) so two never
  // race the same leg set — the in-process equivalent of a per-wallet lock (single-process deployment).
  private readonly ingestLock = new KeyedSerializer();
  // Global concurrent-backfill cap (onboarding admission control); sized to the RPC tier via config.
  private readonly backfillSemaphore: Semaphore;
  // Wallets a client is currently viewing (maintained by the WS layer). Drives `isWalletActive`, which
  // gates the shared price-mark tick (with notify-enabled wallets) so an idle wallet costs no recurring
  // work; a 0→1 viewer transition also triggers one refresh-on-connect EXACT read.
  private viewedWallets = new Set<string>();
  // Per-wallet guard so the chained-FIFO realized-PnL pass (persisted swap_flows + price gateway) never
  // runs twice concurrently for the same wallet — it fires async off the close-notification, not the loop.
  private readonly realizedPnlRunning = new Set<string>();
  // A trigger that arrives mid-run sets this so exactly ONE more pass runs after the current one
  // finishes (coalesced) — a close-burst no longer gets silently dropped by the single-flight guard.
  private readonly realizedPnlRerun = new Set<string>();

  private readonly prices: PriceGateway;
  private readonly stream: TransactionStreamPort;
  private readonly onchain: OnchainDlmmGateway;
  private readonly health: HealthMonitor;
  private readonly strategy: StrategyService;
  private readonly repo: PositionRepository;
  private readonly config: ConfigRepository;
  private readonly accounts: AccountRepository;
  private readonly bus: EventBus;
  private readonly logger: Logger;
  private readonly appConfig: AppConfig;
  private readonly walletTxIngest: WalletTxIngestPort;
  private readonly positionSync: PositionSync;
  private readonly realizedPnl: RealizedPnlEngine;
  private readonly walletRealized: WalletRealizedStore;

  constructor(deps: EngineDeps) {
    const { prices, bus, logger, repo, appConfig } = deps;
    this.prices = prices;
    this.stream = deps.stream;
    this.onchain = deps.onchain;
    this.health = deps.health;
    this.strategy = deps.strategy;
    this.repo = repo;
    this.config = deps.config;
    this.accounts = deps.accounts;
    this.bus = bus;
    this.logger = logger;
    this.appConfig = appConfig;
    this.walletTxIngest = deps.walletTxIngest;
    this.positionSync = deps.positionSync;
    this.realizedPnl = deps.realizedPnl;
    this.walletRealized = deps.walletRealized;
    // The emitter reports WS health off the live backbone (the on-chain TransactionStream).
    this.emitter = new StateEmitter(this.wallets, deps.stream, bus, this.health);
    this.backfillSemaphore = new Semaphore(appConfig.BACKFILL_CONCURRENCY);
  }

  async start(): Promise<void> {
    // The Helius transactionSubscribe stream is the trigger; its onReconnect drives a fleet delta-resync
    // and its built-in gap detector + fromSlot replay own the no-miss guarantee the deleted
    // BACKSTOP_INGEST_MS sweep used to provide.
    this.stream.onReconnect(() => this.resyncAllOnchain());
    this.stream.onConnectionChange((c) =>
      this.logger.debug({ connected: c }, 'Solana WS connection changed'),
    );
    this.stream.start();
    await this.strategy.init();

    for (const address of await this.accounts.monitoredWallets())
      await this.registerWallet(address);

    for (const [, rt] of this.wallets) {
      void this.onchainBackfill(rt);
    }

    this.tick = setInterval(() => this.onTick(), 1000);
    // Value-on-demand: a SINGLE shared timer re-marks viewed wallets off the live price (zero RPC),
    // instead of the per-wallet getMultipleAccounts snapshot we just removed from onTick.
    this.priceTick = setInterval(() => void this.runPriceMark(), PRICE_MARK_INTERVAL_MS);
  }

  stop(): void {
    if (this.tick) clearInterval(this.tick);
    if (this.priceTick) clearInterval(this.priceTick);
    this.stream.stop();
  }

  async addWallet(address: string): Promise<void> {
    if (this.wallets.has(address)) return;
    await this.registerWallet(address);
    void this.onchainBackfill(this.wallets.get(address)!);
  }

  removeWallet(address: string): void {
    this.stream.unwatch(address);
    this.wallets.delete(address);
    this.ingestLock.delete(address);
  }

  getState(wallets: string[], scope: string): WalletState {
    return this.emitter.getState(wallets, scope);
  }

  /** Current health snapshot — lets the WS layer hand a freshly-connected client the live status right
   *  away (emit-on-change means it wouldn't otherwise receive a frame until the next real change). */
  healthSnapshot(): Health {
    return this.emitter.snapshotHealth();
  }

  /** Per-bin liquidity of one open position (Price-Bin histogram). Null if closed/missing. */
  positionBins(positionAddress: string): Promise<PositionBins | null> {
    return this.onchain.positionBins(positionAddress);
  }

  /** On-chain event timeline of a position (History drawer). Null if no history. */
  positionHistory(positionAddress: string): Promise<PositionHistory | null> {
    return this.onchain.positionHistory(positionAddress);
  }

  /** SOL spot price in USD — for the USD figures on a share card. Null if unavailable. */
  solUsdPrice(): Promise<number | null> {
    return this.prices.getSolUsd();
  }

  /** Immediately re-sync + snapshot all wallets (a manual refresh from a client). */
  refreshNow(): void {
    this.resyncAllOnchain();
  }

  /** The WS layer reports which wallets currently have a viewer. The recurring net-worth snapshot is
   *  gated on this so idle/unwatched wallets cost no RPC; a wallet that GAINS a viewer (0→1) is
   *  snapshotted immediately so a returning viewer isn't served a stale total. */
  setViewedWallets(wallets: Set<string>): void {
    for (const w of wallets) {
      if (this.viewedWallets.has(w)) continue;
      const rt = this.wallets.get(w);
      if (rt) void this.doSnapshot(rt); // refresh-on-connect
    }
    this.viewedWallets = wallets;
  }

  /** A wallet warrants the recurring snapshot if a client is viewing it OR it has an enabled
   *  notification rule (global or wallet-scoped) — the owner's alert path is never gated on viewers. */
  private async registerWallet(address: string): Promise<void> {
    const rt = makeRuntime(address, await this.repo.getOpen(address));
    this.wallets.set(address, rt);
    // transactionSubscribe: a DLMM tx (or a gap-detector recovery) → the cursor-based delta ingest.
    this.stream.watch(address, (wallet, reason) => this.onStreamActivity(wallet, reason));
  }

  /** How often to run the safety delta ingest. Rare while the stream is up (it already delivers activity
   *  within seconds); brisk while it is down, because then the poll is the ONLY way anything is noticed. */
  private ingestPollIntervalMs(): number {
    return this.stream.isConnected() ? INGEST_POLL_CONNECTED_MS : INGEST_POLL_DISCONNECTED_MS;
  }

  private onTick(): void {
    // Poll-budget bookkeeping kept ONLY to keep the Health wire's `pollIntervalMs` / `effectiveRps`
    // fields populated exactly as they already were in on-chain mode (native clients decode both, and
    // the RuntimeSettings poll knobs are still exposed to the Settings page). Nothing polls per pool
    // anymore — `rt.pools` is never populated now that the Meteora poller is gone, so `effectiveRps`
    // stays 0 and the interval is a pure cadence hint, not a driver of any RPC.
    let totalPools = 0;
    for (const rt of this.wallets.values()) totalPools += Math.max(rt.pools.length, 1);
    const settings = this.config.getSettings();
    let rps = 0;

    for (const rt of this.wallets.values()) {
      const hasOpen = rt.open.size > 0;
      const perPoolMs = (totalPools / settings.meteoraTargetRps) * 1000;
      const interval = hasOpen
        ? clamp(perPoolMs * Math.max(rt.pools.length, 1), settings.pollMinMs, settings.pollMaxMs)
        : settings.pollIdleMs;
      rt.pollIntervalMs = interval;

      // The blind per-wallet WALLET_BALANCE_REFRESH_MS getMultipleAccounts snapshot is GONE: an EXACT
      // on-chain read now fires only on a real event (WS position-set change, viewer-connect, detail
      // view), and a VIEWED wallet's live value/range is kept current by the shared price-mark timer
      // (runPriceMark) off cached data — zero RPC. So an idle wallet (no viewer, no activity) issues no
      // recurring RPC at all.
      // The no-miss backstop. `logsSubscribe` — the only WS method available on every plan — offers no
      // replay, so a dropped socket loses whatever happened while it was down and nothing can ask for it
      // back. Correctness therefore cannot rest on the stream; it rests here. A poll with nothing new is
      // ONE getSignaturesForAddress against the durable cursor: a single credit, ~300/day per wallet at
      // the connected cadence. The stream is what makes updates feel instant, not what makes them safe.
      if (Date.now() - rt.lastIngestAt >= this.ingestPollIntervalMs()) {
        rt.lastIngestAt = Date.now(); // claim the slot now so the 1s tick can't queue a second pass
        void this.triggerOnchainSync(rt.address);
      }
      // Drive a SLOW periodic EXACT snapshot for any wallet with OPEN positions. The 10s price-mark only
      // re-prices the cached snapshot's frozen amounts (zero RPC) — it can't grow unclaimed fees or
      // re-balance bin liquidity, which need a fresh on-chain read. Without this, a quiet open position's
      // unclaimed fees stay pinned at their open-time value (≈0) for BOTH WS and HTTP (widget) clients. A
      // cached plan keeps this to getMultipleAccounts (no 10-credit gPA); idle wallets (no open positions)
      // re-snapshot nothing. (At large scale, bound to a recently-requested set to keep it cheap.)
      if (
        shouldRefreshOpenSnapshot({
          reconciled: rt.reconciled,
          snapshotting: rt.snapshotting,
          lastSyncAt: rt.lastSyncAt,
          now: Date.now(),
          // An open position needs the 10s beat (fees grow, bins move). A wallet with nothing open
          // still needs its total refreshed — that is when a close has just returned liquidity to it —
          // but a minute is plenty for a figure whose only mover is a transaction.
          intervalMs: hasOpen ? SYNC_INTERVAL_MS : IDLE_SYNC_INTERVAL_MS,
        })
      )
        void this.doSnapshot(rt);
      if (hasOpen) rps += rt.pools.length / (interval / 1000);
    }

    if (Date.now() - this.lastBackfillAt >= STRATEGY_BACKFILL_MS) {
      this.lastBackfillAt = Date.now();
      void this.strategy.backfill();
    }

    this.effectiveRps = rps;
    this.emitter.emitHealth(this.effectiveRps);
  }

  /**
   * Authoritative, slot-consistent wallet valuation from on-chain accounts (positions + idle + fees +
   * rent in ONE getMultipleAccounts pass). Replaces the old tvl+idle two-clock total and its pendingDelta
   * heuristic. Never resets the last good total on failure — a transient RPC error must not corrupt
   * the displayed wallet size.
   */
  private async doSnapshot(rt: WalletRuntime): Promise<void> {
    // `snapshotting` is cleared in a finally, so a THROW always releases it — but an await that never
    // settles (a wedged RPC lane, a half-open socket) would pin it forever and the wallet would simply
    // stop updating, silently and with no error. Treat an in-flight pass older than the stuck window as
    // dead and let a new one through: a duplicate snapshot is cheap, a frozen wallet is not.
    if (rt.snapshotting && Date.now() - rt.lastSnapshotAt < SNAPSHOT_STUCK_MS) return;
    rt.snapshotting = true;
    rt.lastSnapshotAt = Date.now();
    try {
      // Layer A: only re-discover (the 10-credit getProgramAccounts) when the position set may have
      // changed — on WS activity, a missing plan, or the periodic safety interval. Clear the flag
      // BEFORE awaiting so a WS event during the snapshot forces another discovery next tick.
      const rediscover =
        rt.needsDiscovery ||
        rt.snapshotPlan === null ||
        Date.now() - rt.lastDiscoveryAt >= SAFETY_REDISCOVER_MS;
      if (rediscover) {
        rt.needsDiscovery = false;
        rt.lastDiscoveryAt = Date.now();
      }
      const snap = await this.onchain.snapshotWallet(
        rt.address,
        rediscover ? undefined : (rt.snapshotPlan ?? undefined),
      );
      rt.snapshotPlan = snap.plan;
      // Cache the raw snapshot so the shared price-mark tick can re-price it (live Jupiter price, zero RPC)
      // for a viewed wallet between exact reads. Persistence still uses the EXACT `valued` below.
      rt.lastSnapshot = snap;
      this.health.record('rpc', true);
      this.health.setChainTip(snap.slot);
      const priceMap = await this.prices.getPricesSol(mintsNeedingPrice(snap));
      const valued = valueSnapshot(snap, priceMap);
      rt.onchain = valued;
      this.emitter.emitState(rt.address);
      // Keep the positions table in sync with the legs ⊕ this snapshot.
      //  - after an INGEST (`needsSync`): FULL reproject (open + closed) — closed may have changed.
      //    Emit closed_changed ONLY when the closed count actually moves, so viewers don't refetch on
      //    every tick. Flags cleared AFTER success so a transient failure retries next tick.
      //  - otherwise on the CADENCE: refresh ONLY the open positions' live value/range (cheap) — never
      //    re-write the (large, unchanged) closed history. Waits for `reconciled` so a tick before the
      //    first backfill can't wipe the open set with an empty projection.
      if (rt.needsSync) {
        // `sync` already returns ONLY the genuinely newly-closed rows (open→closed transitions vs the
        // persisted prior-open set). That diff is the sole spam guard and it is sufficient on its own:
        //  - the historical backfill (the FIRST-EVER sync of a wallet) persists ~15k closed rows but the
        //    prior-open set is empty, so ZERO are flagged newly-closed → no backfill spam;
        //  - a position transitions to closed at most once (the next sync no longer has it in prior-open).
        // The old `wasReconciled` gate additionally suppressed the FIRST sync after ANY (re)start — but
        // that sync is precisely the one that detects positions closed while the process was down, whose
        // prior-open set was persisted before shutdown. Gating it dropped every downtime close silently on
        // every deploy. So emit unconditionally; `reconciled` now only paces the deferred realized pass.
        const wasReconciled = rt.reconciled;
        const res = await this.positionSync.sync(rt.address, snap, valued);
        rt.needsSync = false;
        rt.lastSyncAt = Date.now();
        rt.reconciled = true;
        this.applyOpenPositions(rt, res.openPositions);
        for (const row of res.closedRows) this.bus.emit('closed', row);
        if (res.closed !== rt.lastClosedCount) {
          rt.lastClosedCount = res.closed;
          this.bus.emit('closedChanged', { wallet: rt.address });
          // The closed set moved → (re)compute the authoritative on-chain realized market_pnl_sol for
          // this wallet's closed positions. Runs async so it never blocks the snapshot loop; the UI fills
          // in via a second closedChanged when it persists. The pass reads the PERSISTED swap_flows (no
          // Enhanced re-page) after a cheap delta top-up — so a restart/close costs ~0 credits, which is
          // what fixes the getEnhancedTransactionsByAddress blowout an on-every-close re-page caused.
          rt.lastRealizedRunAt = Date.now();
          void this.runRealizedPnl(rt.address);
          // Arm the BOUNDED deferred refresh (below) ONLY for a genuine LIVE close — post-reconcile with
          // newly-closed rows. NEVER the initial backfill count-establishment (wasReconciled=false) or a
          // bulk catch-up, which would otherwise fan out N extra realized passes per wallet on cold-start.
          if (wasReconciled && res.closedRows.length > 0) rt.lastCloseAt = Date.now();
        }
      } else if (rt.reconciled && Date.now() - rt.lastSyncAt >= SYNC_INTERVAL_MS) {
        const open = await this.positionSync.refreshOpen(rt.address, snap, valued);
        rt.lastSyncAt = Date.now();
        this.applyOpenPositions(rt, open);
      }

      // Deferred convergence: independent of a new close, keep re-running the realized pass for a bounded
      // window after the last close so a freshly market-sold residual's REAL value lands once Helius
      // indexes the swap — instead of showing the stale pool-spot mark until the wallet's next close.
      if (
        rt.reconciled &&
        shouldRefreshRealized({
          now: Date.now(),
          lastCloseAt: rt.lastCloseAt,
          lastRealizedRunAt: rt.lastRealizedRunAt,
          offsetsMs: REALIZED_REFRESH_OFFSETS_MS,
        })
      ) {
        rt.lastRealizedRunAt = Date.now();
        // Each deferred pass tops up the swap delta (the late residual sell) then re-reads the persisted
        // swap_flows — cheap, so it converges fast even for huge wallets, with no full re-page.
        void this.runRealizedPnl(rt.address);
      }
    } catch (err) {
      this.health.record('rpc', false, err instanceof Error ? err.message : String(err));
      this.logger.warn(
        { err, address: rt.address },
        'on-chain snapshot failed — keeping last good total',
      );
    } finally {
      rt.snapshotting = false;
    }
  }

  /**
   * Shared price-mark tick — the value-on-demand replacement for the deleted 30s per-wallet snapshot.
   * Re-marks EVERY wallet that has OPEN positions from its CACHED on-chain snapshot + ONE shared Jupiter
   * price fetch (free — not a Helius RPC), so it touches NO getMultipleAccounts/getAccountInfo. The result
   * is the APPROXIMATE live mark (token amounts held fixed, re-priced); it is both EMITTED to live WS
   * viewers AND PERSISTED to the open set so HTTP/DB-backed clients (the macOS widget polls — it never sees
   * the WS marks) track the price in real time too. The NetworthRecorder still skips marks (complete:false)
   * — only an EXACT on-chain read is authoritative for net worth, and it overwrites the mark the moment
   * real activity lands. Wallets with no open positions are skipped → zero recurring cost. Single-flight so
   * two ticks never overlap the fetch.
   */
  private async runPriceMark(): Promise<void> {
    if (this.priceMarking) return;
    const targets: { rt: WalletRuntime; snap: OnchainWalletSnapshot }[] = [];
    for (const rt of this.wallets.values()) {
      // Re-mark every wallet with OPEN positions — not just viewed ones. DB-backed clients (the widget
      // polls over HTTP, never receives the WS marks) need the PERSISTED value to follow the price. The
      // Jupiter price fetch is FREE (0 Helius). At large scale, bound this to a recently-requested set so
      // the per-tick DB writes stay cheap; fine at the current wallet count.
      const snap = rt.lastSnapshot;
      if (!snap || snap.positions.length === 0) continue; // nothing open → nothing to re-mark
      targets.push({ rt, snap });
    }
    if (targets.length === 0) return; // no viewer with open positions → no Jupiter call, no emission
    this.priceMarking = true;
    try {
      // ONE shared price fetch covering every viewed wallet's mints (CachedPriceGateway dedups + caches).
      const mints = new Set<string>();
      for (const { snap } of targets) for (const m of mintsNeedingPrice(snap)) mints.add(m);
      const priceMap = await this.prices.getPricesSol([...mints]);
      for (const { rt, snap } of targets) {
        const { valued, open } = liveMarkWallet(snap, [...rt.open.values()], priceMap);
        this.emitter.emitMarked(rt.address, open, valued);
        // PERSIST the live mark so HTTP/DB-backed clients (the widget) see the fresh price too — 0 Helius
        // (Jupiter), just a rewrite of the open set. Isolated so a write hiccup never breaks the tick; an
        // EXACT on-chain read still overwrites this the moment real activity lands.
        await this.positionSync
          .refreshOpen(rt.address, snap, valued)
          .catch((err) =>
            this.logger.warn({ err, wallet: rt.address }, 'price-mark persist failed'),
          );
      }
    } catch (err) {
      this.logger.warn({ err }, 'price-mark tick failed — keeping last emitted state');
    } finally {
      this.priceMarking = false;
    }
  }

  /** Refresh the in-memory open set from the freshly persisted projection and push it
   *  to viewers. `rt.open` is otherwise seeded only at registration, so without this a position opened
   *  after the wallet was registered never appears in the live state until the next process restart. */
  private applyOpenPositions(rt: WalletRuntime, positions: OpenPosition[]): void {
    rt.open = new Map(positions.map((p) => [p.positionAddress, p]));
    this.emitter.emitState(rt.address);
  }

  /**
   * Recompute + persist the authoritative on-chain realized PnL (`market_pnl_sol`) for a wallet's CLOSED
   * positions via the chained-FIFO engine. Idempotent (re-running just rewrites the same values) and
   * single-flight per wallet so it can never pile up. Errors are swallowed — a failed pass must not
   * disturb the live snapshot loop; the existing values stay until the next close-notification retries.
   */
  private async runRealizedPnl(wallet: string): Promise<void> {
    // Master switch: when disabled, NO swap ingest / realized read runs. Closed positions keep their
    // persisted market_pnl_sol; new closes fall back to the pool mark. This is what keeps RPC ≈ 0 and
    // lets the engine scale to many wallets.
    if (!this.appConfig.REALIZED_PNL_ENABLED) return;
    if (this.realizedPnlRunning.has(wallet)) {
      this.realizedPnlRerun.add(wallet); // coalesce a mid-run trigger into one more pass
      return;
    }
    this.realizedPnlRunning.add(wallet);
    try {
      // Freshness: top up the ingest BEFORE reading swap_flows. The residual sale usually lands a few
      // seconds AFTER the close that triggered this pass, so without it the FIFO would read the DB too
      // early and still count the residual as held — overstating PnL. A top-up that finds nothing costs
      // ONE getSignaturesForAddress (1 credit), which is why it can run on every deferred pass.
      try {
        await this.ingestLock.run(wallet, () => this.walletTxIngest.ingest(wallet));
      } catch (err) {
        this.logger.warn(
          { err, wallet },
          'realized-pnl: delta top-up failed — computing on already-persisted swaps',
        );
      }
      do {
        this.realizedPnlRerun.delete(wallet);
        const result = await this.realizedPnl.computeForWallet(wallet);
        // null = the engine refused to produce values (incomplete persisted swap history — cursor
        // missing or the seed unfinished). Skip persisting so a partial history can never overwrite good
        // market_pnl_sol with inflated held values.
        if (result == null || result.byPosition.size === 0) continue;
        // One atomic batched UPDATE for the whole wallet (was N sequential single-row writes): a
        // mid-loop crash can no longer leave mixed old/new market_pnl_sol generations.
        await this.repo.setAuthoritativePnlMany(result.byPosition);
        // The other half of the same walk: gains on tokens that never came from a position. Persisted
        // beside the per-position figures so the reported realized PnL is the whole result, not just
        // the part that happens to map onto a position.
        await this.walletRealized.set(wallet, result.tradingPnlSol);
        // Tell viewers the closed figures changed so the table/stats recompute with the real cash values.
        this.bus.emit('closedChanged', { wallet });
        this.logger.info(
          { wallet, written: result.byPosition.size, tradingPnlSol: result.tradingPnlSol },
          'realized-pnl: market_pnl_sol persisted',
        );
      } while (this.realizedPnlRerun.has(wallet));
    } catch (err) {
      this.logger.error({ err, wallet }, 'realized-pnl pass failed — keeping prior market_pnl_sol');
    } finally {
      this.realizedPnlRunning.delete(wallet);
      this.realizedPnlRerun.delete(wallet);
    }
  }

  /** Initial catch-up for a wallet: the full historical ingest of its transactions — legs, cash-flows
   *  and swap legs all decoded from the same fetch — then project the positions table from them. */
  private onchainBackfill(rt: WalletRuntime): Promise<void> {
    // Admission control: at most BACKFILL_CONCURRENCY wallets backfill at once.
    return this.backfillSemaphore.run(async () => {
      try {
        rt.lastIngestAt = Date.now();
        await this.ingestLock.run(rt.address, () =>
          this.walletTxIngest.ingest(rt.address, {
            onProgress: (txs) => {
              rt.ingestedTxs = txs; // surfaced as the UI's "indexing… (N txs)" onboarding progress
            },
          }),
        );
        rt.needsSync = true;
        await this.doSnapshot(rt); // full reproject; emits closed_changed iff the closed count moved
        this.logger.info({ address: rt.address }, 'onchain backfill complete');
      } catch (err) {
        this.logger.error(
          { err, address: rt.address },
          'onchain backfill failed — next stream activity / gap detector will retry',
        );
      }
    });
  }

  /** Onboarding status for a wallet: `ready` once its first projection has landed (history is queryable);
   *  `indexedTxs` = txs ingested so far during the initial backfill (for an "indexing…" UI state). */
  ingestStatus(address: string): { ready: boolean; indexedTxs: number } {
    const rt = this.wallets.get(address);
    return { ready: rt?.reconciled ?? false, indexedTxs: rt?.ingestedTxs ?? 0 };
  }

  /**
   * TransactionStream activity for a wallet — a live `ws` DLMM notification OR a `gap-backfill` recovery
   * from the no-miss gap detector. BOTH funnel into the SAME cursor-based delta ingest + close-detection
   * (`triggerOnchainSync`, via `onchainActivity`'s short settle lag). The stream is purely the TRIGGER
   * that replaced the unconditional BACKSTOP_INGEST_MS sweep; we don't parse the WS payload into legs here
   * (a later optimization) — the cheap delta ingest re-reads the new signatures.
   */
  private onStreamActivity(wallet: string, reason: StreamActivityReason): void {
    this.logger.debug({ wallet, reason }, 'stream activity → onchain delta sync');
    this.onchainActivity(wallet);
  }

  /** WS open/close/add/remove/claim → delta-ingest the new signatures then re-project, after a short
   *  lag so the just-confirmed tx is visible to getSignaturesForAddress. */
  private onchainActivity(address: string): void {
    // The wallet transacted, so its token balances may have moved. This is the only signal that covers
    // a plain SPL transfer: it is not a DLMM instruction, so it never invalidates the discovery plan.
    this.onchain.invalidateIdle(address);
    setTimeout(() => void this.triggerOnchainSync(address), INITIAL_LAG_MS);
  }

  /** Delta-ingest a wallet's new legs (cursor top-up), then sync — the WS-activity & gap-backfill path. */
  private async triggerOnchainSync(address: string): Promise<void> {
    const rt = this.wallets.get(address);
    if (!rt) return;
    try {
      rt.lastIngestAt = Date.now();
      const r = await this.ingestLock.run(address, () => this.walletTxIngest.ingest(address));
      // Only force a full reproject when the delta actually ingested new txs (a real open/close/add/
      // claim). A delta sync that finds nothing (e.g. a gap-backfill recovery) must NOT re-write the whole
      // closed history — that was a recurring 15k-row write per wallet. doSnapshot still refreshes net-worth.
      if (r.txs > 0) {
        rt.needsSync = true;
        // New legs landed → the position SET may have changed (a real OPEN/add/remove). Force the next
        // snapshot to re-run discovery (getProgramAccountsV2, 1 credit) so a newly-OPENED position is
        // actually FOUND. The legacy logsSubscribe path set this in onWsActivity; the transactionStream
        // path lost it, so opens stayed undiscovered until the 10-min SAFETY_REDISCOVER_MS fallback — they
        // never surfaced (the open-detection regression). Covers the WS, reconnect-resync and gap paths.
        rt.needsDiscovery = true;
      }
      await this.doSnapshot(rt);
    } catch (err) {
      this.logger.warn(
        { err, address },
        'onchain delta sync failed (next stream activity will retry)',
      );
    }
  }

  /** WS reconnect / manual refresh: a staggered safety delta-ingest of every wallet to self-heal gaps. */
  private resyncAllOnchain(): void {
    let i = 0;
    for (const rt of this.wallets.values()) {
      const { address } = rt;
      setTimeout(() => void this.triggerOnchainSync(address), i++ * POLL_STAGGER_MS);
    }
  }
}
