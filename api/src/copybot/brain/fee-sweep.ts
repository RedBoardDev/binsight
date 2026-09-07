/**
 * Copy-bot · Inc.4d — the periodic performance-fee SWEEP (SPEC §9). PURE glue (all I/O injected) so the
 * retry/attempt logic is unit-tested without a runtime, a DB, or a bus.
 *
 * Fully decoupled from the close: a fee failure NEVER blocks or delays the money-critical close. Each tick takes a
 * bounded batch of 'pending' fees, counts an attempt, and asks the OWNING user's runtime to build+publish a
 * `kind:'fee'` transfer to the operator sink (the coffre signs+lands it). A fee stays 'pending' — retried every
 * sweep — until its transfer lands (ev:executed(fee) → the runtime flips it 'landed', so it drops out of the batch).
 */
import type { Logger } from 'pino';

/** A fee owed on a closed position that the sweep should publish a transfer for. */
/**
 * Max transfer attempts for one pending fee before we STOP re-signing it and escalate (idx44). A performance-fee
 * transfer is a trivial send; this many CONSECUTIVE published attempts that never land means it is DOOMED (a
 * bad/edited operator sink, a persistent balance/permission failure), not a transient blip. Re-signing it every
 * tick forever burns RPC + a signer slot for nothing, so past the cap we escalate LOUD and skip it. The row stays
 * 'pending' — a fee is never silently written off; it is left for manual review rather than re-signed in a loop.
 */
export const FEE_SWEEP_MAX_ATTEMPTS = 10;

export interface SweepableFee {
  userId: string;
  ourPosition: string;
  feeLamports: number;
  /** Transfer attempts already journaled (FeeLedgerRepository.attempts) — read to CAP retries at FEE_SWEEP_MAX_ATTEMPTS. */
  attempts: number;
}

/** The minimal runtime surface the sweep needs — the OWNING user builds + publishes the fee with its own signer. */
export interface FeeSweepRuntime {
  publishFee(ourPosition: string, feeLamports: number): Promise<void>;
}

export interface FeeSweepDeps {
  log: Logger;
  /**
   * The oldest bounded batch of 'pending' fees OWNED BY A BOOTED RUNTIME (FeeLedgerRepository.listPending). Passing
   * the booted set filters un-bootable fees out at the SOURCE, so they can't head-of-line-block the bounded batch
   * and stall live users' fee collection (finding #155).
   */
  listPending(bootedUserIds: string[], limit: number): Promise<SweepableFee[]>;
  batchLimit: number;
  /**
   * The userIds whose runtime is currently booted — only their fees are actionable this sweep. Enumerated so the
   * query excludes fees no runtime can publish (finding #155); the concrete runtime is then resolved by runtimeFor.
   */
  bootedUserIds(): string[];
  /** Resolve the runtime OWNING a fee's user — its wallet + signer publish the transfer. undefined ⇒ retry later. */
  runtimeFor(userId: string): FeeSweepRuntime | undefined;
  /** Count a publish attempt (per-attempt journaling); the row stays pending until its transfer lands. */
  bumpAttempts(userId: string, ourPosition: string): Promise<void>;
}

/** ONE sweep pass: publish a fee transfer for each pending fee whose user runtime is booted. Never blocks a close. */
export async function runFeeSweep(deps: FeeSweepDeps): Promise<void> {
  const pending = await deps.listPending(deps.bootedUserIds(), deps.batchLimit);
  for (const f of pending) {
    const rt = deps.runtimeFor(f.userId);
    if (!rt) continue; // runtime torn down between the query and here (TOCTOU) → leave pending, retry next sweep
    if (f.attempts >= FEE_SWEEP_MAX_ATTEMPTS) {
      // Doomed transfer (idx44): this many published attempts have never landed. STOP re-signing (skip the bump +
      // publish so it no longer burns a signer slot every tick) and escalate LOUD. The row stays 'pending' for
      // manual review — never silently dropped. (A durable park would need a new fee-ledger state; deliberately out
      // of scope for this pure sweep — the loud escalation is the observable signal.)
      deps.log.error(
        {
          userId: f.userId,
          ourPosition: f.ourPosition,
          attempts: f.attempts,
          cap: FEE_SWEEP_MAX_ATTEMPTS,
        },
        'fee transfer exhausted its retry cap → re-signing STOPPED, escalated for manual review (still pending)',
      );
      continue;
    }
    // Count the attempt BEFORE the publish so a failed publish still records the try (the row stays retryable).
    await deps.bumpAttempts(f.userId, f.ourPosition);
    await rt
      .publishFee(f.ourPosition, f.feeLamports)
      .catch((e) =>
        deps.log.warn(
          { userId: f.userId, ourPosition: f.ourPosition, err: (e as Error).message },
          'fee publish failed — retried next sweep (never blocks a close)',
        ),
      );
  }
}

/** The minimal runtime surface the backstop drives — the OWNING user re-assesses one of ITS closed positions. */
export interface ClosedFeeBackstopRuntime {
  assessFee(ourPosition: string): Promise<void>;
}

export interface ClosedFeeBackstopDeps {
  log: Logger;
  /** CLOSED-and-unfeed positions (owned by a booted runtime) closed before `closedBeforeMs` — the anti-join query. */
  listClosedWithoutFee(
    bootedUserIds: string[],
    limit: number,
    closedBeforeMs: number,
  ): Promise<Array<{ userId: string; ourPosition: string }>>;
  batchLimit: number;
  /** Skip positions closed within this grace so a normal close-sell's EXACT assess (onSellConfirmed) wins first. */
  graceMs: number;
  bootedUserIds(): string[];
  runtimeFor(userId: string): ClosedFeeBackstopRuntime | undefined;
  /** Injected clock (tests). */
  nowMs?: () => number;
}

/**
 * ONE backstop pass (#140): assess any CLOSED position that STILL lacks a fee_ledger row (past the grace) via its
 * owning runtime. The no-miss net for the DEFERRED-sell tail — a residual sell that FAILED or never confirmed means
 * onSellConfirmed never assessed, so this catches the position and assesses it on the ledger as it stands. Idempotent
 * with the sell-confirm path (feeLedger.assess keys on (userId, ourPosition)) → the two can never double-charge. A
 * failure is swallowed per row (never blocks a close, never aborts the batch); the row is retried next pass.
 */
export async function runClosedFeeBackstop(deps: ClosedFeeBackstopDeps): Promise<void> {
  const closedBeforeMs = (deps.nowMs ?? Date.now)() - deps.graceMs;
  const rows = await deps.listClosedWithoutFee(
    deps.bootedUserIds(),
    deps.batchLimit,
    closedBeforeMs,
  );
  for (const r of rows) {
    const rt = deps.runtimeFor(r.userId);
    if (!rt) continue; // runtime torn down between the query and here (TOCTOU) → retry next pass
    await rt
      .assessFee(r.ourPosition)
      .catch((e) =>
        deps.log.warn(
          { userId: r.userId, ourPosition: r.ourPosition, err: (e as Error).message },
          'fee backstop assess failed — retried next pass (never blocks a close)',
        ),
      );
  }
}
