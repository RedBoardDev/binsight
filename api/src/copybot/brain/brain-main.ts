/**
 * Copy-bot · Inc.2 — BRAIN process (NO keys, NO inbound socket). Detects the leader's DLMM events →
 * decides (sizing/caps, no filters in v1) → BUILDS the tx (SDK: FAITHFUL re-anchored open by-weight / close /
 * claim) → PUBLISHES a `SignRequest` on `cmd:sign` (Redis bus, HMAC). The vault signs+lands (separate process).
 *
 * Bundled CJS (tsup.copybot.config.ts) — imports the SDK, NEVER runs under tsx. Does NOT import the keypair.
 *   yarn tsup --config tsup.copybot.config.ts → node --env-file=../.env dist/copybot/brain-main.cjs [--once] [--seconds=N]
 *
 * Inc.3b: everything tenant-scoped lives in `createUserRuntime` (user-runtime.ts); per-leader detection + the
 * event fan-out live in the `LeaderHub` (leader-hub.ts), driven by the CONFIG-DERIVED leader set (computeLeaderSet
 * — step 7a; COPYBOT_LEADER is demoted to a boot-warning). Boot + live reload spawn ONE runtime per ACTIVE user
 * (user-reload.ts — step 7b); the shared-wallet sweeps (reconcile / rug-SL — wallet-sweeps.ts) and the wallet
 * token sweep run across every runtime. This file keeps the PROCESS SHELL — env/boot, the timers, the sweep/reload
 * wiring and the ev:executed consumer (routed per runtime via executed-router). The SYSTEM runtime is ALWAYS
 * booted: it is the WALLET context (orphan closes / sweep sells / --once publish as SYSTEM, INC3B-PLAN §4).
 */
import { DLMM_PROGRAM_ID } from '@binsight/shared';
import { Connection, PublicKey } from '@solana/web3.js';
import { pino } from 'pino';
import { createDiscordAlertSink } from '@/copybot/alert';
import { assertBusKey } from '@/copybot/bus-key-guard';
import { ConfigStore } from '@/copybot/config-store';
import { makeDetectionDeps } from '@/copybot/detection';
import { HeartbeatStore } from '@/copybot/heartbeat-store';
import { SYSTEM_USER_ID } from '@/copybot/journal-store';
import { CopyEvents } from '@/copybot/observability/copy-events';
import { EventStore } from '@/copybot/observability/event-store';
import { PRUNE_INTERVAL_MS, pruneOldRows } from '@/copybot/observability/retention';
import type { CopybotConfig } from '@/domain/copybot/config';
import type { DetectedEvent } from '@/domain/copybot/events';
import { computeLeaderSet, shouldRetainLeader } from '@/domain/copybot/fan-out';
import type { TokenSnapshot } from '@/domain/copybot/filters';
import { LeaderDetector } from '@/domain/copybot/leader-detector';
import {
  assembleBrainStatus,
  type BrainStatusDetail,
  DETECTION_STALE_FAILURES,
  detectionHealthy,
  HEARTBEAT_INTERVAL_MS,
  shouldAlertDetectionStale,
} from '@/domain/copybot/status';
import { TtlCache } from '@/domain/copybot/ttl-cache';
import type { LoadedPoolMeta } from '@/domain/dlmm';
import { ControlChannel } from '@/infrastructure/bus/control-channel';
import { RedisBus } from '@/infrastructure/bus/redis-bus';
import { JupiterTokenGateway } from '@/infrastructure/jupiter/jupiter-token-gateway';
import { CopybotActivationRepository } from '@/infrastructure/persistence/copybot-activation-repository';
import { CopybotPositionsRepository } from '@/infrastructure/persistence/copybot-positions-repository';
import { openDatabase } from '@/infrastructure/persistence/database';
import { FeeLedgerRepository } from '@/infrastructure/persistence/fee-ledger-repository';
import { PositionLedgerRepository } from '@/infrastructure/persistence/position-ledger-repository';
import { BlockhashCache } from '@/infrastructure/solana/blockhash-cache';
import { readActiveTokenPrice } from '@/infrastructure/solana/dlmm/active-bin-price';
import { decodeDlmmLegs } from '@/infrastructure/solana/dlmm/dlmm-event-decoder';
import {
  readLeaderPositionShape,
  readUserPositions,
} from '@/infrastructure/solana/dlmm/leader-position-reader';
import { OnchainPoolMetaReader } from '@/infrastructure/solana/dlmm/pool-meta';
import { HeliusTxSubscriber } from '@/infrastructure/solana/helius-tx-subscriber';
import {
  DEFAULT_JUPITER_BASE_URL,
  WSOL_MINT,
} from '@/infrastructure/solana/jupiter/jupiter-swap-builder';
import { PriorityFeeOracle } from '@/infrastructure/solana/priority-fee-oracle';
import { readAllOwnerTokenBalances } from '@/infrastructure/solana/token-balance-reader';
import { HeliusTokenMetadataGateway } from '@/infrastructure/solana/token-metadata-gateway';
import {
  type ExecutedBatchDeps,
  processExecutedBatch,
  settleContinuationFailure,
} from './dispatch-executed';
import { resolveExecutedTarget } from './executed-router';
import { runFeeSweep } from './fee-sweep';
import { LeaderHub } from './leader-hub';
import { resolveUserWallet } from './spawn-wallet';
import { reloadAllUsers } from './user-reload';
import {
  createUserRuntime,
  INFLIGHT_BUY_GRACE_MS,
  RECLOSE_GRACE_MS,
  SELL_RESIDUAL_DUST_RAW,
  type SharedBrainDeps,
  type UserRuntime,
} from './user-runtime';
import { createWalletBalanceCache, WALLET_BALANCE_TTL_MS } from './wallet-balance-cache';
import { runReconcileSweepByWallet, runResidualSweep, runRugSlSweep } from './wallet-sweeps';

