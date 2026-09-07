/**
 * Copy-bot · P2 — leader position tracker (PURE, no I/O). Projects the detected-event stream (P1) into
 * per-position state, keyed by the DLMM position pubkey (spec 11 §1: `positions.position_address`).
 *
 * Why: the decision needs the **open size** (sizing input, spec 05 §3), and the exits /
 * reconciliation (P2.5) need to know which positions are **open** and when the leader has
 * **closed**. P1 produces per-tx events; this tracker aggregates them per position.
 *
 * No-miss guarantee (pillar) — layered: P1 misses no tx · this tracker marks `closed` on the close
 * event · P2.5 (on-chain reconciliation) is the backstop that detects a leader position that vanished
 * on-chain (the case of a 100%-remove mis-classified as `remove`). This tracker stays a faithful and simple
 * projection; it does NOT guess a close from the amounts (price drift makes "net ≈ 0" unreliable).
 *
 * Robust on cold start: an add/remove/claim/close for a position whose open was never seen
 * still creates the position (`openSizeKnown = false`) — we never lose an event, especially a close.
 */
import { isCloseEvent } from './dispatch';
import type { DetectedEvent } from './events';

export interface LeaderPosition {
  /** key = DLMM position pubkey. */
  position: string;
  pool: string;
  nonSolMint: string | null;
  nonSolSymbol: string | null;
  status: 'open' | 'closed';
  /** SOL size of the initial deposit (sizing input, spec 05 §3); 0 until the open has been observed. */
  openSizeSol: number;
  /** false if we joined the position mid-life (open never seen) → unreliable fraction base (OQ #3). */
  openSizeKnown: boolean;
  /** sum of deposits (open + adds). */
  depositedSol: number;
  /** sum of withdrawals (removes + close). */
  withdrawnSol: number;
  /** sum of harvested fees. */
  claimedSol: number;
  /** best-effort "current" base = depositedSol − withdrawnSol (at cost, not at market value). */
  netSizeSol: number;
  openedAt: number | null;
  closedAt: number | null;
  lastSignature: string;
  eventCount: number;
}

/** Cap on the per-(sig,position) idempotency guard, bounding it like the detector's `seen`. The `positions` Map is
 *  the real state and is never evicted; this Set only prevents a re-observation (WS+poll overlap, seconds apart)
 *  from double-applying an event. Evicting the OLDEST key past the cap can therefore only re-admit an event so old
 *  it can no longer be re-observed — a bounded double-count at worst, NEVER a missed event. */
const APPLIED_EVENTS_MAX = 10_000; // ≈ 2× the detector's 5000-sig `seen` window (a tx yields up to 2 legs, #37)

export class LeaderPositionTracker {
  private readonly positions = new Map<string, LeaderPosition>();
  /** Keyed by `signature|position`, NOT by signature alone: one tx can carry TWO position-events (finding #37 —
   *  close A + open B), and each must apply exactly once. A per-signature guard would drop the 2nd position's
   *  event (missing its close/remove); a per-(sig,position) guard still collapses WS+poll re-observations. */
  private readonly appliedEvents = new Set<string>();

  constructor(private readonly appliedEventsMax = APPLIED_EVENTS_MAX) {}

  /**
   * Applies a detected event. Returns the updated position, or `undefined` if the event carries no
   * position (tx with no decodable leg, e.g. a pure `InitializePosition` — it carries no capital anyway).
   * Idempotent per (signature, position): re-applying the same event double-counts nothing (replay/live safety),
   * yet two DISTINCT positions of the SAME signature each apply once (finding #37: no per-sig collapse).
   */
  apply(event: DetectedEvent): LeaderPosition | undefined {
    if (!event.position) return undefined; // no key → not traceable (and no capital)
    const applyKey = `${event.signature}|${event.position}`;
    if (this.appliedEvents.has(applyKey)) return this.positions.get(event.position);

    const pos = this.positions.get(event.position) ?? this.create(event.position);

    // Metadata: the last non-empty value wins (we don't overwrite with a null/empty).
    if (event.pool) pos.pool = event.pool;
    if (event.nonSolMint) pos.nonSolMint = event.nonSolMint;
    if (event.nonSolSymbol) pos.nonSolSymbol = event.nonSolSymbol;

    pos.depositedSol += event.depositSol;
    pos.withdrawnSol += event.withdrawSol;
    pos.claimedSol += event.claimSol;
    pos.netSizeSol = pos.depositedSol - pos.withdrawnSol;

    // The 1st capital-bearing event sets the open size (handles the InitializePosition→AddLiquidity split:
    // the position opens with capital on the 1st deposit, whether the instruction is classed 'open' or 'add').
    if (!pos.openSizeKnown && event.depositSol > 0) {
      pos.openSizeSol = event.depositSol;
      pos.openSizeKnown = true;
      pos.openedAt = event.blockTime;
    }

    // Status: only a close (re)sets to 'closed'; a partial withdrawal keeps 'open'; 'closed' is terminal. The close
    // signal is the per-position `event.closed` flag (a decoded PositionClose leg), via the shared `isCloseEvent`
    // — NOT the per-tx `instruction` LABEL. One tx carries ONE label but can close A while opening B (finding #37):
    // the label can't say WHICH position closed, and 10KB log truncation degrades it to '(DLMM)' (kind null).
    // Keying off `closed` makes the tracker and the router (dispatch.ts) agree on what a close is.
    if (isCloseEvent(event) && pos.status === 'open') {
      pos.status = 'closed';
      pos.closedAt = event.blockTime;
    }

    pos.lastSignature = event.signature;
    pos.eventCount += 1;
    this.markApplied(applyKey);
    return pos;
  }

  /** The position for this pubkey, or undefined. */
  get(position: string): LeaderPosition | undefined {
    return this.positions.get(position);
  }

  /** All currently open positions (for the exits / reconciliation). */
  openPositions(): LeaderPosition[] {
    return [...this.positions.values()].filter((p) => p.status === 'open');
  }

  /** All known positions (open + closed). */
  all(): LeaderPosition[] {
    return [...this.positions.values()];
  }

  /** Records a (sig, position) as applied, bounding the guard (evict the OLDEST key past the cap — see
   *  APPLIED_EVENTS_MAX for why that can never drop an event). Mirrors the detector's `markSeen`. Only ever called
   *  for a NEW key (`apply` early-returns on a re-observation), so the just-added key is never the one evicted. */
  private markApplied(applyKey: string): void {
    this.appliedEvents.add(applyKey);
    if (this.appliedEvents.size > this.appliedEventsMax) {
      const oldest = this.appliedEvents.values().next().value; // Set preserves insertion order
      if (oldest !== undefined) this.appliedEvents.delete(oldest);
    }
  }

  private create(position: string): LeaderPosition {
    const pos: LeaderPosition = {
      position,
      pool: '',
      nonSolMint: null,
      nonSolSymbol: null,
      status: 'open',
      openSizeSol: 0,
      openSizeKnown: false,
      depositedSol: 0,
      withdrawnSol: 0,
      claimedSol: 0,
      netSizeSol: 0,
      openedAt: null,
      closedAt: null,
      lastSignature: '',
      eventCount: 0,
    };
    this.positions.set(position, pos);
    return pos;
  }
}
