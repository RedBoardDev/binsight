/**
 * Copy-bot · Inc.3 — VAULT process (zone Z3: the ONLY holder of the key, pull-only, NO inbound socket).
 * Consumes `cmd:sign` (XREADGROUP) and applies the ordered critical section BEFORE any signature:
 *  1-4 (bus) size/HMAC/hop · 5 Zod strict · 6 staleness (slot ≤ deadline) · 7 commandId == derive(eventKey)
 *  · 8 idempotence (INSERT executions ON CONFLICT, BEFORE) · 9 re-clamp size (local config) · 10-11 Wall B
 *  (decoding WITHOUT the SDK) · 12 SIGN · 13 LAND (async confirm). 3c: each message runs on its user's SIGNING
 *  LANE (per-user FIFO, cross-user concurrent — `lanes.ts`) and the on-chain confirmation is owned by the shared
 *  `ConfirmWorker`, so one slow/unconfirmed tx never head-of-line-blocks another user's close (ULTRACODE #22/#31).
 *  Does NOT import the DLMM SDK (firewall F3) → runs under tsx.
 *   node --import tsx --env-file=../.env src/copybot/coffre/coffre-main.ts
 */
import { randomUUID } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import type { Logger } from 'pino';
import { pino } from 'pino';
import { createDiscordAlertSink } from '@/copybot/alert';
import { assertBusKey } from '@/copybot/bus-key-guard';
import { ConfirmWorker } from '@/copybot/coffre/confirm-worker';
import { loadCopierKeypair } from '@/copybot/coffre/keypair';
import { laneKeyOf, SigningLanes } from '@/copybot/coffre/lanes';
import { type Ctx, process1, type UserSignPolicy } from '@/copybot/coffre/process-command';
import {
  DryRunSigner,
  LocalKeypairSigner,
  PrivySessionSigner,
  type Signer,
} from '@/copybot/coffre/signer';
import { ConfigStore } from '@/copybot/config-store';
import { HeartbeatStore } from '@/copybot/heartbeat-store';
import { SYSTEM_USER_ID } from '@/copybot/journal-store';
import { CopyEvents } from '@/copybot/observability/copy-events';
import { EventStore } from '@/copybot/observability/event-store';
import type { CopyCode } from '@/domain/copybot/observability/codes';
import { HEARTBEAT_INTERVAL_MS } from '@/domain/copybot/status';
import { ControlChannel } from '@/infrastructure/bus/control-channel';
import { type ConsumedMessage, RedisBus } from '@/infrastructure/bus/redis-bus';
import { CopybotActivationRepository } from '@/infrastructure/persistence/copybot-activation-repository';
import { openDatabase } from '@/infrastructure/persistence/database';
import { PositionLedgerRepository } from '@/infrastructure/persistence/position-ledger-repository';
import { PrivyServer } from '@/infrastructure/privy/privy-server';
import { BlockhashCache } from '@/infrastructure/solana/blockhash-cache';

const STREAM = 'copybot:cmd:sign';
const GROUP = 'coffre';
const CONSUMER = 'coffre-1';
const HOP = 'cmd:sign';
const CONFIG_POLL_MS = 5_000; // re-read the DB-backed runtime config (the maxTradeSol re-clamp ceiling) so web edits apply live

// Singleton lease: only ONE coffre may own the shared consumer/PEL. A 2nd instance booting would re-claim/re-sign
// in-flight cmd:sign from the PEL and DOUBLE-execute → it must refuse to boot while a live instance holds the lease.
const LEASE_KEY = 'copybot:coffre:lease'; // the exclusive Redis key guarding the coffre singleton
const LEASE_TTL_MS = 30_000; // a crashed holder's lease auto-expires within this window so a restart can re-acquire
const LEASE_RENEW_MS = LEASE_TTL_MS / 2; // renew well before expiry so a live holder never spuriously loses the lease

// --drain parity with the old inline-confirm flow: after the batch, wait (bounded) for the async confirms so the
// validation run still ends with ev:executed published. Past the ceiling (≈ a blockhash lifetime) an unconfirmed tx
// is expiring anyway and the next boot's `loadPending` resumes it — never hang the drain on a dead tx.
const DRAIN_CONFIRM_WAIT_MS = 90_000;
const DRAIN_CONFIRM_POLL_MS = 250; // cheap in-memory check of the worker's in-flight count

