/**
 * Copy-bot · BRAIN — `ev:executed` per-message dispatch (pure glue, extracted for testability + error isolation).
 *
 * The brain consumes the vault's `ev:executed` stream to react to LANDED commands (a close → prompt markClosed +
 * residual sell; a buy → build the deferred open/reshape add; a create → the Token-2022 deposit; observability
 * confirms). Missing a confirmation — ESPECIALLY a close — is forbidden (robustness pillar), so this mirrors the
 * COFFRE's proven consume pattern (coffre-main `processBatch`):
 *   · EACH message is dispatched under its OWN try/catch — a throwing handler (a DB blip in `onCloseConfirmed`, a
 *     failed ack, …) is recorded and the loop CONTINUES to the next message; it is NOT acked, so it stays in the PEL.
 *   · The caller drains the PEL (`consumePending`) before each `'>'` read, so a delivered-but-unACKed message
 *     (left by a transient throw or a same-process restart) is re-delivered for an idempotent retry.
 *
 * All handlers are idempotent on re-delivery: `onCloseConfirmed` → markClosed no-ops once the mirror is closed;
 * the deferred-publish handlers (`publish*AfterBuy` / `publishDepositAfterPositionCreated` / `finalizeToken2022Open`)
 * consume a pending map keyed by a deterministic commandId whose entry is a RETRY TOKEN dropped only once the
 * continuation SETTLES (finding #137 — see runContinuation below), so a re-run after success is a clean no-op AND a
 * transient RPC/DB failure keeps the token for the PEL retry instead of losing the open; the `*Confirmed` handlers
 * are observability-only (emit-deduped).
 */

/** The subset of an `ev:executed` payload the dispatch reads (kind + the correlation keys). */
export interface ExecutedEvent {
  kind?: string;
  pool?: string;
  positionPubkey?: string;
  commandId?: string;
  sig?: string;
  /** Tenant of the landed command (3b fan-out: routes the confirm to that user's runtime — see executed-router).
   *  OPTIONAL: messages already in flight across a deploy predate the field; the router falls back to
   *  position/commandId ownership for those. */
  userId?: string;
}

/** The handler callbacks the dispatch routes to. The async ones may reject on a transient failure (the caller's
 *  per-message guard isolates it); the sync `*Confirmed` handlers are observability-only and never throw. */
export interface DispatchExecutedDeps {
  /** `userId` (additive, 3b) lets the caller route the confirm to the owning runtime — see executed-router. */
  onCloseConfirmed: (ourPosition: string, userId?: string) => Promise<void>;
  onCloseExecuted: (ev: {
    pool: string;
    positionPubkey?: string;
    commandId?: string;
    userId?: string;
  }) => Promise<void>;
  hasPendingReshapeAdd: (commandId: string) => boolean;
  /** `buySig` (#140) = the landed buy's tx signature → the BUY ledger row's idempotent sig at the open persist. */
  publishReshapeAddAfterBuy: (commandId: string, buySig?: string) => Promise<void>;
  publishTwoSidedOpenAfterBuy: (commandId: string, buySig?: string) => Promise<void>;
  hasPendingToken2022Deposit: (commandId: string) => boolean;
  publishDepositAfterPositionCreated: (commandId: string) => Promise<void>;
  onOpenConfirmed: (ourPosition: string) => void;
  hasPendingToken2022Mirror: (commandId: string) => boolean;
  finalizeToken2022Open: (commandId: string) => Promise<void>;
  onAddConfirmed: (ourPosition: string, commandId: string) => void;
  onClaimConfirmed: (ourPosition: string, commandId: string) => void;
  /** #140 — a landed residual SELL: writes the position's SELL ledger row + assesses the DEFERRED fee (SPEC §9),
   *  plus the observability feed. Async (best-effort inside): a transient failure is swallowed and re-covered by
   *  the periodic fee backstop, so it never un-ACKs the sell message. */
  onSellConfirmed: (ev: ExecutedEvent) => Promise<void>;
  /** ev:executed(fee) → the 5% performance-fee transfer landed → mark the fee 'landed' + emit the transparency row
   *  (Inc.4d). Async (a bounded DB write): a transient failure rejects → the message is retried (markLanded is
   *  idempotent). A fee is decoupled from the close — this never affects any close. */
  onFeeConfirmed: (ev: ExecutedEvent) => Promise<void>;
}

