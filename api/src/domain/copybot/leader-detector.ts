/**
 * Copy-bot · Phase 1.2 — robust detection core (PURE, testable, no I/O).
 *
 * "We NEVER miss an event" model (the project's pillar — missing an open and especially a close = forbidden):
 *   - the WS is only a low-latency TRIGGER (`onWsSignature`);
 *   - the cursor POLL (`poll`) is the completeness GUARANTEE: it (re)lists ALL signatures since
 *     the cursor contiguously, so nothing between two passes can be skipped;
 *   - dedup by signature (`seen`) avoids any duplicate when WS and poll overlap.
 *
 * Key invariant: ONLY the poll advances the cursor (contiguous sweep). The WS merely emits events earlier
 * that the poll will re-cover anyway — so it can never "punch a hole" in the poll's coverage.
 */

// `DetectedEvent` is a DOMAIN type (shared with the P2 brain) → defined in the domain, re-exported here
// for the existing P1 consumers (watch-leader, classify-dlmm-tx, tests).
import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import type { DetectedEvent } from './events';
export type { DetectedEvent };

export interface SigInfo {
  signature: string;
}

export type EventSource = 'replay' | 'ws' | 'poll';

/** Outcome of classifying a batch. A sig is in AT MOST one set; a resolved NON-DLMM tx is in NEITHER. */
export interface ClassifyResult {
  /** sig → the 1..N position-events the DLMM tx produced (finding #37: one event PER leader position; a
   *  multi-position tx is fanned out, not merged). Absent/empty for a resolved non-DLMM tx. */
  events: Map<string, DetectedEvent[]>;
  /** Sigs whose transaction could NOT be fetched (still null after the retry loop — the WS outran the RPC). */
  unresolved: Set<string>;
}

export interface DetectorDeps {
  /** NEW signatures (newest → oldest) since `untilSig`, contiguous (full pagination).
   *  `untilSig === undefined` = cold start → return only the recent history (bounded). */
  listSignaturesSince(untilSig: string | undefined): Promise<SigInfo[]>;
  /** Decodes/values a batch of signatures (any order) → DLMM `events` + the `unresolved` (null-tx) sigs.
   *  `prefetched` (WS fast-path): sigs whose full tx the WS already delivered — classify decodes from those
   *  bytes and skips the RPC fetch for them (finding #32). The cursor poll passes none → a full re-fetch. */
  classify(
    signatures: string[],
    prefetched?: ReadonlyMap<string, ParsedTransactionWithMeta>,
  ): Promise<ClassifyResult>;
  /** Called once per fresh DLMM event, in chronological order (display). */
  onEvent(event: DetectedEvent, source: EventSource): void;
  /** (optional) Persists fresh events BEFORE committing the cursor. A failure → rollback + retry on the
   *  next poll, so the audit log NEVER loses an event (especially a close). Must be idempotent. */
  persist?(events: DetectedEvent[], source: EventSource): Promise<void>;
  /** (optional) A sig was force-past after exhausting `UNRESOLVED_MAX_RETRIES` — the caller emits a LOUD/pinned
   *  observability event ("a leader signature was never resolved — possible missed event; reconcile covers closes"). */
  onGap?(signature: string, attempts: number): void;
  /** (optional) An `onEvent` consumer threw while emitting a fresh event. The pure core CONTINUES to the next event
   *  — one throwing consumer must never drop the REST of a batch on the no-miss path (a dropped close is the
   *  cardinal sin) — and hands the failure here so an impure caller (with a logger) can surface it. */
  onEmitError?(event: DetectedEvent, err: unknown): void;
}

/** How many polls we re-list an unresolved (null-tx) sig before accepting a LOUD gap (~2 min at a 15s poll). */
const UNRESOLVED_MAX_RETRIES = 8;
/** Cap on the in-flight unresolved-retry map. Normal operation holds only a few unresolved sigs at once; this bounds
 *  a pathological growth (a sustained RPC read outage returning everything null) without ever evicting a legitimately
 *  pending sig under normal load. Eviction is safe for no-miss: the evicted sig stays un-reserved in `seen`, so if it
 *  is re-listed it simply RESTARTS its retry count (more tries before the LOUD gap, never fewer), and a sig that is
 *  NEVER re-listed was already a dead entry — exactly the leak we are pruning. */
const PENDING_UNRESOLVED_MAX = 2000;

export class LeaderDetector {
  private readonly seen = new Set<string>();
  /** Sigs reserved by an IN-FLIGHT classify (WS or poll). While non-empty, the cursor must NOT advance past them:
   *  a concurrent classify may un-reserve one, and a cursor already ahead would skip it forever (the WS/poll race). */
  private readonly inFlight = new Set<string>();
  /** sig → number of polls it has come back unresolved. Bounded retry before a LOUD gap (Option A). */
  private readonly pendingUnresolved = new Map<string, number>();
  /** Single-flight guard: a poll already running → the next tick is skipped (the interval no longer stacks). */
  private polling = false;
  private cursor: string | undefined;
  /** Monotonic counter bumped on EVERY un-reserve (rollback throw + unresolved-retry). A sweep snapshots it at
   *  entry and the cursor may advance ONLY if it is unchanged at commit: a sig un-reserved by a CONCURRENT classify
   *  during this sweep's `await` was filtered out here while still in `seen`, so it MUST be re-listed — advancing
   *  would skip it forever (the WS/poll race, finding #131). The `inFlight.size` check alone misses this because the
   *  racing classify has already cleared its `inFlight` entry by the time this sweep resumes and commits. */
  private unreserveEpoch = 0;

