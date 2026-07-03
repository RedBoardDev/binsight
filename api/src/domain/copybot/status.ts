/**
 * Copy-bot · process status / heartbeat — PURE (no I/O).
 *
 * Each process upserts a heartbeat row periodically; the web derives online/offline from how fresh that row is,
 * NOT from a stored boolean (a crashed process can't flip a flag to false — staleness is the only honest signal).
 */
import type { JournalProcess } from './journal';

export type StatusProcess = JournalProcess; // 'brain' | 'coffre'

export const HEARTBEAT_INTERVAL_MS = 10_000; // how often each process beats
export const HEARTBEAT_STALE_MS = 30_000; // a process silent longer than this (≈3 missed beats) is offline

// `type` (not `interface`) so these payloads satisfy the adapter's `Record<string, unknown>` jsonb param directly.
/** Per-watched-leader detection health (Inc.3b v2 — replaces the pre-3b lastPollAt/pollFailures singletons). */
export type BrainLeaderStatus = {
  leader: string;
  lastPollAt: number | null; // ms of this leader's last SUCCESSFUL cursor poll, or null if none yet
  pollFailures: number; // this leader's CONSECUTIVE poll failures (reset to 0 on a success)
};

/** One user's slice of the brain status (Inc.3b v2). */
export type BrainUserStatus = {
  userId: string;
  openPositions: number;
  exposureSol: number;
  lastActionAt: number | null;
  lastLatencyMs: number | null;
  /** This user's open mirrors grouped by the leader they copy (per-(user,leader) visibility). */
  perLeader: Array<{ leader: string; openPositions: number; exposureSol: number }>;
};

/** Legacy top-level `leader` when SEVERAL leaders are watched (one ⇒ its address; zero ⇒ ''). */
export const LEGACY_LEADER_MULTI = 'multi';

/** Brain heartbeat payload (rendered by the web — read LOOSELY as jsonb, so v1 rows stay renderable). */
export type BrainStatusDetail = {
  /** Legacy field: the single watched leader; 'multi' when several are watched, '' when none. */
  leader: string;
  openPositions: number; // aggregate across users
  exposureSol: number; // aggregate across users
  lastActionAt: number | null; // ms of the MOST RECENT build+publish across users, or null if none yet
  lastLatencyMs: number | null; // brainMs of that most recent action
  // Detection-liveness (observability). The cursor poll + reconcile sweep run on setInterval with LOG-ONLY
  // `.catch` handlers: if they throw forever (a revoked RPC key, an auth outage, a permanently-throwing poll) the
  // bot goes silently BLIND to leader events — including closes — while this heartbeat keeps the web GREEN. These
  // fields surface detection health so a stalled detector is both visible and alertable. OPTIONAL (defaulted where
  // read) so pre-existing persisted jsonb rows without them stay backward-compatible.
  wsConnected?: boolean; // last-known WS trigger connectivity (sub.isConnected())
  lastReconcileAt?: number | null; // ms of the last SUCCESSFUL reconcile sweep, or null if none yet
  reconcileFailures?: number; // CONSECUTIVE reconcile failures (reset to 0 on a success)
  /** Per-user breakdown (Inc.3b v2). */
  users: BrainUserStatus[];
  /** Per-leader detection health (Inc.3b v2 — replaces the v1 lastPollAt/pollFailures singletons). */
  leaders: BrainLeaderStatus[];
};

/** What the assembly needs from ONE runtime (collected impurely by brain-main, aggregated purely here). */
export interface BrainStatusUserInput {
  userId: string;
  /** (leader, sizeSol) of each OPEN mirror — counts/exposure and the per-leader grouping derive from this. */
  openMirrors: ReadonlyArray<{ leader: string; sizeSol: number }>;
  lastActionAt: number | null;
  lastLatencyMs: number | null;
}

/**
 * Assemble the brain heartbeat payload (Inc.3b step 8). Pure so the exact aggregation rules are testable:
 * top-level legacy fields are AGGREGATES across users (never one arbitrary user's view — a green single-user
 * number over a broken second user would hide the breakage), and `lastLatencyMs` is the latency OF the most
 * recent action (pairing the two fields; mixing users' values would fabricate a latency no action ever had).
 */
