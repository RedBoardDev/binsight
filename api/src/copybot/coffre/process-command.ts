/**
 * Copy-bot · VAULT critical section (extracted from coffre-main so it is UNIT-TESTABLE in isolation — no top-level
 * side effects, all I/O injected via Ctx). Applies the ordered checks 5→13 BEFORE any signature:
 *  5 Zod strict · 6 staleness (slot ≤ deadline) · 7 commandId == derive(userId + eventKey) · 8 idempotence (claim
 *  BEFORE signing, keyed (userId, commandId); only a 'failed' command is re-claimable) · 9 re-clamp size (the SIGNED
 *  userId's config row — SPEC §11) · 10-11 Wall B (decode WITHOUT
 *  the SDK) · 12 SIGN · 13 LAND. A returned signature is NOT execution: the lane's job ends at the broadcast (3c)
 *  and the row is handed to the async CONFIRM WORKER (`confirm-worker.ts`), which finalizes 'landed'/publishes
 *  ev:executed only on an on-chain confirmation — so a dropped/erroring CLOSE is never recorded as success (which
 *  would strand it as a dormant position — only 'failed' is re-claimable, and a premature ev:executed makes the
 *  brain forget it). No lane ever waits for a confirmation (ULTRACODE #22/#31 head-of-line kill).
 */