/** Route ONE `ev:executed` payload to its handler; returns whether a branch consumed it (`true`) or the message
 *  could NOT be routed — a null payload (failed HMAC/hop) or an unknown kind (`false`) — so the caller records it
 *  LOUDLY before acking (finding #25) instead of silently dropping it. Rejects iff the routed handler rejects (the
 *  caller's per-message try/catch turns that into a non-ack + retry). Branch order/conditions are identical to the
 *  original inline loop — do NOT reorder (a Token-2022 create/deposit 'open'/'add' must be caught by its pending-map
 *  branch BEFORE the classic-confirm branch). */
export async function dispatchExecuted(
  ev: ExecutedEvent | null,
  deps: DispatchExecutedDeps,
): Promise<boolean> {
  if (ev?.kind === 'close' && ev.pool) {
    if (ev.positionPubkey) await deps.onCloseConfirmed(ev.positionPubkey, ev.userId); // prompt DB markClosed — no 30s wait
    await deps.onCloseExecuted({
      pool: ev.pool,
      positionPubkey: ev.positionPubkey,
      commandId: ev.commandId,
      userId: ev.userId,
    });
    return true;
  }
  if (ev?.kind === 'buy' && ev.commandId) {
    // a token BUY just landed → build+publish the OPEN (open buy) or the RESHAPE ADD (reshape buy). `ev.sig` (#140)
    // is the buy's tx signature → the deferred publisher attributes the BUY ledger row to the position it funds.
    if (deps.hasPendingReshapeAdd(ev.commandId))
      await deps.publishReshapeAddAfterBuy(ev.commandId, ev.sig);
    else await deps.publishTwoSidedOpenAfterBuy(ev.commandId, ev.sig);
    return true;
  }
  if (ev?.kind === 'open' && ev.commandId && deps.hasPendingToken2022Deposit(ev.commandId)) {
    // a Token-2022 / split open's empty position (TX1) CONFIRMED → build+publish the deposit (TX2).
    await deps.publishDepositAfterPositionCreated(ev.commandId);
    return true;
  }
  if (ev?.kind === 'open' && ev.positionPubkey) {
    // a CLASSIC 1-tx open LANDED → FEED `lifecycle.open_confirmed`. Observability-only. A Token-2022 create/split
    // open is ALWAYS consumed by the pending-deposit branch just above (its commandId is in that pending map), so
    // reaching here means a classic single-tx open — no negated re-check of `hasPendingToken2022Deposit` needed (#61).
    deps.onOpenConfirmed(ev.positionPubkey);
    return true;
  }
  if (ev?.kind === 'add' && ev.commandId && deps.hasPendingToken2022Mirror(ev.commandId)) {
    // a Token-2022 open's deposit (TX2) landed → persist the mirror.
    await deps.finalizeToken2022Open(ev.commandId);
    return true;
  }
  if (ev?.kind === 'add' && ev.positionPubkey && ev.commandId) {
    // a CLASSIC reshape ADD leg LANDED → FEED `lifecycle.add_confirmed`. Observability-only.
    deps.onAddConfirmed(ev.positionPubkey, ev.commandId);
    return true;
  }
  if (ev?.kind === 'claim' && ev.positionPubkey && ev.commandId) {
    // a fees CLAIM LANDED → FEED `lifecycle.claim_confirmed`. Observability-only.
    deps.onClaimConfirmed(ev.positionPubkey, ev.commandId);
    return true;
  }
  if (ev?.kind === 'sell') {
    // a residual token→SOL SELL LANDED → write its position SELL ledger row + assess the DEFERRED fee (#140) AND
    // FEED `swap.executed`. Best-effort inside; the periodic backstop covers a sell that never confirms.
    await deps.onSellConfirmed(ev);
    return true;
  }
  if (ev?.kind === 'fee') {
    // the 5% performance-fee transfer LANDED → mark the fee 'landed' + FEED `fee.landed` (Inc.4d, SPEC §9).
    await deps.onFeeConfirmed(ev);
    return true;
  }
  // No branch consumed it: a null payload (failed HMAC/hop) or an unknown kind → the caller records it loudly (#25).
  return false;
}

