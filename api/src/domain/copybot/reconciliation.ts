/**
 * Copy-bot · P2.5 — reconciliation / failsafe (PURE, no I/O). The on-chain backstop of the no-miss-close pillar:
 * even if we missed or mis-classified the leader's close (the case of a 100%-remove seen as 'remove', or a close out
 * of window), we close OUR mirror as soon as the leader position is confirmed gone on-chain.
 *
 * Sweep A (spec 04 §5 / 15 §5): among our OPEN mirrors, those whose leader position is **confirmed
 * closed** on-chain → to be closed in failsafe. Absolute safety rule: we NEVER act on 'unknown' or
 * 'open' — closing a position wrongly would be serious. The I/O layer provides the state via `getAccountInfo`
 * (closed position account / rent reclaimed ⇒ nonexistent ⇒ 'closed').
 */
export type LeaderPositionState = 'open' | 'closed' | 'unknown';

/** Translates the result of an on-chain fetch into a state. An RPC error ⇒ 'unknown' (we never close on
 *  doubt); account present ⇒ 'open'; account absent ⇒ 'closed' (rent reclaimed at DLMM close). Pure. */
export function leaderStateFromFetch(
  accountExists: boolean,
  errored: boolean,
): LeaderPositionState {
  if (errored) return 'unknown';
  return accountExists ? 'open' : 'closed';
}

/** Sweep A: our open mirrors whose leader position is CONFIRMED closed → to be closed in failsafe.
 *  'open'/'unknown'/absent from the map ⇒ we don't touch (safety). Pure, generic over any type bearing
 *  `leaderPosition` (the brain's Mirror). */
export function planFailsafeCloses<T extends { leaderPosition: string }>(
  openMirrors: T[],
  leaderState: Map<string, LeaderPositionState>,
): T[] {
  return openMirrors.filter((m) => leaderState.get(m.leaderPosition) === 'closed');
}

/**
 * AIRTIGHT reconciliation based on ON-CHAIN reality (NEVER trusts the DB status, which can lie
 * if a close failed). Compares OUR wallet's positions actually on-chain to the persisted mapping + the
 * leader positions' state. Guarantees "never a dormant position": a failed close stays detected (our
 * position is still on-chain while the leader has closed → re-close); a successful close is observed
 * (our position has disappeared → mark closed); an untracked position → orphan → alert.
 */
export interface ReconcileInput {
  /** OUR wallet's positions present on-chain per the ENUMERATOR (getAllLbPairPositionsByUser). Used ONLY for
   *  orphan detection — the enumerator can LAG, so it is NOT trusted to conclude a close (see `ourClosed`). */
  ourOnChain: Set<string>;
  /** Tracked positions whose account is DIRECTLY confirmed gone (`getAccountInfo(ourPosition) === null`). This
   *  is the RELIABLE close signal (a per-account read, not the laggy enumerator) → drives markClosed/reClose. */
  ourClosed: Set<string>;
  /** persisted mapping of mirrors still "open" in DB. */
  tracked: Array<{ ourPosition: string; leaderPosition: string }>;
  /** leaderPositions CONFIRMED closed on-chain. */
  leaderClosed: Set<string>;
  /**
   * ourPositions opened too recently to TRUST their on-chain absence (open-grace). A just-opened position is
   * not yet returned by the on-chain enumerator (indexer/confirmation lag), so its absence does NOT mean
   * "closed". These are skipped for markClosed/reClose, BUT stay counted as tracked (never flagged orphan).
   * Without this, a reconcile firing within ~1s of a fresh open reads the not-yet-indexed position as "gone"
   * → markClosed → the mirror is forgotten → DORMANT (the #1-pillar regression we observed live).
   */
  recentlyOpened?: ReadonlySet<string>;
  /**
   * ourPositions we RUG-SL-closed (our INDEPENDENT crash exit) whose close is NOT yet confirmed gone on-chain.
   * Rug-SL fires while the LEADER still holds the position, so `leaderClosed` never triggers a retry — a failed
   * rug-SL close (congestion, the exact rug scenario) would otherwise stay dormant until the leader eventually
   * closes. A pending mirror still on-chain (NOT in `ourClosed`) → reClose, independent of `leaderClosed`. Once
   * `ourClosed` confirms it gone, the markClosed branch wins (gone > pending) and the I/O layer clears it.
   */
  rugExitPending?: ReadonlySet<string>;
}