import { type Connection, type Keypair, Transaction } from '@solana/web3.js';
import { and, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { claimExecution } from '@/copybot/coffre/idempotency';
import { landViaJito } from '@/copybot/coffre/jito-landing';
import { land } from '@/copybot/coffre/landing';
import { classifySignError, type SignErrorClass } from '@/copybot/coffre/sign-error-classifier';
import { DryRunSkip, type Signer } from '@/copybot/coffre/signer';
import { verifyTx } from '@/copybot/coffre/wall-b';
import { deriveCommandId } from '@/copybot/command-id';
import { derivePositionKeypair } from '@/copybot/ephemeral-position';
import { LOG_MARKER_SUBMITTED } from '@/copybot/log-markers';
import type { CopyEvents } from '@/copybot/observability/copy-events';
import { type SignRequest, SignRequestSchema } from '@/domain/copybot/contracts';
import type { JournalKind } from '@/domain/copybot/journal';
import { type CopyCode, resolveLegacyReason } from '@/domain/copybot/observability/codes';
import type { RedisBus } from '@/infrastructure/bus/redis-bus';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { executions } from '@/infrastructure/persistence/schema';
import type { BlockhashCache } from '@/infrastructure/solana/blockhash-cache';

type Db = ReturnType<typeof openDatabase>;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const LAMPORTS_PER_SOL = 1_000_000_000;
// Wall B SOL-spend ceiling = maxTradeSol × factor + margin. GENEROUS by design (covers a buy's slippage + the WSOL
// ATA rent ~0.00204 SOL) so it NEVER false-rejects a legitimate deposit/buy — it only catches a GROSS over-spend
// (a compromised brain moving far more SOL than the config allows, regardless of the self-reported sizeSol).
const WALL_B_OVERSPEND_FACTOR = 1.1;
const WALL_B_RENT_MARGIN_LAMPORTS = 5_000_000; // 0.005 SOL: WSOL-ATA rent + buffer
const wallBMaxLamports = (maxTradeSol: number): number =>
  Math.ceil(maxTradeSol * LAMPORTS_PER_SOL * WALL_B_OVERSPEND_FACTOR) + WALL_B_RENT_MARGIN_LAMPORTS;

/** Per-user sign-time policy, resolved from the SIGNED `userId`'s config row (SPEC §11/§12). */
export interface UserSignPolicy {
  maxTradeSol: number; // live re-clamp ceiling (this user's DB config; env override wins when set)
  jitoBundleUrl?: string; // when set, land via a Jito bundle (anti-sandwich) with a fallback to plain RPC
}

/**
 * The ev:executed / observability context of ONE broadcast, persisted (`executions.publish_ctx`) alongside the
 * signature by `markSubmitted` so the async confirm worker can finalize AND publish a 'submitted' row even after a
 * restart (the cmd:sign message may already be ACKed — the row, not the PEL, is the durable state past broadcast).
 */
export interface SubmittedPublishCtx {
  kind: JournalKind;
  pool: string;
  positionPubkey: string;
  owner: string;
  sizeSol: number;
  issuedAtMs: number;
}

/** A broadcast handed to the async confirm worker (3c): the exact tx to watch + its publish context. */
export interface TrackedSubmission {
  userId: string;
  commandId: string;
  signature: string;
  lastValidBlockHeight: number;
  publish: SubmittedPublishCtx | null; // null only for a pre-3c legacy row re-read at boot
}

/** Everything the critical section needs — all injected so the function has no hidden module state (testable). */
export interface Ctx {
  conn: Connection;
  db: Db;
  bus: RedisBus;
  /**
   * Resolve the SIGNER for the REQUEST's user (SPEC §11): SYSTEM → a local keypair (bench, byte-identical), a real
   * user → a Privy session signer (or a dry-run signer while the live flag is OFF). Replaces the pre-Inc.4 static
   * `copier: Keypair`. May throw a per-user error (not provisioned / signing disabled) → the lane finalizes 'failed'
   * for THAT command only.
   */
  signerFor: (userId: string) => Promise<Signer>;
  blockhashCache: BlockhashCache;
  events: CopyEvents; // typed observability emitter (replaces the legacy Journal port — P2)
  /** Resolve the sign-time policy for the REQUEST's user (never a hardcoded tenant — SPEC §11). */
  policyFor: (userId: string) => Promise<UserSignPolicy>;
  signingEnabled: boolean; // false ⇒ dry-run (log "I would sign")
  /** The coffre's OWN trusted operator fee sink (Inc.4d, SPEC §9) — the ONE allowlisted non-owner outflow, and
   *  only for a `kind:'fee'` tx. Empty ('') ⇒ no sink ⇒ Wall B rejects any fee tx (fail-closed). Sourced from the
   *  coffre env, NEVER from the request, so a compromised brain cannot redirect the fee. */
  operatorFeeAddress: string;
  hmacKey: string; // ev:executed envelope key
  retryMax: number; // sign+land attempts when land THROWS (no signature produced)
  retryDelayMs: number;
  /** Hand a BROADCAST tx to the async confirm worker (3c). In-memory only — MUST never throw. */
  onSubmitted: (t: TrackedSubmission) => void;
  /**
   * Wave 4e — a per-user CUSTODY sign-failure side effect (Privy outage #20 / revoked delegation #21). Injected so
   * the critical section stays testable: 'outage' → the coffre flips a `signingAvailable:false` heartbeat flag;
   * 'revoked' → disable signing for THAT user (its open mirrors are KEPT for the reconcile). Absent on the SYSTEM/
   * bench path (a local keypair never throws a Privy custody error). MUST be per-user isolated — one user's failure
   * never affects another. Best-effort: a throw here must not break the lane (the caller guards it).
   */
  onSignError?: (e: {
    class: Exclude<SignErrorClass, 'other'>;
    userId: string;
    owner: string;
    message?: string;
  }) => Promise<void>;
  log: Logger;
}

/**
 * Resolve a bare Wall B reason leaf (e.g. `signer_not_owner`, `program_not_allowed`) to its `wallb.<leaf>` code.
 * The legacy journaled reason is `wallb:<leaf>` — `resolveLegacyReason` knows the two aliased forms; the rest are
 * the unique `wallb.<leaf>` namespace leaf. Falls back to `wallb.program_not_allowed` only for a never-seen leaf
 * (all Wall B rejects are a program/signer/destination violation of the same FAILSAFE class). Pure.
 */
function resolveWallbCode(leaf: string): CopyCode {
  return (
    resolveLegacyReason(`wallb:${leaf}`) ?? resolveLegacyReason(leaf) ?? 'wallb.program_not_allowed'
  );
}

/** Persist the terminal state of a command (the idempotency record — keyed per tenant, SPEC §11). */
export async function finalize<T extends { ok: boolean }>(
  db: Db,
  userId: string,
  commandId: string,
  state: string,
  verdict: T,
): Promise<T> {
  await db
    .update(executions)
    .set({ state, updatedAt: Date.now() })
    .where(and(eq(executions.userId, userId), eq(executions.commandId, commandId)));
  return verdict;
}

/**
 * CONDITIONAL finalize of a broadcast row — the exactly-once landing gate (3c). Both the async confirm worker and
 * the boot recovery pre-check can resolve the SAME 'submitted' row concurrently (worker re-read at boot vs the PEL
 * re-delivery of the same command): the compare-and-set (state still pre-terminal AND the signature is STILL the
 * exact broadcast the caller watched) elects exactly ONE winner — only the winner may publish ev:executed / emit.
 * The signature pin also protects a RE-CLAIMED command (a provably-dead tx being re-signed): the re-claim clears
 * the stale signature, so a delayed resolve of the OLD broadcast can never finalize the new attempt's row.
 */
export async function finalizeSubmitted(
  db: Db,
  userId: string,
  commandId: string,
  signature: string,
  state: 'landed' | 'failed',
): Promise<boolean> {
  const won = await db
    .update(executions)
    .set({ state, updatedAt: Date.now() })
    .where(
      and(
        eq(executions.userId, userId),
        eq(executions.commandId, commandId),
        eq(executions.signature, signature),
        // 'claimed' covers the legacy pre-#7 shape (signature persisted before the state flipped) — harmless now
        // that a re-claim clears the signature (the pin above can never match a re-claimed row).
        inArray(executions.state, ['submitted', 'claimed']),
      ),
    )
    .returning({ commandId: executions.commandId });
  return won.length > 0;
}

/**
 * EXACTLY-ONCE (#7): persist the broadcast signature + its blockhash expiry to state 'submitted' BEFORE the tx goes
 * on the wire. If the vault crashes AFTER land() but BEFORE the confirm worker finalizes, recovery (worker re-read
 * + boot pre-check) reads this row and checks the chain — re-signing only when the prior tx is PROVABLY dead (never
 * double-broadcasting an add/buy/sell). `publishCtx` (3c) makes the row self-sufficient for the worker's publish.
 */
export async function markSubmitted(
  db: Db,
  userId: string,
  commandId: string,
  signature: string,
  lastValidBlockHeight: number,
  nowMs: number,
  publishCtx: SubmittedPublishCtx,
): Promise<void> {
  await db
    .update(executions)
    .set({ state: 'submitted', signature, lastValidBlockHeight, publishCtx, updatedAt: nowMs })
    .where(and(eq(executions.userId, userId), eq(executions.commandId, commandId)));
}

/**
 * Publish ev:executed for a CONFIRMED landing — the single shared publisher (inline recovery + confirm worker).
 * A publish failure is swallowed (logged): after a confirmed land the on-chain action is irreversible, and a lost
 * ev:executed is a degraded (reconcile/PEL-backstopped) outcome — strictly better than any retry that could
 * double-execute. ioredis already retries connection blips.
 */
export async function publishExecuted(
  bus: RedisBus,
  hmacKey: string,
  log: Logger,
  info: {
    userId: string;
    commandId: string;
    kind: string;
    sig: string;
    pool: string;
    positionPubkey: string;
    owner: string;
  },
): Promise<void> {
  try {
    await bus.publish('copybot:ev:executed', 'ev:executed', hmacKey, {
      commandId: info.commandId,
      kind: info.kind,
      sig: info.sig,
      pool: info.pool,
      positionPubkey: info.positionPubkey,
      owner: info.owner,
      userId: info.userId, // tenant of the landed command (3b: the brain routes the confirm to that user's runtime)
    });
  } catch (e) {
    log.error(
      { kind: info.kind, sig: info.sig, error: (e as Error).message },
      'ev:executed publish failed after a confirmed land — brain will backstop via reconcile/PEL',
    );
  }
}

/**
 * Emit the definitive-failure pair for a command that could not land: the INTERNAL sign trace (`sign.land_failed`)
 * and the FEED-VISIBLE pinned lifecycle/failsafe alert the user must act on ("VERIFY/CLOSE MANUALLY"). Shared by
 * the lane's sign/land-threw path and the confirm worker's expiry path (same alert semantics, SPEC §2.1).
 * A close/open maps to its precise `lifecycle.*_failed` (risk of a dormant position); any other kind to the generic
 * pinned `failsafe.failed`. `meteoraUrl` carries the "close manually" link.
 */
export function emitLandFailure(
  events: CopyEvents,
  info: { kind?: JournalKind; pool?: string; positionPubkey?: string; commandId: string },
  error: string | undefined,
): void {
  const meteoraUrl = info.pool ? `https://app.meteora.ag/dlmm/${info.pool}` : undefined;
  events.emit('sign.land_failed', {
    stage: 'sign',
    outcome: 'failed',
    reason: 'sign_land_failed',
    kind: info.kind,
    pool: info.pool,
    ourPosition: info.positionPubkey,
    commandId: info.commandId,
    adminDetail: { error },
  });
  const failCode: CopyCode =
    info.kind === 'close'
      ? 'lifecycle.close_failed'
      : info.kind === 'open'
        ? 'lifecycle.open_failed'
        : 'failsafe.failed';
  events.emit(failCode, {
    stage: 'sign',
    outcome: 'failed',
    reason: 'sign_land_failed',
    kind: info.kind,
    pool: info.pool,
    ourPosition: info.positionPubkey,
    commandId: info.commandId,
    adminDetail: { error, meteoraUrl, position: info.positionPubkey },
  });
}

/** The fate of a previously-broadcast tx, decided from the chain (exactly-once recovery pre-check). */
type PriorTxFate = 'landed' | 'dead' | 'in-flight';

/**
 * Classify a previously-broadcast signature from the chain (exactly-once recovery):
 *  - a confirmed/finalized success → 'landed' (the money already moved; NEVER re-sign);
 *  - an on-chain error → 'dead' (Solana txs are atomic → the tx fully reverted, nothing applied → safe to re-sign);
 *  - not found (dropped or too-fresh-to-index) → 'dead' only once the blockhash is PROVABLY expired
 *    (`getBlockHeight > lastValidBlockHeight`), else 'in-flight' (it may still land → do NOT re-sign this pass);
 *  - found but only 'processed' (not yet durable) → 'in-flight'.
 */
export async function classifyPriorTx(
  conn: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<PriorTxFate> {
  const { value } = await conn.getSignatureStatus(signature);
  if (value) {
    if (value.err) return 'dead'; // atomically reverted → nothing applied
    if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized')
      return 'landed';
    return 'in-flight'; // 'processed' only → not durable yet
  }
  // Not found: dropped (dead) vs. not-yet-indexed (in-flight) is disambiguated by the blockhash's expiry.
  const height = await conn.getBlockHeight('confirmed');
  return height > lastValidBlockHeight ? 'dead' : 'in-flight';
}

/**
 * Recovery pre-check (money-path exactly-once): for a command whose executions row already carries a BROADCAST
 * signature ('submitted', or a legacy 'claimed' that reached the wire), decide from the chain BEFORE re-signing:
 *  - 'landed' → finalize 'landed', re-publish ev:executed (idempotent downstream), and SKIP signing;
 *  - 'in-flight' → leave the message for a later recovery pass (retryLater: no ACK), do NOT re-sign;
 *  - 'dead' (or no stored signature) → return null → the caller proceeds to re-claim + re-sign normally.
 * Runs only on the vault boot/PEL recovery path. Not applied to forceReclaim (failsafe/orphan) closes, which keep
 * their existing always-retry semantics (a close re-sign is harmless — the account is either gone or gets re-closed).
 */
export async function recoveryPreCheck(
  ctx: Ctx,
  sr: SignRequest,
): Promise<{ ok: boolean; reason?: string; kind?: string; retryLater?: boolean } | null> {
  const { conn, db, bus, events, log } = ctx;
  const rows = await db
    .select({
      state: executions.state,
      signature: executions.signature,
      lastValidBlockHeight: executions.lastValidBlockHeight,
    })
    .from(executions)
    .where(and(eq(executions.userId, sr.userId), eq(executions.commandId, sr.commandId)));
  const prior = rows[0];
  // Nothing was broadcast (no row, no stored signature, or a terminal state) → safe to (re-)claim + sign normally.
  if (!prior?.signature || (prior.state !== 'submitted' && prior.state !== 'claimed')) return null;
  const fate = await classifyPriorTx(conn, prior.signature, prior.lastValidBlockHeight ?? 0);
  if (fate === 'in-flight')
    return { ok: false, reason: 'recover_in_flight', kind: sr.kind, retryLater: true };
  if (fate === 'dead') return null; // provably dead → fall through to re-claim + re-sign
  // 'landed': the money already moved — never re-sign. The CONDITIONAL finalize elects the exactly-once publisher:
  // the async confirm worker may resolve this very row concurrently (it re-reads 'submitted' rows at boot), and
  // only the compare-and-set winner may publish ev:executed — the loser just acknowledges the terminal outcome.
  if (!(await finalizeSubmitted(db, sr.userId, sr.commandId, prior.signature, 'landed'))) {
    log.info(
      { kind: sr.kind, sig: prior.signature },
      '🔁 recovery: prior tx already finalized by the confirm worker — nothing to re-publish',
    );
    return { ok: true, kind: sr.kind };
  }
  await publishExecuted(bus, ctx.hmacKey, log, {
    userId: sr.userId,
    commandId: sr.commandId,
    kind: sr.kind,
    sig: prior.signature,
    pool: sr.pool,
    positionPubkey: sr.positionPubkey,
    owner: sr.owner,
  });
  events.emit('sign.landed', {
    stage: 'sign',
    outcome: 'landed',
    kind: sr.kind,
    pool: sr.pool,
    ourPosition: sr.positionPubkey,
    commandId: sr.commandId,
    signature: prior.signature,
    ourSizeSol: sr.sizeSol,
    latencyMs: Date.now() - sr.issuedAtMs,
    adminDetail: { recovering: true, recovered: true },
  });
  log.info(
    { kind: sr.kind, sig: prior.signature },
    '🔁 recovery: prior tx already landed — finalized without re-signing',
  );
  return { ok: true, kind: sr.kind }; // the conditional finalize above already flipped the row to 'landed'
}

/** The critical section 5→13 (1-4 done by the bus). Returns a loggable verdict. Effects = DB + log + (when enabled) sign/land. */
export async function process1(
  payload: unknown | null,
  ctx: Ctx,
  recovering = false,
): Promise<{ ok: boolean; reason?: string; kind?: string; retryLater?: boolean }> {
  const { conn, db, blockhashCache, events, log } = ctx;
  if (payload == null) return { ok: false, reason: 'bad_hmac_or_hop' }; // 1-4 failed (bus)
  const parsed = SignRequestSchema.safeParse(payload); // 5
  if (!parsed.success) return { ok: false, reason: 'bad_schema' };
  const sr = parsed.data;
  // Sign-time policy for the SIGNED tenant (SPEC §11): the request's userId — validated by the schema and covered
  // by the HMAC envelope — selects the caps/config row. Never a hardcoded SYSTEM user.
  const { maxTradeSol, jitoBundleUrl } = await ctx.policyFor(sr.userId);

  const action = sr.eventKey.split(':')[2]; // `${leader}:${pool}:${action}:${position}:${signature}` — action stays at index 2 (all fields base58, no ':')
  const forceReclaim = sr.kind === 'close' && (action === 'failsafe' || action === 'orphan');

  // EXACTLY-ONCE recovery pre-check (#7) — BEFORE staleness/claim: a prior instance may have crashed after putting
  // the tx on the wire (state 'submitted') but before finalize('landed'). We check the chain FIRST (a landed tx is
  // landed regardless of the deadline) and re-sign ONLY a provably-dead tx. Skipped for forceReclaim closes (keep
  // their always-retry semantics — a close re-sign is harmless). null ⇒ nothing broadcast / dead → proceed normally.
  if (recovering && !forceReclaim) {
    const pre = await recoveryPreCheck(ctx, sr);
    if (pre) return pre;
  }

  const slot = await conn.getSlot(); // 6 staleness
  if (slot > sr.deadlineSlot) return { ok: false, reason: 'stale', kind: sr.kind };

  // 7 — commandId v2 = derive(userId + eventKey): re-derived from the SIGNED pair, so a tampered userId (or a
  // cross-tenant replay of another user's command) can never bind to this commandId's idempotency slot.
  if (sr.commandId !== deriveCommandId(sr.userId, sr.eventKey))
    return { ok: false, reason: 'commandId_mismatch', kind: sr.kind };

  // 8 idempotency: claim BEFORE signing; only a previously 'failed' command may be re-claimed (retry). EXCEPTION: a
  // reconcile-driven failsafe/orphan CLOSE (eventKey action 'failsafe'/'orphan') is emitted only while the position
  // is PROVABLY still on-chain → it must retry regardless of a stale terminal state, or a phantom is stuck forever.
  const now = Date.now();
  const owned = await claimExecution(
    db,
    sr.userId,
    sr.commandId,
    sr.eventKey,
    sr.deadlineSlot,
    now,
    recovering,
    forceReclaim,
  );
  if (!owned) return { ok: false, reason: 'duplicate', kind: sr.kind };

  // Resolve the SIGNER for the SIGNED tenant (SPEC §11): the request's userId selects the wallet + its signing
  // authority. Done AFTER the claim so a per-user resolution failure finalizes THIS command 'failed' (re-claimable)
  // and is isolated to THAT user — never a global stop (SPEC §17.4). `ourOwner` (the wallet we will actually sign
  // FOR) then gates the Wall B owner check below: a forged owner/userId can never route the tx to another wallet.
  let signer: Signer;
  try {
    signer = await ctx.signerFor(sr.userId);
  } catch (e) {
    log.warn(
      { userId: sr.userId, kind: sr.kind, error: (e as Error).message },
      'signer unavailable for this user — skipping (per-user isolation)',
    );
    return finalize(db, sr.userId, sr.commandId, 'failed', {
      ok: false,
      reason: 'signer_unavailable',
      kind: sr.kind,
    });
  }
  const ourOwner = signer.publicKey.toBase58();

  if (sr.sizeSol > maxTradeSol) {
    events.emit('sign.over_max_trade', {
      stage: 'sign',
      outcome: 'rejected',
      reason: 'over_max_trade',
      kind: sr.kind,
      pool: sr.pool,
      ourPosition: sr.positionPubkey,
      commandId: sr.commandId,
      ourSizeSol: sr.sizeSol,
    });
    return finalize(db, sr.userId, sr.commandId, 'failed', {
      ok: false,
      reason: 'over_max_trade',
      kind: sr.kind,
    }); // 9 re-clamp
  }

  // 10-11 Wall B: decode the tx (WITHOUT the SDK) and re-verify against the intent.
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(sr.txBase64, 'base64'));
  } catch {
    return finalize(db, sr.userId, sr.commandId, 'failed', {
      ok: false,
      reason: 'undecodable_tx',
      kind: sr.kind,
    });
  }
  if (sr.owner !== ourOwner)
    return finalize(db, sr.userId, sr.commandId, 'failed', {
      ok: false,
      reason: 'owner_mismatch',
      kind: sr.kind,
    });
  // Wall B binds a swap to owner's ATA of its non-SOL token: sell = the token sold, buy = the token bought. For a
  // 'fee' it binds the ONLY allowed non-owner outflow to the coffre's OWN operator sink ('' ⇒ undefined ⇒ reject).
  const wb = verifyTx(tx, {
    owner: sr.owner,
    pool: sr.pool,
    kind: sr.kind,
    positionPubkey: sr.positionPubkey,
    inputMint: sr.sell?.inputMint ?? sr.buy?.outputMint,
    maxLamports: wallBMaxLamports(maxTradeSol),
    operatorFeeAddress: ctx.operatorFeeAddress || undefined,
  });
  if (!wb.ok) {
    // Wall B reject → its precise `wallb.<leaf>` code. The verbatim journaled reason stays `wallb:<wb.reason>`
    // (a `program_not_allowed:<prog>` carries its dynamic `<prog>` into adminDetail, per SPEC §2.1). The leaf is
    // resolved from the bare wallb reason (the `:<prog>` suffix stripped) — all wallb leaves are internal.
    const leaf = wb.reason.split(':')[0] ?? wb.reason; // strip a dynamic `:${prog}` suffix (program_not_allowed)
    const code = resolveWallbCode(leaf);
    events.emit(code, {
      stage: 'sign',
      outcome: 'rejected',
      reason: `wallb:${wb.reason}`,
      kind: sr.kind,
      pool: sr.pool,
      ourPosition: sr.positionPubkey,
      commandId: sr.commandId,
      adminDetail: wb.reason.includes(':')
        ? { program: wb.reason.slice(wb.reason.indexOf(':') + 1) }
        : undefined,
    });
    return finalize(db, sr.userId, sr.commandId, 'failed', {
      ok: false,
      reason: `wallb:${wb.reason}`,
      kind: sr.kind,
    });
  }

  // 12-13 SIGN + LAND
  const busMs = Date.now() - sr.issuedAtMs; // latency publish(brain) → here (bus + critical section)
  if (!ctx.signingEnabled) {
    log.info(
      { kind: sr.kind, pool: sr.pool, our: sr.positionPubkey, sizeSol: sr.sizeSol, busMs },
      '✍️  (dry-run) I would sign+land',
    );
    return finalize(db, sr.userId, sr.commandId, 'skipped', {
      ok: true,
      reason: 'dry-run',
      kind: sr.kind,
    });
  }
  // Retry config (fresh blockhash on each attempt), then ALERT "verify/close manually" (Valhalla-style).
  let lastErr: Error | undefined;
  // Once the tx is ON THE WIRE the lane's job is DONE (3c): confirmation is the async worker's. We record the
  // broadcast here and break out of the retry scope: the worker hand-off runs BELOW, OUTSIDE the try, so nothing
  // after a successful broadcast can re-enter sign/land (which would DOUBLE-execute — a 2nd add/buy/sell/remove
  // has no on-chain idempotency).
  const publishCtx: SubmittedPublishCtx = {
    kind: sr.kind,
    pool: sr.pool,
    positionPubkey: sr.positionPubkey,
    owner: sr.owner,
    sizeSol: sr.sizeSol,
    issuedAtMs: sr.issuedAtMs,
  };
  let broadcastSig: string | undefined;
  let broadcastLvbh = 0;
  let dryRunSkipped = false; // the signer declined (DryRunSkip): finalize a benign 'skipped', NOT a land failure
  let signErrorClass: Exclude<SignErrorClass, 'other'> | undefined; // 4e: a per-user Privy custody failure (outage/revoked)
  for (let attempt = 0; attempt <= ctx.retryMax; attempt++) {
    try {
      const tSign = Date.now();
      const fresh = Transaction.from(Buffer.from(sr.txBase64, 'base64')); // fresh tx per attempt
      // First attempt: the cached blockhash + expiry (no RTT) — but ONLY if it's fresh enough to submit with
      // (`getFresh` misses when the cache went stale during RPC instability, exactly when a close matters most).
      // Retries always fetch fresh. A miss on attempt 0 falls back to a live getLatestBlockhash, same as a retry.
      const cachedBh = attempt === 0 ? blockhashCache.getFresh() : undefined;
      const bh = cachedBh ?? (await conn.getLatestBlockhash());
      // feePayer + blockhash freeze the MESSAGE before signing (the owner + any co-signer sign the same bytes).
      fresh.feePayer = signer.publicKey;
      fresh.recentBlockhash = bh.blockhash;
      // Only an OPEN needs the ephemeral position co-signer; the OWNER is signed by the resolved signer (local key or
      // Privy TEE). `signature` is the owner signature (== land()'s return), the exactly-once pin. The SYSTEM/local
      // path reproduces the pre-Inc.4 `fresh.sign(copier, ...co)` bytes exactly.
      const coSigners: Keypair[] = sr.kind === 'open' ? [derivePositionKeypair(sr.commandId)] : [];
      const { raw, signature } = await signer.sign(fresh, coSigners);
      // EXACTLY-ONCE (#7): persist signature + blockhash expiry (+ the worker's publish context, 3c) to 'submitted'
      // BEFORE broadcasting. A crash after land() but before the worker finalizes is then recoverable — the worker
      // re-reads 'submitted' rows and boot recovery re-signs ONLY a provably-dead tx.
      await markSubmitted(
        db,
        sr.userId,
        sr.commandId,
        signature,
        bh.lastValidBlockHeight,
        Date.now(),
        publishCtx,
      );
      // Land via a Jito bundle when configured (anti-sandwich; falls back to plain RPC internally), else plain RPC.
      if (jitoBundleUrl) await landViaJito(conn, jitoBundleUrl, raw, signature);
      else await land(conn, raw);
      // Tx ON THE WIRE — this is the CONTROLLABLE latency endpoint (event → submitted), the price-relevant moment.
      // Logged here so latency tracking reflects submission speed, not chain-confirm time (harness contract).
      log.info(
        { kind: sr.kind, sig: signature, busMs, submitMs: Date.now() - tSign },
        LOG_MARKER_SUBMITTED,
      );
      // Broadcast → TERMINAL for the lane. Record it and LEAVE the retry scope; the worker hand-off runs below
      // where a failure can no longer re-sign/re-land.
      broadcastSig = signature;
      broadcastLvbh = bh.lastValidBlockHeight;
      break;
    } catch (e) {
      if (e instanceof DryRunSkip) {
        // The signer declined (a real user while the live flag is OFF): NOT a land failure — never retried, and the
        // throw is BEFORE markSubmitted so NOTHING is on the wire. Finalize a benign 'skipped' below.
        dryRunSkipped = true;
        break;
      }
      const klass = classifySignError(e);
      if (klass !== 'other') {
        // A per-user CUSTODY failure (Privy outage #20 / revoked delegation #21), NOT a transient land error → do
        // NOT burn the remaining sign/land retries (a PrivySessionSigner already exhausted its own bounded backoff).
        // The throw is BEFORE markSubmitted, so NOTHING is on the wire. Capture the class + break; the branch below
        // emits the pinned alert + runs the injected per-user side effect, then finalizes 'failed' (re-claimable —
        // the reconcile re-publishes the close; never-miss). Isolated to THIS user (SPEC §11/§17).
        signErrorClass = klass;
        lastErr = e as Error;
        break;
      }
      lastErr = e as Error;
      log.warn({ kind: sr.kind, attempt, error: lastErr.message }, 'sign/land failed — retry');
      if (attempt < ctx.retryMax) await sleep(ctx.retryDelayMs);
    }
  }

  if (dryRunSkipped) {
    // A benign, non-poison terminal outcome (like the coffre-wide dry-run above): the lane ACKs it and the confirm
    // worker never picks it up (only 'submitted' rows carry a broadcast). The pipeline ran end-to-end, nothing signed.
    log.info(
      { kind: sr.kind, pool: sr.pool, our: sr.positionPubkey, busMs },
      '✍️  (dry-run) signer declined — finalizing skipped',
    );
    return finalize(db, sr.userId, sr.commandId, 'skipped', {
      ok: true,
      reason: 'dry-run',
      kind: sr.kind,
    });
  }

  if (signErrorClass) {
    // A Privy CUSTODY failure (outage/revoked) — NOTHING was broadcast (thrown before markSubmitted). Emit the pinned
    // alert (operator Discord + the user's feed banner) and run the injected per-user side effect (4e: outage → the
    // `signingAvailable:false` heartbeat flag; revoked → disable signing for THIS user, keeping its mirrors for the
    // reconcile). Then finalize 'failed' (re-claimable): the reconcile re-publishes the close until it lands — an
    // outage self-heals when Privy returns; a revoked user's mirrors are retried once they re-authorize (never-miss).
    const code: CopyCode =
      signErrorClass === 'outage' ? 'system.signing_unavailable' : 'system.delegation_revoked';
    events.emit(code, {
      stage: 'sign',
      outcome: 'failed',
      reason: signErrorClass === 'outage' ? 'privy_outage' : 'delegation_revoked',
      kind: sr.kind,
      pool: sr.pool,
      ourPosition: sr.positionPubkey,
      commandId: sr.commandId,
      adminDetail: { userId: sr.userId, error: lastErr?.message },
    });
    try {
      await ctx.onSignError?.({
        class: signErrorClass,
        userId: sr.userId,
        owner: ourOwner,
        message: lastErr?.message,
      });
    } catch (e) {
      // Best-effort per-user side effect — a failure to flip the flag/disable must never break the lane (the pinned
      // alert already fired + the command finalizes 'failed'; the reconcile keeps the never-miss guarantee).
      log.warn(
        { userId: sr.userId, err: (e as Error).message },
        'onSignError side effect failed (non-fatal)',
      );
    }
    return finalize(db, sr.userId, sr.commandId, 'failed', {
      ok: false,
      reason: `sign_${signErrorClass}`,
      kind: sr.kind,
    });
  }

  if (broadcastSig) {
    // ASYNC CONFIRM (3c): the lane frees HERE — no in-lane confirmation wait (a slow/unconfirmed tx must never
    // head-of-line-block another user's CLOSE, ULTRACODE #22/#31). The confirm worker owns the 'submitted' row from
    // now on: it batch-polls the chain and either finalizes 'landed' + publishes ev:executed, or finalizes 'failed'
    // (re-claimable, pinned alert) on blockhash expiry. ACKing the message after this verdict is safe: the row
    // (signature + lastValidBlockHeight + publishCtx) is the durable recovery state, not the PEL.
    ctx.onSubmitted({
      userId: sr.userId,
      commandId: sr.commandId,
      signature: broadcastSig,
      lastValidBlockHeight: broadcastLvbh,
      publish: publishCtx,
    });
    return { ok: true, reason: 'submitted', kind: sr.kind };
  }
  // Definitive failure (land threw after retries — no broadcast succeeded) → emergency. The shared failure pair:
  // the INTERNAL sign trace + the FEED-VISIBLE pinned "VERIFY/CLOSE MANUALLY" alert. State 'failed' so the
  // reconcile/orphan backstop re-drives it. NOTE: the row may sit in 'submitted' (markSubmitted ran, then land
  // threw) — the worker never tracked it (onSubmitted only fires after a successful broadcast), so this
  // unconditional finalize has no concurrent owner to race.
  emitLandFailure(
    events,
    { kind: sr.kind, pool: sr.pool, positionPubkey: sr.positionPubkey, commandId: sr.commandId },
    lastErr?.message,
  );
  return finalize(db, sr.userId, sr.commandId, 'failed', {
    ok: false,
    reason: 'sign_land_failed',
    kind: sr.kind,
  });
}