const POLL_MS = 15_000;
const RECON_MS = 30_000; // on-chain reconcile cadence (no-miss-close backstop)
const RECONCILE_OPEN_GRACE_MS = Number(process.env.RECONCILE_OPEN_GRACE_MS ?? '30000'); // a just-opened copy may be unconfirmed for ~1-2s (direct getAccountInfo) → skip the 1st reconcile tick after open; 30s = generous margin, minimal backstop delay (anti false-close → no-dormant)
const SWEEP_MS = Number(process.env.SWEEP_MS ?? '60000'); // wallet token→SOL safety-sweep cadence (SYSTEM): the no-miss backstop behind the close-triggered sell (catches any dormant non-SOL left by downtime/a missed close)
const FEE_SWEEP_MS = Number(process.env.FEE_SWEEP_MS ?? '60000'); // performance-fee sweep cadence (Inc.4d): retry each pending fee transfer until it lands — decoupled from the close, so a generous cadence is fine
const FEE_SWEEP_BATCH = Number(process.env.FEE_SWEEP_BATCH ?? '25'); // max pending fees published per sweep tick (bounds the per-tick publish burst)
const EV_EXECUTED_STREAM = 'copybot:ev:executed';
const RUG_SL_POLL_MS = 15_000; // rug-SL price-poll cadence: ~4 samples per a 60s window — fast enough to catch a crash, one lbPair read per open pool (economical)
const CONFIG_POLL_MS = 5_000; // re-read the DB-backed runtime config (sizing/caps/two-sided) so web edits apply live
const SNAPSHOT_TTL_MS = 30_000; // per-mint filter-snapshot cache TTL (short; pre-warm makes repeat opens free)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const cfg = {
  httpUrl: process.env.SOLANA_HTTP_URL ?? '',
  wsUrl: process.env.SOLANA_WS_URL,
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6385',
  dbUrl: process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora',
  leader: process.env.COPYBOT_LEADER ?? '8ryctvNwpJTuuap3wuNTfcyEx4DjSuXvhGXSDHNaU8sQ',
  ownerPubkey: process.env.COPIER_OWNER ?? 'Ybbt2Td4TjxwpzvuicbP9ANizBwAJzqjuRmRrvDh9zz',
  balanceSol: Number(process.env.COPIER_BALANCE_SOL ?? '10'),
  jupiterBaseUrl: process.env.JUPITER_BASE_URL ?? DEFAULT_JUPITER_BASE_URL,
  jitoEnabledEnv:
    process.env.COPYBOT_JITO !== undefined ? process.env.COPYBOT_JITO === 'true' : undefined, // env override of the DB jitoEnabled (anti-sandwich tip ix)
  priorityFeeOracleEnv:
    process.env.COPYBOT_PRIORITY_FEE_ORACLE !== undefined
      ? process.env.COPYBOT_PRIORITY_FEE_ORACLE === 'true'
      : undefined, // env override of the DB priorityFeeOracle
};
// Sizing/caps/two-sided/filters all come from the DB-backed config (config-store), resolved per leader via eff().
// The DB config is the SINGLE source of truth (the on-chain bench seeds it directly — see test-onchain/bench-config).
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// A two-sided open's BOUGHT token sits on the wallet between the buy landing and the deposit landing. Since the
// safety-sweep now sells ANY non-SOL residual (SELL_RESIDUAL_DUST_RAW=0), it must NOT sell that in-flight token
// mid-open (it would empty the token leg). Track the mint while the open is in flight; the sweep skips it within a
// grace, after which a still-present token (the open failed) IS a real stranded residual → swept (cleanup).
const inFlightBuyMints = new Map<string, number>(); // tokenMint → ms the two-sided buy was published
// A published residual SELL (close-triggered OR safety-sweep) carries no token identity on its `ev:executed`
// confirm — only the commandId/pool. Stash the sold token (mint + resolved symbol if known) keyed by the sell's
// commandId at publish time, so the sell-confirm handler can name the token in the FEED `swap.executed` line
// ("Swapped X → SOL") WITHOUT an extra RPC. Mirrors the inFlightBuyMints / pendingReshapeAdds stash pattern.
const pendingSellMints = new Map<
  string,
  { tokenMint: string; nonSolSymbol: string | null; pool: string }
>();
// The in-flight-buy grace (INFLIGHT_BUY_GRACE_MS) lives in user-runtime.ts since 3b step 6: the close-triggered
// sell applies the SAME grace as the sweep below (a shared-wallet hazard — see onCloseExecuted).
const TOKEN2022_DEPOSIT_GRACE_MS = 90_000; // orphan-close grace for an empty position whose deposit is still in flight; past it, a non-deposited position is cleaned