/** A consumed bus message (id + authenticated payload, or null if the MAC/hop mismatched). */
export interface ExecutedMessage {
  id: string;
  payload: unknown | null;
}

/** Why a message could NOT be routed to a handler: a null payload (failed HMAC/hop) or an unrecognized `kind`. */
export type UndispatchedReason = 'unauthenticated' | 'unknown_kind';

/** The batch deps = the dispatch handlers + the ack and loop-error sinks (I/O, injected). */
export interface ExecutedBatchDeps extends DispatchExecutedDeps {
  ack: (id: string) => Promise<void>;
  /** Record a per-message loop error (system.loop_errored). The message is deliberately left UNACKED for retry. */
  onLoopError: (err: unknown, id: string) => void;
  /** Record a message NO branch consumed — a null payload (failed HMAC/hop) or an unknown kind — LOUDLY (observable,
   *  mirroring the coffre's dead-letter trace) BEFORE the ack removes it from the PEL, so it is never SILENTLY
   *  dropped (finding #25). The message IS acked afterwards: a poison/garbage message must not redeliver forever. */
  onUndispatched: (reason: UndispatchedReason, id: string) => void;
}

/** Process a batch of `ev:executed` messages with PER-MESSAGE error isolation (mirrors the coffre `processBatch`):
 *  on success ack; on throw record the loop error for THAT message and CONTINUE without acking (so the next PEL
 *  drain re-delivers it). One bad message must never strand its batch-mates nor abort the batch. */
