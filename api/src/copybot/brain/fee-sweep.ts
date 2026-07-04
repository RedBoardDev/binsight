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
export interface SweepableFee {
  userId: string;
  ourPosition: string;
  feeLamports: number;
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