export interface ReconcilePlan {
  /** our position is DIRECTLY confirmed gone on-chain (getAccountInfo null) → close succeeded → mark closed in DB. */
  markClosed: string[];
  /** our position is STILL on-chain while the leader has closed → re-close (retry the failed close). */
  reClose: Array<{ ourPosition: string; leaderPosition: string }>;
  /** position on-chain on our side but untracked → we don't close blindly, we alert. */
  orphans: string[];
}

export function planReconcile(input: ReconcileInput): ReconcilePlan {
  const plan: ReconcilePlan = { markClosed: [], reClose: [], orphans: [] };
  const trackedOurs = new Set(input.tracked.map((t) => t.ourPosition));
  const recentlyOpened = input.recentlyOpened ?? new Set<string>();
  const rugExitPending = input.rugExitPending ?? new Set<string>();

  for (const t of input.tracked) {
    if (recentlyOpened.has(t.ourPosition)) continue; // open-grace: a fresh open's on-chain state isn't reliable yet
    if (input.ourClosed.has(t.ourPosition)) {
      plan.markClosed.push(t.ourPosition); // DIRECTLY confirmed gone → close confirmed (gone wins over rug-exit-pending)
    } else if (input.leaderClosed.has(t.leaderPosition) || rugExitPending.has(t.ourPosition)) {
      // ours still present AND (leader closed OR our rug-SL close hasn't landed) → re-close (retry the failed close).
      plan.reClose.push(t);
    }
    // otherwise: ours present + leader open + not rug-exit-pending → active mirror, we don't touch.
  }
  // Orphans use the ENUMERATOR vs ALL tracked (incl. recentlyOpened) so a fresh open is never an orphan.
  for (const ours of input.ourOnChain) {
    if (!trackedOurs.has(ours)) plan.orphans.push(ours); // on-chain but untracked → stray position
  }
  return plan;
}

/**
 * ONE user's claims on positions of the SHARED wallet, as seen by the global orphan pass (Inc.3b — INC3B-PLAN §4).
 * The per-user reconcile intersects the enumerator with the user's own tracked set (its orphan list stays EMPTY);
 * only the union across every user may declare a wallet position an orphan.
 */
export interface OrphanScanUser {
  /** ourPositions this user's persisted mirrors track (open rows). */
  tracked: ReadonlySet<string>;
  /** ourPositions inside the reconcile open-grace — a fresh open may not be enumerable/persisted-visible yet,
   *  so it must never be read as "tracked by no user" (kept separate from `tracked` for that reason). */
  recentlyOpened: ReadonlySet<string>;
  /** ourPosition → ms the Token-2022 empty-position create was published (its deposit may still be in flight). */
  buildingToken2022: ReadonlyMap<string, number>;
}

export interface OrphanScanInput {
  /** OUR wallet's positions on-chain per the enumerator (the whole shared wallet). */
  onChain: ReadonlySet<string>;
  /** EVERY runtime's claims. The caller must only run this pass when ALL users' claims are known — a user whose
   *  claims failed to load would otherwise surface THEIR live positions as orphans (a forbidden false close). */
  users: ReadonlyArray<OrphanScanUser>;
  nowMs: number;
  /** Grace for a mid-build Token-2022 position (create landed, deposit in flight). Past it, the deposit never
   *  landed → the empty position IS a real orphan to clean (no dormant position). */
  buildingGraceMs: number;
}

/**
 * Global orphan pass over the SHARED wallet: orphan = an on-chain position tracked by NO user, opened recently by
 * NO user, and mid-Token-2022-build (within grace) for NO user. With zero users every on-chain position is an
 * orphan — an empty tracked set must never short-circuit the scan (the dormant-orphan bug class). Pure.
 */
export function planOrphans(input: OrphanScanInput): string[] {
  const orphans: string[] = [];
  for (const position of input.onChain) {
    const claimed = input.users.some((u) => {
      if (u.tracked.has(position) || u.recentlyOpened.has(position)) return true;
      const buildingSince = u.buildingToken2022.get(position);
      return buildingSince !== undefined && input.nowMs - buildingSince < input.buildingGraceMs;
    });
    if (!claimed) orphans.push(position);
  }
  return orphans;
}