// Dead-letter routing for a REJECTED cmd:sign verdict. Pinning is code-driven (CODE_REGISTRY), so forgery/tamper/
// malformed rejects — "someone/something is wrong" — map to a PINNED code (operator paged out-of-band), while the
// expected rejects (duplicate/stale, and caps that already self-emit) map to a non-pinned internal quarantine trace.
// DLQ_POISON_CODE is the dedicated pinned `system.command_quarantined` — TRUTHFUL: the process is ALIVE and a single
// forged/malformed message was quarantined (NOT the "Bot Stopped" of system.fatal).
const DLQ_POISON_CODE: CopyCode = 'system.command_quarantined';
const DLQ_TRACE_CODE: CopyCode = 'system.loop_errored';
const POISON_REJECT_REASONS = new Set([
  'bad_hmac_or_hop',
  'bad_schema',
  'commandId_mismatch',
  'owner_mismatch',
  'undecodable_tx',
]); // forged / tampered / malformed

/** PURE: map a rejected verdict's reason to its dead-letter system code (pinned for forgery/tamper/malformed). */
export function deadLetterCode(reason: string | undefined): CopyCode {
  return reason !== undefined && POISON_REJECT_REASONS.has(reason)
    ? DLQ_POISON_CODE
    : DLQ_TRACE_CODE;
}

/** What the vault loop does with a processed message given its verdict. */
export type VerdictRoute =
  | { action: 'ack' } // terminal-OK (landed / skipped / dry-run) — clear from the group
  | { action: 'retain' } // #7 recovery in-flight (retryLater) — leave UNACKED for a later recovery pass
  | { action: 'deadLetter'; code: CopyCode }; // rejected/poison — durable quarantine + a system-event trace

/** PURE: decide the routing for a verdict; the caller performs the I/O (ack / dead-letter / leave pending). */
export function routeVerdict(verdict: {
  ok: boolean;
  reason?: string;
  retryLater?: boolean;
}): VerdictRoute {
  if (verdict.retryLater) return { action: 'retain' }; // must stay in the PEL (a prior broadcast may still land)
  if (verdict.ok) return { action: 'ack' };
  return { action: 'deadLetter', code: deadLetterCode(verdict.reason) };
}

/** A real user's Privy wallet identity (the activation table lands in wave 4b; 4a resolves null for every user). */
export interface UserWallet {
  walletId: string; // Privy wallet id — signTransaction needs the id, not the address
  address: string; // the wallet's Solana address (the tx owner / feePayer)
  signingDisabled: boolean; // per-user kill switch (#21/#55): true ⇒ skip THAT user, never sign
}

/** A real user has no activation row yet (4a) — skip THAT user, never a global stop (SPEC §17.4). */
export class UserWalletUnresolvedError extends Error {
  constructor(readonly userId: string) {
    super(`no Privy wallet resolved for user ${userId} (not activated)`);
    this.name = 'UserWalletUnresolvedError';
  }
}

/** A user's signing is disabled (revoked delegation / operator kill, #21/#55) — skip THAT user, never a global stop. */
export class SigningDisabledError extends Error {
  constructor(readonly userId: string) {
    super(`signing is disabled for user ${userId}`);
    this.name = 'SigningDisabledError';
  }
}

/** Everything `createSignerResolver` needs — all injected so the routing + caching are unit-testable without Privy. */
export interface SignerResolverDeps {
  systemSigner: Signer; // the SYSTEM/bench local-keypair signer (cached, unchanged)
  privySigningEnabled: boolean; // PRIVY_SIGNING_ENABLED: real users get a live PrivySessionSigner; else a DryRunSigner
  resolveUserWallet: (userId: string) => Promise<UserWallet | null>; // the single source of a user's (walletId, address)
  buildLiveSigner: (wallet: UserWallet) => Signer; // PrivySessionSigner over the resolved wallet
  buildDryRunSigner: (address: string) => Signer; // DryRunSigner over the resolved address (flag OFF)
  log: Logger;
}

