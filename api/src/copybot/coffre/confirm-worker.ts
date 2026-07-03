/**
 * Copy-bot · 3c — async CONFIRM WORKER (the vault's second half of check 13). One shared timer loop confirms EVERY
 * in-flight broadcast in a single batched `getSignatureStatuses` call, so no signing lane ever waits on the chain
 * (the old in-lane 45s confirm head-of-line-blocked every other user's CLOSE — ULTRACODE #22/#31).
 *
 * Ownership: a row in state 'submitted' belongs to this worker. It resolves each tracked broadcast to exactly one
 * terminal outcome:
 *  - confirmed/finalized → CONDITIONAL finalize 'landed' → publish ev:executed (same payload as the old inline path);
 *  - on-chain error      → CONDITIONAL finalize 'failed' (atomic revert — re-claimable, pinned alert);
 *  - not found AND blockhash expired (current height > lastValidBlockHeight, height read BEFORE the status batch so
 *    "expired + not visible" is PROOF the tx can never land) → CONDITIONAL finalize 'failed';
 *  - anything else (not found but blockhash alive, or only 'processed') → keep polling.
 * Every finalize is the signature-pinned compare-and-set (`finalizeSubmitted`) — the boot recovery pre-check may
 * resolve the same row concurrently (PEL re-delivery of the same command), and only the winner publishes/emits.
 *
 * Crash/restart: nothing to replay — `loadPending()` re-reads the durable 'submitted' rows (signature + expiry +
 * publish context persisted by `markSubmitted` BEFORE the broadcast) and resumes watching them.
 */
import type { Connection } from '@solana/web3.js';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  emitLandFailure,
  finalizeSubmitted,
  publishExecuted,
  type SubmittedPublishCtx,
  type TrackedSubmission,
} from '@/copybot/coffre/process-command';
import type { CopyEvents } from '@/copybot/observability/copy-events';
import type { RedisBus } from '@/infrastructure/bus/redis-bus';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { executions } from '@/infrastructure/persistence/schema';

type Db = ReturnType<typeof openDatabase>;

// One shared poll for ALL in-flight txs ≈ the old per-tx confirm cadence (400ms polls over a ~1-2s confirm) without
// N× the RPC calls: at 2s a confirmation is detected at most one tick late, negligible vs. chain confirm time.
export const CONFIRM_POLL_MS = 2_000;
// getSignatureStatuses accepts at most 256 signatures per call (Solana RPC hard limit).
const SIGNATURE_STATUS_BATCH_MAX = 256;

const keyOf = (t: { userId: string; commandId: string }): string => `${t.userId}:${t.commandId}`;

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export interface ConfirmWorkerDeps {
  conn: Connection;
  db: Db;
  bus: RedisBus;
  events: CopyEvents;
  hmacKey: string;
  log: Logger;
}