async function main(): Promise<void> {
  if (!cfg.httpUrl) {
    log.error('SOLANA_HTTP_URL missing');
    process.exit(1);
  }
  // Fail-closed on the bus HMAC (forging cmd:sign would make the vault sign): refuse to boot with a missing/insecure key.
  const busKey = assertBusKey(process.env);
  if ('error' in busKey) {
    log.error(busKey.error);
    process.exit(1);
  }
  const hmacKey = busKey.key;
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const secondsArg = args.find((a) => a.startsWith('--seconds='));
  const autoStopSec = secondsArg ? Number(secondsArg.slice('--seconds='.length)) : 0;

  const conn = new Connection(cfg.httpUrl, 'confirmed');
  const leaderPk = new PublicKey(cfg.leader);
  const ownerPk = new PublicKey(cfg.ownerPubkey);
  const poolReader = new OnchainPoolMetaReader(conn);
  const tokenMeta = new HeliusTokenMetadataGateway(cfg.httpUrl, log);
  const bus = RedisBus.connect(cfg.redisUrl);
  const db = openDatabase(cfg.dbUrl);
  const configStore = new ConfigStore(db, log);
  const control = ControlChannel.connect(cfg.redisUrl); // instant config-reload pings (kill-switch applies in <100ms)
  const heartbeat = new HeartbeatStore(db, log, 'brain'); // process status the web reads (online + positions/exposure/latency)
  const recentlyPublishedClose = new Map<string, number>(); // ourPosition → ms a close was last published (reClose grace)
  const blockhashCache = new BlockhashCache(async () => {
    const b = await conn.getLatestBlockhash();
    return { blockhash: b.blockhash, lastValidBlockHeight: b.lastValidBlockHeight };
  });
  // Live priority-fee oracle (opt-in): scoped to DLMM-program activity, background-refreshed so serializeUnsigned
  // reads it instantly. Off ⇒ never started, never queried → the static tier stands (zero extra RPC).
  const priorityFeeOracle = new PriorityFeeOracle(cfg.httpUrl, DLMM_PROGRAM_ID);
  const snapshotCache = new TtlCache<TokenSnapshot>(SNAPSHOT_TTL_MS);
  const jupiterToken = new JupiterTokenGateway({
    apiKey: process.env.JUPITER_TOKEN_API_KEY,
    onError: (err, mint) =>
      log.warn({ err, mint }, 'jupiter token snapshot failed (filter data unavailable)'),
  }).getSnapshot;
  const filterDeps = { jupiterToken, snapshotCache };
  let jitoTipSeed = 0; // rotates the tip across Jito's accounts (per-tip) to avoid contention
  // Inc.4c: a REAL user's spendable balance = a short-TTL getBalance cache minus their SOL reserve. Shared across
  // runtimes (SharedBrainDeps) so the getBalance cost is bounded + the cache is mockable. SYSTEM bypasses it.
  const walletBalanceCache = createWalletBalanceCache({
    fetchLamports: (address) => conn.getBalance(new PublicKey(address)),
    ttlMs: WALLET_BALANCE_TTL_MS,
  });
  // Inc.4c: resolve a real user's provisioned wallet address (activation row) → ownerPk; null = not provisioned yet
  // (skipped at spawn, exactly like an inactive user). Privy-FREE repo (F1b) — the brain only needs the address.
  const activationRepo = new CopybotActivationRepository(db);
  const resolveOwner = (uid: string): Promise<PublicKey | null> =>
    activationRepo.resolveSignableWallet(uid).then((w) => (w ? new PublicKey(w.address) : null));
  // Inc.4d — performance-fee collection (SPEC §9). The fee sink is trusted brain/coffre config, NEVER the request.
  // Unset ⇒ fees are still ASSESSED + recorded (state 'skipped') for auditability, but never transferred — logged
  // ONCE here at boot so an operator who forgot to configure the sink learns immediately.
  const operatorFeeAddress = process.env.OPERATOR_FEE_ADDRESS ?? '';
  if (!operatorFeeAddress)
    log.warn(
      'OPERATOR_FEE_ADDRESS unset — performance-fee collection disabled: fees are still recorded (state=skipped) but never transferred (SPEC §9)',
    );
  const positionLedgerRepo = new PositionLedgerRepository(db); // fee-base source (read at close; written by the coffre)
  const feeLedgerRepo = new FeeLedgerRepository(db); // per-position fee ledger (assessed at close, swept by the feeSweep)
  // Cross-tenant open-mirror projection: the boot/reload spawn UNION (finding #134) so a user STOPPED while the
  // brain was down is still (re)spawned to drain + force-close their stranded mirrors — never a missed close.
  const copybotPositionsRepo = new CopybotPositionsRepository(db);

  // Process-level deps shared by every user runtime (ONE detection/RPC/cache/bus layer + the wallet-level maps).
  const shared: SharedBrainDeps = {
    log,
    conn,
    db,
    bus,
    hmacKey,
    poolReader,
    tokenMeta,
    blockhashCache,
    priorityFeeOracle,
    filterDeps,
    control,
    heartbeat,
    recentlyPublishedClose,
    inFlightBuyMints,
    pendingSellMints,
    walletBalanceCache,
    nextJitoTipSeed: () => jitoTipSeed++,
    jupiterBaseUrl: cfg.jupiterBaseUrl,
    jitoEnabledEnv: cfg.jitoEnabledEnv,
    priorityFeeOracleEnv: cfg.priorityFeeOracleEnv,
    // ONE process-wide Discord sink shared by every runtime + the detection emitter (process-wide rate-limit
    // + dedup, SPEC §10). No-op (with one boot log) when DISCORD_WEBHOOK_URL is unset.
    alertSink: createDiscordAlertSink(process.env.DISCORD_WEBHOOK_URL, log),
    operatorFeeAddress, // Inc.4d fee sink (SPEC §9)
    positionLedger: positionLedgerRepo,
    feeLedger: feeLedgerRepo,
  };
  // The brain's runtime/config views (3b): the fan-out, status, sweeps and reload all read these LIVE maps —
  // one entry per booted user. A deactivated user's runtime is RETAINED (its stop-close diff force-closes; it
  // keeps reconciling until its mirrors drain) while its disabled config drops it from the open fan-out targets.
  const runtimes = new Map<string, UserRuntime>();
  const userConfigs = new Map<string, CopybotConfig>();
  let bootRestored = 0; // mirrors restored across every boot-time spawn → gates the boot failsafe reconcile
  // Build + durably seed ONE user runtime (persisted mirrors → registry + opens-window ring; rug sets are seeded
  // inside createUserRuntime). Registration in the maps belongs to the caller (reload orchestration).
  const spawnRuntime = async (uid: string, config: CopybotConfig): Promise<UserRuntime | null> => {
    // Inc.4c: SYSTEM → the bench wallet + the constant bench balance (BYTE-IDENTICAL); a real user → their
    // provisioned Privy wallet + a short-TTL getBalance cache minus the LIVE SOL reserve (config-derived); an
    // unresolved (not-provisioned-yet) user → null → skipped by the caller, exactly like an inactive user.
    const resolved = await resolveUserWallet({
      userId: uid,
      systemOwnerPk: ownerPk,
      systemBalanceSol: cfg.balanceSol,
      resolveOwner,
      walletBalanceCache,
      reserveSol: () => (userConfigs.get(uid) ?? config).user.sizing.solReserveSol,
    });
    if (!resolved) {
      log.info({ userId: uid }, '⏭️ user wallet not provisioned yet → runtime not spawned');
      return null;
    }
    const runtime = await createUserRuntime(shared, uid, {
      ownerPk: resolved.ownerPk,
      balanceOf: resolved.balanceOf,
      leader: cfg.leader,
      initialConfig: config,
    });
    const restored = await runtime.store.loadOpen();
    runtime.restoreOpenMirrors(restored);
    bootRestored += restored.length;
    if (restored.length > 0)
      log.info({ userId: uid, restored: restored.length }, '♻️ mirrors reloaded from the DB');
    return runtime;
  };
  // The SYSTEM runtime is ALWAYS booted, active or not (INC3B-PLAN §4): it is the WALLET context — orphan closes,
  // sweep sells and --once publish as SYSTEM. It never receives opens unless its own config enables leaders (the
  // fan-out targets from `userConfigs`), so an always-on SYSTEM runtime costs nothing.
  const systemConfig = await configStore.seedIfAbsent(SYSTEM_USER_ID); // seed so the web/bench has a row to edit
  const systemRt = await spawnRuntime(SYSTEM_USER_ID, systemConfig);
  if (!systemRt) {
    // SYSTEM always resolves (the configured bench wallet) — a null here is impossible; fail LOUD if it ever isn't.
    log.error('SYSTEM runtime failed to spawn (bench wallet unresolved)');
    process.exit(1);
  }
  runtimes.set(SYSTEM_USER_ID, systemRt);
  userConfigs.set(SYSTEM_USER_ID, systemConfig);
  // SYSTEM is spawned OUTSIDE reloadAllUsers, so the boot-seed force-close (finding #135) can't reach it there:
  // if the bench config was STOPPED while the brain was down, its seeded mirrors would strand (the phase-2 diff
  // sees prev==next → no transition). Replay it here from the same invariant — a no-op unless SYSTEM is stopped.
  await systemRt.applyBootStopCloses(systemConfig);

  // Shared detection-context emitter (SYSTEM-bound, INC3B-PLAN §3): detection is ONE on-chain fact — the hub's
  // `detect.routed` / `detect.gap` / per-leader `system.detection_stale` and the consumer-loop errors are emitted
  // here ONCE, never fabricated per user.
  const detectionLog = log.child({
    userId: SYSTEM_USER_ID,
    wallet: cfg.ownerPubkey,
    process: 'brain',
  });
  const detectionEvents = new CopyEvents(
    new EventStore(db, detectionLog),
    detectionLog,
    { userId: SYSTEM_USER_ID, wallet: cfg.ownerPubkey, process: 'brain' },
    shared.alertSink,
  );
  // WS trigger, created EARLY (never connects until start(), below) so the hub can record its watches.
  const sub = cfg.wsUrl ? new HeliusTxSubscriber(cfg.wsUrl, log) : undefined;
  // Per-leader detection (3b step 4): one detector+tracker+poll-health per watched leader, ONE shared pool-meta
  // cache across the per-leader deps, and the event fan-out (step 5) — driven by the CONFIG-DERIVED leader set
  // (computeLeaderSet over the live `userConfigs`, applied by each reload pass — step 7a).
  const poolMetaCache = new Map<string, LoadedPoolMeta | null>();
  const hub = new LeaderHub({
    log,
    events: detectionEvents,
    makeDetector: (leader, onEvent, onGap) =>
      new LeaderDetector(
        makeDetectionDeps({
          conn,
          pk: new PublicKey(leader),
          poolReader,
          tokenMeta,
          onEvent,
          onGap,
          poolMetaCache,
          // Degraded-valuation signal: a pool meta read returned null, so THIS leader's events on that pool are valued
          // with amounts 0 until the meta resolves (a short-TTL retry re-reads it — never a permanent null; #46).
          onPoolMetaUnavailable: (lbPair) =>
            log.warn(
              { leader, pool: lbPair },
              'pool meta unavailable — events valued degraded until it resolves',
            ),
        }),
      ),
    getConfigs: () => userConfigs,
    getRuntimes: () => runtimes,
    retainLeader: (leader) =>
      shouldRetainLeader(
        leader,
        [...runtimes.values()].map((r) => r.leaderHoldings()),
      ),
    watcher: sub,
  });

  // Detection-liveness (observability). The poll/reconcile loops run with LOG-ONLY `.catch` handlers; if they
  // throw forever the bot is silently BLIND to leader events while the heartbeat stays GREEN. Poll health is now
  // PER LEADER inside the hub (its own counters + stale alerts); the wallet-level reconcile keeps its own
  // process-level counter + alert here. wsConnected is mirrored from the WS connection-change callback (below).
  let wsConnected = false; // last-known WS trigger connectivity
  let lastReconcileAt: number | null = null; // ms of the last SUCCESSFUL reconcile sweep
  let reconcileFailures = 0; // CONSECUTIVE reconcile failures (reset on a success)
  let reconcileStaleAlerted = false; // once-per-episode gate; re-armed when the counter is back to 0
  // Status v2 (3b step 8): pure assembly — legacy top-level fields become AGGREGATES, plus per-user and
  // per-leader breakdowns (see assembleBrainStatus for the aggregation rules and their WHY).
  const brainStatus = (): BrainStatusDetail =>
    assembleBrainStatus({
      users: [...runtimes.values()].map((r) => ({
        userId: r.userId,
        openMirrors: r.registry
          .openPositions()
          .map((m) => ({ leader: r.leaderOf(m), sizeSol: m.sizeSol })),
        lastActionAt: r.lastActionAt(),
        lastLatencyMs: r.lastLatencyMs(),
      })),
      leaders: hub.leaderHealth(),
      wsConnected,
      lastReconcileAt,
      reconcileFailures,
    });
  // The reconcile sweep succeeded: stamp, zero the counter, re-arm the reconcile-side stale alert. (The poll-side
  // equivalent lives per leader in the hub — 3b step 4 split the two health signals.) Observability only.
  const onReconcileSuccess = (): void => {
    lastReconcileAt = Date.now();
    reconcileFailures = 0;
    if (detectionHealthy(0, reconcileFailures)) reconcileStaleAlerted = false;
  };
  // The reconcile sweep failed: bump the counter and — after DETECTION_STALE_FAILURES in a row — emit the pinned
  // "bot may be blind" alert ONCE per stale episode. The per-loop `log.error` is kept at the call site.
  const onReconcileFailure = (): void => {
    reconcileFailures += 1;
    if (shouldAlertDetectionStale(0, reconcileFailures, reconcileStaleAlerted)) {
      reconcileStaleAlerted = true;
      detectionEvents.emit('system.detection_stale', {
        stage: 'failsafe',
        outcome: 'failed',
        leader: cfg.leader,
        eventKey: `detection-stale:${Date.now()}`, // fresh per episode so a later episode isn't dedup-suppressed
        adminDetail: {
          pollFailures: hub.pollHealth().pollFailures,
          reconcileFailures,
          threshold: DETECTION_STALE_FAILURES,
        },
      });
    }
  };

  // Anti-dormant reconcile (the no-miss-close pillar) — driven PER DISTINCT WALLET (Inc.4c): runtimes are grouped
  // by ownerPk, each wallet enumerated once + swept through the 3 phases in wallet-sweeps.ts (per-user plans, a
  // per-sweep read cache, then the GLOBAL orphan pass scoped to THAT wallet, published by a runtime that owns it —
  // SYSTEM for the bench wallet). With only SYSTEM today this is one wallet = one sweep, byte-identical to pre-4c.
  const reconcileSweep = (): Promise<{ enumerated: boolean }> =>
    runReconcileSweepByWallet({
      log,
      runtimes: () => runtimes.values(),
      enumerateForWallet: (wallet) => readUserPositions(conn, new PublicKey(wallet)),
      readAccountInfo: (pubkey) => conn.getAccountInfo(new PublicKey(pubkey)),
      recentlyPublishedClose,
      openGraceMs: RECONCILE_OPEN_GRACE_MS,
      recloseGraceMs: RECLOSE_GRACE_MS,
      token2022DepositGraceMs: TOKEN2022_DEPOSIT_GRACE_MS,
    });
  // One reconcile tick: sweep → health bookkeeping → prune the hub's drained leaders (their retention inputs —
  // open mirrors / pending closes — change exactly when this sweep confirms closes). Never rejects.
  const reconcileTick = (): Promise<void> =>
    reconcileSweep()
      .then(({ enumerated }) => {
        // An enumerator failure (SDK #245) is a reconcile FAILURE for the watchdog (#14) — a permanently broken
        // enumerator must trip detection-stale, not read as healthy — even though the per-user close backstop
        // (direct reads) still ran this tick (#17).
        if (enumerated) onReconcileSuccess();
        else onReconcileFailure();
        hub.pruneDrained();
      })
      .catch((e) => {
        log.error({ e: (e as Error).message }, 'reconcile');
        onReconcileFailure();
      });

  // Rug-SL across EVERY runtime's mirrors, grouped by pool (ONE price read per pool per tick); the trigger is
  // judged per (user, mirror's leader) — see wallet-sweeps.ts.
  const rugSlSweep = (): Promise<void> =>
    runRugSlSweep({
      log,
      runtimes: () => runtimes.values(),
      readPoolTokenPrice: (pool) => readActiveTokenPrice(conn, new PublicKey(pool)),
      recentlyPublishedClose,
      recloseGraceMs: RECLOSE_GRACE_MS,
    });

  // No-miss safety net (Inc.4c: PER DISTINCT WALLET) — enumerate every non-SOL token (classic SPL + Token-2022)
  // on each active runtime's wallet and sell it back to SOL, published by a runtime that owns that wallet (SYSTEM
  // for the bench wallet). Catches anything the close-triggered sell missed — a brain downtime, a failed/rejected
  // sell, any residual — so no wallet ever holds a dormant non-SOL balance. One wallet today ⇒ byte-identical loop.
  const sweepWallet = (): Promise<void> =>
    runResidualSweep({
      log,
      runtimes: () => runtimes.values(),
      readWalletBalances: (wallet) => readAllOwnerTokenBalances(conn, new PublicKey(wallet)),
      inFlightBuyMints,
      wsolMint: WSOL_MINT,
      dustRaw: SELL_RESIDUAL_DUST_RAW,
      inflightGraceMs: INFLIGHT_BUY_GRACE_MS,
      leaderLabel: cfg.leader,
    });

  // Inc.4d (SPEC §9) — publish a transfer for each PENDING performance fee, via the OWNING user's runtime (its
  // wallet + signer). Fully decoupled from the close: a fee failure NEVER blocks/delays a close, and each fee is
  // retried every tick until its transfer lands. No-op when no operator sink is set (nothing is ever 'pending').
  const feeSweep = (): Promise<void> =>
    runFeeSweep({
      log,
      listPending: (limit) => feeLedgerRepo.listPending(limit),
      batchLimit: FEE_SWEEP_BATCH,
      runtimeFor: (userId) => runtimes.get(userId),
      bumpAttempts: (userId, ourPosition) => feeLedgerRepo.bumpAttempts(userId, ourPosition),
    });

  await blockhashCache.start(); // prime + background-refresh so serializeUnsigned never pays a getLatestBlockhash RTT
  // Live priority-fee oracle: started once ANY booted runtime opts in (INC3B-PLAN §3) — env override or the
  // user's DB flag. Checked after every reload pass so a live opt-in starts it too; never stopped once started
  // (an opted-out user simply isn't quoted from it — serializeUnsigned checks oracleOn per publish).
  let oracleStarted = false;
  const ensureOracleStarted = async (): Promise<void> => {
    if (oracleStarted || ![...runtimes.values()].some((r) => r.oracleOn())) return;
    oracleStarted = true;
    await priorityFeeOracle.start(); // prime + background-refresh the live fee estimate (opt-in)
    log.info(
      '📈 priority-fee oracle on (live estimate raises the tier in congestion; cap still bounds it)',
    );
  };
  await ensureOracleStarted();

  // Boot/reload orchestration (3b step 7b): ONE pass spawns every ACTIVE user's runtime, refreshes existing
  // configs (STOP = FORCE-CLOSE diffs), reconciles the hub to computeLeaderSet(configs) and lets fresh users
  // join the reconcile immediately. Reused verbatim by the control ping + the CONFIG_POLL_MS backstop.
  const reloadAllUsersNow = async (): Promise<void> => {
    await reloadAllUsers({
      log,
      listActiveUserIds: () => configStore.listActiveUserIds(),
      listUserIdsWithOpenMirrors: () => copybotPositionsRepo.listUserIdsWithOpenMirrors(),
      loadConfig: (uid) => configStore.load(uid),
      spawn: spawnRuntime,
      runtimes,
      userConfigs,
      applyLeaderSet: (next) => hub.applyLeaderSet(next),
      onUsersSpawned: () => reconcileTick(),
    });
    await ensureOracleStarted();
  };

  // --once: validates the pipeline by forcing ONE open on a live leader position (deterministic), then exits.
  if (once) {
    await onceValidate(
      conn,
      leaderPk,
      poolReader,
      (e) => systemRt.handleOpen(e, cfg.leader), // --once runs on the SYSTEM runtime (always booted above)
      bus,
      hmacKey,
      log,
    );
    await Promise.all([bus.quit(), control.quit()]);
    process.exit(0);
  }

  log.info({ owner: cfg.ownerPubkey, redis: cfg.redisUrl }, '🧠 brain started');
  // Boot pass (7b): spawn every active user's runtime; the hub is seeded with the CONFIG-DERIVED leader set
  // (computeLeaderSet — 7a), each added leader replay-seeded (cursor + tracker, without publishing) before its
  // WS watch is recorded.
  await reloadAllUsersNow();
  // 7a — COPYBOT_LEADER is DEMOTED: the env no longer drives detection. If it is set and disagrees with the
  // config-derived set, say so LOUDLY at boot (an operator expecting the env to steer the bot must learn here).
  const envLeader = process.env.COPYBOT_LEADER;
  const derivedLeaders = computeLeaderSet(userConfigs);
  if (envLeader && !derivedLeaders.has(envLeader)) {
    log.warn(
      { envLeader, configLeaders: [...derivedLeaders] },
      '⚠️ COPYBOT_LEADER is set but absent from the config-derived leader set — the env no longer drives detection (edit the DB config instead)',
    );
  }
  log.info(
    { leaders: [...derivedLeaders], users: [...runtimes.keys()] },
    'replay done — switching to live',
  );

  // No-dormant-token: at boot, sweep any non-SOL balance left on the wallet (a prior downtime, a missed/
  // rejected close-sell) back to SOL before resuming — the wallet must never sit on a dormant token.
  await sweepWallet().catch((e) =>
    systemRt.events.system('system.sweep_failed', e, {
      stage: 'sweep',
      outcome: 'failed',
      reason: 'sweep_failed',
      leader: cfg.leader,
      adminDetail: { phase: 'boot' },
    }),
  );

  // No-dormant: every boot-time spawn reloaded its persisted open mirrors (spawnRuntime) — if ANY were restored,
  // run the immediate failsafe now (a leader may have closed during the downtime → close before resuming live).
  if (bootRestored > 0) {
    await reconcileSweep(); // close right away anything a leader closed during downtime (no grace at boot)
  }
  if (!cfg.wsUrl || !sub) {
    log.warn('no SOLANA_WS_URL → live impossible');
    await Promise.all([bus.quit(), control.quit()]);
    return;
  }
  // The hub already wired watch (per leader, DLMM-filtered) + the reconnect catch-up poll at applyLeaderSet time.
  wsConnected = sub.isConnected(); // seed; the callback keeps it live (observability — status only)
  sub.onConnectionChange((c) => {
    wsConnected = c;
  });
  sub.start();
  // One process-level poll loop: the hub iterates its per-leader detectors sequentially (per-leader failure
  // counters + stale alerts live inside it). pollAll never rejects (per-entry try/catch).
  const timer = setInterval(() => void hub.pollAll(), POLL_MS);
  const reconTimer = setInterval(() => void reconcileTick(), RECON_MS);
  const sweepTimer = setInterval(
    () => sweepWallet().catch((e) => log.error({ e: (e as Error).message }, 'sweep')),
    SWEEP_MS,
  );
  const rugSlTimer = setInterval(
    () => rugSlSweep().catch((e) => log.error({ e: (e as Error).message }, 'rug-sl')),
    RUG_SL_POLL_MS,
  );
  // Inc.4d — periodic performance-fee sweep (publishes each pending fee transfer; retried until it lands, SPEC §9).
  const feeTimer = setInterval(
    () => feeSweep().catch((e) => log.error({ e: (e as Error).message }, 'fee-sweep')),
    FEE_SWEEP_MS,
  );
  // Live config reload — now the FULL multi-user pass (spawn new actives / per-user stop-close diffs / leader
  // set). A web config edit publishes a control ping → reload from the DB NOW (kill-switch in <100ms); the
  // periodic poll is the backstop if a ping is ever missed. load() is fail-safe (defaults on corruption); these
  // are the only writes to the runtimes' configs post-boot.
  const configTimer = setInterval(() => void reloadAllUsersNow(), CONFIG_POLL_MS);
  await control.subscribe(() => {
    log.info('🔁 control: config-changed → reloading all users now');
    void reloadAllUsersNow();
  });
  // Process heartbeat: beat now (web sees the brain online immediately) then on an interval.
  void heartbeat.beat(brainStatus());
  const heartbeatTimer = setInterval(
    () => void heartbeat.beat(brainStatus()),
    HEARTBEAT_INTERVAL_MS,
  );
  // Retention prune (#65): periodically enforce the append-only-table retention policy (copy_journal internal
  // debug rows / networth_snapshots downsampling — see retention.ts). Best-effort like the other sweeps: a prune
  // failure NEVER touches the hot path, it just logs and retries next tick.
  const pruneTimer = setInterval(() => {
    void pruneOldRows(db, Date.now()).catch((e) =>
      log.warn({ e: (e as Error).message }, 'retention prune failed'),
    );
  }, PRUNE_INTERVAL_MS);

  // ev:executed consumer on a SEPARATE Redis connection (a blocking XREAD must never stall publishes). Crash-proof.
  let stopped = false;
  const evBus = RedisBus.connect(cfg.redisUrl);
  await evBus.ensureGroup(EV_EXECUTED_STREAM, 'brain');
  // Per-message dispatch deps — now a ROUTER (3b step 5, INC3B-PLAN §3): each callback resolves the OWNING runtime
  // (ev.userId → runtime; else position/commandId ownership — see executed-router) and dispatches with that
  // runtime's handlers. With the single SYSTEM runtime every message resolves to it, exactly as before.
  // Each deferred-publish handler routes its failure through `settleContinuationFailure` (finding #137): a
  // DETERMINISTIC build failure emits the domain-specific *_failed code (open_failed / add_failed) and ACKs, but a
  // TRANSIENT RPC/DB failure RETHROWS so the batch guard leaves the message UNACKED — the runtime kept the pending
  // retry token, so the PEL drain re-runs the continuation instead of dropping the open after our buy already landed.
  // `onCloseConfirmed` is routed WITHOUT a catch: a DB blip in markClosed must REJECT so the batch guard leaves the
  // close UNACKED for an idempotent PEL-drain retry (never silently drop a close). See dispatch-executed.ts.
  const ownerOfCommand = (commandId: string): UserRuntime | undefined =>
    resolveExecutedTarget(runtimes, { commandId });
  const executedDeps: ExecutedBatchDeps = {
    onCloseConfirmed: async (ourPosition, evUserId) => {
      const owner = resolveExecutedTarget(runtimes, {
        userId: evUserId,
        positionPubkey: ourPosition,
      });
      // A close with NO matching runtime is acked ONLY because the reconcile backstop covers closes: the mirror
      // row (if any) is found and marked closed by the next on-chain sweep — never silently lost.
      if (owner) await owner.onCloseConfirmed(ourPosition);
    },
    onCloseExecuted: async (ev) => {
      // Close-triggered residual sell, attributed to the CLOSING user (fee/journal attribution, Inc.4-ready).
      // No owner (deploy-window legacy message): the wallet-level safety sweep recovers the residual.
      const owner = resolveExecutedTarget(runtimes, {
        userId: ev.userId,
        positionPubkey: ev.positionPubkey,
        commandId: ev.commandId,
      });
      if (!owner) return;
      await owner.onCloseExecuted(ev).catch((e) =>
        // close-residual sell build/publish failed → the swap-failed path (pinned, feed "swap manually").
        owner.events.swapFailed({
          stage: 'sell',
          outcome: 'failed',
          reason: 'failed_after_retries',
          leader: cfg.leader,
          pool: ev.pool,
          commandId: ev.commandId,
          adminDetail: { error: (e as Error).message, pool: ev.pool },
        }),
      );
    },
    // Continuation PREDICATES scan every runtime (commandIds are disjoint across users by derivation, so "any"
    // is exact); the matching publish handler then routes to the owner and no-ops when none (idempotent replay).
    hasPendingReshapeAdd: (commandId) =>
      [...runtimes.values()].some((r) => r.hasPendingReshapeAdd(commandId)),
    publishReshapeAddAfterBuy: async (commandId) => {
      const owner = ownerOfCommand(commandId);
      if (!owner) return;
      await owner.publishReshapeAddAfterBuy(commandId).catch((e) =>
        settleContinuationFailure(e, () =>
          owner.events.emit('reshape.add_failed', {
            stage: 'reshape',
            outcome: 'failed',
            reason: 'add_failed',
            leader: cfg.leader,
            commandId,
            adminDetail: { error: (e as Error).message, commandId },
          }),
        ),
      );
    },
    publishTwoSidedOpenAfterBuy: async (commandId) => {
      const owner = ownerOfCommand(commandId);
      if (!owner) return;
      await owner.publishTwoSidedOpenAfterBuy(commandId).catch((e) =>
        settleContinuationFailure(e, () =>
          owner.events.emit('lifecycle.open_failed', {
            stage: 'open',
            outcome: 'failed',
            reason: 'open_failed',
            leader: cfg.leader,
            commandId,
            adminDetail: { error: (e as Error).message, commandId },
          }),
        ),
      );
    },
    hasPendingToken2022Deposit: (commandId) =>
      [...runtimes.values()].some((r) => r.hasPendingToken2022Deposit(commandId)),
    publishDepositAfterPositionCreated: async (commandId) => {
      const owner = ownerOfCommand(commandId);
      if (!owner) return;
      await owner.publishDepositAfterPositionCreated(commandId).catch((e) =>
        // the deposit leg of a Token-2022 OPEN failed to build/publish → the open did not complete (open_failed).
        settleContinuationFailure(e, () =>
          owner.events.emit('lifecycle.open_failed', {
            stage: 'open',
            outcome: 'failed',
            reason: 'open_failed',
            leader: cfg.leader,
            commandId,
            adminDetail: { error: (e as Error).message, commandId, leg: 'token2022_deposit' },
          }),
        ),
      );
    },
    onOpenConfirmed: (ourPosition) =>
      resolveExecutedTarget(runtimes, { positionPubkey: ourPosition })?.onOpenConfirmed(
        ourPosition,
      ),
    hasPendingToken2022Mirror: (commandId) =>
      [...runtimes.values()].some((r) => r.hasPendingToken2022Mirror(commandId)),
    finalizeToken2022Open: async (commandId) => {
      const owner = ownerOfCommand(commandId);
      if (!owner) return;
      await owner.finalizeToken2022Open(commandId).catch((e) =>
        settleContinuationFailure(e, () =>
          owner.events.emit('lifecycle.open_failed', {
            stage: 'open',
            outcome: 'failed',
            reason: 'open_failed',
            leader: cfg.leader,
            commandId,
            adminDetail: { error: (e as Error).message, commandId, leg: 'token2022_finalize' },
          }),
        ),
      );
    },
    onAddConfirmed: (ourPosition, commandId) =>
      resolveExecutedTarget(runtimes, { positionPubkey: ourPosition })?.onAddConfirmed(
        ourPosition,
        commandId,
      ),
    onClaimConfirmed: (ourPosition, commandId) =>
      resolveExecutedTarget(runtimes, { positionPubkey: ourPosition })?.onClaimConfirmed(
        ourPosition,
        commandId,
      ),
    // Sells are wallet-residual actions: route by the publisher's userId, else fall back to the WALLET context
    // (the SYSTEM runtime) — the stash lives in the shared pendingSellMints either way.
    onSellConfirmed: (ev) =>
      (resolveExecutedTarget(runtimes, { userId: ev.userId }) ?? systemRt).onSellConfirmed(ev),
    // A landed fee transfer → the OWNING user's runtime flips its fee_ledger row 'landed' + emits the feed row.
    // Route by userId, then by the position it was levied on (the ev carries positionPubkey = our_position).
    onFeeConfirmed: async (ev) => {
      const owner = resolveExecutedTarget(runtimes, {
        userId: ev.userId,
        positionPubkey: ev.positionPubkey,
      });
      if (owner) await owner.onFeeConfirmed(ev);
    },
    ack: (id) => evBus.ack(EV_EXECUTED_STREAM, 'brain', id),
    onLoopError: (err, id) =>
      detectionEvents.system('system.loop_errored', err, {
        stage: 'failsafe',
        outcome: 'failed',
        reason: 'loop_errored',
        leader: cfg.leader,
        adminDetail: { loop: 'ev_executed', id },
      }),
  };
  const consumeExecuted = async (): Promise<void> => {
    let backoff = 1000;
    while (!stopped) {
      try {
        // No-miss (mirrors coffre-main): drain the PEL FIRST — any message a prior iteration left delivered-but-
        // unACKed (a transient handler/ack throw, or a same-process restart) is re-processed here so a confirmation
        // (ESPECIALLY a close) is never stranded by `'>'` (which only returns NEW messages). On the first iteration
        // this also recovers a boot-time PEL. Then read new messages. Both go through the SAME per-message guard.
        await processExecutedBatch(
          await evBus.consumePending(
            EV_EXECUTED_STREAM,
            'brain',
            'brain-1',
            'ev:executed',
            hmacKey,
            100,
          ),
          executedDeps,
        );
        await processExecutedBatch(
          await evBus.consume(
            EV_EXECUTED_STREAM,
            'brain',
            'brain-1',
            'ev:executed',
            hmacKey,
            10,
            5000,
          ),
          executedDeps,
        );
        backoff = 1000;
      } catch (e) {
        // CONNECTION-level failure only (a Redis-down consume/consumePending) — per-message errors are already
        // isolated inside processExecutedBatch. Record + exponential backoff + continue (Redis may recover).
        detectionEvents.system('system.loop_errored', e, {
          stage: 'failsafe',
          outcome: 'failed',
          reason: 'loop_errored',
          leader: cfg.leader,
          adminDetail: { loop: 'ev_executed', backoff },
        });
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  };
  void consumeExecuted();

  const shutdown = async (): Promise<void> => {
    stopped = true;
    clearInterval(timer);
    clearInterval(reconTimer);
    clearInterval(sweepTimer);
    clearInterval(rugSlTimer);
    clearInterval(feeTimer);
    clearInterval(configTimer);
    clearInterval(heartbeatTimer);
    clearInterval(pruneTimer);
    blockhashCache.stop();
    sub.stop();
    await Promise.all([bus.quit(), evBus.quit(), control.quit()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  if (autoStopSec > 0) setTimeout(() => void shutdown(), autoStopSec * 1000);
}

/** Forces an open on the most recent live leader position (deterministic validation of the brain). */
async function onceValidate(
  conn: Connection,
  leaderPk: PublicKey,
  poolReader: OnchainPoolMetaReader,
  handleOpen: (e: DetectedEvent) => Promise<void>,
  bus: RedisBus,
  hmacKey: string,
  logger: typeof log,
): Promise<void> {
  const sigs = (await conn.getSignaturesForAddress(leaderPk, { limit: 14 }))
    .filter((s) => !s.err)
    .map((s) => s.signature);
  const txs = await conn.getParsedTransactions(sigs, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  for (const tx of txs) {
    if (!tx?.meta?.logMessages?.some((l) => l.includes(DLMM_PROGRAM_ID))) continue;
    for (const leg of decodeDlmmLegs(tx)) {
      const meta = await poolReader.loadPoolMeta(leg.lbPair);
      if (!meta?.solSide || !leg.position) continue;
      const shape = await readLeaderPositionShape(
        conn,
        new PublicKey(leg.lbPair),
        leaderPk,
        leg.position,
      );
      if (!shape) continue;
      const sym = meta.mintX === WSOL_MINT ? meta.mintY : meta.mintX;
      logger.info(
        { pool: leg.lbPair, position: leg.position },
        '--once: forced open on live position',
      );
      await handleOpen({
        signature: `once-${leg.position}`,
        blockTime: 1,
        instruction: 'AddLiquidityByStrategy2',
        depositSol: 0.5,
        withdrawSol: 0,
        claimSol: 0,
        closed: false,
        pool: leg.lbPair,
        position: leg.position,
        nonSolMint: sym,
        nonSolSymbol: null,
      });
      // re-read the stream to prove the publication
      const msgs = await bus
        .consume('copybot:cmd:sign', 'validate', 'v1', 'cmd:sign', hmacKey, 5, 2000)
        .catch(() => []);
      logger.info(
        { consumed: msgs.length, ok: msgs[0]?.payload != null },
        '--once: re-read from the bus',
      );
      return;
    }
  }
  logger.warn('--once: no live leader position found');
}

main().catch((e) => {
  log.error({ err: (e as Error).message }, 'brain fatal');
  process.exit(1);
});