  constructor(
    private readonly deps: DetectorDeps,
    private readonly seenMax = 5000,
    private readonly pendingUnresolvedMax = PENDING_UNRESOLVED_MAX,
  ) {}

  /** The poll cursor (newest contiguously covered signature). Exposed for tests/diagnostics. */
  get cursorSignature(): string | undefined {
    return this.cursor;
  }

  /** Count of sigs in the unresolved-retry map. Exposed for tests/diagnostics (bounded by `pendingUnresolvedMax`). */
  get pendingUnresolvedSize(): number {
    return this.pendingUnresolved.size;
  }

  /**
   * Ingests a batch of signatures (newest → oldest), emits the FRESH DLMM events in chronological
   * order, deduped via `seen`. `advanceCursor` is only true for contiguous sweeps (replay/poll),
   * never for the WS (which doesn't necessarily cover contiguously).
   */
  async ingest(
    sigInfosNewestFirst: SigInfo[],
    source: EventSource,
    advanceCursor: boolean,
    prefetched?: ReadonlyMap<string, ParsedTransactionWithMeta>,
  ): Promise<void> {
    const newest = sigInfosNewestFirst[0]?.signature;
    if (newest === undefined) return;
    // Snapshot the un-reserve epoch BEFORE reading `seen` (the filter below). If a concurrent classify un-reserves
    // any sig while this sweep is awaiting `classify`, the epoch changes and the cursor MUST hold: that sig was
    // filtered out here while still reserved in `seen`, so it needs re-listing (finding #131). Captured locally (not
    // a field) so a concurrent WS `ingest` and this poll `ingest` each keep their own view.
    const unreserveEpochAtEntry = this.unreserveEpoch;
    const freshNewestFirst = sigInfosNewestFirst.filter((s) => !this.seen.has(s.signature));

    if (freshNewestFirst.length === 0) {
      // Nothing fresh (all committed or reserved in-flight). The sweep is contiguous up to `newest`, but we may
      // only advance if NO concurrent classify still holds a reservation — otherwise it could un-reserve a sig
      // the advanced cursor would then skip forever (the WS/poll race). `false` = nothing was retried this pass.
      this.maybeAdvanceCursor(advanceCursor, newest, false, unreserveEpochAtEntry);
      return;
    }

    // We "reserve" the fresh ones BEFORE the async classify so a concurrent call (WS during a poll) doesn't
    // pick them up again — in BOTH `seen` (dedup) and `inFlight` (the cursor must not pass an in-flight sig).
    // BUT if classify fails, we ROLLBACK the reservation: NEVER missing an event is better than a possible
    // duplicate (which will be deduped downstream anyway).
    for (const s of freshNewestFirst) {
      this.markSeen(s.signature);
      this.inFlight.add(s.signature);
    }

    const freshChronological = freshNewestFirst.map((s) => s.signature).reverse();
    let detected: DetectedEvent[];
    let unresolved: Set<string>;
    try {
      const result = await this.deps.classify(freshChronological, prefetched);
      unresolved = result.unresolved;
      // Fan out each signature's 1..N position-events (finding #37) in signature order, then sort by blockTime:
      // the RPC signature order is not strictly monotonic in time, so we order emission (and persistence) by the
      // tx's real timestamp. A stable sort keeps same-sig events in their deterministic per-position build order.
      detected = freshChronological
        .flatMap((s) => result.events.get(s) ?? [])
        .sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
      // Persist BEFORE committing: if the log fails, we rollback and the next poll retries.
      if (this.deps.persist && detected.length > 0) await this.deps.persist(detected, source);
    } catch (err) {
      for (const s of freshNewestFirst) {
        this.seen.delete(s.signature); // rollback → retried on the next poll
        this.inFlight.delete(s.signature);
      }
      this.unreserveEpoch++; // un-reserve → a concurrent sweep's snapshot is now stale → it must hold its cursor
      throw err; // do NOT advance the cursor: the window remains to be re-swept
    }

    // This batch's classify resolved → release its in-flight reservation.
    for (const s of freshNewestFirst) this.inFlight.delete(s.signature);

    // NO-MISS guarantee, per sig in this batch:
    //  - emitted (DLMM) or resolved non-DLMM → COMMITTED: keep `seen`, clear any retry counter.
    //  - unresolved (null tx: the WS raced ahead of tx availability) → un-reserve so the poll re-lists it, up
    //    to `UNRESOLVED_MAX_RETRIES`; beyond that, FORCE-PAST it (keep `seen`, never re-listed) and fire a LOUD
    //    gap signal. Keeping it in `seen` while it is being retried would let the contiguous poll skip it FOREVER.
    const emitted = new Set(detected.map((e) => e.signature));
    let retriedThisPass = false; // a sig un-reserved for retry ⇒ the window is NOT fully covered ⇒ hold the cursor
    for (const s of freshNewestFirst) {
      const sig = s.signature;
      if (emitted.has(sig)) {
        this.pendingUnresolved.delete(sig);
        continue;
      }
      if (unresolved.has(sig)) {
        const attempts = (this.pendingUnresolved.get(sig) ?? 0) + 1;
        if (attempts < UNRESOLVED_MAX_RETRIES) {
          this.trackPending(sig, attempts);
          this.seen.delete(sig); // un-reserve → the next poll re-lists and retries
          this.unreserveEpoch++; // same as rollback: a concurrent sweep's snapshot is now stale → it must hold
          retriedThisPass = true;
        } else {
          this.deps.onGap?.(sig, attempts); // exhausted → accept a LOUD gap; keep `seen` so it is never re-listed
          this.pendingUnresolved.delete(sig);
        }
        continue;
      }
      this.pendingUnresolved.delete(sig); // resolved non-DLMM → committed
    }

    this.maybeAdvanceCursor(advanceCursor, newest, retriedThisPass, unreserveEpochAtEntry);
    // Defense-in-depth on the no-miss path: emit each event under its own guard so one throwing `onEvent` consumer
    // cannot drop the REST of the batch (a dropped close = the cardinal sin). Events are already persisted before
    // the cursor commit above, so the audit log is safe regardless; the hub consumer is throw-hardened today — this
    // makes the guarantee structural, not dependent on the consumer staying that way.
    for (const event of detected) {
      try {
        this.deps.onEvent(event, source);
      } catch (err) {
        this.deps.onEmitError?.(event, err);
      }
    }
  }

