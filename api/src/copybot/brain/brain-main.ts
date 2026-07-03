/**
 * Copy-bot · Inc.2 — BRAIN process (NO keys, NO inbound socket). Detects the leader's DLMM events →
 * decides (sizing/caps, no filters in v1) → BUILDS the tx (SDK: FAITHFUL re-anchored open by-weight / close /
 * claim) → PUBLISHES a `SignRequest` on `cmd:sign` (Redis bus, HMAC). The vault signs+lands (separate process).
 *
 * Bundled CJS (tsup.copybot.config.ts) — imports the SDK, NEVER runs under tsx. Does NOT import the keypair.
 *   yarn tsup --config tsup.copybot.config.ts → node --env-file=../.env dist/copybot/brain-main.cjs [--once] [--seconds=N]
 *
 * Inc.3b step 3: everything tenant-scoped lives in `createUserRuntime` (user-runtime.ts). This file keeps the
 * PROCESS SHELL — env/boot, detection wiring, the timers, the wallet-level sweeps (reconcile / rug-SL / wallet
 * sweep) and the ev:executed consumer — and runs exactly ONE runtime bound to SYSTEM_USER_ID (the multi-user
 * fan-out is the next 3b step).
 */
import { DLMM_PROGRAM_ID } from '@binsight/shared';
import { Connection, PublicKey } from '@solana/web3.js';
import { pino } from 'pino';
import { assertBusKey } from '@/copybot/bus-key-guard';
import { ConfigStore } from '@/copybot/config-store';
import { makeDetectionDeps } from '@/copybot/detection';
import { HeartbeatStore } from '@/copybot/heartbeat-store';
import { SYSTEM_USER_ID } from '@/copybot/journal-store';
import { purgeRugExitPending } from '@/copybot/rug-exit-store';
import { effectiveFor } from '@/domain/copybot/config';
import type { DetectedEvent } from '@/domain/copybot/events';
import type { TokenSnapshot } from '@/domain/copybot/filters';
import { JupiterTokenGateway } from '@/domain/copybot/filters/sources/jupiter-token/jupiter-token-gateway';
import { LeaderDetector } from '@/domain/copybot/leader-detector';
import { LeaderPositionTracker } from '@/domain/copybot/leader-position';
import { planReconcile } from '@/domain/copybot/reconciliation';
import { planWalletSweep } from '@/domain/copybot/residual-sell';
import {
  type BrainStatusDetail,
  DETECTION_STALE_FAILURES,
  detectionHealthy,
  HEARTBEAT_INTERVAL_MS,
  shouldAlertDetectionStale,
} from '@/domain/copybot/status';
import { TtlCache } from '@/domain/copybot/ttl-cache';
import { ControlChannel } from '@/infrastructure/bus/control-channel';
import { RedisBus } from '@/infrastructure/bus/redis-bus';
import { openDatabase } from '@/infrastructure/persistence/database';
import { BlockhashCache } from '@/infrastructure/solana/blockhash-cache';
import { readActiveTokenPrice } from '@/infrastructure/solana/dlmm/active-bin-price';
import { decodeDlmmLegs } from '@/infrastructure/solana/dlmm/dlmm-event-decoder';
import {
  readLeaderPositionShape,
  readUserPositions,
  type UserPosition,
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
import { type ExecutedBatchDeps, processExecutedBatch } from './dispatch-executed';
import type { Mirror } from './mirror-registry';
import { pendingOpenLeaders } from './pending-open-cancel';
import {
  createUserRuntime,
  RECLOSE_GRACE_MS,
  SELL_RESIDUAL_DUST_RAW,
  type SharedBrainDeps,
} from './user-runtime';

const POLL_MS = 15_000;
const RECON_MS = 30_000; // on-chain reconcile cadence (no-miss-close backstop)
const RECONCILE_OPEN_GRACE_MS = Number(process.env.RECONCILE_OPEN_GRACE_MS ?? '30000'); // a just-opened copy may be unconfirmed for ~1-2s (direct getAccountInfo) → skip the 1st reconcile tick after open; 30s = generous margin, minimal backstop delay (anti false-close → no-dormant)
const SWEEP_MS = Number(process.env.SWEEP_MS ?? '60000'); // wallet token→SOL safety-sweep cadence (SYSTEM): the no-miss backstop behind the close-triggered sell (catches any dormant non-SOL left by downtime/a missed close)
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
// The sweep must not sell the bought token during buy → (create →) deposit (≤ ~20s under load). Kept SHORT so it
// expires soon after the deposit lands — else it would also block the safety-sweep from selling that same token's
// CLOSE residual (the close returns it to the wallet) for too long. The close-triggered sell is the primary path;
// this grace only gates the backstop sweep.
const INFLIGHT_BUY_GRACE_MS = 30_000;
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
  const tracker = new LeaderPositionTracker();
  const db = openDatabase(cfg.dbUrl);
  // Single-tenant binding (Inc.3a — SPEC §11): the brain still runs ONE user, bound ONCE here and passed to the
  // single user runtime, which threads it through everything tenant-scoped (commandId derivation,
  // SignRequest.userId, mirror/rug-exit rows, config, observability) — never hardcoded deep in call chains. The
  // multi-user fan-out (next increment) turns this into one runtime per active user.
  const userId = SYSTEM_USER_ID;
  const configStore = new ConfigStore(db, log);
  // Single-user runtime (increment 2): the brain reads THE SYSTEM_USER_ID row of the per-user config table.
  // Increment 3 iterates configStore.listActiveUserIds() and runs one runtime per active user.
  const initialConfig = await configStore.seedIfAbsent(userId); // polled + ping-reloaded live below
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
    tracker,
    recentlyPublishedClose,
    inFlightBuyMints,
    pendingSellMints,
    nextJitoTipSeed: () => jitoTipSeed++,
    jupiterBaseUrl: cfg.jupiterBaseUrl,
    jitoEnabledEnv: cfg.jitoEnabledEnv,
    priorityFeeOracleEnv: cfg.priorityFeeOracleEnv,
    alertWebhookUrl: process.env.ALERT_WEBHOOK,
  };
  // ONE per-user runtime, bound to SYSTEM (Inc.3b step 3): all tenant-scoped state + handlers live inside it; the
  // process shell below (detection, timers, wallet-level sweeps, consumers) drives this single instance. The
  // multi-user fan-out (next 3b steps) turns this into a Map<userId, UserRuntime>.
  const rt = await createUserRuntime(shared, userId, {
    ownerPk,
    balanceOf: () => cfg.balanceSol,
    leader: cfg.leader,
    initialConfig,
  });

  const reloadConfig = async (): Promise<void> => {
    // STOP = FORCE-CLOSE (SPEC §4.3): diff the config we were RUNNING (prev, the last loaded value in memory —
    // never a stale/boot snapshot, so a restart can't replay an old stop) against the fresh load, and force-close
    // the mirrors of every observed stop transition (leader disabled/removed, or global user.enabled off).
    const prev = rt.getConfig();
    const next = await configStore.load(userId);
    rt.setConfig(next);
    await rt.applyStopCloses(prev, next);
  };

  // Detection-liveness (observability). The poll/reconcile timers below run with LOG-ONLY `.catch` handlers; if
  // they throw forever the bot is silently BLIND to leader events while the heartbeat stays GREEN. These stamps +
  // consecutive-failure counters feed the status snapshot AND the watchdog alert. wsConnected is mirrored from the
  // WS subscriber's connection-change callback (set once `sub` exists, below).
  let wsConnected = false; // last-known WS trigger connectivity
  let lastPollAt: number | null = null; // ms of the last SUCCESSFUL cursor poll
  let lastReconcileAt: number | null = null; // ms of the last SUCCESSFUL reconcile sweep
  let pollFailures = 0; // CONSECUTIVE poll failures (reset on a success)
  let reconcileFailures = 0; // CONSECUTIVE reconcile failures (reset on a success)
  let detectionStaleAlerted = false; // once-per-episode gate; re-armed when BOTH counters are back to 0
  const brainStatus = (): BrainStatusDetail => {
    const open = rt.registry.openPositions();
    return {
      leader: cfg.leader,
      openPositions: open.length,
      exposureSol: open.reduce((s, m) => s + m.sizeSol, 0),
      lastActionAt: rt.lastActionAt(),
      lastLatencyMs: rt.lastLatencyMs(),
      wsConnected,
      lastPollAt,
      lastReconcileAt,
      pollFailures,
      reconcileFailures,
    };
  };
  // A detector loop (poll or reconcile) succeeded: stamp its time, zero its consecutive-failure counter, and re-arm
  // the stale alert once detection is FULLY healthy again (both counters at 0). Observability only.
  const onDetectionSuccess = (which: 'poll' | 'reconcile'): void => {
    if (which === 'poll') {
      lastPollAt = Date.now();
      pollFailures = 0;
    } else {
      lastReconcileAt = Date.now();
      reconcileFailures = 0;
    }
    if (detectionHealthy(pollFailures, reconcileFailures)) detectionStaleAlerted = false;
  };
  // A detector loop failed: bump its consecutive-failure counter and — after DETECTION_STALE_FAILURES in a row —
  // emit the pinned "bot may be blind" alert ONCE per stale episode (the flag suppresses repeats until a recovery
  // re-arms it). The existing per-loop `log.error` is kept at the call site. Observability only.
  const onDetectionFailure = (which: 'poll' | 'reconcile'): void => {
    if (which === 'poll') pollFailures += 1;
    else reconcileFailures += 1;
    if (shouldAlertDetectionStale(pollFailures, reconcileFailures, detectionStaleAlerted)) {
      detectionStaleAlerted = true;
      rt.events.emit('system.detection_stale', {
        stage: 'failsafe',
        outcome: 'failed',
        leader: cfg.leader,
        eventKey: `detection-stale:${Date.now()}`, // fresh per episode so a later episode isn't dedup-suppressed
        adminDetail: { pollFailures, reconcileFailures, threshold: DETECTION_STALE_FAILURES },
      });
    }
  };

  // Anti-dormant reconcile (the no-miss-close pillar) — driven by ON-CHAIN reality, NEVER by DB status (which
  // can lie if a close failed). Enumerates OUR positions actually on-chain and compares to the persisted mirrors:
  //  · our position gone on-chain                  → close confirmed → mark closed in DB
  //  · our position still on-chain + leader closed  → re-publish the close (retried by the vault until it lands)
  //  · on-chain position we never tracked           → orphan → alert (never close blindly)
  // Any RPC failure aborts the sweep (retry next tick) so we never act on incomplete data.
  async function reconcileSweep(): Promise<void> {
    const tracked = await rt.store.loadOpen();

    let held: UserPosition[];
    try {
      held = await readUserPositions(conn, ownerPk);
    } catch (e) {
      log.error(
        { e: (e as Error).message },
        'reconcile: failed to enumerate our positions → skip this sweep',
      );
      return;
    }
    const ourOnChain = new Set(held.map((p) => p.position)); // enumerator → orphan detection ONLY (can lag)

    // Per-mirror DIRECT account reads — the RELIABLE close signal (a per-account getAccountInfo, not the laggy
    // enumerator): is OUR position gone? is the leader's? A read error → undefined → never added (no close on doubt).
    const ourClosed = new Set<string>();
    const leaderClosed = new Set<string>();
    await Promise.all(
      tracked.map(async (m) => {
        const [ours, leader] = await Promise.all([
          conn.getAccountInfo(new PublicKey(m.ourPosition)).catch(() => undefined),
          conn.getAccountInfo(new PublicKey(m.leaderPosition)).catch(() => undefined),
        ]);
        if (ours === null) ourClosed.add(m.ourPosition); // null = account gone (rent reclaimed on DLMM close)
        if (leader === null) leaderClosed.add(m.leaderPosition);
      }),
    );

    const now = Date.now();
    // Open-grace: a copy opened < RECONCILE_OPEN_GRACE_MS ago isn't reliably confirmable on-chain yet → exclude
    // it from close decisions so a fresh open is never mistaken for "gone" (anti-dormant regression).
    const recentlyOpened = new Set(
      tracked.filter((m) => now - m.openedAt < RECONCILE_OPEN_GRACE_MS).map((m) => m.ourPosition),
    );

    const plan = planReconcile({
      ourOnChain,
      ourClosed,
      tracked: tracked.map((m) => ({
        ourPosition: m.ourPosition,
        leaderPosition: m.leaderPosition,
      })),
      leaderClosed,
      recentlyOpened,
      rugExitPending: rt.rugExitPending, // re-close a rug-SL-closed mirror (leader still open) until confirmed gone — never-miss-close
    });

    for (const our of plan.markClosed) {
      const m = tracked.find((x) => x.ourPosition === our);
      if (!m) continue;
      await rt.store.markClosed(m.leaderPosition);
      rt.registry.close(m.leaderPosition);
      recentlyPublishedClose.delete(our);
      rt.rugSlTracker.forget(our);
      void purgeRugExitPending(rt.rugExitPending, rt.rugExitStore, our); // rug-SL/stop close CONFIRMED gone → stop retrying

      rt.events.closed({
        stage: 'close',
        outcome: 'confirmed',
        leader: cfg.leader,
        pool: m.pool,
        leaderPosition: m.leaderPosition,
        ourPosition: our,
        ourSizeSol: m.sizeSol,
        eventKey: rt.closeConfirmedKey(m.pool, our),
        adminDetail: { nonSolSymbol: m.nonSolSymbol, via: 'reconcile' },
      });
    }
    for (const rc of plan.reClose) {
      // Grace: skip if we published a close for this position recently (let the in-flight close land first).
      if (now - (recentlyPublishedClose.get(rc.ourPosition) ?? 0) < RECLOSE_GRACE_MS) continue;
      const m = tracked.find((x) => x.ourPosition === rc.ourPosition);
      if (m) await rt.publishReClose(m);
    }
    for (const orphan of plan.orphans) {
      // A Token-2022 open's empty position (TX1 landed, deposit TX2 still in flight) is intentionally UNTRACKED until
      // the deposit lands — don't orphan-close it mid-build. Past the grace (deposit never landed) the entry is
      // dropped and the empty position IS cleaned up here as a normal orphan (no dormant position).
      const buildingSince = rt.buildingToken2022Positions.get(orphan);
      if (buildingSince !== undefined) {
        if (now - buildingSince < TOKEN2022_DEPOSIT_GRACE_MS) continue;
        rt.buildingToken2022Positions.delete(orphan);
      }
      // Stray position on our wallet (a bug-forgotten mirror or a manual open) → AUTO-CLOSE it (spec 04
      // reconcile; Valhalla force-closes random DLMMs). We have its pool + bins from the enumerator. The grace
      // avoids re-publishing while a previous orphan-close is still landing.
      const p = held.find((h) => h.position === orphan);
      if (p && now - (recentlyPublishedClose.get(orphan) ?? 0) >= RECLOSE_GRACE_MS)
        await rt.publishOrphanClose(p);
    }

    // Belt-and-suspenders (backstop behind the close-event-driven handleClose path): a leader that closed a position
    // whose MULTI-TX open is still IN FLIGHT is never in `tracked` (the mirror isn't registered yet), so the loops
    // above can't catch it. Cancel any pending open whose leader account is confirmably GONE so the continuation
    // never funds an exited pool — only when it's a CLEAN addition (leader account read as null; else rely on handleClose).
    const pendingLeaders = [...pendingOpenLeaders(rt.pendingOpenMapsView())].filter(
      ([lp]) => !rt.registry.hasOpen(lp),
    );
    if (pendingLeaders.length > 0) {
      await Promise.all(
        pendingLeaders.map(async ([lp, pool]) => {
          const info = await conn.getAccountInfo(new PublicKey(lp)).catch(() => undefined);
          if (info === null) rt.cancelPendingOpen(lp, pool); // leader account gone → the pending open must not complete
        }),
      );
    }
  }

  // Rug-SL: poll each open pool's active-bin token price (one cheap lbPair read per pool), feed the tracker, and
  // close any position whose price crashed ≥ dropPercent within the window. The leader keeps holding (it's OUR
  // independent safety exit) → close + drop the tracker window; re-copy only on a NEW leader open (no auto-reopen
  // path exists: planReconcile never opens, handleResync no-ops on a closed mirror). A failed price read yields
  // null → NOT recorded, so a transient RPC blip can never fabricate a crash.
  async function rugSlSweep(): Promise<void> {
    const open = rt.registry.openPositions();
    if (open.length === 0) return;
    const now = Date.now();
    const byPool = new Map<string, Mirror[]>();
    for (const m of open) byPool.set(m.pool, [...(byPool.get(m.pool) ?? []), m]);
    for (const [pool, mirrors] of byPool) {
      const price = await readActiveTokenPrice(conn, new PublicKey(pool));
      if (price === null) continue; // never record a garbage price → no false trigger
      for (const m of mirrors) {
        // Per-mirror leader config (3b): the rug-SL trigger reads the settings of the leader THIS mirror copies —
        // leader A's rug config must never fire (or mute) a close on leader B's mirror.
        const rugCfg = effectiveFor(rt.getConfig(), m.leaderAddress).rugSl;
        rt.rugSlTracker.record(m.ourPosition, price, now);
        if (!rugCfg.enabled) continue;
        if (now - (recentlyPublishedClose.get(m.ourPosition) ?? 0) < RECLOSE_GRACE_MS) continue; // a close is already in flight
        if (!rt.rugSlTracker.check(m.ourPosition, rugCfg, now)) continue;
        await rt.publishSafetyClose(m, 'rugsl', 'rug_sl');
        // Keep the mirror TRACKED (do NOT registry.close here): a failed rug-SL close (congestion — the rug case)
        // must be re-published by the reconcile until the position is confirmed gone on-chain. Marking it
        // rug-exit-pending drives that retry independent of `leaderClosed` (the leader still holds it — rug-SL is OUR
        // exit). The reconcile clears the pending flag + registry.close + DB markClosed once the close lands.
        rt.rugExitPending.add(m.ourPosition);
        void rt.rugExitStore.addPending(m.ourPosition); // persist so the retry survives a brain restart
        rt.rugSlTracker.forget(m.ourPosition); // stop price re-triggering (recentlyPublishedClose + reconcile now own the retry)
        rt.rugExited.add(m.leaderPosition); // suppress re-opening this leader position on its next add (we rug-exited it)
        void rt.rugExitStore.addExited(m.leaderPosition); // persist so the suppression survives a brain restart
      }
    }
  }

  /** No-miss safety net: enumerate EVERY non-SOL token on the copier wallet (classic SPL + Token-2022) and sell
   *  each back to SOL. Catches anything the close-triggered sell missed — a brain downtime, a failed/rejected
   *  sell, or a residual from any other source — so the wallet never holds a dormant non-SOL balance. */
  async function sweepWallet(): Promise<void> {
    const balances = await readAllOwnerTokenBalances(conn, ownerPk);
    const swNow = Date.now();
    // Sweep ANY non-SOL (minSellOutLamports gates economics post-quote) — EXCEPT a token still in-flight for a
    // two-sided open (bought, awaiting deposit): selling it mid-open would empty the token leg. After the grace, a
    // still-present in-flight token means the open failed → it IS a stranded residual → swept.
    const toSweep = planWalletSweep(balances, WSOL_MINT, SELL_RESIDUAL_DUST_RAW).filter(
      (b) => swNow - (inFlightBuyMints.get(b.mint) ?? 0) >= INFLIGHT_BUY_GRACE_MS,
    );
    if (toSweep.length === 0) return;
    // `eventKey` is the per-cycle correlation (swNow): each periodic sweep that finds a residual is its own row
    // (the operator must see a still-stranded residual each cycle), while WS/poll have no part here. The per-mint
    // failure shares the cycle stamp + mint so a retry within the same cycle collapses, distinct cycles don't.
    rt.events.emit('swap.sweep_detected', {
      stage: 'sweep',
      outcome: 'detected',
      leader: cfg.leader,
      eventKey: `${cfg.leader}:sweep:${swNow}`,
      adminDetail: { count: toSweep.length, mints: toSweep.map((b) => b.mint) },
    });
    for (const b of toSweep) {
      await rt.publishSell(b.mint, b.amountRaw, ownerPk.toBase58(), 'sweep').catch((e) => {
        // A sweep sell that fails to build/publish is the swap-failed path → pinned, feed-visible (SPEC §2.1 swap).
        rt.events.swapFailed({
          stage: 'sweep',
          outcome: 'failed',
          reason: 'failed_after_retries',
          leader: cfg.leader,
          eventKey: `${cfg.leader}:sweep:${swNow}:${b.mint}`,
          adminDetail: { mint: b.mint, error: (e as Error).message },
        });
      });
    }
  }

  const detector = new LeaderDetector(
    makeDetectionDeps({
      conn,
      pk: leaderPk,
      poolReader,
      tokenMeta,
      onEvent: rt.onEvent,
      onGap: rt.onGap,
    }),
  );
  await blockhashCache.start(); // prime + background-refresh so serializeUnsigned never pays a getLatestBlockhash RTT
  if (rt.oracleOn()) {
    await priorityFeeOracle.start(); // prime + background-refresh the live fee estimate (opt-in)
    log.info(
      '📈 priority-fee oracle on (live estimate raises the tier in congestion; cap still bounds it)',
    );
  }

  // --once: validates the pipeline by forcing ONE open on a live leader position (deterministic), then exits.
  if (once) {
    await onceValidate(conn, leaderPk, poolReader, rt.handleOpen, bus, hmacKey, log);
    await Promise.all([bus.quit(), control.quit()]);
    process.exit(0);
  }

  log.info({ leader: cfg.leader, owner: cfg.ownerPubkey, redis: cfg.redisUrl }, '🧠 brain started');
  await detector.poll('replay'); // sets the cursor + tracker state (without publishing)
  log.info('replay done — switching to live');

  // No-dormant-token: at boot, sweep any non-SOL balance left on the wallet (a prior downtime, a missed/
  // rejected close-sell) back to SOL before resuming — the wallet must never sit on a dormant token.
  await sweepWallet().catch((e) =>
    rt.events.system('system.sweep_failed', e, {
      stage: 'sweep',
      outcome: 'failed',
      reason: 'sweep_failed',
      leader: cfg.leader,
      adminDetail: { phase: 'boot' },
    }),
  );

  // No-dormant: reload persisted open mirrors + immediate failsafe (the leader may have closed during a
  // brain downtime → we close right away whatever must be closed before even resuming live).
  const restored = await rt.store.loadOpen();
  for (const m of restored) rt.registry.open(m);
  if (restored.length > 0) {
    log.info({ restored: restored.length }, '♻️ mirrors reloaded from the DB');
    await reconcileSweep(); // close right away anything the leader closed during downtime (no grace at boot)
  }
  if (!cfg.wsUrl) {
    log.warn('no SOLANA_WS_URL → live impossible');
    await Promise.all([bus.quit(), control.quit()]);
    return;
  }
  const sub = new HeliusTxSubscriber(cfg.wsUrl, log);
  wsConnected = sub.isConnected(); // seed; the callback keeps it live (observability — status only)
  sub.onConnectionChange((c) => {
    wsConnected = c;
  });
  sub.onReconnect(() =>
    detector.poll().catch((e) => log.error({ e: (e as Error).message }, 'catch-up poll')),
  );
  sub.watch(cfg.leader, (sig, logs) => {
    const hasDlmm = logs.some((l) => l.includes(DLMM_PROGRAM_ID));
    log.debug({ sig, hasDlmm, nLogs: logs.length }, '📡 ws notif');
    if (hasDlmm)
      detector.onWsSignature(sig).catch((e) => log.error({ e: (e as Error).message }, 'ws'));
  });
  sub.start();
  const timer = setInterval(
    () =>
      detector
        .poll()
        .then(() => onDetectionSuccess('poll'))
        .catch((e) => {
          log.error({ e: (e as Error).message }, 'poll');
          onDetectionFailure('poll');
        }),
    POLL_MS,
  );
  const reconTimer = setInterval(
    () =>
      reconcileSweep()
        .then(() => onDetectionSuccess('reconcile'))
        .catch((e) => {
          log.error({ e: (e as Error).message }, 'reconcile');
          onDetectionFailure('reconcile');
        }),
    RECON_MS,
  );
  const sweepTimer = setInterval(
    () => sweepWallet().catch((e) => log.error({ e: (e as Error).message }, 'sweep')),
    SWEEP_MS,
  );
  const rugSlTimer = setInterval(
    () => rugSlSweep().catch((e) => log.error({ e: (e as Error).message }, 'rug-sl')),
    RUG_SL_POLL_MS,
  );
  // Live config reload. A web config edit publishes a control ping → reload from the DB NOW (kill-switch in <100ms);
  // the periodic poll is the backstop if a ping is ever missed. load() is fail-safe (defaults on corruption); these
  // are the only writes to the runtime's config post-boot.
  const configTimer = setInterval(() => void reloadConfig(), CONFIG_POLL_MS);
  await control.subscribe(() => {
    log.info('🔁 control: config-changed → reloading config now');
    void reloadConfig();
  });
  // Process heartbeat: beat now (web sees the brain online immediately) then on an interval.
  void heartbeat.beat(brainStatus());
  const heartbeatTimer = setInterval(
    () => void heartbeat.beat(brainStatus()),
    HEARTBEAT_INTERVAL_MS,
  );

  // ev:executed consumer on a SEPARATE Redis connection (a blocking XREAD must never stall publishes). Crash-proof.
  let stopped = false;
  const evBus = RedisBus.connect(cfg.redisUrl);
  await evBus.ensureGroup(EV_EXECUTED_STREAM, 'brain');
  // Per-message dispatch deps: each deferred-publish handler keeps its OWN domain-specific failure emit (open_failed /
  // add_failed / swap.failed) via an inline `.catch()` — those are terminal (the pending-map entry is already
  // consumed → a retry no-ops) so the message is still acked. `onCloseConfirmed` is passed WITHOUT a catch: a DB blip
  // in markClosed must REJECT so the batch guard leaves the close UNACKED for an idempotent PEL-drain retry (never
  // silently drop a close). See dispatch-executed.ts.
  const executedDeps: ExecutedBatchDeps = {
    onCloseConfirmed: rt.onCloseConfirmed,
    onCloseExecuted: (ev) =>
      rt.onCloseExecuted(ev).catch((e) =>
        // close-residual sell build/publish failed → the swap-failed path (pinned, feed "swap manually").
        rt.events.swapFailed({
          stage: 'sell',
          outcome: 'failed',
          reason: 'failed_after_retries',
          leader: cfg.leader,
          pool: ev.pool,
          commandId: ev.commandId,
          adminDetail: { error: (e as Error).message, pool: ev.pool },
        }),
      ),
    hasPendingReshapeAdd: rt.hasPendingReshapeAdd,
    publishReshapeAddAfterBuy: (commandId) =>
      rt.publishReshapeAddAfterBuy(commandId).catch((e) =>
        rt.events.emit('reshape.add_failed', {
          stage: 'reshape',
          outcome: 'failed',
          reason: 'add_failed',
          leader: cfg.leader,
          commandId,
          adminDetail: { error: (e as Error).message, commandId },
        }),
      ),
    publishTwoSidedOpenAfterBuy: (commandId) =>
      rt.publishTwoSidedOpenAfterBuy(commandId).catch((e) =>
        rt.events.emit('lifecycle.open_failed', {
          stage: 'open',
          outcome: 'failed',
          reason: 'open_failed',
          leader: cfg.leader,
          commandId,
          adminDetail: { error: (e as Error).message, commandId },
        }),
      ),
    hasPendingToken2022Deposit: rt.hasPendingToken2022Deposit,
    publishDepositAfterPositionCreated: (commandId) =>
      rt.publishDepositAfterPositionCreated(commandId).catch((e) =>
        // the deposit leg of a Token-2022 OPEN failed to build/publish → the open did not complete (open_failed).
        rt.events.emit('lifecycle.open_failed', {
          stage: 'open',
          outcome: 'failed',
          reason: 'open_failed',
          leader: cfg.leader,
          commandId,
          adminDetail: { error: (e as Error).message, commandId, leg: 'token2022_deposit' },
        }),
      ),
    onOpenConfirmed: rt.onOpenConfirmed,
    hasPendingToken2022Mirror: rt.hasPendingToken2022Mirror,
    finalizeToken2022Open: (commandId) =>
      rt.finalizeToken2022Open(commandId).catch((e) =>
        rt.events.emit('lifecycle.open_failed', {
          stage: 'open',
          outcome: 'failed',
          reason: 'open_failed',
          leader: cfg.leader,
          commandId,
          adminDetail: { error: (e as Error).message, commandId, leg: 'token2022_finalize' },
        }),
      ),
    onAddConfirmed: rt.onAddConfirmed,
    onClaimConfirmed: rt.onClaimConfirmed,
    onSellConfirmed: rt.onSellConfirmed,
    ack: (id) => evBus.ack(EV_EXECUTED_STREAM, 'brain', id),
    onLoopError: (err, id) =>
      rt.events.system('system.loop_errored', err, {
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
        rt.events.system('system.loop_errored', e, {
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
    clearInterval(configTimer);
    clearInterval(heartbeatTimer);
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