export function assembleBrainStatus(input: {
  users: ReadonlyArray<BrainStatusUserInput>;
  leaders: ReadonlyArray<BrainLeaderStatus>;
  wsConnected: boolean;
  lastReconcileAt: number | null;
  reconcileFailures: number;
}): BrainStatusDetail {
  const users: BrainUserStatus[] = input.users.map((u) => {
    const perLeader = new Map<
      string,
      { leader: string; openPositions: number; exposureSol: number }
    >();
    for (const m of u.openMirrors) {
      const slot = perLeader.get(m.leader) ?? {
        leader: m.leader,
        openPositions: 0,
        exposureSol: 0,
      };
      slot.openPositions += 1;
      slot.exposureSol += m.sizeSol;
      perLeader.set(m.leader, slot);
    }
    return {
      userId: u.userId,
      openPositions: u.openMirrors.length,
      exposureSol: u.openMirrors.reduce((s, m) => s + m.sizeSol, 0),
      lastActionAt: u.lastActionAt,
      lastLatencyMs: u.lastLatencyMs,
      perLeader: [...perLeader.values()],
    };
  });
  // Most recent action across users; its latency travels WITH it (never another user's latency).
  let lastActionAt: number | null = null;
  let lastLatencyMs: number | null = null;
  for (const u of users) {
    if (u.lastActionAt !== null && (lastActionAt === null || u.lastActionAt > lastActionAt)) {
      lastActionAt = u.lastActionAt;
      lastLatencyMs = u.lastLatencyMs;
    }
  }
  return {
    leader:
      input.leaders.length === 1
        ? input.leaders[0]!.leader
        : input.leaders.length > 1
          ? LEGACY_LEADER_MULTI
          : '',
    openPositions: users.reduce((s, u) => s + u.openPositions, 0),
    exposureSol: users.reduce((s, u) => s + u.exposureSol, 0),
    lastActionAt,
    lastLatencyMs,
    wsConnected: input.wsConnected,
    lastReconcileAt: input.lastReconcileAt,
    reconcileFailures: input.reconcileFailures,
    users,
    leaders: [...input.leaders],
  };
}

/** Consecutive poll OR reconcile failures after which the detector is assumed BLIND and the operator is alerted. */
export const DETECTION_STALE_FAILURES = 3; // ~3 missed cycles ⇒ not a transient blip; a persistent RPC/key outage

/**
 * Should we raise the pinned detection-stale operator alert NOW? Pure. True iff detection is not already flagged
 * (`alreadyAlerted` gates it to ONCE per stale episode) AND either loop has failed `threshold` times in a row.
 * The caller sets its own `alerted` flag on a true result and re-arms it via `detectionHealthy` on recovery.
 */
export function shouldAlertDetectionStale(
  pollFailures: number,
  reconcileFailures: number,
  alreadyAlerted: boolean,
  threshold: number = DETECTION_STALE_FAILURES,
): boolean {
  return !alreadyAlerted && (pollFailures >= threshold || reconcileFailures >= threshold);
}

/** Detection is healthy again iff BOTH loops have a zeroed consecutive-failure counter. Pure. Re-arms the alert. */
export function detectionHealthy(pollFailures: number, reconcileFailures: number): boolean {
  return pollFailures === 0 && reconcileFailures === 0;
}

/** Coffre heartbeat payload. */
export type CoffreStatusDetail = {
  signingEnabled: boolean;
};

/**
 * A process is online iff it beat within the stale window. `null` (never beat) ⇒ offline. Pure.
 * Boundary is inclusive (a beat exactly `staleMs` ago still counts as online) so the edge doesn't flap.
 */
export function isOnline(
  lastBeatMs: number | null,
  nowMs: number,
  staleMs: number = HEARTBEAT_STALE_MS,
): boolean {
  return lastBeatMs !== null && nowMs - lastBeatMs <= staleMs;
}