async function resolveSigner(userId: string, deps: SignerResolverDeps): Promise<Signer> {
  if (userId === SYSTEM_USER_ID) return deps.systemSigner;
  const wallet = await deps.resolveUserWallet(userId);
  if (!wallet) throw new UserWalletUnresolvedError(userId); // not provisioned yet (real-user provisioning = wave 4b)
  if (!deps.privySigningEnabled) return deps.buildDryRunSigner(wallet.address); // flag OFF → run the pipeline, skip the sign
  if (wallet.signingDisabled) throw new SigningDisabledError(userId); // per-user kill switch → skip THAT user
  return deps.buildLiveSigner(wallet); // live per-user Privy signing
}

/**
 * Build `signerFor(userId)` (SPEC §11): resolve + CACHE one Signer per SIGNED tenant.
 *  - SYSTEM → the cached local-keypair signer (bench, byte-identical).
 *  - any other user → resolve its wallet (the single source of the address, needed by BOTH the live and the dry-run
 *    path for the Wall B owner check). No activation row (null, always in 4a) ⇒ UserWalletUnresolvedError; then the
 *    flag chooses OFF → DryRunSigner (pipeline runs end-to-end, nothing signed) vs ON → signingDisabled ⇒
 *    SigningDisabledError, else a live PrivySessionSigner.
 * Every error is per-user (isolated): the caller (process-command) finalizes 'failed' for THAT command only.
 */
export function createSignerResolver(
  deps: SignerResolverDeps,
): (userId: string) => Promise<Signer> {
  const cache = new Map<string, Signer>();
  return async (userId) => {
    const cached = cache.get(userId);
    if (cached) return cached;
    const signer = await resolveSigner(userId, deps);
    cache.set(userId, signer);
    return signer;
  };
}

/** What the lane task needs to route ONE message to its terminal I/O (ack / dead-letter / retain). */
export interface MessageHandlerDeps {
  /** The critical section — `process1` bound to its Ctx (injected so the handler is unit-testable). */
  process: (
    payload: unknown | null,
    recovering: boolean,
  ) => Promise<{ ok: boolean; reason?: string; kind?: string; retryLater?: boolean }>;
  bus: Pick<RedisBus, 'ack' | 'deadLetter'>;
  events: Pick<CopyEvents, 'system'>;
  log: Logger;
  stream: string;
  group: string;
}

/**
 * Build the per-message LANE TASK: run the critical section, then perform the verdict's terminal I/O. The ACK (or
 * dead-letter, which acks internally) happens ONLY here — after the lane task reached a terminal outcome — never at
 * dispatch/enqueue time: a crash between the dispatch and this point leaves the message in the PEL, and the boot
 * drain (+ the executions table idempotency) re-drives it. Exported for direct unit tests of that contract.
 */
export function createMessageHandler(
  deps: MessageHandlerDeps,
): (msg: ConsumedMessage, recovering: boolean) => Promise<void> {
  const { process, bus, events, log, stream, group } = deps;
  return async (msg, recovering) => {
    try {
      const verdict = await process(msg.payload, recovering);
      log.info({ id: msg.id, recovering, ...verdict }, verdict.ok ? '✅ processed' : '⛔ rejected');
      // Route by verdict (pure decision, I/O here):
      //  - retain (#7 recovery in-flight): leave UNACKED so a later pass re-checks the chain — ACKing would strand it;
      //  - deadLetter (rejected/poison): move the raw message to the DLQ + emit a system-event trace (PINNED for a
      //    forged/malformed command — "something is wrong"; internal for the expected duplicate/stale), instead of a
      //    SILENT ack that would let a poison/forged message vanish without a durable trace;
      //  - ack (terminal-OK): clear it as before (idempotence guarded by the executions table).
      const route = routeVerdict(verdict);
      if (route.action === 'retain') return;
      if (route.action === 'deadLetter') {
        events.system(route.code, undefined, {
          stage: 'sign',
          outcome: 'rejected',
          reason: `dead_letter:${verdict.reason ?? 'unknown'}`,
          adminDetail: { id: msg.id, reason: verdict.reason, kind: verdict.kind, recovering },
        });
        await bus.deadLetter(stream, group, msg.id, msg.raw);
      } else {
        await bus.ack(stream, group, msg.id);
      }
    } catch (e) {
      // process threw (transient I/O before the idempotency claim) → the message is left UNACKED for retry. An
      // internal loop self-failure (NEVER user-notified — loop guard, SPEC §6); the row carries the cause.
      events.system('system.loop_errored', e, {
        stage: 'sign',
        outcome: 'failed',
        reason: 'loop_errored',
        adminDetail: { id: msg.id, phase: 'process1' },
      });
    }
  };
}