  /**
   * Advance the cursor to `newest` ONLY when the window is provably, fully covered: the caller is a contiguous
   * sweep (`advanceCursor`), NO sig is still reserved in-flight (a concurrent classify could un-reserve one),
   * NOTHING was un-reserved for retry this pass, AND no un-reserve happened CONCURRENTLY since this sweep took its
   * view (`unreserveEpoch === unreserveEpochAtEntry`). The last condition closes finding #131: a WS classify that
   * un-reserves an older sig mid-poll clears its own `inFlight` before the poll resumes, so `inFlight.size` reads 0
   * and would wrongly let the poll advance past that sig; the epoch changed, so we hold instead. Otherwise leave the
   * cursor behind → the next poll re-lists the window (`seen` dedups the committed ones; unresolved ones get retried).
   */
  private maybeAdvanceCursor(
    advanceCursor: boolean,
    newest: string,
    retriedThisPass: boolean,
    unreserveEpochAtEntry: number,
  ): void {
    if (
      advanceCursor &&
      this.inFlight.size === 0 &&
      !retriedThisPass &&
      this.unreserveEpoch === unreserveEpochAtEntry
    ) {
      this.cursor = newest;
    }
  }

  /** The backstop: lists everything since the cursor and ingests it (advances the cursor). On a cold start
   *  (undefined cursor), pass `source='replay'` to label the startup history. Single-flight: a poll already
   *  running → this tick is skipped (the brain's `setInterval` no longer stacks concurrent sweeps). */
  async poll(source: EventSource = 'poll'): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const sigs = await this.deps.listSignaturesSince(this.cursor);
      await this.ingest(sigs, source, true);
    } finally {
      this.polling = false;
    }
  }

  /** WS trigger: emits a signature early, without advancing the cursor (the poll will re-cover it). `tx` — the
   *  full parsed tx from the delivered payload, when complete — lets classify decode from the WS bytes instead
   *  of re-fetching over RPC (finding #32); `null`/omitted → classify falls back to the fetch. */
  async onWsSignature(signature: string, tx?: ParsedTransactionWithMeta | null): Promise<void> {
    const prefetched = tx ? new Map([[signature, tx]]) : undefined;
    await this.ingest([{ signature }], 'ws', false, prefetched);
  }

  private markSeen(signature: string): void {
    if (this.seen.has(signature)) return;
    this.seen.add(signature);
    if (this.seen.size > this.seenMax) {
      const oldest = this.seen.values().next().value; // Set keeps insertion order
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  /** Record an unresolved sig's retry count, bounding the map: evict the OLDEST (longest-pending) entry past the
   *  cap. See PENDING_UNRESOLVED_MAX for why eviction never risks a miss. Re-setting an existing key keeps its
   *  position (Map insertion order), so the oldest is always the longest-stuck straggler, never the just-set sig. */
  private trackPending(sig: string, attempts: number): void {
    this.pendingUnresolved.set(sig, attempts);
    if (this.pendingUnresolved.size > this.pendingUnresolvedMax) {
      const oldest = this.pendingUnresolved.keys().next().value; // Map keeps insertion order
      if (oldest !== undefined && oldest !== sig) this.pendingUnresolved.delete(oldest);
    }
  }
}