export class ConfirmWorker {
  /** In-flight broadcasts keyed `(userId, commandId)` — a re-registration (recovery re-sign) replaces the stale one. */
  private readonly inflight = new Map<string, TrackedSubmission>();
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private readonly deps: ConfirmWorkerDeps) {}

  /** Broadcasts still awaiting a terminal outcome — for tests, the drain wait, and observability. */
  get inflightCount(): number {
    return this.inflight.size;
  }

  /** Register a fresh broadcast (called by the signing lane right after the tx hits the wire). Never throws. */
  track(t: TrackedSubmission): void {
    this.inflight.set(keyOf(t), t);
  }

  /**
   * Crash recovery: re-read every durable 'submitted' row (a broadcast whose confirmation was in flight when a prior
   * instance died — its cmd:sign message may already be ACKed, so the ROW is the only recovery state). Returns the
   * number of rows resumed. Run BEFORE the boot PEL drain so a re-claimed (provably-dead) row is already tracked
   * under its OLD signature — the signature-pinned finalize then simply loses against the re-claim's cleared row.
   */
  async loadPending(): Promise<number> {
    const rows = await this.deps.db
      .select({
        userId: executions.userId,
        commandId: executions.commandId,
        signature: executions.signature,
        lastValidBlockHeight: executions.lastValidBlockHeight,
        publishCtx: executions.publishCtx,
      })
      .from(executions)
      .where(and(eq(executions.state, 'submitted'), isNotNull(executions.signature)));
    for (const row of rows) {
      this.track({
        userId: row.userId,
        commandId: row.commandId,
        signature: row.signature as string,
        lastValidBlockHeight: row.lastValidBlockHeight ?? 0,
        publish: (row.publishCtx as SubmittedPublishCtx | null) ?? null,
      });
    }
    return rows.length;
  }

  start(): void {
    this.timer = setInterval(() => void this.safeTick(), CONFIRM_POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Never throws and never overlaps (a slow RPC tick must not stack a second batch on top of itself). */
  private async safeTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tick();
    } catch (e) {
      // Transient RPC/DB blip — the tracked set is untouched, the next tick retries. Never crash the vault.
      this.deps.log.error(
        { error: (e as Error).message },
        'confirm worker tick failed — will retry',
      );
    } finally {
      this.ticking = false;
    }
  }

  /** One confirmation pass over every in-flight broadcast. Public so tests drive it deterministically. */
  async tick(): Promise<void> {
    if (this.inflight.size === 0) return;
    const tracked = [...this.inflight.values()];
    // Height BEFORE the status batch: if a sig is invisible in a status read taken AFTER the chain already passed
    // its lastValidBlockHeight, the tx can provably never land (inclusion requires height ≤ lastValidBlockHeight)
    // — the reverse order would let a tx landing between the two reads be misdeclared dead.
    const height = await this.deps.conn.getBlockHeight('confirmed');
    for (const batch of chunk(tracked, SIGNATURE_STATUS_BATCH_MAX)) {
      const { value } = await this.deps.conn.getSignatureStatuses(batch.map((t) => t.signature));
      for (let i = 0; i < batch.length; i++) {
        const t = batch[i] as TrackedSubmission;
        const status = value[i];
        if (status?.err) {
          // Solana txs are atomic → an on-chain error means the tx fully reverted, nothing applied.
          await this.resolveFailed(t, `tx_error: ${JSON.stringify(status.err)}`);
        } else if (
          status?.confirmationStatus === 'confirmed' ||
          status?.confirmationStatus === 'finalized'
        ) {
          await this.resolveLanded(t);
        } else if (!status && height > t.lastValidBlockHeight) {
          await this.resolveFailed(t, `blockhash_expired (sig ${t.signature})`);
        }
        // else: not found but blockhash alive, or only 'processed' — still in flight, keep polling.
      }
    }
  }

  /** Confirmed on-chain → finalize 'landed' and, as the exactly-once WINNER only, publish ev:executed + emit. */
  private async resolveLanded(t: TrackedSubmission): Promise<void> {
    const { db, bus, events, hmacKey, log } = this.deps;
    this.inflight.delete(keyOf(t));
    if (!(await finalizeSubmitted(db, t.userId, t.commandId, t.signature, 'landed'))) return; // recovery won — it publishes
    if (!t.publish) {
      // Pre-3c legacy row (no persisted publish context): the landing is recorded; the brain's reconcile/orphan
      // backstop picks up the position change since ev:executed cannot be reconstructed faithfully.
      log.warn(
        { sig: t.signature, commandId: t.commandId },
        'confirmed landing finalized WITHOUT ev:executed (no publish context on the row) — reconcile will backstop',
      );
      return;
    }
    const p = t.publish;
    await publishExecuted(bus, hmacKey, log, {
      userId: t.userId,
      commandId: t.commandId,
      kind: p.kind,
      sig: t.signature,
      pool: p.pool,
      positionPubkey: p.positionPubkey,
      owner: p.owner,
    });
    events.emit('sign.landed', {
      stage: 'sign',
      outcome: 'landed',
      kind: p.kind,
      pool: p.pool,
      ourPosition: p.positionPubkey,
      commandId: t.commandId,
      signature: t.signature,
      ourSizeSol: p.sizeSol,
      latencyMs: Date.now() - p.issuedAtMs,
    });
    // Same text as the old inline confirm log (grep-stable for ops; the harness SLA uses the SUBMITTED marker).
    log.info(
      { kind: p.kind, sig: t.signature, totalMs: Date.now() - p.issuedAtMs },
      '🚀 signed + landed (confirmed)',
    );
  }

  /** Provably dead (on-chain error / blockhash expired) → finalize 'failed' (re-claimable) + the pinned alert pair. */
  private async resolveFailed(t: TrackedSubmission, reason: string): Promise<void> {
    const { db, events, log } = this.deps;
    this.inflight.delete(keyOf(t));
    // The signature-pinned compare-and-set: a re-claimed row (recovery already re-signing this command) no longer
    // matches the OLD signature, so a stale expiry can never fail the NEW attempt nor emit a spurious pinned alert.
    if (!(await finalizeSubmitted(db, t.userId, t.commandId, t.signature, 'failed'))) return;
    log.warn(
      { sig: t.signature, commandId: t.commandId, reason },
      '💀 broadcast never confirmed — failed (re-claimable)',
    );
    emitLandFailure(
      events,
      {
        kind: t.publish?.kind,
        pool: t.publish?.pool,
        positionPubkey: t.publish?.positionPubkey,
        commandId: t.commandId,
      },
      reason,
    );
  }
}