const cfg = {
  httpUrl: process.env.SOLANA_HTTP_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6385',
  dbUrl: process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora',
  keypairPath: process.env.COPIER_KEYPAIR_PATH ?? '.wallets/copier-test.json',
  owner: process.env.COPIER_OWNER ?? 'Ybbt2Td4TjxwpzvuicbP9ANizBwAJzqjuRmRrvDh9zz',
  maxTradeSolEnv:
    process.env.MAX_TRADE_SOL !== undefined ? Number(process.env.MAX_TRADE_SOL) : undefined, // env override; else the DB config's maxTradeSizeSol
  signingEnabled: process.env.SIGNING_ENABLED === 'true', // Inc.4 ; false = dry-run
  retryMax: Number(process.env.SIGN_RETRY_MAX ?? '2'), // sign+land attempts when land THROWS (no sig produced); a returned-but-unconfirmed sig is NOT retried in place (double-apply risk)
  retryDelayMs: Number(process.env.SIGN_RETRY_DELAY_MS ?? '1500'),
  jitoBundleUrl: process.env.COPYBOT_JITO_BUNDLE_URL, // block-engine URL; absent ⇒ never bundle (plain RPC land)
  jitoEnabledEnv:
    process.env.COPYBOT_JITO !== undefined ? process.env.COPYBOT_JITO === 'true' : undefined, // env override of the DB jitoEnabled
  operatorFeeAddress: process.env.OPERATOR_FEE_ADDRESS ?? '', // Inc.4d fee sink (SPEC §9); '' ⇒ Wall B rejects fee txs
};