export async function processExecutedBatch(
  msgs: ReadonlyArray<ExecutedMessage>,
  deps: ExecutedBatchDeps,
): Promise<void> {
  for (const msg of msgs) {
    try {
      const routed = await dispatchExecuted(msg.payload as ExecutedEvent | null, deps);
      // A message no branch consumed — a null payload (failed HMAC/hop) or an unknown kind — is NOT silently acked
      // away (finding #25): record it LOUDLY before the ack removes it from the PEL, so it stays observable.
      if (!routed)
        deps.onUndispatched(msg.payload === null ? 'unauthenticated' : 'unknown_kind', msg.id);
      await deps.ack(msg.id);
    } catch (err) {
      // A handler (e.g. a DB blip in onCloseConfirmed) or the ack itself threw → do NOT ack, do NOT abort the
      // batch. The next consumePending drain re-delivers this message for an idempotent retry.
      deps.onLoopError(err, msg.id);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Deferred-continuation retry semantics (finding #137 — never drop an open after our buy landed)
// ─────────────────────────────────────────────────────────────────────────────
// The deferred publishers (publish*AfterBuy / publishDepositAfterPositionCreated / finalizeToken2022Open) run from
// this ev:executed loop AFTER our buy or position-create already LANDED on chain — real SOL moved. Dropping the
// continuation there loses money: the open/add/deposit is abandoned and the bought token is recovered only by the
// wallet sweep (selling it back at a spread). So each pending-stash entry is a RETRY TOKEN: it is deleted ONLY once
// the continuation settles (published/persisted, or a deterministic in-body skip), never before the fallible work.
// A TRANSIENT failure (RPC/DB/bus) keeps the token and rethrows → the message stays un-ACKed and the next
// consumePending drain re-runs the continuation. That retry is a clean no-op-or-complete: the deterministic
// commandId + the vault's per-commandId claim (process1 step 8) make a re-publish a duplicate the coffre rejects
// (no double open), and a re-run after a success that raced the ACK finds the token already gone (`if (!ctx) return`).

/**
 * A DETERMINISTIC deferred-continuation failure: re-running would fail identically (e.g. a Token-2022 open/deposit
 * whose liquidity chunks into >1 tx — a range too wide to replicate as one create+deposit). Marking it TERMINAL lets
 * the consumer ACK it (emit *_failed) instead of holding the message for a pointless, poison PEL retry. Every other
 * continuation throw (RPC/DB/bus) is TRANSIENT by default → retried. A coffre-side DryRunSkip never reaches here: the
 * brain only PUBLISHES to the bus; process1 finalizes a signer-declined command 'skipped' on the coffre side.
 */
export class TerminalContinuationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalContinuationError';
  }
}

/** A continuation failure is retryable UNLESS it is a known-deterministic one. The safe default is "retry" so an open
 *  or add is NEVER dropped after our buy already landed (robustness pillar: missing an open is forbidden). */
export function isRetryableContinuationError(err: unknown): boolean {
  return !(err instanceof TerminalContinuationError);
}

/** The slice of a pending-stash Map a continuation needs to drop its retry token. */
interface RetryTokenStash {
  delete(key: string): boolean;
}

/**
 * Run a deferred continuation whose retry token is `stash[key]`, deleting the token only on a SETTLED outcome:
 *  · body resolves (published/persisted, or a terminal in-body skip that emitted + returned) → delete (done).
 *  · body throws TRANSIENT → KEEP the token + rethrow → the ev:executed message stays un-ACKed and the PEL drain
 *    re-runs the continuation (idempotent) — never drop an open/add after our buy landed.
 *  · body throws DETERMINISTIC (TerminalContinuationError) → delete the token (no poison loop) + rethrow so the
 *    consumer emits *_failed and ACKs.
 * The caller peeks the TYPED entry first (`const ctx = stash.get(key); if (!ctx) return;`); this owns only the
 * delete-on-settled lifecycle, so a re-delivery after a prior success is already a no-op at the caller's peek.
 */
export async function runContinuation(
  stash: RetryTokenStash,
  key: string,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (err) {
    if (!isRetryableContinuationError(err)) stash.delete(key);
    throw err;
  }
  stash.delete(key);
}

/**
 * Settle a deferred-continuation failure at the ev:executed consumer: rethrow a TRANSIENT error so the per-message
 * guard leaves the message un-ACKed for an idempotent PEL retry (the runtime kept the retry token), or run the
 * DETERMINISTIC-failure side effect `onTerminal` (emit the *_failed feed row) and swallow so the message ACKs (no
 * poison retry). Pairs with runContinuation: the runtime keeps/drops the token exactly as the consumer un-ACKs/ACKs.
 */
export function settleContinuationFailure(err: unknown, onTerminal: () => void): void {
  if (isRetryableContinuationError(err)) throw err;
  onTerminal();
}

// ─────────────────────────────────────────────────────────────────────────────
// Leader attribution for a router failure (finding #60 — multi-leader alerts must not be mislabeled)
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal read-side of the mirror registry: look up OUR mirror by its position pubkey (open OR closed). */
export interface MirrorLeaderLookup {
  getByOurPosition(ourPosition: string): { leaderAddress: string } | undefined;
}

/**
 * The REAL leader of the mirror being closed (finding #60), for the close-residual-sell `swap_failed` alert — NOT the
 * demoted env/default leader (`cfg.leader`), which MISLABELS the alert once more than one leader is copied. The closing
 * mirror row survives `markClosed`, so it is looked up by OUR position; `leaderOf` applies the runtime's boot-leader
 * fallback for a legacy blank `leaderAddress`. Falls back to `fallbackLeader` only when the position is absent/unknown
 * (a deploy-window legacy close with no matching mirror).
 */
export function leaderOfClosingPosition(
  registry: MirrorLeaderLookup,
  leaderOf: (m: { leaderAddress: string }) => string,
  ourPosition: string | undefined,
  fallbackLeader: string,
): string {
  const mirror = ourPosition ? registry.getByOurPosition(ourPosition) : undefined;
  return mirror ? leaderOf(mirror) : fallbackLeader;
}
