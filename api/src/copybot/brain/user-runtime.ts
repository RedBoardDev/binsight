/**
 * Copy-bot · Inc.3b — PER-USER runtime factory (SPEC §11, INC3B-PLAN §3/§7 step 3).
 *
 * Everything tenant-scoped that used to live as closures in brain-main's `main()` — mirror registry/store, the
 * pending multi-tx-open maps, rug-SL/rug-exit state, the per-user config + effective resolution, the observability
 * emitter, commandId derivation, publish/serialize and ALL open/close/claim/reshape/confirm handlers — lives in ONE
 * `createUserRuntime(shared, userId, opts)` instance. The user dimension is an INSTANCE, not a key: a throw inside
 * runtime A can never corrupt runtime B's maps, and per-user failure isolation is structural.
 *
 * Process-level pieces (RPC/pool/blockhash/fee/filter caches, the bus, and the wallet-level maps keyed by
 * globally-unique position pubkeys or mints) stay in `SharedBrainDeps`, shared by every runtime. Detection lives
 * in the `LeaderHub` (3b step 4): the hub applies the per-leader tracker, drops replay, and fans each event out to
 * `onEvent(e, source, leader, …)` — event-driven paths read the EVENT's leader, mirror-driven paths read
 * `m.leaderAddress`. The wallet-level sweeps (reconcile / rug-SL / wallet sweep) STAY in brain-main this increment
 * and drive the runtime through its exposed accessors (their multi-user split is a later 3b step).
 *
 * Extracted MECHANICALLY from brain-main with ZERO behavior change: command IDs, event keys, log lines (the
 * on-chain harness greps some — see log-markers.ts), journal rows and publish payloads are byte-identical.
 * (3b steps 4-5 exceptions, single-leader value-identical: the leader in keys/rows is now the event's/mirror's;
 * the SKIP/CANCEL correlation keys fold the userId — see the key helpers below.)
 */