// Inc.4a — per-user Privy signing (default OFF). While OFF, a real user's pipeline runs end-to-end via a DryRunSigner
// (nothing signed) and the SYSTEM/bench wallet always signs with its LOCAL keypair (byte-identical); NO Privy
// credentials are read/needed. When ON (post-devnet 4f), a real user's OWNER signature comes from Privy's TEE.
const privyCfg = {
  signingEnabled: process.env.PRIVY_SIGNING_ENABLED === 'true', // default false
  appId: process.env.PRIVY_APP_ID ?? '',
  appSecret: process.env.PRIVY_APP_SECRET ?? '',
  authorizationKey: process.env.PRIVY_AUTHORIZATION_KEY, // coffre session-signer P-256 (off-host); undefined until 4f
};

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!cfg.httpUrl) {
    log.error('SOLANA_HTTP_URL missing');
    process.exit(1);
  }
  // Fail-closed on the bus HMAC (the vault's only transport auth): refuse to boot with a missing/insecure key.
  const busKey = assertBusKey(process.env);
  if ('error' in busKey) {
    log.error(busKey.error);
    process.exit(1);
  }
  const hmacKey = busKey.key;
  // THE-TRAP: the loaded key MUST be the expected copier wallet (fail-closed otherwise).
  const copier = loadCopierKeypair(cfg.keypairPath, cfg.owner);
  const conn = new Connection(cfg.httpUrl, 'confirmed');
  const db = openDatabase(cfg.dbUrl);
  // ONE observability emitter bound to this tenant (mono-user PoC): a tenant-scoped pino child is its logger. The
  // vault's call sites (process1 + the loop) emit TYPED codes through it directly; every row back-fills
  // user/wallet/correlation. Operator-actionable (pinned) events also fan out to the external ALERT_WEBHOOK via the
  // injected sink (no-op when unset).
  const tlog = log.child({ userId: SYSTEM_USER_ID, wallet: cfg.owner, process: 'coffre' });
  const alertSink = createDiscordAlertSink(process.env.DISCORD_WEBHOOK_URL, tlog);
  const events = new CopyEvents(
    new EventStore(db, tlog),
    tlog,
    { userId: SYSTEM_USER_ID, wallet: cfg.owner, process: 'coffre' },
    alertSink,
  );
  const configStore = new ConfigStore(db, log);
  // PER-USER config cache (SPEC §11/§12): the SIGNED userId of each cmd:sign selects ITS caps/config row — never a
  // hardcoded SYSTEM read at sign time. Lazily loaded on first use (fail-closed ConfigStore.load; a missing row =
  // defaults, no row created), refreshed live by the poll + control pings. The SYSTEM row is still seeded at boot
  // (the single-user brain publishes for it today); user #2 just becomes another cache entry.
  const userConfigs = new Map<string, Awaited<ReturnType<typeof configStore.load>>>();
  userConfigs.set(SYSTEM_USER_ID, await configStore.seedIfAbsent(SYSTEM_USER_ID));
  const configFor = async (
    userId: string,
  ): Promise<Awaited<ReturnType<typeof configStore.load>>> => {
    const cached = userConfigs.get(userId);
    if (cached) return cached;
    const loaded = await configStore.load(userId);
    userConfigs.set(userId, loaded);
    return loaded;
  };
  // Sign-time policy for ONE user: the maxTradeSol re-clamp ceiling (env wins when set) + Jito bundle landing
  // (active only when jitoEnabled — env override else THIS user's DB config — AND a block-engine URL is set).
  const policyFor = async (userId: string): Promise<UserSignPolicy> => {
    const c = await configFor(userId);
    return {
      maxTradeSol: cfg.maxTradeSolEnv ?? c.user.sizing.maxTradeSizeSol,
      jitoBundleUrl: (cfg.jitoEnabledEnv ?? c.user.jitoEnabled) ? cfg.jitoBundleUrl : undefined,
    };
  };
  const reloadConfig = async (): Promise<void> => {
    // Refresh EVERY cached user's row (today: the SYSTEM row) so web edits apply live for each tenant.
    for (const userId of userConfigs.keys())
      userConfigs.set(userId, await configStore.load(userId));
  };
  const control = ControlChannel.connect(cfg.redisUrl); // instant config-reload pings (re-clamp ceiling in <100ms)
  const heartbeat = new HeartbeatStore(db, log, 'coffre'); // process status the web reads (vault online + signing state)
  const bus = RedisBus.connect(cfg.redisUrl);
  await bus.ensureGroup(STREAM, GROUP);
  // SINGLETON GUARD (before ANY processing/recovery): acquire the exclusive coffre lease. A 2nd instance booting with
  // the same consumer would re-claim/re-sign this consumer's in-flight PEL and DOUBLE-execute — so if the lease is
  // already held by a live instance, refuse to boot. The lease auto-expires (TTL) if the holder crashes.
  const instanceId = `${CONSUMER}:${process.pid}:${randomUUID()}`;
  if (!(await bus.acquireLease(LEASE_KEY, instanceId, LEASE_TTL_MS))) {
    log.error(
      { key: LEASE_KEY, instanceId },
      '🔒 another vault instance holds the singleton lease — refusing to boot (would double-sign in-flight commands)',
    );
    process.exit(1);
  }
  // Renew on a ttl/2 timer so a live holder never loses the lease. If a renew ever fails (our lease expired and was
  // taken by another instance, e.g. after a long Redis outage), we lost exclusivity → exit to avoid a split-brain
  // double-sign. A transient renew error is logged and retried on the next tick (ioredis retries the connection).
  const leaseTimer = setInterval(() => {
    void bus
      .renewLease(LEASE_KEY, instanceId, LEASE_TTL_MS)
      .then((ok) => {
        if (!ok) {
          log.error(
            { key: LEASE_KEY, instanceId },
            '🔒 lost the singleton lease (expired/taken) — exiting to avoid a split-brain double-sign',
          );
          process.exit(1);
        }
      })
      .catch((e) =>
        log.error({ err: (e as Error).message }, 'lease renew failed (will retry next tick)'),
      );
  }, LEASE_RENEW_MS);
  const blockhashCache = new BlockhashCache(async () => {
    const b = await conn.getLatestBlockhash();
    return { blockhash: b.blockhash, lastValidBlockHeight: b.lastValidBlockHeight };
  });
  await blockhashCache.start(); // first sign attempt reads it instantly (no getLatestBlockhash RTT)
  log.info(
    { owner: copier.publicKey.toBase58(), signing: cfg.signingEnabled },
    '🔐 vault started (pull-only)',
  );

  // ASYNC CONFIRM WORKER (3c): the single owner of on-chain confirmation for every broadcast — no signing lane ever
  // waits on the chain. `loadPending` runs BEFORE the boot PEL drain: a 'submitted' row whose cmd:sign was already
  // ACKed by a prior instance (crash after broadcast) has NO PEL copy — the row is its only recovery state.
  // Inc.4d — the confirm worker appends a lamport-exact position_ledger row per confirmed position tx (the fee
  // base's source), as post-confirm bookkeeping OFF the exactly-once path (a write failure never affects finalize).
  const positionLedger = new PositionLedgerRepository(db);
  const confirmWorker = new ConfirmWorker({
    conn,
    db,
    bus,
    events,
    ledger: positionLedger,
    hmacKey,
    log,
  });
  const resumed = await confirmWorker.loadPending();
  if (resumed > 0)
    log.info({ resumed }, '🔎 confirm worker resumed in-flight broadcasts from durable state');
  confirmWorker.start();

  // Inc.4a — signerFor: the SYSTEM/bench wallet signs with its LOCAL keypair (byte-identical to pre-Inc.4); a real
  // user gets a live PrivySessionSigner when PRIVY_SIGNING_ENABLED, else a DryRunSigner (pipeline runs end-to-end,
  // nothing signed). The Privy facade is constructed ONLY when live signing is ON (no credentials needed for bench).
  const systemSigner = new LocalKeypairSigner(copier);
  const privyServer = privyCfg.signingEnabled
    ? new PrivyServer({
        appId: privyCfg.appId,
        appSecret: privyCfg.appSecret,
        authorizationKey: privyCfg.authorizationKey,
      })
    : undefined;
  // Real-user wallet lookup (4b): read the activation row — a provisioned user resolves to (walletId, address,
  // signingDisabled). With PRIVY_SIGNING_ENABLED OFF the resolver still routes to a DryRunSigner (nothing signed);
  // when the flag flips a provisioned+ready user (signing_disabled cleared by the SYSTEM reconciler) signs live.
  // Privy-FREE path: the coffre reads the state through the repository only, never the provisioning/policy modules.
  const activationRepo = new CopybotActivationRepository(db);
  const resolveUserWallet = (userId: string): Promise<UserWallet | null> =>
    activationRepo.resolveSignableWallet(userId);
  const signerFor = createSignerResolver({
    systemSigner,
    privySigningEnabled: privyCfg.signingEnabled,
    resolveUserWallet,
    buildLiveSigner: (wallet) => {
      if (!privyServer)
        throw new Error('unreachable: live signer requested while the Privy facade is unset');
      return new PrivySessionSigner(
        privyServer,
        wallet.walletId,
        wallet.address,
        privyCfg.authorizationKey,
      );
    },
    buildDryRunSigner: (address) => new DryRunSigner(new PublicKey(address), log),
    log,
  });

  // CRASH RECOVERY (no-miss): re-process any cmd:sign a prior (crashed) instance read but never ACKed — its PEL,
  // re-read with XREADGROUP id '0'. Exactly-once is guaranteed by the executions table (a landed command is a
  // duplicate; a stranded 'claimed' one is re-claimable). Without this, a vault crash mid-sign would STRAND an
  // in-flight open/close forever (XREADGROUP '>' never re-delivers it) → a missed copy.
  const ctx: Ctx = {
    conn,
    db,
    bus,
    signerFor,
    blockhashCache,
    events,
    policyFor, // per-message, per-USER sign-time policy (reads the live per-user config cache — SPEC §11)
    signingEnabled: cfg.signingEnabled,
    operatorFeeAddress: cfg.operatorFeeAddress, // Inc.4d Wall B fee-sink allowlist (coffre-trusted, not the request)
    hmacKey,
    retryMax: cfg.retryMax,
    retryDelayMs: cfg.retryDelayMs,
    onSubmitted: (t) => confirmWorker.track(t), // lane → worker hand-off at the broadcast (3c)
    log,
  };
  // 3c PER-USER SIGNING LANES: each message runs on its SIGNED user's lane — FIFO within a user, concurrent across
  // users (bounded) — so one user's slow sign/broadcast never delays another user's close. The batch is awaited as a
  // whole before the next read: per-user FIFO holds ACROSS batches (batch N fully dispatched before batch N+1 is
  // read), memory is bounded to one batch, and a message is ACKed ONLY by its own lane task reaching a terminal
  // outcome (createMessageHandler) — a crash mid-batch leaves every unfinished message in the PEL for the boot drain.
  const lanes = new SigningLanes();
  const handleMessage = createMessageHandler({
    process: (payload, recovering) => process1(payload, ctx, recovering),
    bus,
    events,
    log,
    stream: STREAM,
    group: GROUP,
  });
  const processBatch = async (
    msgs: Awaited<ReturnType<typeof bus.consume>>,
    recovering = false,
  ): Promise<void> => {
    await Promise.all(
      msgs.map((msg) =>
        lanes.dispatch(laneKeyOf(msg.payload), () => handleMessage(msg, recovering)),
      ),
    );
  };
  try {
    // Crash recovery (recovering=true → a stranded 'claimed' from a CRASHED prior instance is re-claimable).
    await processBatch(await bus.consumePending(STREAM, GROUP, CONSUMER, HOP, hmacKey, 100), true);
  } catch (e) {
    events.system('system.recovery_failed', e, {
      stage: 'recover',
      outcome: 'failed',
      reason: 'recovery_failed',
      adminDetail: { phase: 'boot_pending_recovery' },
    });
  }

  let stopped = false;
  const drain = process.argv.includes('--drain'); // one batch then exit (validation)
  // Live config reload. A web config edit publishes a control ping → reload from the DB NOW (re-clamp ceiling in
  // <100ms); the periodic poll is the backstop if a ping is missed.
  const configTimer = setInterval(() => void reloadConfig(), CONFIG_POLL_MS);
  await control.subscribe(() => {
    log.info('🔁 control: config-changed → reloading config now');
    void reloadConfig();
  });
  // Process heartbeat: beat now (web sees the vault online immediately) then on an interval.
  void heartbeat.beat({ signingEnabled: cfg.signingEnabled });
  const heartbeatTimer = setInterval(
    () => void heartbeat.beat({ signingEnabled: cfg.signingEnabled }),
    HEARTBEAT_INTERVAL_MS,
  );
  const stop = async (): Promise<void> => {
    stopped = true;
    clearInterval(configTimer);
    clearInterval(heartbeatTimer);
    clearInterval(leaseTimer);
    confirmWorker.stop();
    blockhashCache.stop();
    await bus.releaseLease(LEASE_KEY, instanceId).catch(() => {}); // best-effort; the TTL reclaims it anyway
    await Promise.all([bus.quit(), control.quit()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  let backoff = 1000;
  do {
    try {
      // Re-drain the PEL FIRST: any message a prior iteration left pending is retried here without waiting for a
      // restart (consumePending at boot alone would strand it until then). recovering=true — a pending message is
      // ALWAYS a prior read that never finalized (a process1 throw, OR a #7 in-flight left unACKed), so it must get
      // the exactly-once recovery pre-check (a landed tx is finalized, a still-in-flight one is left, only a dead
      // one is re-signed). Harmless for a pre-claim throw (no 'submitted' row ⇒ the pre-check is a no-op).
      await processBatch(
        await bus.consumePending(STREAM, GROUP, CONSUMER, HOP, hmacKey, 100),
        true,
      );
      await processBatch(
        await bus.consume(STREAM, GROUP, CONSUMER, HOP, hmacKey, 10, drain ? 3000 : 5000),
      );
      backoff = 1000; // success → reset
    } catch (e) {
      // never crash: record + exponential backoff + continue (Redis/RPC may recover). Internal loop self-failure.
      events.system('system.loop_errored', e, {
        stage: 'sign',
        outcome: 'failed',
        reason: 'loop_errored',
        adminDetail: { loop: 'vault_consume', backoff },
      });
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
    if (drain) break;
  } while (!stopped);
  if (drain) {
    // Validation parity with the old inline-confirm flow: give the async worker a bounded window to confirm what
    // the drained batch just broadcast (so ev:executed is published before exit). See DRAIN_CONFIRM_WAIT_MS.
    const drainStart = Date.now();
    while (confirmWorker.inflightCount > 0 && Date.now() - drainStart < DRAIN_CONFIRM_WAIT_MS)
      await sleep(DRAIN_CONFIRM_POLL_MS);
    await stop();
  }
}

// Auto-run as the process entrypoint. Guarded so importing this module in a unit test (vitest sets process.env.VITEST;
// production never does) does NOT boot the vault — the pure helpers above (routeVerdict/deadLetterCode) stay testable
// without triggering env reads / Redis connections / process.exit.
if (!process.env.VITEST) {
  main().catch((e) => {
    log.error({ err: (e as Error).message }, 'vault fatal');
    process.exit(1);
  });
}