import {
  type Connection,
  type Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import type { Logger } from 'pino';
import { deriveCommandId } from '@/copybot/command-id';
import { derivePositionKeypair } from '@/copybot/ephemeral-position';
import type { HeartbeatStore } from '@/copybot/heartbeat-store';
import { LOG_MARKER_EVENT_ROUTED } from '@/copybot/log-markers';
import { CopyEvents } from '@/copybot/observability/copy-events';
import { EventStore } from '@/copybot/observability/event-store';
import { purgeRugExitPending, RugExitStore } from '@/copybot/rug-exit-store';
import { type CapsState, checkCaps, exposureFor } from '@/domain/copybot/caps';
import { type CopybotConfig, type EffectiveConfig, effectiveFor } from '@/domain/copybot/config';
import { type SignRequest, SignRequestSchema } from '@/domain/copybot/contracts';
import { decideEntry } from '@/domain/copybot/decision';
import { isCloseEvent, routeWithPending } from '@/domain/copybot/dispatch';
import type { DetectedEvent } from '@/domain/copybot/events';
import type { LeaderHoldings } from '@/domain/copybot/fan-out';
import { computeFee } from '@/domain/copybot/fee/fee';
import {
  accountKeysOf,
  ledgerRowFromMeta,
  sumLedgerBase,
} from '@/domain/copybot/fee/position-ledger';
import {
  type FilterContext,
  filtersActive,
  neededSources,
  type ResolveDeps,
  rangeCoveragePercent,
  resolveFilterContext,
  runFilters,
} from '@/domain/copybot/filters';
import { jitoTipFor } from '@/domain/copybot/jito-tip';
import { type JournalEntry, stageForKind } from '@/domain/copybot/journal';
import type { EventSource } from '@/domain/copybot/leader-detector';
import {
  type CopyCode,
  FALLBACK_CODE,
  resolveLegacyReason,
} from '@/domain/copybot/observability/codes';
import type { CopyEvent } from '@/domain/copybot/observability/event';
import type { EmitInput } from '@/domain/copybot/observability/input';
import {
  ATOMIC_BY_WEIGHT_BIN_LIMIT,
  activeBinSlippagePctFromBps,
  isWideOpen,
  MAX_SINGLE_POSITION_BINS,
} from '@/domain/copybot/open-routing';
import {
  chunkBySpan,
  fillContiguousWeights,
  lamportsToSol,
  reshapeToCalls,
} from '@/domain/copybot/position-adjust';
import { reanchorShape } from '@/domain/copybot/reanchor';
import { decideResidualSell, minOutWithSlippage } from '@/domain/copybot/residual-sell';
import { RUG_SL_RETAIN_MS, RugSlTracker } from '@/domain/copybot/rug-sl';
import {
  planBootStopCloses,
  planStopCloses,
  type StopClosePlan,
} from '@/domain/copybot/stop-closes';
import {
  inRangeTokenAdds,
  isTwoSidedLeader,
  planTwoSided,
  planTwoSidedReshape,
  reshapeCapFactor,
  resolveTwoSidedTokenDeposit,
  sizeTwoSided,
  type TwoSidedPlan,
  twoSidedLegTotals,
} from '@/domain/copybot/two-sided';
import { classifyInstruction } from '@/domain/dlmm';
import type { ControlChannel } from '@/infrastructure/bus/control-channel';
import type { RedisBus } from '@/infrastructure/bus/redis-bus';
import type { Database } from '@/infrastructure/persistence/database';
import type { FeeLedgerRepository } from '@/infrastructure/persistence/fee-ledger-repository';
import type { PositionLedgerRepository } from '@/infrastructure/persistence/position-ledger-repository';
import type { BlockhashCache } from '@/infrastructure/solana/blockhash-cache';
import {
  buildAddByWeight,
  buildAddByWeight2,
  buildClaimTx,
  buildCloseTx,
  buildCreateEmptyPosition,
  buildOpenByWeight,
  buildRemovePartial,
  createDlmmPair,
  isToken2022Pool,
  type WeightBin,
} from '@/infrastructure/solana/dlmm/dlmm-tx-builder';
import {
  readLeaderPositionShape,
  type UserPosition,
} from '@/infrastructure/solana/dlmm/leader-position-reader';
import type { OnchainPoolMetaReader } from '@/infrastructure/solana/dlmm/pool-meta';
import {
  buildJupiterSwapTx,
  getJupiterBuyQuoteExactIn,
  getJupiterQuote,
} from '@/infrastructure/solana/jupiter/jupiter-swap-builder';
import type { PriorityFeeOracle } from '@/infrastructure/solana/priority-fee-oracle';
import { readOwnerTokenBalance } from '@/infrastructure/solana/token-balance-reader';
import type { HeliusTokenMetadataGateway } from '@/infrastructure/solana/token-metadata-gateway';
import { applyPriorityFee, withCuLimit } from './compute-budget';
import { runContinuation, TerminalContinuationError } from './dispatch-executed';
import { type Mirror, MirrorRegistry } from './mirror-registry';
import { MirrorStore } from './mirror-store';
import {
  type PendingOpenMaps,
  type PendingStashKeys,
  pendingStashesFor,
  stashCount,
} from './pending-open-cancel';
import { createPendingOpenReservations } from './pending-open-reservations';
import { createPositionQueue } from './position-queue';
import type { WalletBalanceCache } from './wallet-balance-cache';

const STREAM = 'copybot:cmd:sign';
const HOP = 'cmd:sign';
/** Journal reason stamped when a bus.publish itself throws (a 'failed' journal row requires a reason). Used only when
 *  the intent carries no more specific reason (a plain open/add); a failsafe/rug-SL close keeps its own reason. */
const BUS_PUBLISH_FAILED_REASON = 'bus_publish_failed';
/** Separator between a retry-close's stable commandId and its per-tick attempt stamp on `correlationId` (#64). The
 *  same `#` grammar the observability dedup tests pin (e.g. `CMD#<tick>`) — a duplicate within one tick still dedups. */
const RETRY_CORRELATION_SEP = '#';
/** Wait this long after publishing a close before a reconcile re-close (let it land). Shared with brain-main's
 *  wallet-level sweeps (reconcile / rug-SL), which apply the same grace. */
export const RECLOSE_GRACE_MS = 60_000;
const DEADLINE_SLOTS = 150; // ~60s
// Swap/reshape execution tunables now live in the runtime config (eff().execution) — see config/defaults.ts.
// The close-sell + the safety-sweep sell ANY non-SOL residual (the wallet must NEVER hold a non-SOL token). The
// economic floor is `minSellOutLamports` (a SOL-value gate applied AFTER quoting) — NOT a raw-token threshold, which
// would mis-scale across token decimals AND conflate with the two-sided-CLASSIFICATION cutoff (`dustTokenRaw`, which
// decides whether a leader TOKEN LEG is worth buying — a different concern). So selling uses 0 here. Exported for
// brain-main's wallet sweep (the same floor gates the close-sell and the sweep).
export const SELL_RESIDUAL_DUST_RAW = 0n;
// Time-epoch that discriminates a recurring residual SELL's commandId. A sell never forceReclaims, so a residual
// whose earlier sell FAILED — recurring with the SAME (pool, mint, amount) — would re-derive the SAME commandId and be
// PERMANENTLY idempotency-rejected (stuck-forever token). Bucketing `Date.now()` by this window lets a genuine retry
// land in a LATER epoch (fresh commandId) while two attempts within ONE epoch — a concurrent / still-in-flight
// re-attempt — keep the SAME commandId so the vault still dedups them. Sized to exceed one sell's on-chain deadline
// (DEADLINE_SLOTS ≈ 60s): by the time the epoch rolls, the prior sell has landed or expired, so a re-sell is correct.
export const SELL_COMMAND_EPOCH_MS = 60_000;
// A two-sided open's BOUGHT token sits on the wallet from the buy landing until the DEPOSIT lands — a MULTI-hop,
// multi-tx window (buy → open/deposit; a Token-2022 open is create → deposit; a reshape is buy → add). Selling it in
// that window (close-triggered sell OR safety sweep — both read the WHOLE shared-wallet balance) would empty the
// token leg mid-open — on the shared wallet even ANOTHER user's in-flight open is at risk (Inc.3b step 6). It is
// RE-STAMPED at EACH hop (buy-publish + every deposit-publish continuation) so the window restarts per hop: a single
// hop's window need only outlast ONE tx's land time, never the whole buy→deposit chain. Finding #96: a fixed 30s
// window stamped ONCE at buy-publish expired before a congested deposit landed → the leg was sold mid-open and the
// open aborted. Sized to OPEN_PENDING_TTL_MS (the multi-tx open reservation window — the same window this guards).
// The wallet sweep backstop recovers a genuinely stranded token one window after the last hop. Exported: brain-main's
// sweep applies the same grace over the shared `inFlightBuyMints` map.
export const INFLIGHT_BUY_GRACE_MS = 90_000; // == OPEN_PENDING_TTL_MS; re-stamped at each open hop (finding #96)
// eventKey prefix for WALLET-context (no-leader) actions — today the orphan close (INC3B-PLAN §4): an orphan is
// tracked by NO user and copies NO leader, so a leader-address prefix would fabricate an attribution AND alias the
// commandId with that leader's real closes. Exported for the tests that pin the derived keys.
export const WALLET_EVENT_PREFIX = 'wallet';
// Retention of the per-user opens-per-window ring (caps.maxOpensPerWindow): far above any sane `windowMinutes`
// (minutes-scale by design), so pruning can never eat a live window, while bounding the ring to O(day) entries.
const OPEN_TIMESTAMPS_RETAIN_MS = 24 * 60 * 60_000;
// A leader OPEN's WS event can arrive BEFORE the position account is readable on our RPC node (read-after-write lag).
// Retry the shape read briefly so a transient read-miss never DROPS a leader open (the sig is already deduped, so the
// poll won't re-cover it → no other backstop). The normal case reads on the 1st try → zero added latency.
const OPEN_SHAPE_READ_RETRIES = 6;
const OPEN_SHAPE_READ_DELAY_MS = 1_000;
// When the tx decode says an open is TWO-SIDED, wait longer for BOTH legs' bin arrays to index (RPC lag can be
// seconds under load) — fidelity demands the full shape, and a half (one-sided) copy is forbidden. A ceiling: real
// two-sided positions index well within this; production (RPC not shared) settles in ~1-2s.
const TWO_SIDED_SHAPE_MAX_READS = 18;
// A leader ADD/REMOVE seen via WS may not be on-chain-readable yet → retry the resync read+compute until the deficit
// appears (else a premature read = no deficit = the copy wouldn't grow/shrink). Only when the event carries a real change.
const RESYNC_READ_RETRIES = 8;
const RESYNC_MIN_CHANGE_SOL = 0.001;
// #121 — how long a just-published reshape (remove/add) may still be in flight (published, not yet on-chain-readable).
// A rapid follow-up resync on the SAME position runs BEFORE the prior reshape lands — and a reshape REMOVE never
// confirms back to the brain (dispatch-executed has no 'remove' branch) — so our own on-chain read would still show
// the PRE-reshape shape, mis-netting the copy into a persistent ~2×/~0.5× exposure. Within this grace the resync nets
// against the reshape's TARGET (where the position is already being driven) instead; past it the reshape has landed →
// the on-chain read is truth again (and a rare failed reshape self-heals: the next resync re-nets from the real read).
// Sized to a Solana settlement ceiling — well under the 90s multi-tx OPEN windows (a reshape is a single tx, faster).
const RESHAPE_INFLIGHT_GRACE_MS = 30_000;
// Fixed-size mode (`sizing.tradeRatioPct == null`) carries no percentage ratio — the user pinned a SOL size
// (`maxTradeSizeSol`) instead. Its ONE coherent meaning in every path = mirror the leader at a FULL (100%) NOMINAL
// ratio, then let that path's existing cap bound the deployment to `maxTradeSizeSol` — i.e. an effective ratio of
// `min(1, maxTradeSizeSol / leaderTotalValue)`. At OPEN the #94 combined cap (`maxDeployLamports`) does the bounding;
// at RESYNC planTwoSidedReshape's `maxSol = maxTradeSizeSol` cap does it (⇒ factor = min(1, fixedSize/leaderSolTotal)),
// so a leader de-risk shrinks the mirror (target = factor × leaderBins ↓) rather than the old resync `?? 0`, which
// zeroed the factor and silently disabled EVERY fixed-size reshape — the copy rode a drawdown fully deployed until
// the final close (finding #143).
const FIXED_SIZE_MIRROR_RATIO_PCT = 100;
// After a two-sided BUY confirms (on the coffre's connection), the brain reads the bought balance on ITS connection
// ~300ms later → a read-after-write lag can show the token too low. Retry the balance read (reusing
// OPEN_SHAPE_READ_DELAY_MS between reads) until the BOUGHT delta clears the quote-derived floor; if it never does
// within this bound, SKIP the deposit (both-or-nothing) rather than deposit a short/one-sided half leg (#33).
const TOKEN_BALANCE_SETTLE_MAX_READS = 6;
// addLiquidityByWeight2 distributes a total by per-bin bps; the rounded per-bin amounts can sum to a hair MORE than
// the total → the token TransferChecked fails "insufficient funds". Deposit just under the wallet balance to absorb
// it (the tiny remainder is swept). ≤0.1% → negligible fidelity impact.
const depositableToken = (raw: bigint): bigint => (raw > 10_000n ? (raw * 999n) / 1000n : raw);
const FILTER_TIMEOUT_MS = 800; // hard cap on the filter-data fetch so a slow Jupiter never blocks the open
// A routed OPEN reserves its leader position until `registry.open` runs. For MULTI-TX opens (two-sided buy→open,
// Token-2022 create→deposit, wide split) that happens in a later ev:executed continuation, seconds after the open
// handler returned. This TTL must exceed the longest such window so a follow-up leader add during it routes to
// resync (not a 2nd open); it matches TOKEN2022_DEPOSIT_GRACE_MS (the orphan-close grace for the same window). A
// stale reservation self-heals (it only suppresses re-opening the SAME position for ≤TTL, never a double open).
const OPEN_PENDING_TTL_MS = 90_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const firstTx = (t: Transaction | Transaction[]): Transaction =>
  Array.isArray(t) ? (t[0] as Transaction) : t;
// A by-weight OPEN/ADD build must be a SINGLE tx — if the SDK chunked it (range too wide for one tx), publishing only
// the first tx would deposit nothing (create the position but not the liquidity, or land a partial deposit). Wide
// opens/adds are routed through create + add2 (one ≤70-bin deposit tx); this asserts that invariant — fail LOUD
// rather than silently drop a chunk (the no-miss/shape-fidelity pillar). Close/claim/remove are ≤70 bins → 1 tx.
const onlyTx = (t: Transaction | Transaction[], context: string): Transaction => {
  const arr = Array.isArray(t) ? t : [t];
  if (arr.length !== 1)
    throw new TerminalContinuationError(
      `${context}: build chunked into ${arr.length} txs (range too wide) — aborting, no partial open/deposit`,
    );
  return arr[0] as Transaction;
};
// Merge several SDK txs into ONE (concatenate their instructions). A WIDE atomic open chunks into [pre, main, post];
// the DEPOSIT half is `main` (the native addLiquidityOneSide/addLiquidityByWeight) + `post` (unwrap leftover WSOL).
// We publish `pre` (create+wrap) as TX1, then this merged deposit as TX2 — the unwrap MUST ride with the deposit (it
// references no pool/position of its own → Wall B would reject it alone). Stale CU/fee/blockhash are reset at publish.
const mergeDeposit = (txs: Transaction[]): Transaction => {
  const merged = new Transaction();
  for (const tx of txs) for (const ix of tx.instructions) merged.add(ix);
  return merged;
};

// A two-sided open/add builds a tx that DEPOSITS token the copier doesn't hold yet (the BUY lands first, in the
// coffre). The SDK's compute-unit estimation SIMULATES that deposit → fails "insufficient funds" → the tx ships
// with no/low CU limit → fails on-chain. Force an explicit CU limit so the build never depends on that estimation.
const TWO_SIDED_CU_LIMIT = 1_400_000; // max CU cap (free — only used CU is metered): a wide 17-bin two-sided open/add needs >400k; the build's own estimation fails (token not held yet)
const TOKEN2022_MAX_OPEN_BINS = 70; // a single createEmptyPosition + single addLiquidityByWeight2 chunk cover ≤70 bins; wider Token-2022 two-sided opens are skipped (no partial deposit)

/**
 * Process-level dependencies shared by EVERY user runtime (INC3B-PLAN §3 "stay process-level"): one RPC/pool/meta/
 * blockhash/fee/filter layer, ONE bus, and the wallet-level maps whose keys are globally unique on the shared
 * wallet (position pubkeys / mints). Assembled once by brain-main. NB: the ev:executed consumer bus (`evBus`) stays
 * main-local — it is created after the `--once` exit path and is pure consumer plumbing, never read by a runtime.
 */
export interface SharedBrainDeps {
  /** Process logger (NOT tenant-bound) — the runtime derives its tenant-scoped pino child from it. */
  log: Logger;
  conn: Connection;
  db: Database;
  bus: RedisBus;
  hmacKey: string;
  poolReader: OnchainPoolMetaReader;
  tokenMeta: HeliusTokenMetadataGateway;
  blockhashCache: BlockhashCache;
  priorityFeeOracle: PriorityFeeOracle;
  /** Filter external-data providers + per-mint snapshot cache (one fetch serves every runtime). */
  filterDeps: ResolveDeps;
  control: ControlChannel;
  heartbeat: HeartbeatStore;
  /** ourPosition → ms a close was last published (reClose grace) — position pubkeys are globally unique. */
  recentlyPublishedClose: Map<string, number>;
  /** tokenMint → ms a two-sided buy was published (protects the bought token from the wallet sweep). */
  inFlightBuyMints: Map<string, number>;
  /** commandId → sold-token stash so the sell confirm can name the token (wallet-level; sells are residual). */
  pendingSellMints: Map<
    string,
    {
      tokenMint: string;
      nonSolSymbol: string | null;
      pool: string;
      /** #140 — set ONLY for a CLOSE-path sell (the position it liquidates); null for a wallet-sweep sell. The
       *  sell-confirm writes the SELL ledger row + assesses the fee for this position (SPEC §9). */
      ourPosition: string | null;
    }
  >;
  /** Short-TTL SOL-balance cache shared by every runtime (Inc.4c) — one entry per REAL wallet; SYSTEM bypasses
   *  it (constant bench balance). Injected so it is mockable and the getBalance cost is shared/bounded. */
  walletBalanceCache: WalletBalanceCache;
  /** Rotates the Jito tip across accounts (per-tip, process-wide) to avoid contention. */
  nextJitoTipSeed: () => number;
  jupiterBaseUrl: string;
  /** env override of the DB jitoEnabled (anti-sandwich tip ix). */
  jitoEnabledEnv: boolean | undefined;
  /** env override of the DB priorityFeeOracle. */
  priorityFeeOracleEnv: boolean | undefined;
  /** Process-wide Discord operator-alert sink (pinned/operator events); undefined ⇒ no-op. Shared across
   *  every runtime + the detection emitter so the rate-limit + dedup are process-wide (SPEC §10). */
  alertSink: ((e: CopyEvent) => void) | undefined;
  /** Inc.4d — the operator fee sink (SPEC §9). '' ⇒ no collection: fees are still recorded (state 'skipped') but
   *  never swept. NOT read from the request — the coffre re-verifies the tx moves SOL to its OWN configured sink. */
  operatorFeeAddress: string;
  /** Inc.4d — the per-position execution ledger (the fee base source, written by the coffre confirm worker). */
  positionLedger: PositionLedgerRepository;
  /** Inc.4d — the per-position performance-fee ledger (assessed here at close, swept by the feeSweep). */
  feeLedger: FeeLedgerRepository;
}

/** Per-user injection points (INC3B-PLAN §8): Inc.4c resolves these per user (spawn-wallet.ts). */
export interface UserRuntimeOptions {
  /** The signing wallet's owner pubkey — SYSTEM = the bench wallet; a real user = their provisioned Privy wallet. */
  ownerPk: PublicKey;
  /** Available SOL fed to decideEntry — SYSTEM = the constant bench balance; a real user = a short-TTL getBalance
   *  cache minus their SOL reserve (async: a live user reads on-chain). */
  balanceOf: () => Promise<number>;
  /** The BOOT leader (cfg.leader). Since the LeaderHub extraction (3b step 4) events/mirrors carry their own
   *  leader; this remains only as (a) the fallback for legacy mirrors persisted without a `leader` column and
   *  (b) the prefix of the still-wallet-level paths (sell / orphan / cancel keys) until steps 6-7. */
  leader: string;
  /** The user's config as loaded/seeded at boot (brain-main owns the ConfigStore + reload wiring). */
  initialConfig: CopybotConfig;
}

/** One per-user brain runtime (the surface brain-main's timers/sweeps/consumers drive). */
export type UserRuntime = Awaited<ReturnType<typeof createUserRuntime>>;

/** Build the tenant-scoped runtime for `userId`: seeds its durable state (mirrors are reloaded by the caller,
 *  rug-exit sets here) and returns the handler/accessor surface. Everything inside is per-instance. */
export async function createUserRuntime(
  shared: SharedBrainDeps,
  userId: string,
  opts: UserRuntimeOptions,
) {
  const {
    log,
    conn,
    db,
    bus,
    hmacKey,
    poolReader,
    blockhashCache,
    priorityFeeOracle,
    filterDeps,
    recentlyPublishedClose,
    inFlightBuyMints,
    pendingSellMints,
    nextJitoTipSeed,
    jupiterBaseUrl,
    jitoEnabledEnv,
    priorityFeeOracleEnv,
    operatorFeeAddress,
    positionLedger,
    feeLedger,
  } = shared;
  const { ownerPk, balanceOf, leader: bootLeader, initialConfig } = opts;
  const wallet = ownerPk.toBase58();

  const registry = new MirrorRegistry();
  // commandId v2 = derive(userId + eventKey) (SPEC §11, supersedes ADR-8): bound once so the same leader event
  // copied for two users never collides into one idempotency slot, and no call site threads the tenant by hand.
  // WS-driven per-position eventKey grammar: `${leader}:${pool}:${action}:${position}:${signature}` — the leader
  // POSITION sits AFTER the action (finding #37): two DISTINCT leader positions closed/opened on the SAME pool in
  // ONE signature would otherwise share `${leader}:${pool}:${action}:${signature}` → one commandId → the 2nd copy
  // dropped as a duplicate (a MISSED close). Position keeps `.split(':')[2]` = action stable for the coffre.
  const commandIdFor = (eventKey: string): string => deriveCommandId(userId, eventKey);
  // A reconcile / rug-SL / orphan RE-CLOSE deliberately reuses its DETERMINISTIC commandId every retry tick (so the
  // vault idempotency re-claims + re-signs the SAME close until it lands). The observability dedup index is
  // `(wallet, correlationId, code)` and correlationId defaults to the commandId — so WITHOUT a discriminator every
  // retry of that close collapses onto the FIRST tick's audit row (a genuine retry silently lost, #64). Stamping the
  // per-sweep tick onto correlationId makes each DISTINCT tick a DISTINCT audit row, while two publishes of the same
  // close within ONE tick (same stamp) still correctly dedup to one row. Absent stamp ⇒ undefined ⇒ correlationId
  // falls back to commandId exactly as before (non-retry publishes are byte-identical).
  const retryCorrelationId = (
    commandId: string,
    tickStamp: number | undefined,
  ): string | undefined =>
    tickStamp === undefined ? undefined : `${commandId}${RETRY_CORRELATION_SEP}${tickStamp}`;
  const store = new MirrorStore(db, userId); // no-dormant persistence (survives restarts)
  // ONE observability emitter bound to this tenant: a tenant-scoped pino child is its logger. The runtime's call
  // sites emit TYPED codes through it directly; every row back-fills user/wallet/correlation. Operator-actionable
  // (pinned) events also fan out to the external ALERT_WEBHOOK via the injected sink (no-op when unset).
  const tlog = log.child({ userId, wallet, process: 'brain' });
  const events = new CopyEvents(
    new EventStore(db, tlog),
    tlog,
    { userId, wallet, process: 'brain' },
    shared.alertSink,
  );
  // P2: emit a TYPED event for a call site whose `reason` is RUNTIME-DYNAMIC (decision.reason, cap.reason, the
  // filter verdict, the generic publish marker). The leaf == the verbatim reason (SPEC §2.1 + resolveLegacyReason);
  // an unmapped/absent reason deterministically falls back to `system.unmapped` (never code-less). The pure
  // `resolveLegacyReason` is the SAME mapping the P1 shim used, so the persisted `code` column is unchanged — only
  // the registry severity/category/audience/pinned now become exact (the point of P2). Fire-and-forget; never throws.
  const emitFor = (reason: string | undefined, fields: EmitInput<CopyCode>): void => {
    events.emit(resolveLegacyReason(reason) ?? FALLBACK_CODE, fields);
  };
  // The leader a MIRROR-driven path acts for (close/claim/resync/safety-close/confirms): the mirror's own
  // `leaderAddress` (3b step 1). A legacy row persisted before the `leader` column loads as '' — fall back to the
  // boot leader so its keys/commandIds stay EXACTLY what the pre-3b code derived (never a ''-prefixed key, which
  // would break close idempotency for in-flight retries across the deploy).
  const leaderOf = (m: Pick<Mirror, 'leaderAddress'>): string => m.leaderAddress || bootLeader;
  // Per-leg detection correlation keys for the no-copy SKIP events (which carry no commandId/eventKey of their own):
  // the emit dedup keys on `(correlationId, code)`, so distinct skipped opens/reshapes need a UNIQUE eventKey or
  // they would collapse into one row under the 120s LRU. WS + cursor-poll re-detect of the SAME leg shares the key
  // (correctly collapses to one row). The leaf differs per stage so an open-skip and a reshape-skip never alias.
  // The USERID IS FOLDED IN (3b step 5): the durable dedup index is `(wallet, correlationId, code)` and every user
  // shares ONE wallet until Inc.4 custody — without the fold, two users skipping the SAME leader open would
  // collapse into one journal row (the second user's skip silently lost). commandId-bearing keys don't need it
  // (deriveCommandId already folds the userId). NOT asserted by any test/harness — safe to reshape.
  const openSkipKey = (e: DetectedEvent, leader: string): string =>
    `${userId}:${leader}:${e.pool}:open-skip:${e.signature}:${e.position}`;
  const reshapeSkipKey = (e: DetectedEvent, m: Mirror): string =>
    `${userId}:${leaderOf(m)}:${m.pool}:reshape-skip:${e.signature}:${m.ourPosition}`;
  // Per-position correlation keys for the `lifecycle.*_confirmed` FEED events. These confirmed emits carry no
  // commandId of their own, yet the emit dedup keys on `(correlationId, code)` — without a per-position key the
  // `correlationId` would be empty and two DISTINCT positions' confirms within the 120s LRU would collapse into one
  // row (lost feed). Keyed by OUR position so the SAME position's duplicate confirms (ev:executed + reconcile)
  // correctly collapse to one row, while distinct positions stay distinct. The leaf differs per code. (No userId
  // fold needed: OUR position pubkeys are per-user ephemeral keys, already globally unique on the shared wallet.)
  const openConfirmedKey = (leader: string, pool: string, ourPosition: string): string =>
    `${leader}:${pool}:open-confirmed:${ourPosition}`;
  const closeConfirmedKey = (leader: string, pool: string, ourPosition: string): string =>
    `${leader}:${pool}:close-confirmed:${ourPosition}`;
  let runtimeConfig = initialConfig; // polled + ping-reloaded live by brain-main via getConfig/setConfig
  // Resolve the EFFECTIVE config for ONE leader from the DB-backed config. Pure + cheap → recomputed at each point
  // of use so a live reload always takes effect on the next event. Decision paths pass the EVENT's/MIRROR's leader
  // (3b fan-out). `eff()` is the DOCUMENTED wallet-context path (INC3B-PLAN §4 / wave-C deviation 5): the
  // wallet-level reads with no leader in scope (sell economics, priority-fee plumbing in serializeUnsigned) resolve
  // THIS RUNTIME's config against the boot leader — for the wallet actions that runtime is SYSTEM, so wallet
  // economics = the SYSTEM config (per-leader overrides don't apply to leaderless actions by construction).
  const effFor = (leader: string): EffectiveConfig => effectiveFor(runtimeConfig, leader);
  const eff = (): EffectiveConfig => effFor(bootLeader);
  // Config-driven active-bin slippage PERCENT for a DLMM by-weight deposit, resolved per-leader (SPEC §9). Threaded
  // into every copy open/add build so the SDK derives a price-normalized bin tolerance instead of baking its 3-bin
  // default (ULTRACODE #47 — a fast pool drifts >3 bins between build and land and the deposit fails deterministically).
  const depositSlippagePct = (leader: string): number =>
    activeBinSlippagePctFromBps(effFor(leader).execution.slippageBps);
  const rugSlTracker = new RugSlTracker(RUG_SL_RETAIN_MS); // per-position price windows for the rug-SL crash check
  const rugExitStore = new RugExitStore(db, log, userId); // durable, tenant-bound rug-exit rows (suppress re-open + pending re-close)
  const rugExited = await rugExitStore.load(); // seed across restart so a leader add can't re-enter a rug-exited position
  const rugExitPending = await rugExitStore.loadPending(); // seed across restart so a failed rug-SL close keeps being re-closed until confirmed gone
  let lastActionAt: number | null = null; // ms of the last build+publish (status snapshot)
  let lastLatencyMs: number | null = null; // brainMs of that last action
  const oracleOn = (): boolean => priorityFeeOracleEnv ?? runtimeConfig.user.priorityFeeOracle;
  log.info({ filters: eff().filters }, '🧪 entry filters loaded');

  // BUILD-AFTER-BUY: a two-sided OPEN can't be built before the token is bought — the copier's token ATA doesn't
  // even exist yet, so the SDK build produces a tx that fails on-chain. We publish the BUY, stash the open context
  // here keyed by the buy's commandId, and build+publish the open only when the buy's ev:executed arrives (token +
  // ATA now present → clean build). (A two-sided reshape ADD does NOT need this — its position's ATA already exists.)
  // KNOWN LIMIT — these in-memory pending maps (pendingTwoSidedOpens / pendingReshapeAdds / pendingToken2022Deposits /
  // pendingToken2022Mirrors) are NOT persisted, so a FULL process crash loses them: a buy/create confirm replayed after
  // restart whose pending entry is gone will no-op (the deferred open/deposit is dropped, recovered only by the
  // orphan-sweep / reconcile backstops). The ev:executed PEL drain covers the close path + transient errors within
  // a LIVE process; persisting these maps to survive a crash is a separate follow-up (not in this fix).
  const pendingTwoSidedOpens = new Map<
    string,
    {
      e: DetectedEvent;
      /** The event's leader (3b): the deferred open must derive the SAME keys the triggering event would have. */
      leader: string;
      dist: WeightBin[];
      sizeLamports: bigint;
      solSide: 'X' | 'Y';
      tokenMint: string;
      /** OUR SOL leg (the SOL the open command deposits) — the per-command coffre re-clamp figure. */
      sizeSol: number;
      /** COMBINED deployment (SOL leg + the SOL the buy spends) — recorded on the mirror so exposure counts BOTH
       *  legs (finding #94 §3). Distinct from `sizeSol` so a command re-clamp never folds in the separate buy. */
      recordedSizeSol: number;
      /** #140 — the buy's ExactIn SOL input (`buyQuote.inAmount`, lamports) → the BUY ledger row's `lamportsOut`
       *  once the open persists, so the fee base at close counts the SOL spent on the token leg (not just the SOL leg). */
      buyInLamports: number;
      /** #33 — snapshot of the token balance BEFORE the buy was published (a pre-existing residual of the same mint
       *  must NOT be co-deposited); the quoted token output + buy slippage derive the settle floor the post-buy read
       *  must clear before we trust it (read-after-write lag → never a short/one-sided half copy). */
      preBuyTokenRaw: bigint;
      expectedTokenRaw: bigint;
      buySlippageBps: number;
    }
  >();

  // TOKEN-2022 2-TX OPEN: a Token-2022 leg can't be deposited by the v1 by-weight ix (on-chain it pins the token
  // program to classic). The deposit must use the v2 ix (addLiquidityByWeight2), which is add-to-EXISTING → the open
  // splits into TX1 createEmptyPosition (kind 'open') then TX2 addLiquidityByWeight2 (kind 'add'), sequenced via
  // ev:executed (create lands → deposit; deposit lands → persist the mirror). We persist the mirror ONLY after the
  // deposit lands, so a crash/failure between the two leaves an UNTRACKED empty position that the orphan-sweep
  // auto-closes (no dormant position). `buildingToken2022Positions` (with a grace) stops the sweep from closing a
  // position WHILE its deposit is still in flight; once the grace expires (deposit never landed) the sweep cleans it.
  // Keyed by the CREATE's commandId. Two deposit strategies share this map + the create→deposit→finalize sequencing:
  //  · REBUILD (Token-2022 two-sided): `dist`/`totalX`/`totalY` present → addLiquidityByWeight2 is REBUILT after the
  //    create lands (add2 fetches the positionV2 account, so it can't be pre-built).
  //  · PREBUILT (one-sided wide / classic-wide two-sided): `prebuiltDeposit` present → the deposit (native
  //    addLiquidityOneSide/addLiquidityByWeight + unwrap, built atomically with the create) is published as-is.
  const pendingToken2022Deposits = new Map<
    string,
    {
      e: DetectedEvent;
      /** The event's leader (3b): threads through create → deposit → mirror. */
      leader: string;
      lower: number;
      upper: number;
      /** SOL leg = the deposit command's per-command re-clamp figure. */
      sizeSol: number;
      /** COMBINED deployment (SOL leg + buy spend) — recorded on the mirror so exposure counts both legs (#94 §3);
       *  == sizeSol for a one-sided open (no buy). */
      recordedSizeSol: number;
      prebuiltDeposit?: Transaction;
      dist?: WeightBin[];
      totalX?: bigint;
      totalY?: bigint;
      /** #140 — the two-sided open's buy cost + sig, threaded create → deposit → mirror so `finalizeToken2022Open`
       *  attributes the BUY ledger row to the funded position. Absent for a one-sided wide open (no buy). */
      buyInLamports?: number;
      buySig?: string;
    }
  >();
  const pendingToken2022Mirrors = new Map<
    string,
    {
      leaderPosition: string;
      /** The event's leader (3b): stamped on the mirror once the deposit lands. */
      leader: string;
      ourPosition: string;
      pool: string;
      nonSolSymbol: string | null;
      /** per-token concurrency-cap key — threaded deposit → mirror so the persisted Token-2022 mirror carries it. */
      nonSolMint: string;
      sizeSol: number;
      /** COMBINED deployment (SOL leg + buy spend) → the persisted mirror's sizeSol, so exposure counts both legs
       *  (#94 §3); == sizeSol for a one-sided open. */
      recordedSizeSol: number;
      lower: number;
      upper: number;
      leaderSizeSol: number;
      /** #140 — the two-sided open's buy cost + sig; `finalizeToken2022Open` writes the BUY ledger row from these
       *  once the mirror persists. Absent for a one-sided wide open (no buy). */
      buyInLamports?: number;
      buySig?: string;
    }
  >();
  // TWO-SIDED RESHAPE ADD (grow with a token-leg deficit): like the open, the token can't be bought via ExactOut on a
  // Token-2022 coin → buy via ExactIn (variable output) then build+publish the add ONCE the buy lands (deposit the
  // ACTUAL balance). Stashed by the reshape buy's commandId; consumed in publishReshapeAddAfterBuy.
  const pendingReshapeAdds = new Map<
    string,
    {
      dist: WeightBin[];
      addLamports: bigint;
      solSide: 'X' | 'Y';
      tokenMint: string;
      lower: number;
      upper: number;
      totalAddSol: number;
      ourPosition: string;
      pool: string;
      leaderPosition: string;
      /** The mirror's leader (3b): the deferred add derives the same keys the reshape would have. */
      leader: string;
      signature: string;
      /** #140 — the reshape buy's ExactIn SOL input (lamports) → the BUY ledger row's `lamportsOut`, attributed to
       *  the existing `ourPosition` this add grows, so the fee base counts the SOL spent on the reshape token leg. */
      buyInLamports: number;
      /** #33 — pre-buy token snapshot + quoted output + slippage: the post-buy read must clear the derived floor
       *  before the add deposits (read-after-write lag → never a short token leg), and only the BOUGHT delta deposits. */
      preBuyTokenRaw: bigint;
      expectedTokenRaw: bigint;
      buySlippageBps: number;
      /** #145 — exposure target for a DEFERRED two-sided grow. handleResync records the size only up to the CURRENT
       *  exposure (removes land synchronously; the grow is not real until its add publishes); this target is applied
       *  when publishReshapeAddAfterBuy actually publishes the add — never inflating caps for an add that never lands. */
      deferredSizeSol?: number;
    }
  >();
  const buildingToken2022Positions = new Map<string, number>(); // ourPosition → ms the create was published (orphan-close grace while the deposit lands)
  // DUPLICATE-OPEN GUARD (two mechanisms). (1) `positionQueue` serializes ALL handler work for ONE leader position:
  // event B's routing is computed only AFTER event A's handler settled (so a classic open's `registry.open` has
  // run → B sees tracked=true → resync, not a 2nd open). (2) `pendingOpens` bridges the MULTI-TX open window (the
  // open handler returns before `registry.open`, which runs in a later ev:executed continuation): a routed open
  // reserves its leader position; the tracked test treats a pending reservation as tracked; each `registry.open`
  // site clears it; a stale entry self-heals after OPEN_PENDING_TTL_MS. Together they make a follow-up add during an
  // open-in-flight route to resync/ignore instead of a duplicate real-money open.
  const positionQueue = createPositionQueue();
  const pendingOpens = createPendingOpenReservations(OPEN_PENDING_TTL_MS);
  // #146 — leader positions whose CLOSE has ALREADY been observed (an event queued on the position's serial chain)
  // but not yet handled. Added SYNCHRONOUSLY the instant `onEvent` classifies a close, BEFORE it enqueues the task,
  // and cleared when that close's task dequeues. Its sole consumer is `handleResync`: an in-flight resync serializes
  // AHEAD of the queued close on the SAME position, so it polls this set and BAILS the moment a close appears — a
  // leader CLOSE never waits out the resync's multi-retry read budget (RESYNC_READ_RETRIES × readStableShape ≈ tens
  // of seconds of extra rug exposure). Latency-only: the close is never dropped (it stays queued) and the on-chain
  // reconcile is still the completeness backstop.
  const pendingCloses = new Set<string>();
  // A leader position whose IN-FLIGHT multi-tx open (two-sided buy→open, Token-2022 create→deposit, wide split) must
  // NOT complete because the leader CLOSED before the open landed. The open handler returned before `registry.open`
  // (which runs in a later ev:executed continuation), so `handleClose` finds no mirror — without this signal a queued
  // continuation would deploy capital into the pool the leader just EXITED (a fast scalp / rug exit). The continuations
  // run from the ev:executed loop — a DIFFERENT execution path than the position-queue — so we need this cross-path
  // cancellation marker. `cancelPendingOpen` sets it; each continuation clears it via `consumeOpenCancellation` before
  // publishing on-chain. TTL-bounded via the SAME self-healing reservation abstraction (OPEN_PENDING_TTL_MS — the
  // multi-tx open window a continuation lives within): the COMMON cancel path drops the stash and returns with NO
  // continuation left to consume the marker, so an unbounded Set would leak this entry forever — the TTL evicts a
  // never-consumed marker instead. KNOWN LIMIT (like the pending maps above): in-memory only — a FULL process crash
  // loses it, but the mirror was never registered so nothing is stuck, and the periodic sweep clears any token bought.
  const cancelledOpens = createPendingOpenReservations(OPEN_PENDING_TTL_MS);
  // #121 — the shape the LAST published reshape drives each position toward (per OUR-offset target SOL + token =
  // `capFactor × leaderBin`), stamped when handleResync publishes its ops. A rapid follow-up resync on the same
  // position (leaderPosition key) nets the leader's NEW shape against THIS in-flight-adjusted self-state instead of
  // the not-yet-updated on-chain read (removes never confirm back to the brain, so the read can stay stale), which
  // otherwise mis-nets into a persistent ~2×/~0.5× exposure. Fresh only within RESHAPE_INFLIGHT_GRACE_MS; overwritten
  // by each subsequent reshape and cleared on close. In-memory (like the pending maps above): a crash drops it →
  // the resync falls back to the on-chain read, and the reconcile/next event backstops (never a missed close).
  const inFlightReshapeTargets = new Map<
    string,
    { atMs: number; sol: Map<number, number>; token: Map<number, number> }
  >();

  // Per-user opens-per-window ring (3b step 8): wall-clock ms of every mirror THIS user opened, feeding
  // caps.maxOpensPerWindow (checkCaps filters by the live window). PER USER by construction — user A's open burst
  // must never consume user B's window. Seeded at boot from the persisted OPEN mirrors' openedAt: positions opened
  // AND closed before a restart have no open row, so a boot mid-window UNDER-COUNTS by those closed-within-window
  // opens (known + accepted: windows are minutes-scale, restarts mid-window are rare, and the cap is a rate
  // limiter, not a safety exit).
  const openTimestampsMs: number[] = [];
  const recordOpen = (openedAtMs: number): void => {
    openTimestampsMs.push(openedAtMs);
    const cutoff = Date.now() - OPEN_TIMESTAMPS_RETAIN_MS;
    while (openTimestampsMs.length > 0 && (openTimestampsMs[0] as number) < cutoff)
      openTimestampsMs.shift();
  };
  // The ONE seam through which a mirror becomes tracked (every open path + the boot restore): registry + the
  // opens-window ring stay in lockstep. Idempotent like registry.open — an already-open leader position records
  // nothing (a re-open no-op is not a new open; counting it would burn window budget on duplicates).
  const openMirror = (m: Omit<Mirror, 'status'>): Mirror => {
    const alreadyOpen = registry.hasOpen(m.leaderPosition);
    const mirror = registry.open(m);
    if (!alreadyOpen) recordOpen(mirror.openedAt);
    return mirror;
  };

  const capsState = (candidateLeader: string, candidateMint: string): CapsState => {
    const open = registry.openPositions();
    return {
      openPositions: open.length,
      totalExposureSol: open.reduce((s, m) => s + m.sizeSol, 0),
      // Per-leader scope (3b): only the CANDIDATE leader's mirrors count toward its exposure cap — another
      // leader's open positions must never consume this leader's `maxTotalExposureSol` budget.
      leaderExposureSol: exposureFor(open, candidateLeader),
      // Per-token concurrency: count THIS user's open mirrors already in the candidate's token. An empty candidate
      // mint (a non-SOL pool, skipped later anyway) counts 0 — never matching a legacy '' mirror on either side.
      tokenOpenCount: candidateMint ? open.filter((m) => m.nonSolMint === candidateMint).length : 0,
      openTimestampsMs: [...openTimestampsMs],
    };
  };

  async function publish(
    sr: Omit<SignRequest, 'issuedAtMs' | 'userId'>,
    journalHint?: Partial<JournalEntry>,
    // Explicit correlationId for the RETRY-capable close stages (#64): a reconcile/rug-SL/orphan re-close stamps its
    // per-tick attempt here so a genuine retry persists as a DISTINCT audit row. Undefined for every other publish ⇒
    // the emit falls back to `correlationId = commandId` exactly as before (byte-identical).
    correlationId?: string,
  ): Promise<void> {
    // The tenant is injected HERE, once (the runtime binding) — no call site carries it by hand; timestamped at
    // publish time (latency).
    const full: SignRequest = { ...sr, userId, issuedAtMs: Date.now() };
    SignRequestSchema.parse(full); // local guardrail: we only publish a valid contract
    // Activity journal: EVERY published intent is recorded here (single backstop). A context-specific publish (a
    // failsafe / orphan / rug-SL re-close) passes a `reason` hint that resolves to the pinned `failsafe.*` code
    // (SPEC §2.1) — every other publish is a plain internal `lifecycle.open_published` trace (the on-chain
    // confirmation arrives later as `lifecycle.*_confirmed`, never here). The leaf == the verbatim hint reason.
    // NB: `severity` is denormalized from the resolved code in the typed model (the failsafe codes are already
    // warn/error), so the legacy `journalHint.severity` is no longer plumbed — the registry now governs it.
    // The emit is FACTORED so BOTH the success path AND a bus.publish FAILURE journal the intent: a publish throw on
    // the hot path must NEVER drop a live open/resync/claim with only a log line (never-miss pillar) — the row is the
    // durable audit backstop and the failure branch raises the code to error-severity `lifecycle.publish_failed`.
    const reason = journalHint?.reason;
    const successCode = reason
      ? (resolveLegacyReason(reason) ?? FALLBACK_CODE)
      : 'lifecycle.open_published';
    const journal = (
      code: CopyCode,
      outcome: JournalEntry['outcome'],
      journaledReason: string | undefined,
      streamId?: string,
    ): void =>
      events.emit(code, {
        stage: journalHint?.stage ?? stageForKind(full.kind),
        outcome,
        kind: full.kind,
        // The event's/mirror's leader when the caller passes it (3b); wallet-level publishes (sell/orphan) keep the
        // boot-leader fallback as a correlation-only label (documented wallet-context path — their eventKeys/
        // commandIds are what matter, and the orphan's is wallet-prefixed since step 6).
        leader: journalHint?.leader ?? bootLeader,
        pool: full.pool,
        leaderPosition: journalHint?.leaderPosition,
        ourPosition: full.positionPubkey,
        commandId: full.commandId,
        eventKey: full.eventKey,
        correlationId, // retry-close discriminator (#64); undefined ⇒ correlationId = commandId (unchanged)
        leaderSizeSol: journalHint?.leaderSizeSol,
        ourSizeSol: full.sizeSol,
        reason: journaledReason,
        adminDetail: { targetBinRange: full.targetBinRange, streamId, ...journalHint?.detail },
      });

    let id: string;
    try {
      id = await bus.publish(STREAM, HOP, hmacKey, full);
    } catch (err) {
      // ioredis (maxRetriesPerRequest:null + offline queue) already retries CONNECTION failures indefinitely, so a
      // throw here is a genuine non-connection failure. Journal the intent as FAILED (error-severity, auditable) and
      // log LOUD, then RE-THROW — the caller must never treat an unpublished command as sent (fail loud, no swallow).
      journal('lifecycle.publish_failed', 'failed', reason ?? BUS_PUBLISH_FAILED_REASON);
      log.error(
        { err: (err as Error).message, kind: full.kind, our: full.positionPubkey, pool: full.pool },
        '📤❌ bus publish FAILED — intent journaled, command NOT sent',
      );
      throw err;
    }
    // Machine-readable publish marker: the EXACT copy pubkey + kind we just published (the journal's formatted line
    // carries neither as a field). Ops visibility + lets a consumer track the published copy without RPC enumeration.
    log.info(
      { kind: full.kind, our: full.positionPubkey, pool: full.pool, streamId: id },
      '📤 published',
    );
    journal(successCode, journalHint?.outcome ?? 'published', reason, id);
  }

  // Jito on = env override (bench) else the user-level DB flag; mirrors the coffre's landing decision so the tip
  // is added exactly when the vault will bundle. jitoEnabled is user-level only (not per-leader-overridable).
  const jitoOn = (): boolean => jitoEnabledEnv ?? runtimeConfig.user.jitoEnabled;

  function serializeUnsigned(tx: Transaction): string {
    tx.feePayer = ownerPk;
    tx.recentBlockhash = blockhashCache.get().blockhash; // cached: the vault re-sets a fresh one before signing → no hot-path RTT
    const pf = eff().priorityFee;
    const live = oracleOn() ? priorityFeeOracle.get(pf.tier) : null; // live floor in congestion; null ⇒ static tier
    const prioritySpent = applyPriorityFee(tx, pf, live); // capped priority fee on every DLMM tx (Wall B allows ComputeBudget)
    // Anti-sandwich Jito tip, INSIDE the shared priority-fee cap (priority + tip ≤ maxCapSol). Only has effect when
    // the vault bundles; on the RPC fallback the tip burns (small, capped, only when Jito is on). Wall B allowlists
    // a tip to a known Jito account up to its own hard cap. Default off ⇒ no tip ix at all.
    const tip = jitoTipFor(
      jitoOn(),
      pf.maxCapSol * LAMPORTS_PER_SOL,
      prioritySpent,
      nextJitoTipSeed(),
    );
    if (tip)
      tx.instructions.push(
        SystemProgram.transfer({
          fromPubkey: ownerPk,
          toPubkey: tip.account,
          lamports: tip.lamports,
        }),
      );
    return tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');
  }

  async function slots(): Promise<{ issuedAtSlot: number; deadlineSlot: number }> {
    const s = await conn.getSlot();
    return { issuedAtSlot: s, deadlineSlot: s + DEADLINE_SLOTS };
  }

  // A freshly-changed leader position can read PARTIALLY (its bin arrays aren't indexed yet → a two-sided open's TOKEN
  // leg, or a fresh add, reads as 0), making the bot misclassify a two-sided open as one-sided or skip a reshape (RPC
  // read-after-write lag). Read until the shape is RELIABLE: a both-legs shape is fully indexed (return at once → zero
  // added latency on the common two-sided open); a single-leg shape is confirmed STABLE (total liquidity unchanged
  // across two reads) before trusting it as genuinely one-sided / settled. null only if the position is never readable.
  async function readStableShape(
    poolPk: PublicKey,
    owner: PublicKey,
    position: string,
    pair: Awaited<ReturnType<typeof createDlmmPair>>,
    expectBothLegs = false,
  ) {
    let last: Awaited<ReturnType<typeof readLeaderPositionShape>> = null;
    let lastTotal = -1n;
    const maxReads = expectBothLegs ? TWO_SIDED_SHAPE_MAX_READS : OPEN_SHAPE_READ_RETRIES;
    for (let r = 0; r <= maxReads; r++) {
      if (r > 0) await sleep(OPEN_SHAPE_READ_DELAY_MS);
      const shape = await readLeaderPositionShape(conn, poolPk, owner, position, pair);
      if (!shape) continue; // not readable yet → retry
      if (shape.perBin.some((b) => b.x > 0n) && shape.perBin.some((b) => b.y > 0n)) return shape; // both legs indexed
      // The tx decode says this is two-sided but a leg's bin array isn't indexed yet → DON'T accept the partial
      // (single-leg) shape; keep reading until the missing leg appears.
      if (expectBothLegs) {
        last = shape;
        continue;
      }
      const total = shape.perBin.reduce((s, b) => s + b.x + b.y, 0n);
      if (last && total === lastTotal && total > 0n) return shape; // single-leg but stable → genuinely settled
      last = shape;
      lastTotal = total;
    }
    // Expected two-sided but never saw both legs → return null (NOT a half/single-leg shape): handleOpen then SKIPS
    // the open rather than copying a forbidden one-sided half of a two-sided leader (both-or-nothing).
    return expectBothLegs ? null : last;
  }

  // #33 — SETTLE the two-sided token leg before depositing. The BUY confirms on the coffre's connection; the brain
  // reads the balance on ITS connection ~300ms later → a read-after-write lag can show the bought token still at (or
  // near) its PRE-buy value. Depositing that stale/short amount = a forbidden one-sided half copy. Retry the read until
  // the BOUGHT delta (`actual − preBuy`, which also excludes any pre-existing residual of the same mint) clears the
  // quote-derived floor; if it never does within the bound, return `ready:false` so the caller SKIPS (both-or-nothing).
  async function settledTwoSidedDeposit(
    tokenMint: string,
    preBuyTokenRaw: bigint,
    expectedTokenRaw: bigint,
    slippageBps: number,
  ): Promise<{ ready: boolean; depositRaw: bigint }> {
    const mintPk = new PublicKey(tokenMint);
    let last: { ready: boolean; depositRaw: bigint } = { ready: false, depositRaw: 0n };
    for (let r = 0; r <= TOKEN_BALANCE_SETTLE_MAX_READS; r++) {
      if (r > 0) await sleep(OPEN_SHAPE_READ_DELAY_MS);
      const actualBalance = await readOwnerTokenBalance(conn, ownerPk, mintPk);
      last = resolveTwoSidedTokenDeposit({
        actualBalance,
        preBuyBalance: preBuyTokenRaw,
        expectedOut: expectedTokenRaw,
        slippageBps,
      });
      if (last.ready) return last;
    }
    return last; // never settled → caller does a both-or-nothing skip (the bought token is recovered by the sweep)
  }

  async function handleOpen(e: DetectedEvent, leader: string): Promise<void> {
    log.info(
      { position: e.position, pool: e.pool, depositSol: e.depositSol },
      '🔨 handleOpen start',
    );
    const ec = effFor(leader);
    // Read the spendable balance ONCE (a real user's is an async cached getBalance; SYSTEM's is a constant): the
    // decision and the skip-emit's `configuredSol` must report the SAME value.
    const availableBalanceSol = await balanceOf();
    const decision = decideEntry(
      e,
      { ...ec.sizing, skipNonSolPaired: true },
      { availableBalanceSol },
    );
    if (decision.outcome === 'skipped') {
      // dynamic reason: below_min_floor (sizing) / insufficient_balance (balance, pinned) / non_sol_paired — resolved to its leaf.
      // `eventKey` (the per-open detection correlation) keys the emit dedup so distinct opens skipped for the same
      // reason stay DISTINCT rows (an empty correlation would collapse them); WS+poll re-detect of one leg collapses.
      emitFor(decision.reason, {
        stage: 'open',
        outcome: 'skipped',
        reason: decision.reason,
        leader,
        pool: e.pool,
        leaderPosition: e.position,
        eventKey: openSkipKey(e, leader),
        leaderSizeSol: e.depositSol,
        adminDetail: {
          mint: e.nonSolMint,
          nonSolSymbol: e.nonSolSymbol,
          configuredSol: availableBalanceSol,
        },
      });
      return;
    }
    const cap = checkCaps(
      ec.caps,
      capsState(leader, e.nonSolMint ?? ''), // candidate leader/mint = the EVENT's (3b fan-out; '' mint ⇒ per-token cap not counted)
      decision.sizeSol,
      Date.now(),
      ec.leaderMaxTotalExposureSol, // per-leader exposure ceiling (SPEC §4.2/§12)
    );
    if (cap.action === 'block') {
      // dynamic cap reason: kill_switch_* (internal) / max_open_positions / max_concurrent_per_token / max_opens_per_window / max_total_exposure (feed).
      emitFor(cap.reason, {
        stage: 'open',
        outcome: 'blocked',
        reason: cap.reason,
        leader,
        pool: e.pool,
        leaderPosition: e.position,
        eventKey: openSkipKey(e, leader),
        leaderSizeSol: e.depositSol,
        ourSizeSol: decision.sizeSol,
        adminDetail: { mint: e.nonSolMint, nonSolSymbol: e.nonSolSymbol },
      });
      return;
    }

    const poolPk = new PublicKey(e.pool);
    const leaderPk = new PublicKey(leader); // the EVENT's leader owns the shape we copy (3b)
    // Latency budget (≤3s SLA): fire the INDEPENDENT reads in PARALLEL — the DLMM pair (~300ms, DLMM.create), the
    // slot fetch, and the entry-filter data all overlap the pool-meta read instead of running after it. (The pair
    // doesn't depend on meta; the only sequential link is shape ← pair and build ← shape.) `filterDataP` fetches
    // nothing when only local/leader-shape filters are enabled. ONE shared DLMM instance serves the read AND build.
    const pairP = createDlmmPair(conn, poolPk);
    const slotsP = slots();
    const filterDataP = resolveFilterContext(e.nonSolMint, neededSources(ec.filters), filterDeps, {
      nowMs: Date.now(),
      timeoutMs: FILTER_TIMEOUT_MS,
    });
    // Tee a no-op rejection handler on EACH in-flight read the instant it is created (#138). Every filtered/skipped
    // open path below (non-SOL, no-shape, filter-skip, two-sided, too-wide) returns WITHOUT awaiting these, so a
    // transient reject (e.g. a `getSlot()` 429 landing after the skip) would otherwise bubble to the process as an
    // unhandledRejection and crash the whole brain. Teeing marks each promise handled for the process detector; every
    // `await pairP/slotsP/filterDataP` on the REAL open path below still observes a genuine failure and surfaces it.
    pairP.catch(() => {});
    slotsP.catch(() => {});
    filterDataP.catch(() => {});

    const meta = await poolReader.loadPoolMeta(e.pool);
    if (!meta?.solSide) {
      events.emit('eligibility.non_sol_paired', {
        stage: 'open',
        outcome: 'skipped',
        reason: 'non_sol_pool',
        leader,
        pool: e.pool,
        leaderPosition: e.position,
        eventKey: openSkipKey(e, leader),
        adminDetail: { mint: e.nonSolMint, nonSolSymbol: e.nonSolSymbol },
      });
      return;
    }

    const pair = await pairP;
    // Read the leader's shape RELIABLY. The tx decode tells us AUTHORITATIVELY whether the leader deposited a TOKEN
    // leg (two-sided) — independent of the race-prone shape read; when so, wait for BOTH legs to index before
    // classifying (a partial read would misclassify a two-sided open as one-sided = a forbidden half copy).
    const expectTwoSided = (e.depositTokenRaw ?? 0) > ec.execution.dustTokenRaw;
    const shape = await readStableShape(poolPk, leaderPk, e.position, pair, expectTwoSided);
    if (!shape) {
      events.emit('detect.leader_position_not_found', {
        stage: 'open',
        outcome: 'skipped',
        reason: 'leader_position_not_found',
        leader,
        pool: e.pool,
        leaderPosition: e.position,
        eventKey: openSkipKey(e, leader),
        adminDetail: { afterRetries: OPEN_SHAPE_READ_RETRIES },
      });
      return;
    }

    // Entry filters gate the OPEN only. Context = local (open tokens) + leader-shape (range) + resolved data.
    const filterCtx: FilterContext = {
      openTokenMints: new Set(),
      priceRangePercent: rangeCoveragePercent(shape.perBin.length, meta.binStep),
      ...(await filterDataP),
    };
    const verdict = runFilters({ nonSolMint: e.nonSolMint, pool: e.pool }, filterCtx, ec.filters);
    if (filtersActive(ec.filters)) {
      log.info(
        {
          mint: e.nonSolMint,
          organicScore: filterCtx.organicScore,
          marketCapUsd: filterCtx.marketCapUsd,
          tokenAgeHours: filterCtx.tokenAgeHours,
          volume24hUsd: filterCtx.volume24hUsd,
          priceChangePercent: filterCtx.priceChangePercent,
          holders: filterCtx.holders,
          priceRangePercent: filterCtx.priceRangePercent,
          verdict: verdict.action,
          reason: verdict.action === 'skip' ? verdict.reason : undefined,
        },
        '🔎 entry filters evaluated',
      );
    }
    if (verdict.action === 'skip') {
      // An enabled filter ENFORCES (no shadow mode): the open is skipped with the failing filter's reason → its
      // `filter.<reason>` leaf (dynamic; 16 verbatim filter leaves, all feed/transparency — resolved per reason).
      emitFor(verdict.reason, {
        stage: 'open',
        outcome: 'skipped',
        reason: verdict.reason,
        leader,
        pool: e.pool,
        leaderPosition: e.position,
        eventKey: openSkipKey(e, leader),
        leaderSizeSol: e.depositSol,
        adminDetail: { mint: e.nonSolMint, nonSolSymbol: e.nonSolSymbol },
      });
      return;
    }

    // TWO-SIDED classification. `legs` = the leader's per-bin SOL + token RAW amounts from the settled shape.
    const legs = shape.perBin.map((b) => ({
      binId: b.binId,
      solRaw: meta.solSide === 'Y' ? b.y : b.x,
      tokenRaw: meta.solSide === 'Y' ? b.x : b.y,
    }));
    const dustTokenRaw = BigInt(ec.execution.dustTokenRaw);

    // 'off' (default): a TWO-SIDED leader is SKIPPED entirely — copying only its SOL leg would be a forbidden HALF
    // copy (Spec 04; the 'on' path likewise treats a half copy as forbidden), NOT the correct SOL-only copy of a
    // genuinely one-sided leader (finding #39). Two conditions, both required: `expectTwoSided` (the tx decode says
    // the leader DELIBERATELY deposited a token leg > dust — the authoritative intent signal; it is what made
    // readStableShape wait for both legs) AND `isTwoSidedLeader` (the settled shape confirms BOTH a SOL leg and a
    // token leg > dust). Gating on the DEPOSIT intent — not the raw shape alone — keeps a genuinely SOL-only leader
    // whose position merely spans the always-mixed active bin (a token SLIVER, but depositTokenRaw = 0) on the
    // correct SOL-only path. Classified on the leader's RAW legs, so the skip fires REGARDLESS of dust — #144's
    // on-mode our-leg-dust SOL-only fallthrough is a DIFFERENT case (mode='on', our SCALED leg ≤ dust), untouched below.
    if (ec.twoSidedMode === 'off' && expectTwoSided && isTwoSidedLeader(legs, dustTokenRaw)) {
      events.emit('eligibility.two_sided_disabled', {
        stage: 'open',
        outcome: 'skipped',
        reason: 'two_sided_disabled',
        leader,
        pool: e.pool,
        leaderPosition: e.position,
        eventKey: openSkipKey(e, leader),
        leaderSizeSol: e.depositSol,
        adminDetail: { mint: e.nonSolMint, nonSolSymbol: e.nonSolSymbol },
      });
      return; // no funds deployed — nothing built/published
    }

    // 'on'/'shadow': replicate BOTH sides (buy the token, deposit two-sided). 'shadow' logs the plan but still opens
    // SOL-only. planTwoSided gates `twoSided` on OUR SCALED token target (#144), so a dust-scaled token FALLS THROUGH
    // to the legitimate SOL-only copy below (mode='on' + our-leg-dust) — a copy that must NOT be missed.
    if (ec.twoSidedMode !== 'off') {
      const plan = planTwoSided(
        legs,
        shape.activeBinId,
        shape.activeBinId,
        dustTokenRaw,
        ec.sizing.tradeRatioPct ?? 100, // gate two-sided on OUR scaled token target (the ratio openTwoSided buys at) — #144
      );
      if (plan.twoSided && plan.leaderSolRaw > 0n && e.nonSolMint) {
        log.info(
          {
            mode: ec.twoSidedMode,
            leaderTokenRaw: plan.leaderTokenRaw.toString(),
            bins: plan.weights.length,
          },
          '🪙 two-sided position detected',
        );
        // SAFE: a two-sided leader is copied as BOTH legs or NOT AT ALL — NEVER a half (one-sided) position. 'on'
        // hands off to openTwoSided, which either replicates both legs or SKIPS cleanly if the token can't be
        // bought (no Jupiter route). Either way we return — we do NOT fall through to the one-sided SOL path.
        if (ec.twoSidedMode === 'on')
          return openTwoSided(e, leader, e.nonSolMint, meta.solSide, plan, decision.sizeSol);
        // 'shadow' → fall through to the SOL-only path below (shadow mode = log the two-sided plan, open SOL-only).
      }
    }

    const perBinSol = shape.perBin.map((b) => ({
      binId: b.binId,
      amount: meta.solSide === 'Y' ? b.y : b.x,
    }));
    const reanchored = reanchorShape(shape.activeBinId, shape.activeBinId, perBinSol); // delta 0 = 100% exact bins
    // CONTIGUOUS span for the SDK by-weight open: a re-anchor that drops a tiny interior bin to 0 bps would leave a
    // binId gap → "Discontinuous Bin ID". Fill gaps with 0/0 (min/max unchanged, so targetBinRange stays correct).
    const dist: WeightBin[] = fillContiguousWeights(
      reanchored.weights.map((w) => ({
        binId: w.binId,
        xBps: meta.solSide === 'X' ? w.bps : 0,
        yBps: meta.solSide === 'Y' ? w.bps : 0,
      })),
    );

    // A leader position wider than a single DLMM position can't be replicated as ONE createEmptyPosition + deposit
    // (a >MAX_SINGLE_POSITION_BINS span chunks into multiple positions → a partial/forbidden half copy). Emit a
    // TYPED skip BEFORE buildOpenByWeight so an extended leader position never throws a generic mirror error (#18).
    if (dist.length > MAX_SINGLE_POSITION_BINS) {
      events.emit('eligibility.too_wide', {
        stage: 'open',
        outcome: 'skipped',
        reason: 'too_wide',
        leader,
        pool: e.pool,
        leaderPosition: e.position,
        eventKey: openSkipKey(e, leader),
        adminDetail: {
          mint: e.nonSolMint,
          nonSolSymbol: e.nonSolSymbol,
          bins: dist.length,
          max: MAX_SINGLE_POSITION_BINS,
        },
      });
      return;
    }

    const sizeLamports = BigInt(Math.round(decision.sizeSol * LAMPORTS_PER_SOL));
    const totalX = meta.solSide === 'X' ? sizeLamports : 0n;
    const totalY = meta.solSide === 'Y' ? sizeLamports : 0n;
    const lower = reanchored.lowerBinId;
    const upper = reanchored.upperBinId;
    // A WIDE one-sided open (≥26 bins) chunks the atomic by-weight open into [pre, main(addLiquidityOneSide), post].
    // The deposit (main) is NOT the first tx, so we sequence it: publish `pre` (create+wrap) then `main`+`post`
    // (deposit+unwrap) once the create lands (publishSplitOpen). The commandId is derived from `open-create:` so the
    // create's position keypair matches the one baked into the SDK build. Narrow opens (≤25) keep the atomic 1-tx path.
    const wide = isWideOpen(dist.length);
    const eventKey = wide
      ? `${leader}:${e.pool}:open-create:${e.position}:${e.signature}`
      : `${leader}:${e.pool}:open:${e.position}:${e.signature}`;
    const commandId = commandIdFor(eventKey);
    const posKp: Keypair = derivePositionKeypair(commandId);
    const built = await buildOpenByWeight(
      conn,
      poolPk,
      ownerPk,
      posKp.publicKey,
      totalX,
      totalY,
      dist,
      depositSlippagePct(leader),
      pair,
    );
    if (wide) {
      const arr = Array.isArray(built) ? built : [built]; // ≥26 bins → [pre, main, post]
      return publishSplitOpen(e, leader, {
        createTx: arr[0] as Transaction,
        depositTx: mergeDeposit(arr.slice(1)),
        posPubkey: posKp.publicKey.toBase58(),
        commandId,
        eventKey,
        lower,
        upper,
        sizeSol: decision.sizeSol,
        recordedSizeSol: decision.sizeSol, // one-sided: no token buy → recorded == the SOL leg
      });
    }
    const { issuedAtSlot, deadlineSlot } = await slotsP;
    const sr: Omit<SignRequest, 'issuedAtMs' | 'userId'> = {
      commandId,
      eventKey,
      kind: 'open',
      pool: e.pool,
      positionPubkey: posKp.publicKey.toBase58(),
      owner: ownerPk.toBase58(),
      txBase64: serializeUnsigned(onlyTx(built, 'open')),
      sizeSol: decision.sizeSol,
      targetBinRange: { lower, upper },
      issuedAtSlot,
      deadlineSlot,
    };
    const mirror = openMirror({
      leaderPosition: e.position,
      leaderAddress: leader, // the EVENT's leader (3b fan-out) — drives per-leader stop-closes/exposure/rug config
      ourPosition: sr.positionPubkey,
      pool: e.pool,
      nonSolSymbol: e.nonSolSymbol,
      nonSolMint: e.nonSolMint ?? '', // per-token concurrency-cap key
      sizeSol: decision.sizeSol,
      lowerBin: lower,
      upperBin: upper,
      openedAt: Date.now(),
    });
    pendingOpens.clear(e.position); // now tracked → lift the duplicate-open reservation for this leader position
    await store.saveOpen(mirror); // persist BEFORE publishing → never an untracked open
    await publish(sr, { leader, leaderPosition: e.position, leaderSizeSol: e.depositSol });
  }

  /** TWO-SIDED open: buy the token leg then deposit BOTH legs. Publishes the BUY first so the coffre lands it before
   *  the open (funds the token). BOTH legs are scaled by ONE shared factor so the leader's composition holds AND the
   *  COMBINED SOL deployment (SOL leg + the token buy) is bounded by the cap (finding #94). */
  async function openTwoSided(
    e: DetectedEvent,
    leader: string,
    tokenMint: string,
    solSide: 'X' | 'Y',
    plan: TwoSidedPlan,
    decisionSizeSol: number,
  ): Promise<void> {
    const ec = effFor(leader);
    // Cap the COMBINED deployment (SOL leg + the SOL spent buying the token), NOT the SOL leg alone (finding #94).
    // Ceiling = min(decideEntry's sizeSol — the copy-ratio of the leader's TOTAL value, incl. reduce-to-fit — and
    // the per-trade hard cap maxTradeSol). The token leg's SOL value = the detected deposit (which already prices
    // BOTH legs in SOL) minus OUR SOL leg; clamp ≥0 so a shape-read/deposit skew never yields a negative that would
    // defeat the cap. sizeTwoSided then scales BOTH legs by one shared factor so composition holds AND the total is
    // bounded — so the token buy can't over-deploy (symptom 1) or get coffre-rejected and drop the open (symptom 2).
    const maxTradeLamports = BigInt(Math.round(ec.sizing.maxTradeSizeSol * LAMPORTS_PER_SOL));
    const decisionLamports = BigInt(Math.round(decisionSizeSol * LAMPORTS_PER_SOL));
    const maxDeployLamports =
      decisionLamports < maxTradeLamports ? decisionLamports : maxTradeLamports;
    const depositLamports = BigInt(Math.round(e.depositSol * LAMPORTS_PER_SOL));
    const tokenLegValueLamports =
      depositLamports > plan.leaderSolRaw ? depositLamports - plan.leaderSolRaw : 0n;
    const { solLamports: sizeLamports, tokenTarget } = sizeTwoSided(
      plan.leaderSolRaw,
      plan.leaderTokenRaw,
      tokenLegValueLamports,
      ec.sizing.tradeRatioPct ?? FIXED_SIZE_MIRROR_RATIO_PCT, // fixed-size: full nominal ratio, bounded to the fixed size by the #94 combined cap below — one fixed-size semantic (#143)
      maxDeployLamports,
    );
    const dist: WeightBin[] = fillContiguousWeights(
      plan.weights.map((w) => ({
        binId: w.binId,
        xBps: solSide === 'X' ? w.solBps : w.tokenBps,
        yBps: solSide === 'Y' ? w.solBps : w.tokenBps,
      })),
    ); // contiguous span (SDK by-weight requirement)
    // ExactIn buy: ExactOut has NO Jupiter route for most memecoins (NO_ROUTES_FOUND). Price the token leg via the
    // SELL direction (ExactIn, fully routed) → its SOL value → spend that to BUY the token (ExactIn). The token
    // received is variable, so the build-after-buy step deposits the ACTUAL balance (not a pre-planned exact amount).
    let buyQuote: Awaited<ReturnType<typeof getJupiterBuyQuoteExactIn>>;
    let buyTxB64: string;
    try {
      const priceQuote = await getJupiterQuote(
        jupiterBaseUrl,
        tokenMint,
        tokenTarget,
        ec.execution.slippageBps,
      ); // sell tokenTarget → its SOL value
      const solToSpend = BigInt(priceQuote.outAmount);
      if (!(solToSpend > 0n)) throw new Error('token leg priced at 0 SOL');
      buyQuote = await getJupiterBuyQuoteExactIn(
        jupiterBaseUrl,
        tokenMint,
        solToSpend,
        ec.execution.slippageBps,
      );
      buyTxB64 = await buildJupiterSwapTx(jupiterBaseUrl, buyQuote, ownerPk.toBase58());
    } catch (err) {
      // SAFE: the token leg genuinely can't be acquired (no route EVEN via ExactIn, or a priced-at-0 leg). We do NOT
      // open a HALF (one-sided) position — SKIP entirely (nothing stashed/published yet → clean no-op).
      events.emit('eligibility.twosided.unbuyable', {
        stage: 'open',
        outcome: 'skipped',
        reason: 'twosided_unbuyable',
        leader,
        pool: e.pool,
        leaderPosition: e.position,
        eventKey: openSkipKey(e, leader),
        adminDetail: { mint: tokenMint, nonSolSymbol: e.nonSolSymbol, err: (err as Error).message },
      });
      return; // SAFE: never a partial/one-sided copy
    }
    const buyKey = `${leader}:${e.pool}:buy:${e.position}:${e.signature}`;
    const buyCommandId = commandIdFor(buyKey);
    const { issuedAtSlot, deadlineSlot } = await slots();
    // #33 — snapshot the token balance BEFORE the buy lands: the post-buy read deposits only the BOUGHT delta
    // (actual − preBuy), so a pre-existing residual of the same mint is never co-deposited past the leader composition.
    const preBuyTokenRaw = await readOwnerTokenBalance(conn, ownerPk, new PublicKey(tokenMint));

    // `sizeSol` = OUR SOL leg = the SOL the OPEN command actually deposits → each command's per-command coffre
    // re-clamp stays a true, always-in-bounds figure (the SOL leg is ≤ the cap by construction, so a fresh open is
    // never spuriously rejected). `recordedSizeSol` = the COMBINED deployment (SOL leg + the SOL the buy spends, the
    // ExactIn input) → recorded on the MIRROR so exposure caps count BOTH legs (finding #94 §3: the SOL-leg-only
    // mirror size undercounted deployed capital by up to ~2×). The buy is its OWN separately-clamped command, so it
    // is never folded into a command re-clamp (drift could push that over maxTradeSol → a dropped open).
    const sizeSol = Number(sizeLamports) / LAMPORTS_PER_SOL;
    const recordedSizeSol = Number(sizeLamports + BigInt(buyQuote.inAmount)) / LAMPORTS_PER_SOL;

    // Stash the open context → built+published once the buy lands; the build reads the ACTUAL token bought (ExactIn
    // output is variable) and deposits THAT, keyed by solSide/tokenMint (not a pre-planned exact amount).
    pendingTwoSidedOpens.set(buyCommandId, {
      e,
      leader,
      dist,
      sizeLamports,
      solSide,
      tokenMint,
      sizeSol,
      recordedSizeSol,
      buyInLamports: Number(buyQuote.inAmount), // #140 — the SOL spent on the token leg → the BUY ledger row at open
      preBuyTokenRaw,
      expectedTokenRaw: BigInt(buyQuote.outAmount),
      buySlippageBps: ec.execution.slippageBps,
    });
    inFlightBuyMints.set(tokenMint, Date.now()); // protect this bought token from the safety-sweep until it's deposited
    await publish(
      {
        commandId: buyCommandId,
        eventKey: buyKey,
        kind: 'buy',
        pool: e.pool,
        positionPubkey: ownerPk.toBase58(), // n/a for a swap — Wall B binds to owner's ATA of the bought token
        owner: ownerPk.toBase58(),
        txBase64: buyTxB64,
        sizeSol: Number(buyQuote.inAmount) / LAMPORTS_PER_SOL, // the ExactIn SOL input (spend) → re-clamped against maxTradeSol by the coffre
        targetBinRange: { lower: 0, upper: 0 },
        issuedAtSlot,
        deadlineSlot,
        buy: {
          outputMint: tokenMint,
          exactOutAmountRaw: buyQuote.outAmount,
          maxInLamports: buyQuote.inAmount,
        }, // expected token (informational) + the SOL input (cap)
      },
      { leader },
    );
    log.info(
      {
        tokenMint,
        expectToken: buyQuote.outAmount,
        spendSol: Number(buyQuote.inAmount) / LAMPORTS_PER_SOL,
        solLamports: sizeLamports.toString(),
        bins: dist.length,
      },
      '🪙 two-sided BUY (ExactIn) published — the open follows once the buy lands',
    );
  }

  /** Publish an open as TX1 createEmptyPosition (kind 'open') → TX2 addLiquidityByWeight2 (kind 'add'), sequenced via
   *  ev:executed (create lands → publishDepositAfterPositionCreated; deposit lands → finalizeToken2022Open persists the
   *  mirror). Used for every open that CANNOT be the atomic single-tx by-weight open: a Token-2022 two-sided open (v1
   *  deposit rejected on-chain) AND any wide open (≥26 bins, where the atomic open chunks and the deposit isn't the
   *  first tx). The mirror is persisted ONLY after the deposit lands, so a crash between the two leaves an UNTRACKED
   *  empty position the orphan-sweep auto-closes (no dormant position). Caller guarantees dist.length ≤ the single
   *  add2 chunk (≤70 bins). One-sided: one of totalX/totalY is 0; two-sided: both legs are funded (token bought first). */
  async function publishOpenViaCreateDeposit(
    e: DetectedEvent,
    leader: string,
    pair: Awaited<ReturnType<typeof createDlmmPair>>,
    args: {
      dist: WeightBin[];
      totalX: bigint;
      totalY: bigint;
      lower: number;
      upper: number;
      sizeSol: number;
      recordedSizeSol: number;
      /** #140 — the two-sided open's buy cost + sig, threaded to the mirror finalize for the BUY ledger row. */
      buyInLamports?: number;
      buySig?: string;
    },
  ): Promise<void> {
    const { dist, totalX, totalY, lower, upper, sizeSol, recordedSizeSol } = args;
    const createEventKey = `${leader}:${e.pool}:open-create:${e.position}:${e.signature}`;
    const createCommandId = commandIdFor(createEventKey);
    const posKp: Keypair = derivePositionKeypair(createCommandId); // the coffre signs 'open' with derivePositionKeypair(commandId) → MUST match
    const built = await buildCreateEmptyPosition(
      conn,
      new PublicKey(e.pool),
      ownerPk,
      posKp.publicKey,
      lower,
      upper,
      pair,
    );
    const { issuedAtSlot, deadlineSlot } = await slots();
    pendingToken2022Deposits.set(createCommandId, {
      e,
      leader,
      dist,
      totalX,
      totalY,
      lower,
      upper,
      sizeSol,
      recordedSizeSol,
      buyInLamports: args.buyInLamports, // #140 — carried to finalizeToken2022Open for the BUY ledger row
      buySig: args.buySig,
    });
    buildingToken2022Positions.set(posKp.publicKey.toBase58(), Date.now()); // orphan-close grace until the deposit lands
    await publish(
      {
        commandId: createCommandId,
        eventKey: createEventKey,
        kind: 'open',
        pool: e.pool,
        positionPubkey: posKp.publicKey.toBase58(),
        owner: ownerPk.toBase58(),
        txBase64: serializeUnsigned(built), // create deploys no SOL → no CU-limit override needed
        sizeSol: 0, // position creation deploys no SOL; the deposit (TX2) deploys it
        targetBinRange: { lower, upper },
        issuedAtSlot,
        deadlineSlot,
      },
      { leader, leaderPosition: e.position, leaderSizeSol: e.depositSol },
    );
    log.info(
      { our: posKp.publicKey.toBase58(), bins: dist.length },
      '🔨 open via create+deposit published (deposit follows once the create lands)',
    );
  }

  /** Publish a WIDE open (≥26 bins) via the SDK's NATIVE multi-tx split. The atomic by-weight open returns
   *  [pre, main, post]: TX1 = `pre` (create position + bin arrays + wrap SOL, kind 'open', position signer); TX2 =
   *  `main`+`post` merged (the deposit via the native addLiquidityOneSide / addLiquidityByWeight + unwrap leftover,
   *  kind 'add'). Sequenced via ev:executed → publishDepositAfterPositionCreated (uses the PREBUILT deposit) →
   *  finalizeToken2022Open persists the mirror. `main` is the SDK's native one-/two-sided deposit ix → correct bin
   *  placement (unlike add2, which is two-sided-only and deposits 0 for a one-sided leg on the wrong side of active).
   *  `commandId` is derived from `eventKey` BY THE CALLER so the create's position keypair matches `createTx`. */
  async function publishSplitOpen(
    e: DetectedEvent,
    leader: string,
    args: {
      createTx: Transaction;
      depositTx: Transaction;
      posPubkey: string;
      commandId: string;
      eventKey: string;
      lower: number;
      upper: number;
      sizeSol: number;
      recordedSizeSol: number;
      /** #140 — the two-sided open's buy cost + sig (absent for a one-sided wide open), threaded to the finalize. */
      buyInLamports?: number;
      buySig?: string;
    },
  ): Promise<void> {
    const { createTx, depositTx, posPubkey, commandId, eventKey, lower, upper, sizeSol } = args;
    const { recordedSizeSol } = args;
    const { issuedAtSlot, deadlineSlot } = await slots();
    pendingToken2022Deposits.set(commandId, {
      e,
      leader,
      lower,
      upper,
      sizeSol,
      recordedSizeSol,
      prebuiltDeposit: depositTx,
      buyInLamports: args.buyInLamports, // #140 — carried to finalizeToken2022Open for the BUY ledger row
      buySig: args.buySig,
    });
    buildingToken2022Positions.set(posPubkey, Date.now()); // orphan-close grace until the deposit lands
    await publish(
      {
        commandId,
        eventKey,
        kind: 'open',
        pool: e.pool,
        positionPubkey: posPubkey,
        owner: ownerPk.toBase58(),
        txBase64: serializeUnsigned(withCuLimit(createTx, TWO_SIDED_CU_LIMIT)), // bin-array init can exceed the 200k CU default
        sizeSol, // `pre` wraps the full SOL → bounded by both the coffre re-clamp AND Wall B's wrap cap
        targetBinRange: { lower, upper },
        issuedAtSlot,
        deadlineSlot,
      },
      { leader, leaderPosition: e.position, leaderSizeSol: e.depositSol },
    );
    log.info(
      { our: posPubkey, lower, upper },
      '🔨 wide open CREATE published (split — deposit follows once the create lands)',
    );
  }

  /** Build + publish the two-sided OPEN once its BUY has landed (token + ATA now exist → clean SDK build). Keyed
   *  by the buy's commandId; a no-op if there's no pending open (e.g. a reshape buy, which builds its add directly). */
  async function publishTwoSidedOpenAfterBuy(buyCommandId: string, buySig?: string): Promise<void> {
    const ctx = pendingTwoSidedOpens.get(buyCommandId);
    if (!ctx) return;
    await runContinuation(pendingTwoSidedOpens, buyCommandId, async () => {
      const { e, leader, dist, sizeLamports, solSide, tokenMint, sizeSol, recordedSizeSol } = ctx;
      if (consumeOpenCancellation(e.position, e.pool, leader)) return; // leader closed before the buy landed → don't open into an exited pool
      // The buy landed and its bought token is on the wallet; RE-STAMP the in-flight grace so it covers THIS hop's
      // deposit landing (finding #96 — the buy-publish stamp can expire before a congested deposit lands → the sweep/
      // close-sell would sell the leg mid-open). Every downstream branch (build, split, Token-2022, or a late skip) is
      // protected for one more window; a genuinely stranded token is recovered by the sweep a window later.
      inFlightBuyMints.set(tokenMint, Date.now());
      // RE-ARM the duplicate-open reservation for THIS hop too (#136): the route-time reservation is TTL-bounded, and a
      // slow multi-tx open (buy retried under congestion → deposit still to build/land) can outlast it. Re-stamping at
      // each open-continuation hop bounds the TTL to a SINGLE hop, so a leader ADD to this same position mid-chain
      // never sees an expired reservation and routes to a SECOND real-money open. Same per-hop re-stamp as the grace above.
      pendingOpens.reserve(e.position);
      const poolPk = new PublicKey(e.pool);
      const pair = await createDlmmPair(conn, poolPk);
      // Deposit the token we ACTUALLY bought (ExactIn output is variable). #33 — the balance read can LAG the buy confirm
      // (read-after-write): guard it until the BOUGHT delta clears the quote-derived floor. If it never settles, SKIP the
      // whole open (both-or-nothing) — NEVER deposit a short/stale token leg (a forbidden one-sided half copy). The
      // bought token is recovered by the wallet sweep. `depositableToken` still reserves a hair for per-bin bps rounding.
      const settled = await settledTwoSidedDeposit(
        tokenMint,
        ctx.preBuyTokenRaw,
        ctx.expectedTokenRaw,
        ctx.buySlippageBps,
      );
      if (!settled.ready) {
        events.emit('eligibility.twosided.unbuyable', {
          stage: 'open',
          outcome: 'skipped',
          reason: 'twosided_unbuyable',
          leader,
          pool: e.pool,
          leaderPosition: e.position,
          eventKey: openSkipKey(e, leader),
          adminDetail: {
            mint: tokenMint,
            nonSolSymbol: e.nonSolSymbol,
            err: 'token balance never settled to the buy floor (read-after-write) — both-or-nothing skip',
          },
        });
        return;
      }
      const actualToken = depositableToken(settled.depositRaw);
      const { totalX, totalY } = twoSidedLegTotals(solSide, sizeLamports, actualToken);
      const lower = Math.min(...dist.map((d) => d.binId));
      const upper = Math.max(...dist.map((d) => d.binId));

      // TOKEN-2022 leg → the v1 by-weight open is rejected on-chain (token program pinned to classic). Split into TX1
      // createEmptyPosition (kind 'open') + TX2 addLiquidityByWeight2 (kind 'add'), sequenced via ev:executed. Both legs
      // span the active bin so the two-sided add2 deposits correctly. The mirror is persisted ONLY after the deposit
      // lands → a crash between the two leaves an UNTRACKED empty position the orphan-sweep auto-closes (no dormant).
      if (isToken2022Pool(pair)) {
        if (dist.length > TOKEN2022_MAX_OPEN_BINS) {
          // Wider than a single create + single add2 chunk → SKIP (never a partial deposit). The bought token is
          // recovered by the wallet sweep (sold back to SOL); a >70-bin two-sided memecoin copy is rare.
          events.emit('eligibility.twosided.token2022_too_wide', {
            stage: 'open',
            outcome: 'skipped',
            reason: 'twosided_token2022_too_wide',
            leader,
            pool: e.pool,
            leaderPosition: e.position,
            eventKey: openSkipKey(e, leader),
            adminDetail: {
              mint: tokenMint,
              nonSolSymbol: e.nonSolSymbol,
              bins: dist.length,
              max: TOKEN2022_MAX_OPEN_BINS,
            },
          });
          return;
        }
        return publishOpenViaCreateDeposit(e, leader, pair, {
          dist,
          totalX,
          totalY,
          lower,
          upper,
          sizeSol,
          recordedSizeSol,
          buyInLamports: ctx.buyInLamports, // #140 — threaded create → deposit → mirror → the BUY ledger row
          buySig,
        });
      }

      // A span wider than a single DLMM position can't be replicated as one create + deposit (it would chunk into
      // multiple positions → a partial/forbidden half copy). Typed skip BEFORE buildOpenByWeight (#18); the bought
      // token is recovered by the wallet sweep — same guarantee as the Token-2022 branch above.
      if (dist.length > MAX_SINGLE_POSITION_BINS) {
        events.emit('eligibility.too_wide', {
          stage: 'open',
          outcome: 'skipped',
          reason: 'too_wide',
          leader,
          pool: e.pool,
          leaderPosition: e.position,
          eventKey: openSkipKey(e, leader),
          adminDetail: {
            mint: tokenMint,
            nonSolSymbol: e.nonSolSymbol,
            bins: dist.length,
            max: MAX_SINGLE_POSITION_BINS,
          },
        });
        return;
      }

      // CLASSIC SPL two-sided. WIDE (≥26 bins) → the atomic open chunks into [pre, main(addLiquidityByWeight), post] →
      // sequence it (publishSplitOpen) so the deposit isn't dropped. NARROW (≤25) → the atomic 1-tx open (token held now
      // → CU estimation works). v1 addLiquidityByWeight is correct for a CLASSIC two-sided deposit (both legs span active).
      const wide = isWideOpen(dist.length);
      const eventKey = wide
        ? `${leader}:${e.pool}:open-create:${e.position}:${e.signature}`
        : `${leader}:${e.pool}:open:${e.position}:${e.signature}`;
      const commandId = commandIdFor(eventKey);
      const posKp: Keypair = derivePositionKeypair(commandId);
      const built = await buildOpenByWeight(
        conn,
        poolPk,
        ownerPk,
        posKp.publicKey,
        totalX,
        totalY,
        dist,
        depositSlippagePct(leader),
        pair,
      );
      if (wide) {
        const arr = Array.isArray(built) ? built : [built]; // ≥26 bins → [pre, main, post]
        return publishSplitOpen(e, leader, {
          createTx: arr[0] as Transaction,
          depositTx: mergeDeposit(arr.slice(1)),
          posPubkey: posKp.publicKey.toBase58(),
          commandId,
          eventKey,
          lower,
          upper,
          sizeSol,
          recordedSizeSol,
          buyInLamports: ctx.buyInLamports, // #140 — threaded create → deposit → mirror → the BUY ledger row
          buySig,
        });
      }
      const { issuedAtSlot, deadlineSlot } = await slots();
      const sr: Omit<SignRequest, 'issuedAtMs' | 'userId'> = {
        commandId,
        eventKey,
        kind: 'open',
        pool: e.pool,
        positionPubkey: posKp.publicKey.toBase58(),
        owner: ownerPk.toBase58(),
        txBase64: serializeUnsigned(
          withCuLimit(onlyTx(built, 'two-sided open'), TWO_SIDED_CU_LIMIT),
        ),
        sizeSol,
        targetBinRange: { lower, upper },
        issuedAtSlot,
        deadlineSlot,
      };
      if (consumeOpenCancellation(e.position, e.pool, leader)) return; // a close arrived DURING the build → abort before the on-chain publish
      const mirror = openMirror({
        leaderPosition: e.position,
        leaderAddress: leader, // the EVENT's leader (3b fan-out) — drives per-leader stop-closes/exposure/rug config
        ourPosition: sr.positionPubkey,
        pool: e.pool,
        nonSolSymbol: e.nonSolSymbol,
        nonSolMint: tokenMint, // the token we bought = the per-token concurrency-cap key
        sizeSol: recordedSizeSol, // COMBINED deployment (SOL leg + buy spend) → exposure counts both legs (#94 §3)
        lowerBin: lower,
        upperBin: upper,
        openedAt: Date.now(),
      });
      pendingOpens.clear(e.position); // now tracked → lift the duplicate-open reservation for this leader position
      await store.saveOpen(mirror); // persist BEFORE publishing → never an untracked open
      // #140 — attribute the token buy to THIS position now that it is persisted (narrow classic 1-tx open). Placed
      // at the persist point (not at keypair derivation) so a cancelled/aborted open leaves NO dangling buy row.
      await appendBuyRow(sr.positionPubkey, ctx.buyInLamports, buySig);
      await publish(sr, { leader, leaderPosition: e.position, leaderSizeSol: e.depositSol });
      log.info(
        { our: sr.positionPubkey, bins: dist.length },
        '🪙 two-sided OPEN published (after buy landed)',
      );
    });
  }

  /** TX2 of a Token-2022 two-sided open: once the empty position (TX1) has CONFIRMED on-chain, build + publish the
   *  exact-shape deposit via addLiquidityByWeight2 (kind 'add'). Keyed by the create's commandId; a no-op if there's
   *  no pending deposit. The mirror is persisted only after THIS lands (finalizeToken2022Open). */
  async function publishDepositAfterPositionCreated(createCommandId: string): Promise<void> {
    const ctx = pendingToken2022Deposits.get(createCommandId);
    if (!ctx) return;
    await runContinuation(pendingToken2022Deposits, createCommandId, async () => {
      const { e, leader, lower, upper, sizeSol, recordedSizeSol } = ctx;
      if (consumeOpenCancellation(e.position, e.pool, leader)) return; // leader closed before the create landed → don't fund an exited pool (the empty position is orphan-closed)
      // TX2 is the actual token deposit of a Token-2022 open (create→deposit chain); RE-STAMP an already-in-flight
      // bought token so its grace outlasts THIS hop's landing too (finding #96). Gated on `.has`: a one-sided wide
      // open reaches here via the prebuilt path with NO bought token, so its untouched pool mint must not be protected.
      if (e.nonSolMint && inFlightBuyMints.has(e.nonSolMint))
        inFlightBuyMints.set(e.nonSolMint, Date.now());
      // RE-ARM the duplicate-open reservation for THIS hop too (#136 — see publishTwoSidedOpenAfterBuy): the create
      // landed but the deposit is still to build/publish/land, and the route-time reservation may have lapsed. Bound
      // the TTL to this single hop so a leader ADD mid-chain never routes to a SECOND open. Unconditional (unlike the
      // bought-token grace above): a one-sided wide open has no bought token but the same in-flight-open window.
      pendingOpens.reserve(e.position);
      const poolPk = new PublicKey(e.pool);
      const posKp: Keypair = derivePositionKeypair(createCommandId); // SAME position the create made
      let depositTx: Transaction;
      if (ctx.prebuiltDeposit) {
        // SPLIT path (one-sided wide / classic-wide two-sided): the deposit (native addLiquidityOneSide / by-weight +
        // unwrap) was built ATOMICALLY with the create, so its accounts are already correct — publish it as-is.
        depositTx = ctx.prebuiltDeposit;
      } else {
        // REBUILD path (Token-2022 two-sided): addLiquidityByWeight2 fetches the positionV2 account → must build AFTER
        // the create lands. A transient "not yet readable" must not drop the deposit → retry the build.
        const pair = await createDlmmPair(conn, poolPk); // fresh: the position now exists on-chain
        let built: Transaction | Transaction[] | undefined;
        for (let r = 0; r < OPEN_SHAPE_READ_RETRIES && built === undefined; r++) {
          try {
            built = await buildAddByWeight(
              conn,
              poolPk,
              ownerPk,
              posKp.publicKey,
              ctx.totalX as bigint,
              ctx.totalY as bigint,
              ctx.dist as WeightBin[],
              depositSlippagePct(leader),
              pair,
            );
          } catch (err) {
            if (r === OPEN_SHAPE_READ_RETRIES - 1) throw err;
            await sleep(OPEN_SHAPE_READ_DELAY_MS);
          }
        }
        // addLiquidityByWeight2 returns Transaction[]; ≤70 bins = a single chunk. More than one chunk would be a
        // PARTIAL deposit (shape mismatch) → abort (the empty position is then orphan-closed).
        const txs = Array.isArray(built) ? built : [built as Transaction];
        if (txs.length !== 1)
          throw new TerminalContinuationError(
            `token2022 deposit chunked into ${txs.length} txs (range too wide) — aborting, no partial deposit`,
          );
        depositTx = txs[0] as Transaction;
      }
      if (consumeOpenCancellation(e.position, e.pool, leader)) return; // a close arrived DURING the deposit build → abort before the on-chain deposit
      const depositEventKey = `${leader}:${e.pool}:open-deposit:${e.position}:${e.signature}`;
      const depositCommandId = commandIdFor(depositEventKey);
      const { issuedAtSlot, deadlineSlot } = await slots();
      pendingToken2022Mirrors.set(depositCommandId, {
        leaderPosition: e.position,
        leader,
        ourPosition: posKp.publicKey.toBase58(),
        pool: e.pool,
        nonSolSymbol: e.nonSolSymbol,
        nonSolMint: e.nonSolMint ?? '', // per-token concurrency-cap key
        sizeSol,
        recordedSizeSol,
        lower,
        upper,
        leaderSizeSol: e.depositSol,
        buyInLamports: ctx.buyInLamports, // #140 — carried to finalizeToken2022Open for the BUY ledger row
        buySig: ctx.buySig,
      });
      await publish(
        {
          commandId: depositCommandId,
          eventKey: depositEventKey,
          kind: 'add',
          pool: e.pool,
          positionPubkey: posKp.publicKey.toBase58(),
          owner: ownerPk.toBase58(),
          txBase64: serializeUnsigned(withCuLimit(depositTx, TWO_SIDED_CU_LIMIT)),
          sizeSol,
          targetBinRange: { lower, upper },
          issuedAtSlot,
          deadlineSlot,
        },
        { leader, leaderPosition: e.position, leaderSizeSol: e.depositSol },
      );
      log.info(
        {
          our: posKp.publicKey.toBase58(),
          prebuilt: ctx.prebuiltDeposit !== undefined,
          lower,
          upper,
        },
        '🔨 open DEPOSIT published (position created → deposit)',
      );
    });
  }

  /** Finalize a Token-2022 two-sided open once its deposit (TX2) has landed: NOW persist the mirror (the position is
   *  funded + tracked) and lift the orphan-close grace. */
  async function finalizeToken2022Open(depositCommandId: string): Promise<void> {
    const pend = pendingToken2022Mirrors.get(depositCommandId);
    if (!pend) return;
    await runContinuation(pendingToken2022Mirrors, depositCommandId, async () => {
      const leader = pend.leader; // the ORIGINATING event's leader, threaded create → deposit → mirror (3b)
      if (consumeOpenCancellation(pend.leaderPosition, pend.pool, leader)) {
        // Leader closed while the deposit was in flight. The deposit already landed (this is its confirm) → capital is
        // in the pool, but we do NOT register the mirror: lift the orphan-close grace so the reconcile/orphan sweep
        // closes the now-funded, untracked position and pulls the capital back out.
        buildingToken2022Positions.delete(pend.ourPosition);
        return;
      }
      const mirror = openMirror({
        leaderPosition: pend.leaderPosition,
        leaderAddress: leader, // the EVENT's leader (3b fan-out) — drives per-leader stop-closes/exposure/rug config
        ourPosition: pend.ourPosition,
        pool: pend.pool,
        nonSolSymbol: pend.nonSolSymbol,
        nonSolMint: pend.nonSolMint, // per-token concurrency-cap key
        sizeSol: pend.recordedSizeSol, // COMBINED deployment (SOL leg + buy spend) → exposure counts both legs (#94 §3)
        lowerBin: pend.lower,
        upperBin: pend.upper,
        openedAt: Date.now(),
      });
      pendingOpens.clear(pend.leaderPosition); // now tracked → lift the duplicate-open reservation for this leader position
      await store.saveOpen(mirror); // tracked only NOW — a funded, deposited position
      // #140 — attribute the token buy to THIS position now that it is persisted (Token-2022 + classic-wide open).
      await appendBuyRow(pend.ourPosition, pend.buyInLamports, pend.buySig);
      buildingToken2022Positions.delete(pend.ourPosition);
      // Token-2022 open is COMPLETE (deposit landed → mirror persisted) → emit the FEED `lifecycle.open_confirmed`,
      // the SAME confirm a classic open fires in onOpenConfirmed (the classic branch's ev:executed 'open' carries the
      // empty-position create, never the funded mirror, so it is excluded there). Observability-only.
      events.opened({
        stage: 'open',
        outcome: 'confirmed',
        leader,
        pool: mirror.pool,
        leaderPosition: mirror.leaderPosition,
        ourPosition: mirror.ourPosition,
        ourSizeSol: mirror.sizeSol,
        eventKey: openConfirmedKey(leader, mirror.pool, mirror.ourPosition),
        adminDetail: {
          nonSolSymbol: mirror.nonSolSymbol,
          openCount: registry.openPositions().length,
        },
      });
      log.info(
        { our: pend.ourPosition },
        '🪙 two-sided Token-2022 OPEN complete (deposit landed → mirror persisted)',
      );
    });
  }

  /** Build + publish a two-sided RESHAPE ADD once its token BUY (ExactIn) has landed — deposit the ACTUAL bought
   *  amount (variable). Keyed by the reshape buy's commandId; a no-op if there's no pending reshape add. */
  async function publishReshapeAddAfterBuy(buyCommandId: string, buySig?: string): Promise<void> {
    const ctx = pendingReshapeAdds.get(buyCommandId);
    if (!ctx) return;
    await runContinuation(pendingReshapeAdds, buyCommandId, async () => {
      const {
        dist,
        addLamports,
        solSide,
        tokenMint,
        lower,
        upper,
        totalAddSol,
        ourPosition,
        pool,
        leaderPosition,
        leader,
        signature,
      } = ctx;
      // A reshape ADD is on an EXISTING (registered) mirror — NOT an open, so a leader close finds the mirror and runs
      // the normal close path. But that close may land WHILE this add's buy was in flight: don't ADD liquidity to a
      // position the leader closed (registry.close flips its status). The bought token is recovered by the sweep.
      if (!registry.hasOpen(leaderPosition)) {
        events.emit('reshape.noop', {
          stage: 'reshape',
          outcome: 'noop',
          leader,
          pool,
          leaderPosition,
          ourPosition,
          // userId folded: shared wallet until Inc.4 — see the skip-key rationale above.
          eventKey: `${userId}:${leader}:${pool}:reshape-add-cancelled:${signature}`,
          adminDetail: { phase: 'mirror_closed_before_reshape_add' },
        });
        return;
      }
      // The buy landed and its bought token is on the wallet; RE-STAMP the in-flight grace so it covers THIS reshape
      // add's deposit landing (finding #96 — the buy-publish stamp can expire before a congested add lands → the
      // sweep/close-sell would sell the leg mid-add). A stranded token (settle-skip below) is recovered by the sweep.
      inFlightBuyMints.set(tokenMint, Date.now());
      const poolPk = new PublicKey(pool);
      const pair = await createDlmmPair(conn, poolPk);
      // #33 — the ExactIn output is variable, so deposit the REAL balance — but guard the read against a read-after-write
      // lag: retry until the BOUGHT delta clears the quote-derived floor. If it never settles, SKIP the token add (the
      // SOL-leg removes already published stand; the reconcile self-corrects on the next event) — never a short leg.
      const settled = await settledTwoSidedDeposit(
        tokenMint,
        ctx.preBuyTokenRaw,
        ctx.expectedTokenRaw,
        ctx.buySlippageBps,
      );
      if (!settled.ready) {
        events.emit('reshape.token_unbuyable', {
          stage: 'reshape',
          outcome: 'skipped',
          reason: 'reshape_token_unbuyable',
          leader,
          pool,
          leaderPosition,
          ourPosition,
          eventKey: `${userId}:${leader}:${pool}:reshape-add-unsettled:${signature}`,
          adminDetail: {
            mint: tokenMint,
            err: 'token balance never settled to the buy floor (read-after-write) — both-or-nothing skip',
          },
        });
        return;
      }
      const depositToken = depositableToken(settled.depositRaw); // reserve a hair for per-bin bps rounding (else TransferChecked → insufficient funds)
      // TWO-SIDED add. WIDE (≥26 bins) → addLiquidityByWeight2 (v1 would chunk at 26 → onlyTx throw → the wide grow would
      // fail); fits ≤70 bins in one tx, works classic + Token-2022. NARROW (≤25) → keep the PROVEN buildAddByWeight (v1
      // classic / add2 Token-2022) untouched — exact per-bin placement (changing it perturbs precise spike/refill copies).
      // SOL/token → pool X/Y via the SHARED mapping (ULTRACODE #16: this path had the operands inverted vs the
      // open path — SOL landed on the token side — so a two-sided grow failed or deposited swapped legs).
      const { totalX, totalY } = twoSidedLegTotals(solSide, addLamports, depositToken);
      const built =
        dist.length >= ATOMIC_BY_WEIGHT_BIN_LIMIT
          ? await buildAddByWeight2(
              conn,
              poolPk,
              ownerPk,
              new PublicKey(ourPosition),
              totalX,
              totalY,
              dist,
              depositSlippagePct(leader),
              pair,
            )
          : await buildAddByWeight(
              conn,
              poolPk,
              ownerPk,
              new PublicKey(ourPosition),
              totalX,
              totalY,
              dist,
              depositSlippagePct(leader),
              pair,
            );
      const { issuedAtSlot, deadlineSlot } = await slots();
      const addKey = `${leader}:${pool}:reshape-add:${signature}`;
      await publish(
        {
          commandId: commandIdFor(addKey),
          eventKey: addKey,
          kind: 'add',
          pool,
          positionPubkey: ourPosition,
          owner: ownerPk.toBase58(),
          txBase64: serializeUnsigned(
            withCuLimit(onlyTx(built, 'reshape add (two-sided)'), TWO_SIDED_CU_LIMIT),
          ),
          sizeSol: totalAddSol,
          targetBinRange: { lower, upper },
          issuedAtSlot,
          deadlineSlot,
        },
        { stage: 'reshape', leader, leaderPosition },
      );
      // #140 — attribute the reshape token buy to the EXISTING position this add grows (the add published above).
      await appendBuyRow(ourPosition, ctx.buyInLamports, buySig);
      // #145 — the DEFERRED two-sided grow is REAL now (the add published above): record the exposure target
      // handleResync stashed. Until this point the tracked size stayed at the pre-grow value, so the caps never
      // counted a grow whose add had not landed (a Jupiter blip / unsettled balance returns above, before the
      // publish → the size is never inflated for an add that never happened).
      if (ctx.deferredSizeSol !== undefined) {
        registry.adjustSize(leaderPosition, ctx.deferredSizeSol);
        await store.updateSize(leaderPosition, ctx.deferredSizeSol);
      }
      log.info(
        { our: ourPosition, bins: dist.length },
        '🪙 two-sided reshape ADD published (after buy landed)',
      );
    });
  }

  // A cancelled multi-tx open surfaces as the leader-closed FAILSAFE (SAME semantics as the reClose alias
  // `leader_closed` → `failsafe.activated`): the leader closed and we protected capital by NOT completing the open.
  // Feed-visible + deduped per leader position (distinct cancels stay distinct; a cross-path double-emit collapses).
  // userId folded (shared wallet until Inc.4 — see the skip-key rationale above). The BOOT leader prefixes it:
  // cancels can fire from brain-main's reconcile backstop, which has no event context (steps 6-7 refine this) —
  // correlation-only, same value while the hub is seeded with [cfg.leader].
  const openCancelledKey = (pool: string, leaderPosition: string): string =>
    `${userId}:${bootLeader}:${pool}:open-cancelled:${leaderPosition}`;
  const emitOpenCancelled = (
    leaderPosition: string,
    pool: string,
    dropped: number,
    leader: string,
  ): void => {
    events.emit('failsafe.activated', {
      stage: 'open',
      outcome: 'skipped',
      reason: 'leader_closed',
      leader,
      pool,
      leaderPosition,
      eventKey: openCancelledKey(pool, leaderPosition),
      adminDetail: { phase: 'multi_tx_open_cancelled', dropped },
    });
  };
  const pendingOpenMapsView = (): PendingOpenMaps => ({
    twoSidedOpens: pendingTwoSidedOpens,
    token2022Deposits: pendingToken2022Deposits,
    token2022Mirrors: pendingToken2022Mirrors,
    reshapeAdds: pendingReshapeAdds,
  });
  // Does this leader position have any in-flight multi-tx open stash? (Belt-and-suspenders behind pendingOpens: a
  // stash can outlive the reservation's TTL if a buy/create never lands.)
  const hasPendingOpenStash = (leaderPosition: string): boolean =>
    stashCount(pendingStashesFor(leaderPosition, pendingOpenMapsView())) > 0;
  // The originating event's leader carried on ANY in-flight open stash for this leader position (each stash threads it
  // from the event) — labels the open-cancelled failsafe with the REAL leader instead of the bootLeader fallback.
  const stashLeaderFor = (keys: PendingStashKeys): string | null => {
    for (const k of keys.twoSidedOpens) {
      const v = pendingTwoSidedOpens.get(k);
      if (v) return v.leader;
    }
    for (const k of keys.token2022Deposits) {
      const v = pendingToken2022Deposits.get(k);
      if (v) return v.leader;
    }
    for (const k of keys.token2022Mirrors) {
      const v = pendingToken2022Mirrors.get(k);
      if (v) return v.leader;
    }
    for (const k of keys.reshapeAdds) {
      const v = pendingReshapeAdds.get(k);
      if (v) return v.leader;
    }
    return null;
  };

  // Cancel an IN-FLIGHT multi-tx open because the leader closed before it completed. Drops every pending-open stash
  // for this leader position across the 4 continuation maps, clears the duplicate-open reservation, and marks it in
  // `cancelledOpens` so a continuation ALREADY running (cross-path race: it resolved its stash before this ran)
  // aborts before publishing on-chain (see consumeOpenCancellation). There is nothing on-chain to close (the open
  // never landed); any token already bought is left to the periodic sweep (residual → sold back to SOL).
  function cancelPendingOpen(leaderPosition: string, pool: string): void {
    const keys: PendingStashKeys = pendingStashesFor(leaderPosition, pendingOpenMapsView());
    // Resolve the REAL leader from any in-flight stash BEFORE deleting; fall back to bootLeader only when nothing is
    // stashed (then dropped==0 below and we don't emit anyway).
    const leader = stashLeaderFor(keys) ?? bootLeader;
    cancelledOpens.reserve(leaderPosition); // ALWAYS mark (also covers the race where a continuation already deleted its stash)
    for (const k of keys.twoSidedOpens) pendingTwoSidedOpens.delete(k);
    for (const k of keys.token2022Deposits) pendingToken2022Deposits.delete(k);
    for (const k of keys.token2022Mirrors) pendingToken2022Mirrors.delete(k);
    for (const k of keys.reshapeAdds) pendingReshapeAdds.delete(k);
    pendingOpens.clear(leaderPosition);
    // Emit ONLY when a real in-flight open was dropped. A stashCount of 0 with a reservation means either (a) a
    // SKIPPED open's leaked reservation (nothing was in flight → a "leader closed" alert would be misleading) or
    // (b) the RACE where a continuation already grabbed+deleted its stash — in that case the continuation's
    // `consumeOpenCancellation` emits instead (it always emits), so we still get exactly one row.
    const dropped = stashCount(keys);
    if (dropped > 0) emitOpenCancelled(leaderPosition, pool, dropped, leader);
  }

  // Cross-path guard called INSIDE each multi-tx open continuation: if the leader closed (cancelPendingOpen marked
  // this leader position) WHILE the continuation was in flight, clear the reservation, forget the marker, emit, and
  // tell the caller to abort BEFORE publishing on-chain. Returns true iff the open was cancelled.
  function consumeOpenCancellation(leaderPosition: string, pool: string, leader: string): boolean {
    if (!cancelledOpens.isPending(leaderPosition)) return false;
    cancelledOpens.clear(leaderPosition);
    pendingOpens.clear(leaderPosition);
    emitOpenCancelled(leaderPosition, pool, 0, leader);
    return true;
  }

  async function handleClose(e: DetectedEvent): Promise<void> {
    const m = registry.get(e.position);
    if (!m) {
      // The mirror isn't registered → either an untracked position (ignore) OR a MULTI-TX open still IN FLIGHT
      // (buy→open / create→deposit / wide split) whose `registry.open` runs in a later ev:executed continuation. If
      // the leader CLOSED during that gap the in-flight open must be CANCELLED — else the continuation deploys
      // capital into the pool the leader just EXITED (a fast scalp / rug exit). Nothing is on-chain to close (the
      // open never landed).
      if (pendingOpens.isPending(e.position) || hasPendingOpenStash(e.position))
        cancelPendingOpen(e.position, e.pool);
      return;
    }
    const leader = leaderOf(m); // the MIRROR's leader (3b): a close routes by ownership, not by config
    const eventKey = `${leader}:${m.pool}:close:${e.position}:${e.signature}`;
    const built = await buildCloseTx(
      conn,
      new PublicKey(m.pool),
      ownerPk,
      new PublicKey(m.ourPosition),
      m.lowerBin,
      m.upperBin,
    );
    const { issuedAtSlot, deadlineSlot } = await slots();
    registry.close(e.position); // in-memory fast path (caps/dedup); the DB is marked closed by the reconcile once confirmed on-chain
    inFlightReshapeTargets.delete(e.position); // #121 — the position is closing; drop any in-flight reshape target
    await publish(
      {
        commandId: commandIdFor(eventKey),
        eventKey,
        kind: 'close',
        pool: m.pool,
        positionPubkey: m.ourPosition,
        owner: ownerPk.toBase58(),
        txBase64: serializeUnsigned(firstTx(built)),
        sizeSol: m.sizeSol,
        targetBinRange: { lower: m.lowerBin, upper: m.upperBin },
        issuedAtSlot,
        deadlineSlot,
      },
      { leader },
    );
    recentlyPublishedClose.set(m.ourPosition, Date.now()); // grace: don't let the reconcile re-close while this is landing
  }

  async function handleClaim(e: DetectedEvent): Promise<void> {
    const m = registry.get(e.position);
    if (!m) return;
    const leader = leaderOf(m); // the MIRROR's leader (3b)
    const eventKey = `${leader}:${m.pool}:claim:${e.position}:${e.signature}`;
    const built = await buildClaimTx(conn, new PublicKey(m.pool), ownerPk, m.ourPosition);
    const { issuedAtSlot, deadlineSlot } = await slots();
    await publish(
      {
        commandId: commandIdFor(eventKey),
        eventKey,
        kind: 'claim',
        pool: m.pool,
        positionPubkey: m.ourPosition,
        owner: ownerPk.toBase58(),
        txBase64: serializeUnsigned(firstTx(built)),
        sizeSol: m.sizeSol,
        targetBinRange: { lower: m.lowerBin, upper: m.upperBin },
        issuedAtSlot,
        deadlineSlot,
      },
      { leader },
    );
  }

  // The leader changed a position (add or partial remove) → RE-SYNC ours to the TARGET = copyRatio × leader's
  // CURRENT on-chain size (capped). Reads BOTH sizes on-chain so drift self-corrects and a missed event catches
  // up on the next one. A deadband (MIN_ADD_SOL) avoids churning on price-driven SOL-leg wiggle.
  async function handleResync(e: DetectedEvent): Promise<void> {
    const m = registry.get(e.position);
    if (!m) return;
    const leader = leaderOf(m); // the MIRROR's leader (3b): a resync follows the position we own
    const leaderPk = new PublicKey(leader);
    const ec = effFor(leader);
    const copyRatio = (ec.sizing.tradeRatioPct ?? FIXED_SIZE_MIRROR_RATIO_PCT) / 100; // re-sync target = ratio × leader current size; fixed-size (null) ⇒ full nominal mirror BOUNDED to maxTradeSizeSol by planTwoSidedReshape's cap → a leader de-risk IS mirrored (was `?? 0`: a silent no-op — #143)
    const poolPk = new PublicKey(m.pool);
    const meta = await poolReader.loadPoolMeta(m.pool);
    if (!meta?.solSide) {
      events.emit('eligibility.non_sol_paired', {
        stage: 'reshape',
        outcome: 'skipped',
        reason: 'non_sol_pool',
        leader,
        pool: m.pool,
        leaderPosition: e.position,
        ourPosition: m.ourPosition,
        eventKey: reshapeSkipKey(e, m),
        adminDetail: { nonSolSymbol: m.nonSolSymbol },
      });
      return;
    }
    const solSide = meta.solSide;
    const pair = await createDlmmPair(conn, poolPk);
    // Stable read: a leader ADD/REMOVE we just saw may not be indexed yet → a premature read shows no change → we'd
    // skip the reshape (the copy wouldn't grow/shrink). readStableShape waits for the leader's liquidity to settle.
    // SHAPE-EXACT re-sync, aligned by offset-from-LOWER. A leader ADD/REMOVE seen via WS may not be indexed yet
    // (read-after-write lag) → a premature read shows no deficit → the copy wouldn't grow/shrink. When the event
    // carries a real change, RETRY the read+compute until a deficit appears (or retries exhausted = a genuine noop).
    const solOf = (b: { x: bigint; y: bigint }) => lamportsToSol(solSide === 'Y' ? b.y : b.x);
    const tokenOf = (b: { x: bigint; y: bigint }) => Number(solSide === 'Y' ? b.x : b.y); // RAW token units
    const changeExpected =
      e.depositSol > RESYNC_MIN_CHANGE_SOL || e.withdrawSol > RESYNC_MIN_CHANGE_SOL;
    let ourShape: Awaited<ReturnType<typeof readLeaderPositionShape>> = null;
    let plan: ReturnType<typeof planTwoSidedReshape> | null = null;
    let leaderBins: Array<{ offset: number; sol: number }> = []; // hoisted: also used post-loop for the new-size calc
    let leaderTokenBins: Array<{ offset: number; sol: number }> = []; // hoisted: also used post-loop for the #121 target
    let leaderTokenRawTotal = 0; // hoisted: leader's full token-leg raw units → valued in SOL for the new-size calc
    for (let r = 0; r <= (changeExpected ? RESYNC_READ_RETRIES : 0); r++) {
      // #146 — PREEMPT: a leader CLOSE for this position has been observed (it is queued behind us on the position's
      // serial chain). ABORT the resync NOW — before the sleep and the ~seconds-long readStableShape — so the close
      // runs next instead of waiting out the whole retry budget (~tens of seconds of extra rug exposure). Bail
      // cleanly: no further read, no publish, no size write. The on-chain reconcile remains the completeness backstop.
      if (pendingCloses.has(e.position)) {
        log.info({ position: e.position }, '🛑 resync preempted by a pending leader close');
        return;
      }
      if (r > 0) await sleep(OPEN_SHAPE_READ_DELAY_MS);
      const leaderShape = await readStableShape(poolPk, leaderPk, e.position, pair);
      if (!leaderShape) return; // leader gone → the reconcile closes ours
      const os = await readLeaderPositionShape(conn, poolPk, ownerPk, m.ourPosition, pair);
      if (!os) {
        events.emit('detect.not_on_chain_yet', {
          stage: 'reshape',
          outcome: 'skipped',
          reason: 'not_on_chain_yet',
          leader,
          pool: m.pool,
          leaderPosition: e.position,
          ourPosition: m.ourPosition,
          eventKey: reshapeSkipKey(e, m),
        });
        return;
      }
      ourShape = os;
      leaderBins = leaderShape.perBin.map((b) => ({
        offset: b.binId - leaderShape.lowerBinId,
        sol: solOf(b),
      }));
      const ourBins = os.perBin.map((b) => ({ offset: b.binId - os.lowerBinId, sol: solOf(b) }));
      leaderTokenBins = leaderShape.perBin.map((b) => ({
        offset: b.binId - leaderShape.lowerBinId,
        sol: tokenOf(b),
      }));
      leaderTokenRawTotal = leaderTokenBins.reduce((s, b) => s + b.sol, 0); // full token leg (raw) for the size calc
      const ourTokenBins = os.perBin.map((b) => ({
        offset: b.binId - os.lowerBinId,
        sol: tokenOf(b),
      }));
      // #121 — net against the IN-FLIGHT-adjusted self-state, not the (possibly stale) on-chain read: while the prior
      // reshape's target for this position is still fresh, our position is being driven toward it (its removes/adds
      // may not have landed, and a remove never confirms back to the brain). Using the on-chain read here would let a
      // rapid remove→add (or add→remove) mis-net into a persistent ~2×/~0.5× exposure. The token override is applied
      // only in two-sided mode (a SOL-only copy holds no managed token leg, so its on-chain token read stays truth).
      const inflight = inFlightReshapeTargets.get(e.position);
      const inflightFresh =
        inflight !== undefined && Date.now() - inflight.atMs < RESHAPE_INFLIGHT_GRACE_MS;
      const ourBinsEff = inflightFresh
        ? [...inflight.sol.entries()].map(([offset, sol]) => ({ offset, sol }))
        : ourBins;
      const ourTokenBinsEff =
        inflightFresh && ec.twoSidedMode === 'on'
          ? [...inflight.token.entries()].map(([offset, sol]) => ({ offset, sol }))
          : ourTokenBins;
      // SOL-leg ops (removes are proportional → cover both legs); token-leg ADD deficit handled two-sided when enabled.
      plan = planTwoSidedReshape(
        leaderBins,
        ourBinsEff,
        leaderTokenBins,
        ourTokenBinsEff,
        copyRatio,
        ec.sizing.maxTradeSizeSol,
        ec.execution.reshapeBinDeadbandSol,
        ec.execution.reshapeBinDeadbandToken,
      );
      if (plan.ops.length > 0 || (ec.twoSidedMode === 'on' && plan.tokenAddOps.length > 0)) break; // deficit found → proceed
      // noop this read — if a change was expected, the leader event likely isn't indexed yet → retry
    }
    if (!ourShape || !plan) return;
    // #146 — a close may have arrived DURING the read that just found the deficit (the loop-top guard only covers the
    // retry gap). Re-check before any build/publish/size write: never deploy a reshape into — nor record a size for —
    // a position the leader is closing. The queued close proceeds next; the reconcile backstops.
    if (pendingCloses.has(e.position)) {
      log.info({ position: e.position }, '🛑 resync preempted by a pending leader close');
      return;
    }
    const { ops, tokenAddOps } = plan;
    // #48: gate the two-sided-BUY branch on the FILTERED token deficit (in OUR fixed range, positive raw), NOT the raw
    // op count. A reshape whose token adds all fall outside our range or round to 0 has NO token leg to grow → it must
    // fall through to the one-sided SOL add path below so the SOL leg STILL grows this cycle (else it would enter the
    // buy branch, price a 0-token leg, throw, and drop the SOL-leg adds — leaving the copy undersized its whole life).
    const tokenMint = solSide === 'Y' ? meta.mintX : meta.mintY;
    const tokenAdds =
      ec.twoSidedMode === 'on'
        ? inRangeTokenAdds(tokenAddOps, ourShape.lowerBinId, ourShape.upperBinId)
        : [];
    const twoSidedAdd = tokenAdds.length > 0;
    if (ops.length === 0 && !twoSidedAdd) {
      events.emit('reshape.noop', {
        stage: 'reshape',
        outcome: 'noop',
        leader,
        pool: m.pool,
        leaderPosition: e.position,
        ourPosition: m.ourPosition,
        eventKey: reshapeSkipKey(e, m),
      });
      return;
    }

    const calls = reshapeToCalls(ops, ourShape.lowerBinId);
    // Our position's bin range is fixed at open; can't add outside it (leader extending its range = v1 limit).
    const adds = calls.adds.filter(
      (a) => a.binId >= ourShape.lowerBinId && a.binId <= ourShape.upperBinId,
    );
    if (adds.length < calls.adds.length) {
      events.emit('reshape.partial_range', {
        stage: 'reshape',
        outcome: 'skipped',
        reason: 'partial_range',
        leader,
        pool: m.pool,
        leaderPosition: e.position,
        ourPosition: m.ourPosition,
        eventKey: reshapeSkipKey(e, m),
        adminDetail: { dropped: calls.adds.length - adds.length },
      });
    }

    const { issuedAtSlot, deadlineSlot } = await slots();
    // Removes first (free SOL), then ONE by-weight add. Each is its own idempotent cmd:sign.
    let rm = 0;
    for (const r of calls.removes) {
      const built = await buildRemovePartial(
        conn,
        poolPk,
        ownerPk,
        new PublicKey(m.ourPosition),
        r.fromBin,
        r.toBin,
        r.bps,
      );
      const eventKey = `${leader}:${m.pool}:reshape-rm${rm}:${e.position}:${e.signature}`;
      await publish(
        {
          commandId: commandIdFor(eventKey),
          eventKey,
          kind: 'remove',
          pool: m.pool,
          positionPubkey: m.ourPosition,
          owner: ownerPk.toBase58(),
          txBase64: serializeUnsigned(firstTx(built)),
          sizeSol: 0,
          targetBinRange: { lower: r.fromBin, upper: r.toBin },
          issuedAtSlot,
          deadlineSlot,
        },
        { leader },
      );
      rm++;
    }
    // Exposure cap re-check on a GROW (idx15): checkCaps runs only at OPEN, but a reshape/resync ADD grows the position
    // → post-open growth could breach maxTotalExposureSol / the per-leader ceiling. Gate the grow on the SAME caps
    // function, but ONLY the exposure ceilings apply to growing an already-open position — the open-count / per-token /
    // per-window / kill-switch ENTRY gates are neutralized (a grow is not a new entry). Basis = the SOL-leg growth
    // target (== the one-sided recordedSize; a two-sided grow's extra token-leg value is separately bounded by
    // maxTradeSizeSol per position and re-checked at the next event/reconcile). A shrink never breaches an exposure cap.
    const leaderSolSizeSol = leaderBins.reduce((s, b) => s + b.sol, 0); // also the recorded-size basis below
    const growTargetSol = Math.min(copyRatio * leaderSolSizeSol, ec.sizing.maxTradeSizeSol);
    let growBlocked = false;
    if (growTargetSol > m.sizeSol) {
      const growCap = checkCaps(
        {
          ...ec.caps,
          killSwitchGlobal: false,
          killSwitchLeader: false,
          maxOpenPositions: null,
          maxConcurrentPerToken: null,
          maxOpensPerWindow: null,
        },
        capsState(leader, tokenMint), // live totals already include m.sizeSol
        growTargetSol - m.sizeSol, // the exposure DELTA this grow adds
        Date.now(),
        ec.leaderMaxTotalExposureSol,
      );
      if (growCap.action === 'block') {
        // Skip the grow add (the removes above still stand; recordedSize clamps to the current size below → no
        // exposure inflation). Consistent with the open path's cap block and the token_unbuyable grow skip.
        growBlocked = true;
        emitFor(growCap.reason, {
          stage: 'reshape',
          outcome: 'blocked',
          reason: growCap.reason,
          leader,
          pool: m.pool,
          leaderPosition: e.position,
          ourPosition: m.ourPosition,
          eventKey: reshapeSkipKey(e, m),
          leaderSizeSol: leaderSolSizeSol,
          ourSizeSol: growTargetSol,
          adminDetail: { mint: tokenMint, nonSolSymbol: m.nonSolSymbol, currentSizeSol: m.sizeSol },
        });
      }
    }
    // #145 — track what the GROW side actually PUBLISHES so the recorded size never runs ahead of on-chain reality.
    // A one-sided add publishes synchronously below (`growPublished`); a two-sided add is DEFERRED to the buy's
    // confirm (`deferredGrowKey`, applied in publishReshapeAddAfterBuy). A skipped/unquotable grow sets NEITHER, so
    // the size block clamps to the current exposure (no inflation). Removes always publish above → shrinks still count.
    let growPublished = false;
    let deferredGrowKey: string | null = null;
    if (!growBlocked && twoSidedAdd) {
      // TWO-SIDED reshape add: a deficit on the SOL leg AND the token leg → BUY the token deficit via ExactIn (ExactOut
      // has no Token-2022 route), then ADD both legs once the buy lands — the bought amount is variable, so we
      // build-after-buy and deposit the ACTUAL balance (exactly like the two-sided OPEN). `tokenMint`/`tokenAdds` were
      // computed above the two-sided gate (#48) — the filtered token deficit is what decided we're on this branch.
      const solShaped =
        adds.length > 0
          ? reanchorShape(
              0,
              0,
              adds.map((a) => ({
                binId: a.binId,
                amount: BigInt(Math.round(a.addSol * LAMPORTS_PER_SOL)),
              })),
            )
          : null;
      const tokShaped =
        tokenAdds.length > 0
          ? reanchorShape(
              0,
              0,
              tokenAdds.map((a) => ({ binId: a.binId, amount: BigInt(a.raw) })),
            )
          : null;
      const byBin = new Map<number, WeightBin>();
      if (solShaped)
        for (const w of solShaped.weights)
          byBin.set(w.binId, {
            binId: w.binId,
            xBps: solSide === 'X' ? w.bps : 0,
            yBps: solSide === 'Y' ? w.bps : 0,
          });
      if (tokShaped)
        for (const w of tokShaped.weights) {
          const cur = byBin.get(w.binId) ?? { binId: w.binId, xBps: 0, yBps: 0 };
          if (solSide === 'X') cur.yBps = w.bps;
          else cur.xBps = w.bps;
          byBin.set(w.binId, cur);
        }
      // The SDK by-weight requires CONTIGUOUS binIds (a deadband-dropped per-bin add would leave a gap → it
      // errors "Discontinuous Bin ID"). Fill the [min,max] span with 0/0 entries so the listed bins are contiguous.
      const dist: WeightBin[] = fillContiguousWeights([...byBin.values()]);
      const totalAddSol = adds.reduce((s, a) => s + a.addSol, 0);
      const addLamports = BigInt(Math.round(totalAddSol * LAMPORTS_PER_SOL));
      const totalTokenRaw = BigInt(tokenAdds.reduce((s, a) => s + a.raw, 0));
      // Price the token target (sell direction, fully routed) → spend that SOL via ExactIn (output variable → the add
      // is built after the buy lands, reading the real balance). Skip cleanly if the token can't be priced/bought.
      try {
        const priceQuote = await getJupiterQuote(
          jupiterBaseUrl,
          tokenMint,
          totalTokenRaw,
          ec.execution.slippageBps,
        );
        const solToSpend = BigInt(priceQuote.outAmount);
        if (!(solToSpend > 0n)) throw new Error('token leg priced at 0 SOL');
        const buyQuote = await getJupiterBuyQuoteExactIn(
          jupiterBaseUrl,
          tokenMint,
          solToSpend,
          ec.execution.slippageBps,
        );
        const buyTxB64 = await buildJupiterSwapTx(jupiterBaseUrl, buyQuote, ownerPk.toBase58());
        const buyKey = `${leader}:${m.pool}:reshape-buy:${e.position}:${e.signature}`;
        const buyCommandId = commandIdFor(buyKey);
        // #33 — pre-buy snapshot so the deferred add deposits only the BOUGHT delta (never a pre-existing residual).
        const preBuyTokenRaw = await readOwnerTokenBalance(conn, ownerPk, new PublicKey(tokenMint));
        pendingReshapeAdds.set(buyCommandId, {
          dist,
          addLamports,
          solSide,
          tokenMint,
          lower: dist[0]!.binId,
          upper: dist.at(-1)!.binId,
          totalAddSol,
          ourPosition: m.ourPosition,
          pool: m.pool,
          leaderPosition: m.leaderPosition,
          leader,
          signature: e.signature,
          buyInLamports: Number(buyQuote.inAmount), // #140 — the SOL spent on the reshape token leg → the BUY ledger row
          preBuyTokenRaw,
          expectedTokenRaw: BigInt(buyQuote.outAmount),
          buySlippageBps: ec.execution.slippageBps,
        });
        inFlightBuyMints.set(tokenMint, Date.now()); // protect the bought token from the sweep until the reshape add deposits it
        await publish(
          {
            commandId: buyCommandId,
            eventKey: buyKey,
            kind: 'buy',
            pool: m.pool,
            positionPubkey: ownerPk.toBase58(),
            owner: ownerPk.toBase58(),
            txBase64: buyTxB64,
            sizeSol: Number(buyQuote.inAmount) / LAMPORTS_PER_SOL,
            targetBinRange: { lower: 0, upper: 0 },
            issuedAtSlot,
            deadlineSlot,
            buy: {
              outputMint: tokenMint,
              exactOutAmountRaw: buyQuote.outAmount,
              maxInLamports: buyQuote.inAmount,
            },
          },
          { stage: 'reshape', leader, leaderPosition: m.leaderPosition },
        );
        log.info(
          { our: m.ourPosition, tokenMint, bins: dist.length },
          '🪙 two-sided reshape BUY (ExactIn) published — the add follows once the buy lands',
        );
        deferredGrowKey = buyCommandId; // #145 — grow recorded ONLY when the deferred add publishes (see the size block)
      } catch (err) {
        // SAFE: can't acquire the token deficit → the SOL-leg removes already published stand; skip the token add (no
        // partial two-sided add). The reconcile self-corrects on the next leader event.
        events.emit('reshape.token_unbuyable', {
          stage: 'reshape',
          outcome: 'skipped',
          reason: 'reshape_token_unbuyable',
          leader,
          pool: m.pool,
          leaderPosition: e.position,
          ourPosition: m.ourPosition,
          eventKey: reshapeSkipKey(e, m),
          adminDetail: {
            mint: tokenMint,
            nonSolSymbol: m.nonSolSymbol,
            err: (err as Error).message,
          },
        });
      }
    } else if (!growBlocked && adds.length > 0) {
      // A reshape ADD spanning ≥26 bins would chunk the SDK by-weight deposit into [pre, main, post] (deposit not the
      // first tx) → can't be one published tx. Split the deficit into ≤25-bin-span CHUNKS, each a self-contained
      // single-tx addLiquidityOneSide (wrap+deposit+unwrap), published INDEPENDENTLY (idempotent commandId, no
      // cross-tx dependency → landed in parallel). The copy grows by the FULL deficit. A narrow add = one chunk.
      const chunks = chunkBySpan(adds, ATOMIC_BY_WEIGHT_BIN_LIMIT - 1); // each chunk's bin span ≤ 25 → one tx
      let ci = 0;
      for (const chunk of chunks) {
        const chunkSol = chunk.reduce((s, a) => s + a.addSol, 0);
        const shaped = reanchorShape(
          0,
          0,
          chunk.map((a) => ({
            binId: a.binId,
            amount: BigInt(Math.round(a.addSol * LAMPORTS_PER_SOL)),
          })),
        ); // delta 0: keep binIds, amounts → BPS (normalized within the chunk)
        // CONTIGUOUS span: a selective/deadband add (or a re-anchor that drops a tiny interior bin) leaves binId gaps;
        // the SDK by-weight rejects those ("Discontinuous Bin ID"). Fill them with 0/0 — same as the two-sided path.
        const dist: WeightBin[] = fillContiguousWeights(
          shaped.weights.map((w) => ({
            binId: w.binId,
            xBps: solSide === 'X' ? w.bps : 0,
            yBps: solSide === 'Y' ? w.bps : 0,
          })),
        );
        const chunkLamports = BigInt(Math.round(chunkSol * LAMPORTS_PER_SOL));
        const built = await buildAddByWeight(
          conn,
          poolPk,
          ownerPk,
          new PublicKey(m.ourPosition),
          solSide === 'X' ? chunkLamports : 0n,
          solSide === 'Y' ? chunkLamports : 0n,
          dist,
          depositSlippagePct(leader),
          pair,
        );
        const eventKey = `${leader}:${m.pool}:reshape-add${ci}:${e.position}:${e.signature}`; // per-chunk key → distinct idempotent commands
        await publish(
          {
            commandId: commandIdFor(eventKey),
            eventKey,
            kind: 'add',
            pool: m.pool,
            positionPubkey: m.ourPosition,
            owner: ownerPk.toBase58(),
            txBase64: serializeUnsigned(onlyTx(built, 'reshape add chunk')),
            sizeSol: chunkSol,
            targetBinRange: { lower: dist[0]!.binId, upper: dist.at(-1)!.binId },
            issuedAtSlot,
            deadlineSlot,
          },
          { leader },
        );
        ci++;
      }
      growPublished = true; // #145 — ≥1 one-sided add chunk published synchronously → the grow is REAL, record the target
    }

    // Exposure basis (finding #94 §3): the recorded size must count BOTH legs, exactly like the two-sided OPEN —
    // else the FIRST resync clobbers the open's combined size back to a SOL-leg-only figure and undercounts deployed
    // capital by up to ~2×. Value the leader's full token leg in SOL via the fully-routed SELL quote, but ONLY when
    // we actually copy the token leg (twoSidedMode 'on' AND the leader holds token). This runs AFTER every reshape
    // command is already published (off the copy SLA path) and is guarded: a quote failure falls back to the SOL-leg
    // basis (never worse than before the fix), and it feeds ONLY the recorded size — the deposits are unaffected.
    // (`leaderSolSizeSol` is computed once above, for the grow-cap gate.)
    let tokenLegValueSol = 0;
    if (ec.twoSidedMode === 'on' && leaderTokenRawTotal > 0) {
      try {
        const valueQuote = await getJupiterQuote(
          jupiterBaseUrl,
          tokenMint,
          BigInt(Math.round(leaderTokenRawTotal)),
          ec.execution.slippageBps,
        );
        tokenLegValueSol = Number(valueQuote.outAmount) / LAMPORTS_PER_SOL;
      } catch {
        tokenLegValueSol = 0; // SOL-leg basis fallback — same as before the fix, never an overcount
      }
    }
    const newSize = Math.min(
      copyRatio * (leaderSolSizeSol + tokenLegValueSol),
      ec.sizing.maxTradeSizeSol,
    );
    // #145 — record ONLY what actually published. Removes land synchronously, so a SHRINK (or a one-sided grow whose
    // adds published) records the full target now; a grow whose add was DEFERRED (two-sided) or SKIPPED
    // (token_unbuyable / all adds out of range) must NOT inflate exposure → clamp to the current size so the caps and
    // the feed track the copy's real deployed capital. A deferred two-sided grow records `newSize` later, when
    // publishReshapeAddAfterBuy publishes its add (the target is stashed on the pending-add ctx just below).
    const recordedSize = growPublished ? newSize : Math.min(newSize, m.sizeSol);
    registry.adjustSize(e.position, recordedSize);
    await store.updateSize(e.position, recordedSize);
    if (deferredGrowKey) {
      const pending = pendingReshapeAdds.get(deferredGrowKey);
      if (pending) pending.deferredSizeSol = newSize; // applied on the deferred add's publish (buy confirm)
    }
    // #121 — record the target this reshape drives OUR position toward, so a rapid follow-up resync nets against it
    // (the read override above) instead of the stale on-chain read. Only when we PUBLISHED something (removes / a
    // one-sided add / a deferred two-sided buy): a pure noop returned earlier, and with nothing published the position
    // is unchanged so the on-chain read stays truth. `capFactor` is the EXACT factor planTwoSidedReshape applied, so
    // the per-offset target (`capFactor × leaderBin`) matches what the plan built toward; offsets outside our FIXED
    // range are unreachable (partial-range limit) → dropped, exactly like the on-chain add filter does.
    if (calls.removes.length > 0 || growPublished || deferredGrowKey !== null) {
      const capFactor = reshapeCapFactor(leaderSolSizeSol, copyRatio, ec.sizing.maxTradeSizeSol);
      const maxOffset = ourShape.upperBinId - ourShape.lowerBinId; // our range is fixed at open
      const leaderSolByOffset = new Map(leaderBins.map((b) => [b.offset, b.sol]));
      const leaderTokenByOffset = new Map(leaderTokenBins.map((b) => [b.offset, b.sol]));
      const targetSol = new Map<number, number>();
      const targetToken = new Map<number, number>();
      for (const offset of new Set<number>([
        ...ourShape.perBin.map((b) => b.binId - ourShape.lowerBinId),
        ...leaderBins.map((b) => b.offset),
      ])) {
        if (offset < 0 || offset > maxOffset) continue;
        targetSol.set(offset, capFactor * (leaderSolByOffset.get(offset) ?? 0));
        targetToken.set(offset, capFactor * (leaderTokenByOffset.get(offset) ?? 0));
      }
      inFlightReshapeTargets.set(e.position, {
        atMs: Date.now(),
        sol: targetSol,
        token: targetToken,
      });
    }
    log.info(
      {
        position: e.position,
        removes: calls.removes.length,
        adds: adds.length,
        recordedSize,
        target: newSize,
      },
      '🔧 reshape published (per-bin exact)',
    );
  }

  // Publish a safety close for a tracked mirror (failsafe leader-closed, or rug-SL crash). Deterministic commandId
  // (per `tag`) → the vault retries it (idempotency re-claims a previously failed close) until it lands.
  async function publishSafetyClose(
    m: Mirror,
    tag: string,
    reason: string,
    reCloseAttempt?: number,
  ): Promise<void> {
    // The MIRROR's leader (3b) prefixes the key — same commandId the pre-3b code derived for a fresh mirror, and
    // the exact shape the failsafe idempotency depends on (`${leader}:${pool}:failsafe:${leaderPosition}`).
    const leader = leaderOf(m);
    const eventKey = `${leader}:${m.pool}:${tag}:${m.leaderPosition}`;
    const commandId = commandIdFor(eventKey);
    const built = await buildCloseTx(
      conn,
      new PublicKey(m.pool),
      ownerPk,
      new PublicKey(m.ourPosition),
      m.lowerBin,
      m.upperBin,
    );
    const { issuedAtSlot, deadlineSlot } = await slots();
    await publish(
      {
        commandId,
        eventKey,
        kind: 'close',
        pool: m.pool,
        positionPubkey: m.ourPosition,
        owner: ownerPk.toBase58(),
        txBase64: serializeUnsigned(firstTx(built)),
        sizeSol: m.sizeSol,
        targetBinRange: { lower: m.lowerBin, upper: m.upperBin },
        issuedAtSlot,
        deadlineSlot,
      },
      { stage: 'failsafe', severity: 'warn', reason, leader, leaderPosition: m.leaderPosition },
      retryCorrelationId(commandId, reCloseAttempt),
    );
    recentlyPublishedClose.set(m.ourPosition, Date.now()); // grace; journaled as a failsafe-published event in publish()
  }

  // Re-publish a failsafe close for a mirror still on-chain whose leader has closed. `reCloseAttempt` = the reconcile
  // tick stamp (#64) so each RETRY tick persists as a distinct audit row.
  const publishReClose = (m: Mirror, reCloseAttempt?: number): Promise<void> =>
    publishSafetyClose(m, 'failsafe', 'leader_closed', reCloseAttempt);

  // Publish a failsafe close for each mirror a stop PLAN targets — the shared executor for BOTH the live prev/next
  // diff (applyStopCloses) and the boot-seed replay (applyBootStopCloses). Grace-gated so a close already in flight
  // is not re-published, and every target is marked rug-exit-pending (+ persisted) so a close that fails to land is
  // re-closed by the reconcile until confirmed gone. A stop leaves the LEADER position OPEN, so the `leaderClosed`
  // retry never fires for it — this our-exit pending channel (shared with rug-SL) is what guarantees no silent orphan.
  async function executeStopClosePlan(
    toClose: StopClosePlan['toClose'],
    open: Mirror[],
  ): Promise<void> {
    for (const c of toClose) {
      const m = open.find((x) => x.ourPosition === c.ourPosition);
      if (!m) continue;
      // Grace: a close already published for this mirror (failsafe/rug-SL/an earlier stop) is still landing.
      if (Date.now() - (recentlyPublishedClose.get(m.ourPosition) ?? 0) < RECLOSE_GRACE_MS)
        continue;
      log.warn(
        { our: m.ourPosition, leaderPosition: m.leaderPosition, reason: c.reason },
        '🛑 stop → force-close',
      );
      // ARM the retry-until-confirmed-gone state BEFORE publishing (#153, matches the rug-SL path). A stop close
      // that FAILS to publish must still be re-closed by the reconcile until the position is confirmed gone, so
      // arming the retry must not hinge on the publish succeeding.
      rugExitPending.add(m.ourPosition); // retry-until-confirmed-gone via the reconcile (SPEC §4.3 failure branch)
      // AWAIT the durable persist BEFORE publishing (#153): a SIGKILL between the publish and this INSERT would
      // lose the ONLY cross-restart re-close channel. addPending is fail-safe (logs a write error, never throws)
      // → awaiting it can never hinder the close.
      await rugExitStore.addPending(m.ourPosition); // persist so the retry survives a brain restart
      // The eventKey tag is keyed by OUR position (not the leader's, unlike failsafe/rugsl): a stop leaves the
      // LEADER position open, so the same leader position can be legitimately re-mirrored after a stop→start
      // cycle — a leaderPosition-keyed commandId would collide with the previous stop's already-executed close
      // and be rejected as a duplicate (the close would never land).
      await publishSafetyClose(m, `stop:${m.ourPosition}`, c.reason).catch((err) =>
        // Retry state is armed above → the reconcile re-closes even on a failed publish (never a silent orphan).
        log.error({ err: (err as Error).message, our: m.ourPosition }, 'stop close publish failed'),
      );
    }
  }

  // A mirror projected to the 3 keys the stop planners correlate on (the executor re-finds the full Mirror by
  // ourPosition). Per-mirror leader (3b): a stop of leader A closes ONLY A's mirrors even with several watched; a
  // legacy '' leaderAddress is stopped-by-definition for the planners → only a GLOBAL stop closes such a row.
  const toStopCloseMirror = (m: Mirror) => ({
    ourPosition: m.ourPosition,
    leaderPosition: m.leaderPosition,
    leaderAddress: m.leaderAddress,
  });

  // STOP = FORCE-CLOSE (SPEC §4.3) — LIVE path: close the mirrors concerned by an OBSERVED config stop transition.
  // `prev` is the config the brain was RUNNING, so a start is a structural no-op (forward-only) and a stale prev
  // can never replay an old stop. Config preserved (never written here).
  async function applyStopCloses(prev: CopybotConfig, next: CopybotConfig): Promise<void> {
    const open = registry.openPositions();
    if (open.length === 0) return;
    await executeStopClosePlan(
      planStopCloses(prev, next, open.map(toStopCloseMirror)).toClose,
      open,
    );
  }

  // STOP = FORCE-CLOSE (SPEC §4.3) — BOOT/seed path (finding #135): after a (re)spawn reloaded this runtime's
  // persisted open mirrors, force-close any whose leader is now disabled/absent — or whose user is globally
  // stopped — i.e. a STOP written while the brain was DOWN. The live diff above cannot see it (a fresh spawn has no
  // transition to observe), so we replay from the "open mirror ⇒ started leader" invariant. Same executor ⇒ the
  // grace gate dedupes an in-flight prior close and a failed publish is retry-tracked exactly like the live path.
  async function applyBootStopCloses(boot: CopybotConfig): Promise<void> {
    const open = registry.openPositions();
    if (open.length === 0) return;
    await executeStopClosePlan(planBootStopCloses(boot, open.map(toStopCloseMirror)).toClose, open);
  }

  // Force-close a STRAY (untracked) position on our wallet — pool + bins come from the on-chain enumerator. The
  // close goes through the vault's Wall B like any other (signer/destination re-verified), so it can only ever
  // close OUR own position. Deterministic commandId → idempotent if it has to be retried.
  async function publishOrphanClose(p: UserPosition, reCloseAttempt?: number): Promise<void> {
    // An orphan has NO leader (tracked by no mirror) — its keys live in the WALLET context (INC3B-PLAN §4): the
    // `wallet:` prefix replaces a leader address so the commandId never aliases a leader-scoped close and never
    // fabricates an attribution. Published as SYSTEM (brain-main routes every orphan through the SYSTEM runtime).
    const eventKey = `${WALLET_EVENT_PREFIX}:${p.pool}:orphan:${p.position}`;
    const built = await buildCloseTx(
      conn,
      new PublicKey(p.pool),
      ownerPk,
      new PublicKey(p.position),
      p.lowerBinId,
      p.upperBinId,
    );
    const { issuedAtSlot, deadlineSlot } = await slots();
    const commandId = commandIdFor(eventKey);
    // Per-tick discriminator (#64) so each RETRY of this deterministic orphan close persists as a distinct audit row.
    const correlationId = retryCorrelationId(commandId, reCloseAttempt);
    await publish(
      {
        commandId,
        eventKey,
        kind: 'close',
        pool: p.pool,
        positionPubkey: p.position,
        owner: ownerPk.toBase58(),
        txBase64: serializeUnsigned(firstTx(built)),
        sizeSol: 0,
        targetBinRange: { lower: p.lowerBinId, upper: p.upperBinId },
        issuedAtSlot,
        deadlineSlot,
      },
      { stage: 'failsafe', reason: 'orphan' },
      correlationId,
    );
    recentlyPublishedClose.set(p.position, Date.now());
    // Orphan auto-close → the pinned, feed-visible `failsafe.orphan_closed` (was a generic `alert()`). Same
    // commandId AND correlationId as the publish marker above ⇒ the emit dedup collapses the two into ONE
    // orphan-closed row (per tick — a genuine retry on a later tick is a distinct row via `correlationId`).
    events.emit('failsafe.orphan_closed', {
      stage: 'failsafe',
      outcome: 'published',
      reason: 'orphan',
      leader: bootLeader,
      pool: p.pool,
      ourPosition: p.position,
      commandId,
      eventKey,
      correlationId,
      adminDetail: { position: p.position, pool: p.pool },
    });
  }

  // ev:executed(open) → a CLASSIC open LANDED on-chain: emit the FEED `lifecycle.open_confirmed` so the user sees
  // the open (the publish only emits the internal `lifecycle.open_published`). The mirror is already persisted at
  // publish time (no untracked open), so we look it up by OUR position. No-op if there's no mirror (e.g. a Token-2022
  // open's empty-position create lands here too — but those carry a pendingToken2022Deposits commandId and are routed
  // to the deposit step, never to this handler; the Token-2022 FEED confirm fires in finalizeToken2022Open instead).
  // Observability-only — never touches decision/tx-build/reconcile state.
  function onOpenConfirmed(ourPosition: string): void {
    const m = registry.getByOurPosition(ourPosition);
    if (!m) return;
    events.opened({
      stage: 'open',
      outcome: 'confirmed',
      leader: leaderOf(m),
      pool: m.pool,
      leaderPosition: m.leaderPosition,
      ourPosition,
      ourSizeSol: m.sizeSol,
      eventKey: openConfirmedKey(leaderOf(m), m.pool, ourPosition),
      adminDetail: { nonSolSymbol: m.nonSolSymbol, openCount: registry.openPositions().length },
    });
  }

  // ev:executed(add) → a reshape ADD leg LANDED → emit the FEED `lifecycle.add_confirmed` (the publish only emits the
  // internal `lifecycle.open_published` trace for a reshape add). The Token-2022 open's deposit also lands as kind
  // 'add' but carries a pendingToken2022Mirrors commandId and is routed to finalizeToken2022Open, never here. The
  // landed command's `commandId` (carried by the ev) is the correlation key → a duplicate confirm of the SAME add leg
  // collapses while distinct legs (distinct commandIds) stay distinct. Observability-only.
  function onAddConfirmed(ourPosition: string, commandId: string): void {
    const m = registry.getByOurPosition(ourPosition);
    if (!m) return;
    events.addedLiquidity({
      stage: 'reshape',
      outcome: 'confirmed',
      leader: leaderOf(m),
      pool: m.pool,
      leaderPosition: m.leaderPosition,
      ourPosition,
      ourSizeSol: m.sizeSol,
      commandId,
      adminDetail: { nonSolSymbol: m.nonSolSymbol },
    });
  }

  // ev:executed(claim) → a fees CLAIM LANDED → emit the FEED `lifecycle.claim_confirmed` (the publish only emits the
  // internal `lifecycle.open_published` trace). Correlation = the landed command's `commandId` (same-claim duplicate
  // confirms collapse; distinct claims stay distinct). Observability-only.
  function onClaimConfirmed(ourPosition: string, commandId: string): void {
    const m = registry.getByOurPosition(ourPosition);
    if (!m) return;
    events.claimed({
      stage: 'close',
      outcome: 'confirmed',
      leader: leaderOf(m),
      pool: m.pool,
      leaderPosition: m.leaderPosition,
      ourPosition,
      ourSizeSol: m.sizeSol,
      commandId,
      adminDetail: { nonSolSymbol: m.nonSolSymbol },
    }); // 'claim' maps to the close-domain stage (stageForKind)
  }

  // ev:executed(close) → the close LANDED, so our position is gone: mark the mirror closed in the DB NOW (don't
  // wait for the periodic reconcile, which the open-grace can defer up to ~grace+cadence). Orphan close (no
  // tracked mirror) → nothing to do. The reconcile + orphan-sweep stay the backstop if this ev was ever missed.
  async function onCloseConfirmed(ourPosition: string): Promise<void> {
    // Purge a pending rug-SL/stop re-close FIRST (before the mirror lookup, which can already be unregistered):
    // the coffre CONFIRMED this close landed, so the retry entry is now stale. Without this, only the reconcile
    // purged it — an entry whose mirror was gone by then sat inert (and durable) forever.
    void purgeRugExitPending(rugExitPending, rugExitStore, ourPosition);
    const m = registry.getByOurPosition(ourPosition);
    if (!m) return;
    await store.markClosed(m.leaderPosition);
    registry.close(m.leaderPosition);
    inFlightReshapeTargets.delete(m.leaderPosition); // #121 — close confirmed; drop any in-flight reshape target
    recentlyPublishedClose.delete(ourPosition);
    rugSlTracker.forget(ourPosition);
    events.closed({
      stage: 'close',
      outcome: 'confirmed',
      leader: leaderOf(m),
      pool: m.pool,
      leaderPosition: m.leaderPosition,
      ourPosition,
      ourSizeSol: m.sizeSol,
      eventKey: closeConfirmedKey(leaderOf(m), m.pool, ourPosition),
      adminDetail: { nonSolSymbol: m.nonSolSymbol, via: 'ev_executed' },
    });
    // #140 — the fee is NO LONGER assessed here. markClosed runs BEFORE the residual sell (onCloseExecuted), so the
    // ledger at this point is missing the sell's proceeds row → assessing here undercounts a two-sided winner. The
    // trigger moved to onCloseExecuted (no-sell paths) / onSellConfirmed (after the SELL row lands), backstopped by
    // the periodic re-assess of any closed position still lacking a fee_ledger row (SPEC §9).
  }

  /**
   * Assess the 5% performance fee for a just-closed position from its own execution ledger (SPEC §9): base =
   * Σlamports_in − Σlamports_out; a base ≤ 0 owes nothing (per position, no loss offset, no high-water mark).
   * Idempotent per position (the fee_ledger unique key), so a re-confirm never double-charges — the transparency
   * feed row is emitted only on the FIRST insert. When no operator sink is configured the fee is still RECORDED
   * (state 'skipped') so what would be owed is auditable, but it is never swept.
   */
  async function assessFee(ourPosition: string): Promise<void> {
    const rows = await positionLedger.listForPosition(userId, ourPosition);
    const base = sumLedgerBase(rows);
    const fee = computeFee(base);
    if (fee <= 0n) return; // a losing/flat position pays nothing (SPEC §9)
    const state = operatorFeeAddress ? 'pending' : 'skipped';
    const inserted = await feeLedger.assess(userId, ourPosition, Number(base), Number(fee), state);
    if (!inserted) return; // a prior assessment already recorded (+ emitted) this position's fee (idempotent)
    events.emit('fee.assessed', {
      stage: 'sweep',
      outcome: 'detected',
      kind: 'fee',
      pool: ourPosition,
      ourPosition,
      eventKey: `fee:${ourPosition}`,
      adminDetail: {
        basePnlSol: Number(base) / LAMPORTS_PER_SOL,
        feeSol: Number(fee) / LAMPORTS_PER_SOL,
        state,
      },
    });
  }

  /**
   * Inc.4d (#140) — assess a closed position's fee, GUARDED: a missing `ourPosition` or a transient failure never
   * blocks the close-executed ack nor the sell-confirm (fully decoupled from the money-critical close). The periodic
   * backstop re-assesses anything that slips through. Shared by the no-sell close paths and the sell-confirm.
   */
  const assessFeeSafe = (ourPosition: string | undefined): Promise<void> =>
    ourPosition
      ? assessFee(ourPosition).catch((err) =>
          log.warn(
            { ourPosition, err: (err as Error).message },
            'fee assessment failed — close is unaffected; the periodic backstop re-assesses',
          ),
        )
      : Promise.resolve();

  /**
   * Inc.4d (finding #140) — append the two-sided open's/reshape's BUY as a ledger row attributed to `ourPosition`,
   * so the fee base at close counts the SOL SPENT buying the token leg (not only the SOL leg). `lamportsOut` = the
   * buy's ExactIn SOL input (`buyQuote.inAmount`), deterministic pre-land; the ~5000-lamport tx fee the buy also
   * paid is a negligible approximation vs SPEC §9's lamport-exact ideal (the close/sell rows ARE exact via the owner
   * delta). Idempotent on `(userId, buySig, ourPosition)`. Best-effort post-open bookkeeping, EXACTLY like the confirm
   * worker's row write: a rare DB blip is swallowed + logged so it NEVER breaks the money-critical open publish. A
   * one-sided open funds no buy → `buyInLamports`/`buySig` are absent → no row.
   */
  async function appendBuyRow(
    ourPosition: string,
    buyInLamports: number | undefined,
    buySig: string | undefined,
  ): Promise<void> {
    if (buyInLamports === undefined || buySig === undefined) return; // one-sided open (no token buy) → no row
    try {
      await positionLedger.append({
        userId,
        ourPosition,
        kind: 'buy', // a free kind the repo accepts and `sumLedgerBase` folds into the base (Σin − Σout)
        lamportsIn: 0,
        lamportsOut: buyInLamports,
        sig: buySig,
        confirmedAt: Date.now(),
      });
    } catch (err) {
      log.warn(
        { ourPosition, buySig, err: (err as Error).message },
        'buy ledger row append failed — fee bookkeeping only, the open is unaffected (a rare over-charge)',
      );
    }
  }

  /**
   * Inc.4d (finding #140) — a CLOSE-path residual sell CONFIRMED: append its SELL as a ledger row (lamportsIn = the
   * owner's SOL delta on the sell tx — EXACT via the confirmed meta, i.e. the proceeds net of the tx fee) attributed
   * to `ourPosition`, THEN assess the fee. The base now counts the token-leg proceeds returned to SOL, so a two-sided
   * position that recovers its token value is charged on the TRUE net (SPEC §9), not on the SOL leg alone. One
   * getTransaction per confirmed close-sell (reuses the pure `ledgerRowFromMeta` + shared `accountKeysOf`). Idempotent:
   * append is keyed `(userId, sellSig, ourPosition)` and `assessFee` is keyed `(userId, ourPosition)`, so a PEL re-run
   * — and the periodic backstop — can never double-count nor double-charge. Best-effort: a getTransaction/DB blip is
   * swallowed + logged and the backstop re-assesses; the sell-confirm ack is never blocked.
   * SHARED-WALLET note: `publishSell` sells the WHOLE wallet balance of the mint, so with two concurrent same-mint
   * positions the FIRST to close is credited the joint proceeds and the second gets none — bounded by
   * maxConcurrentPerToken (net-neutral across the pair; the total proceeds are counted exactly once).
   */
  async function appendSellRowAndAssess(ourPosition: string, sig: string): Promise<void> {
    try {
      const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
      const row = tx?.meta
        ? ledgerRowFromMeta(
            ownerPk.toBase58(),
            'sell',
            { preBalances: tx.meta.preBalances, postBalances: tx.meta.postBalances },
            accountKeysOf(tx.transaction.message),
            sig,
          )
        : null;
      if (row)
        await positionLedger.append({
          userId,
          ourPosition,
          kind: row.kind,
          lamportsIn: row.lamportsIn,
          lamportsOut: row.lamportsOut,
          sig: row.sig,
          confirmedAt: Date.now(),
        });
    } catch (err) {
      log.warn(
        { ourPosition, sig, err: (err as Error).message },
        'sell ledger row append failed — the fee backstop re-assesses (never blocks the sell-confirm)',
      );
    }
    await assessFeeSafe(ourPosition);
  }

  /**
   * Build + publish the 5% performance-fee transfer (owner → operator sink) as a `kind:'fee'` SignRequest (Inc.4d)
   * — the coffre signs+lands it like any other kind, and Wall B re-checks the destination is the coffre's OWN
   * configured sink. Idempotent per (user, position): commandId = derive(userId, `fee:${ourPosition}`). A plain
   * transfer (no priority fee / tip) keeps the fee tx minimal + trivially Wall-B-verifiable. Skips when no sink is
   * configured (such rows were assessed 'skipped' and never reach the sweep — this is belt-and-suspenders).
   */
  async function publishFee(ourPosition: string, feeLamports: number): Promise<void> {
    if (!operatorFeeAddress) return;
    const operatorPk = new PublicKey(operatorFeeAddress);
    const eventKey = `fee:${ourPosition}`;
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: ownerPk, toPubkey: operatorPk, lamports: feeLamports }),
    );
    tx.feePayer = ownerPk;
    tx.recentBlockhash = blockhashCache.get().blockhash; // placeholder — the coffre re-sets a fresh blockhash before signing
    const txBase64 = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');
    const { issuedAtSlot, deadlineSlot } = await slots();
    await publish(
      {
        commandId: commandIdFor(eventKey),
        eventKey,
        kind: 'fee',
        pool: ourPosition, // a fee has no DLMM pool — carry the position for correlation (Wall B ignores it for a fee)
        positionPubkey: ourPosition, // provenance: the closed position this fee is levied on
        owner: ownerPk.toBase58(),
        txBase64,
        sizeSol: 0, // a fee deploys no position SOL (it transfers the fee out)
        targetBinRange: { lower: 0, upper: 0 }, // n/a for a fee
        issuedAtSlot,
        deadlineSlot,
        fee: { toAddress: operatorFeeAddress, lamports: feeLamports.toString() },
      },
      { leaderPosition: ourPosition },
    );
    log.info({ ourPosition, feeLamports }, '💸 fee published');
  }

  /**
   * ev:executed(fee) → the performance-fee transfer LANDED → flip the fee 'pending' → 'landed' and emit the
   * transparency feed row. Idempotent (markLanded transitions only a still-'pending' row → a duplicate confirm
   * emits nothing). Observability + a bounded DB write; never blocks the close.
   */
  async function onFeeConfirmed(ev: { positionPubkey?: string; sig?: string }): Promise<void> {
    const ourPosition = ev.positionPubkey;
    if (!ourPosition) return;
    const feeLamports = await feeLedger.markLanded(userId, ourPosition, ev.sig ?? '');
    if (feeLamports === null) return; // already landed / unknown → no duplicate feed row
    events.emit('fee.landed', {
      stage: 'sweep',
      outcome: 'confirmed',
      kind: 'fee',
      pool: ourPosition,
      ourPosition,
      signature: ev.sig,
      eventKey: `fee:${ourPosition}`,
      adminDetail: { feeSol: feeLamports / LAMPORTS_PER_SOL },
    });
  }

  // ev:executed(sell) → a residual token→SOL SELL (close-triggered OR safety-sweep) LANDED → emit the FEED
  // `swap.executed` ("Swapped X → SOL") so the user sees the residual sale. The sold token was stashed by
  // `publishSell` under this commandId (mint + symbol if known); we read+delete it here to name the token without
  // an extra RPC. No-op (defensive) if there's no stash (e.g. a sell from a prior process run, or a duplicate
  // confirm whose stash was already consumed). Correlation = the landed command's commandId. Observability-only;
  // never throws.
  async function onSellConfirmed(ev: {
    commandId?: string;
    pool?: string;
    sig?: string;
  }): Promise<void> {
    if (!ev.commandId) return;
    const stash = pendingSellMints.get(ev.commandId);
    if (!stash) return; // unknown / already-confirmed sell → nothing to do
    pendingSellMints.delete(ev.commandId);
    events.swapped({
      stage: 'sell',
      outcome: 'confirmed',
      kind: 'sell',
      leader: bootLeader, // sells are WALLET-level residual actions (correlation-only label; SYSTEM publishes them)
      pool: ev.pool ?? stash.pool,
      commandId: ev.commandId,
      signature: ev.sig,
      adminDetail: {
        nonSolSymbol: stash.nonSolSymbol,
        mint: stash.tokenMint,
        pool: ev.pool ?? stash.pool,
      },
    });
    // #140 — a CLOSE-path sell (ourPosition set) completes the position's ledger → write its SELL row + assess the
    // fee NOW (the assessment DEFERRED by onCloseExecuted). A wallet-sweep sell (ourPosition null) is not a position
    // leg → no row, no assess. Best-effort inside; a sell that never confirms is picked up by the periodic backstop.
    if (stash.ourPosition && ev.sig) await appendSellRowAndAssess(stash.ourPosition, ev.sig);
  }

  // ev:executed feedback → fast residual sell. Once the vault confirms a CLOSE landed, the close returned SOL +
  // a residual non-SOL token; we immediately swap that residual back to SOL (Jupiter, built here → verified by
  // Wall B → signed by the vault). This is the FAST trigger — no waiting for the 30s reconcile.
  /** Build + publish a Jupiter token→SOL sell for `residualRaw` units of `tokenMint` (shared by the close-
   *  triggered residual sell and the wallet safety sweep). `source` only labels the event/log. `nonSolSymbol`
   *  (resolvable only on the close path, via the Mirror) names the token in the sell-confirm FEED line; null on
   *  the sweep path falls back to the truncated mint. Returns whether a sell was published (false = quote below
   *  the SOL-out floor). */
  async function publishSell(
    tokenMint: string,
    residualRaw: bigint,
    pool: string,
    source: 'close' | 'sweep',
    nonSolSymbol: string | null = null,
    /** #140 — the CLOSE-path position this sell liquidates (null for a wallet-sweep sell). Carried on the stash so
     *  the sell-confirm writes the SELL ledger row + assesses the fee for it (SPEC §9). */
    ourPosition: string | null = null,
  ): Promise<boolean> {
    const t0 = Date.now();
    const ec = eff(); // wallet-level economics = the publishing runtime's config (SYSTEM for sweeps — documented wallet-context path)
    // The below-min-sell-out emit dedups on this DETERMINISTIC key so a permanently-uneconomic residual stays ONE row.
    const sellDedupKey = `${bootLeader}:${pool}:${source}:${tokenMint}:${residualRaw}`;
    // The published eventKey (⇒ the derived commandId) adds a time-epoch discriminator so a legitimately-recurring
    // identical residual is not PERMANENTLY idempotency-rejected (a sell never forceReclaims). It MUST live in the
    // eventKey — the vault re-derives commandId == deriveCommandId(userId, eventKey). See SELL_COMMAND_EPOCH_MS.
    const eventKey = `${sellDedupKey}:${Math.floor(Date.now() / SELL_COMMAND_EPOCH_MS)}`;
    const quote = await getJupiterQuote(
      jupiterBaseUrl,
      tokenMint,
      residualRaw,
      ec.execution.slippageBps,
    );
    const minOut = minOutWithSlippage(BigInt(quote.outAmount), ec.execution.slippageBps);
    if (minOut < BigInt(ec.execution.minSellOutLamports)) {
      events.emit('swap.below_min_sell_out', {
        stage: 'sell',
        outcome: 'skipped',
        reason: 'below_min_sell_out',
        leader: bootLeader,
        pool,
        eventKey: sellDedupKey,
        adminDetail: { mint: tokenMint, outAmount: quote.outAmount, source },
      });
      return false;
    }
    const txBase64 = await buildJupiterSwapTx(jupiterBaseUrl, quote, ownerPk.toBase58());

    const commandId = commandIdFor(eventKey);
    // Stash the sold token keyed by the sell's commandId so the `ev:executed{kind:'sell'}` confirm can name it in
    // the FEED `swap.executed` line without an extra RPC (deleted on confirm; see onSellConfirmed). Set BEFORE the
    // publish so an instant confirm can never race ahead of the stash.
    pendingSellMints.set(commandId, { tokenMint, nonSolSymbol, pool, ourPosition });
    const { issuedAtSlot, deadlineSlot } = await slots();
    await publish({
      commandId,
      eventKey,
      kind: 'sell',
      pool,
      positionPubkey: ownerPk.toBase58(), // n/a for a sell — Wall B binds to owner's ATA of the input mint
      owner: ownerPk.toBase58(),
      txBase64,
      sizeSol: 0, // a sell deploys no SOL (it returns SOL)
      targetBinRange: { lower: 0, upper: 0 }, // n/a for a sell
      issuedAtSlot,
      deadlineSlot,
      sell: {
        inputMint: tokenMint,
        inputAmountRaw: residualRaw.toString(),
        minOutLamports: minOut.toString(),
      },
    });
    log.info(
      {
        tokenMint,
        residual: residualRaw.toString(),
        outAmount: quote.outAmount,
        minOut: minOut.toString(),
        source,
        buildMs: Date.now() - t0,
      },
      '💱 sell published',
    );
    return true;
  }

  async function onCloseExecuted(ev: { pool: string; positionPubkey?: string }): Promise<void> {
    const meta = await poolReader.loadPoolMeta(ev.pool);
    // #140 — a non-SOL pool has no residual to sell → the ledger (open/adds/removes/claims/close) is already
    // COMPLETE for this position → assess the fee NOW (no deferral). markClosed already ran in onCloseConfirmed.
    if (!meta?.solSide) return assessFeeSafe(ev.positionPubkey); // non-SOL pool → nothing to re-swap into SOL
    const tokenMint = meta.solSide === 'X' ? meta.mintY : meta.mintX; // the non-SOL leg = residual to sell
    // SHARED-WALLET guard (3b step 6): this sell reads (and would sell) the WHOLE wallet balance of the mint.
    // If ANY runtime's two-sided open of this mint is in flight (buy landed, deposit pending), selling now would
    // empty THAT user's token leg — a cross-user capital loss the single-user code couldn't have. Defer within
    // the in-flight grace (checked BEFORE the balance read: no RPC spent on a deferred sell); the wallet sweep
    // backstop applies the same grace and sells whatever residual remains once it expires.
    if (Date.now() - (inFlightBuyMints.get(tokenMint) ?? 0) < INFLIGHT_BUY_GRACE_MS) {
      log.info(
        { mint: tokenMint, pool: ev.pool },
        '💤 close-sell deferred: mint has an in-flight two-sided buy (sweep backstop sells the residue)',
      );
      // #140 — no close-sell will be attributed to THIS position (the sweep sell that eventually clears the residue
      // is a wallet-level, unattributed sell) → its ledger is as complete as it will get → assess NOW. The tiny
      // shared-wallet imprecision (proceeds land at the wallet level) is bounded by maxConcurrentPerToken.
      return assessFeeSafe(ev.positionPubkey);
    }
    const residual = await readOwnerTokenBalance(conn, ownerPk, new PublicKey(tokenMint));
    const decision = decideResidualSell(residual, SELL_RESIDUAL_DUST_RAW); // sell ANY residual; minSellOutLamports gates economics post-quote
    if (!decision.sell) {
      // dynamic reason: `no_residual` → swap.no_residual (internal). (`dust` is unreachable here — the dust threshold
      // is 0 so a sub-dust balance is already `no_residual`; if it ever fired it would take the deterministic fallback.)
      emitFor(decision.reason, {
        stage: 'sell',
        outcome: 'skipped',
        reason: decision.reason,
        leader: bootLeader, // close-sell is a WALLET-level residual action (correlation-only label)
        pool: ev.pool,
        eventKey: `${bootLeader}:${ev.pool}:close-sell:${ev.positionPubkey ?? tokenMint}`,
        adminDetail: { mint: tokenMint },
      });
      return assessFeeSafe(ev.positionPubkey); // #140 — no residual to sell → ledger complete → assess NOW
    }
    // Resolve the token symbol from the (now-closed) Mirror so the sell-confirm FEED line can name it (null → the
    // renderer truncates the mint). The Mirror still exists at close-confirm time (markClosed flips status, not the row).
    const closedMirror = ev.positionPubkey
      ? registry.getByOurPosition(ev.positionPubkey)
      : undefined;
    // #140 — thread ourPosition so the sell-confirm attributes the SELL ledger row to THIS position. The fee is
    // DEFERRED to onSellConfirmed (assessed once the SELL row lands → the base counts the token-leg proceeds). If
    // the sell is NOT published (below-min-sell-out inside publishSell), no sell-confirm will fire → assess NOW.
    const sold = await publishSell(
      tokenMint,
      residual,
      ev.pool,
      'close',
      closedMirror?.nonSolSymbol ?? null,
      ev.positionPubkey ?? null,
    );
    if (!sold) await assessFeeSafe(ev.positionPubkey);
  }

  // Fan-out entry point (3b step 5): the LeaderHub already applied the per-leader tracker, dropped replay/
  // untracked events, and emitted the shared `detect.routed` — this ONLY enqueues (synchronous, cheap) so one
  // user's throw can never consume the event for the others. `leader` = the event's leader; `eventCount` = the
  // hub tracker's per-position event counter (kept for the routed log's byte-identical fields).
  const onEvent = (
    e: DetectedEvent,
    source: EventSource,
    leader: string,
    eventCount: number,
  ): void => {
    const t0 = Date.now();
    // #146 — recognize (and MARK) a CLOSE SYNCHRONOUSLY, before enqueuing: an in-flight resync for this SAME position
    // runs AHEAD of us on the serial chain and must observe the close IMMEDIATELY (routing below runs only at dequeue,
    // i.e. AFTER that resync has drained). `isCloseEvent` is the exact predicate the router uses, so this pre-mark can
    // never disagree with the eventual 'close' routing.
    const closeObserved = isCloseEvent(e);
    if (closeObserved) pendingCloses.add(e.position);
    // SERIALIZE per leader position: all handler work for ONE position runs strictly in order (no concurrent
    // handlers on the same position → no duplicate open). Route INSIDE the task (at dequeue time) so this event is
    // classified AFTER the prior same-position handler settled — its `registry.open`/pending reservation is visible.
    positionQueue.run(e.position, async () => {
      // This queued close is now BEING handled (any resync ahead of us has already bailed) → drop the pending mark.
      if (closeObserved) pendingCloses.delete(e.position);
      const kind = classifyInstruction(e.instruction);
      const ecRoute = effFor(leader);
      // tracked = already-open OR open-in-flight — a pending reservation (re-armed at each open-continuation hop) OR
      // an in-flight multi-tx open stash bridges the window before `registry.open` runs → a follow-up add during an
      // open routes to resync, never a 2nd open. `rugExited` ⇒ no re-open. Pure routing.
      const tracked =
        registry.hasOpen(e.position) ||
        pendingOpens.isPending(e.position) ||
        hasPendingOpenStash(e.position);
      const action = routeWithPending(e, {
        hasOpen: (p) => registry.hasOpen(p),
        isPendingOpen: (p) => pendingOpens.isPending(p),
        hasPendingOpenStash: (p) => hasPendingOpenStash(p),
        cfg: { infiniteAdd: ecRoute.infiniteAdd, claimFloorSol: ecRoute.claimFloorSol },
        rugExited: rugExited.has(e.position),
      });
      log.info(
        {
          source,
          position: e.position,
          kind,
          action,
          depositSol: e.depositSol,
          withdrawSol: e.withdrawSol,
          claimSol: e.claimSol,
          eventCount,
          tracked,
        },
        LOG_MARKER_EVENT_ROUTED,
      );
      // Reserve BEFORE handleOpen: a multi-tx open returns before `registry.open`, so without this a follow-up add
      // (a later serialized task) would see tracked=false and route to a 2nd open. Cleared at each registry.open site.
      if (action === 'open') pendingOpens.reserve(e.position);
      const act =
        action === 'open'
          ? handleOpen(e, leader)
          : action === 'resync'
            ? handleResync(e)
            : action === 'close'
              ? handleClose(e)
              : action === 'claim'
                ? handleClaim(e)
                : null;
      if (act) {
        // AWAIT here so the queue holds the next same-position task until this handler SETTLES; preserve the
        // existing build+publish / mirror-error logging. The .catch keeps the task from rejecting → the queue
        // continues (a throwing task never blocks the position's next event).
        await act
          .then(() => {
            lastActionAt = Date.now();
            lastLatencyMs = Date.now() - t0;
            log.info({ kind, brainMs: lastLatencyMs }, '🧠 build+publish');
          })
          .catch((err) => {
            // A build/publish throw is caught so the position queue keeps draining (a throwing task must never block
            // this position's next event) — control flow is UNCHANGED. A bus-publish failure is already journaled by
            // `publish` (lifecycle.publish_failed); a BUILD-phase throw (before publish) previously had ONLY this log
            // line. Also emit the typed system.mirror_error so a build failure is OBSERVABLE with its context
            // (leader/position/kind/action/phase + the serialized cause), mirroring the publish-failure journaling.
            events.emit('system.mirror_error', {
              stage: kind ? stageForKind(kind) : 'detect',
              outcome: 'failed',
              leader,
              pool: e.pool,
              leaderPosition: e.position,
              eventKey: `${leader}:${e.pool}:mirror-error:${e.signature}:${e.position}`,
              adminDetail: { kind, action, phase: 'build' },
              cause: {
                name: (err as Error).name,
                message: (err as Error).message,
                stack: (err as Error).stack,
              },
            });
            log.error(
              { err: (err as Error).message, leader, position: e.position, kind, action },
              'mirror error',
            );
          });
      }
    });
  };

  return {
    userId,
    /** The wallet this runtime acts on (ownerPk.toBase58()) — the key brain-main groups runtimes by for the
     *  per-wallet sweeps (Inc.4c). SYSTEM = the bench wallet; a real user = their provisioned Privy wallet. */
    wallet,
    events,
    registry,
    store,
    /** Boot restore: re-track persisted open mirrors AND seed the opens-per-window ring from their `openedAt`
     *  (a position opened+closed before the restart has no open row → the documented small boot under-count). */
    restoreOpenMirrors: (mirrors: ReadonlyArray<Omit<Mirror, 'status'>>): void => {
      for (const m of mirrors) openMirror(m);
    },
    rugSlTracker,
    rugExitStore,
    rugExited,
    rugExitPending,
    buildingToken2022Positions,
    getConfig: (): CopybotConfig => runtimeConfig,
    setConfig: (next: CopybotConfig): void => {
      runtimeConfig = next;
    },
    applyStopCloses,
    applyBootStopCloses,
    oracleOn,
    capsState,
    commandIdFor,
    closeConfirmedKey,
    leaderOf,
    onEvent,
    handleOpen,
    onOpenConfirmed,
    onAddConfirmed,
    onClaimConfirmed,
    onCloseConfirmed,
    onSellConfirmed,
    onCloseExecuted,
    publishFee,
    /** #140 — assess (idempotently) the 5% fee for a CLOSED position from its ledger; driven by the periodic fee
     *  backstop (runClosedFeeBackstop) for the deferred-sell tail. Rejects on a DB failure (the backstop catches). */
    assessFee,
    onFeeConfirmed,
    hasPendingReshapeAdd: (commandId: string): boolean => pendingReshapeAdds.has(commandId),
    hasPendingToken2022Deposit: (commandId: string): boolean =>
      pendingToken2022Deposits.has(commandId),
    hasPendingToken2022Mirror: (commandId: string): boolean =>
      pendingToken2022Mirrors.has(commandId),
    publishReshapeAddAfterBuy,
    publishTwoSidedOpenAfterBuy,
    publishDepositAfterPositionCreated,
    finalizeToken2022Open,
    publishSafetyClose,
    publishReClose,
    publishOrphanClose,
    publishSell,
    cancelPendingOpen,
    pendingOpenMapsView,
    lastActionAt: (): number | null => lastActionAt,
    lastLatencyMs: (): number | null => lastLatencyMs,
    // ─── Fan-out ownership accessors (3b step 5) ───
    /** Does this runtime OWN a LEADER position (open mirror, reserved open, or in-flight multi-tx stash)? The hub
     *  unions owners into an event's targets so a close reaches a user whose leader was stopped mid-flight. */
    ownsLeaderPosition: (leaderPosition: string): boolean =>
      registry.hasOpen(leaderPosition) ||
      pendingOpens.isPending(leaderPosition) ||
      hasPendingOpenStash(leaderPosition),
    /** Does this runtime own OUR position pubkey (mirror row — open or closed —, pending safety-close retry, or a
     *  Token-2022 position mid-build)? Routes an ev:executed confirm without a userId (deploy-window legacy). */
    ownsOurPosition: (ourPosition: string): boolean =>
      registry.getByOurPosition(ourPosition) !== undefined ||
      rugExitPending.has(ourPosition) ||
      buildingToken2022Positions.has(ourPosition),
    /** Does this runtime own a deferred-continuation commandId? Disjoint across users by derivation. */
    ownsCommand: (commandId: string): boolean =>
      pendingTwoSidedOpens.has(commandId) ||
      pendingToken2022Deposits.has(commandId) ||
      pendingToken2022Mirrors.has(commandId) ||
      pendingReshapeAdds.has(commandId),
    /** The per-command leader stashed on an in-flight multi-tx open/add (two-sided open, Token-2022 create/deposit,
     *  reshape add). A deferred-continuation FAILURE alert reads this so a fan-out leader's failed open/add is
     *  labelled with the REAL leader — not the demoted default (cfg.leader) — mirroring the close-swap path (#60).
     *  Resolve it BEFORE the continuation runs: `runContinuation` drops the stash on a terminal failure, so at emit
     *  time the entry is already gone (undefined ⇒ the caller falls back to cfg.leader). Same four maps, disjoint keys. */
    leaderOfCommand: (commandId: string): string | undefined =>
      pendingTwoSidedOpens.get(commandId)?.leader ??
      pendingToken2022Deposits.get(commandId)?.leader ??
      pendingToken2022Mirrors.get(commandId)?.leader ??
      pendingReshapeAdds.get(commandId)?.leader,
    /** What still ties this runtime to each leader — feeds the pure `shouldRetainLeader` (a removed leader's hub
     *  entry drains only once no mirror/pending close references it; null = unattributable ⇒ retain). */
    leaderHoldings: (): LeaderHoldings => ({
      openMirrorLeaders: registry.openPositions().map((m) => m.leaderAddress),
      rugExitPendingLeaders: [...rugExitPending].map(
        (our) => registry.getByOurPosition(our)?.leaderAddress ?? null,
      ),
    }),
  };
}
