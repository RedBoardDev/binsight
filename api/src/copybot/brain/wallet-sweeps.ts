/**
 * Copy-bot · Inc.3b step 6 — the SHARED-WALLET sweeps (INC3B-PLAN §4). One wallet, N user runtimes:
 *
 * RECONCILE (`runReconcileSweep`) — three phases, driven by ON-CHAIN reality, NEVER by DB status:
 *  1. ONE wallet enumeration per tick (O(wallet), not O(users)) + a per-sweep READ CACHE for the direct
 *     `getAccountInfo` reads — two users mirroring the SAME leaderPosition cost ONE read (O(distinct positions)).
 *  2. Per-runtime plan under its OWN try/catch (a user's DB/RPC failure skips THEIR sweep this tick, never the
 *     others'): `planReconcile` with `ourOnChain` INTERSECTED with that user's tracked set, so per-user orphan
 *     lists stay EMPTY — a user must never see another user's position as an orphan.
 *  3. GLOBAL orphan pass (`planOrphans`): orphan = on-chain position tracked by NO user (∪ tracked, ∪ recently
 *     opened, ∪ mid-Token-2022-build within grace). Published as SYSTEM (wallet maintenance). SKIPPED whenever any
 *     user's claims failed to load — closing "orphans" from incomplete data could close a live user's position.
 *  Plus the pending-open-cancel backstop, per runtime over its own pending maps.
 *
 * RUG-SL (`runRugSlSweep`) — ALL runtimes' open mirrors grouped by pool → ONE `readActiveTokenPrice` per pool per
 * tick; the trigger is judged per (runtime, mirror) with `effectiveFor(that user's config, mirror's leader).rugSl`
 * — one user's rug config can never fire (or mute) another user's close.
 *
 * Structural runtime interfaces (`UserRuntime` satisfies them) keep both sweeps unit-testable with stubs.
 */
import type { Logger } from 'pino';
import type { CopyEvents } from '@/copybot/observability/copy-events';
import { purgeRugExitPending, type RugExitStore } from '@/copybot/rug-exit-store';
import { type CopybotConfig, effectiveFor } from '@/domain/copybot/config';
import { type OrphanScanUser, planOrphans, planReconcile } from '@/domain/copybot/reconciliation';
import type { RugSlTracker } from '@/domain/copybot/rug-sl';
import type { UserPosition } from '@/infrastructure/solana/dlmm/leader-position-reader';
import type { Mirror } from './mirror-registry';
import { type PendingOpenMaps, pendingOpenLeaders } from './pending-open-cancel';

/** The per-user runtime surface the reconcile sweep drives (structural — `UserRuntime` satisfies it). */
export interface ReconcileRuntime {
  readonly userId: string;
  store: { loadOpen(): Promise<Mirror[]>; markClosed(leaderPosition: string): Promise<void> };
  registry: { close(leaderPosition: string): unknown; hasOpen(leaderPosition: string): boolean };
  events: Pick<CopyEvents, 'closed'>;
  rugSlTracker: Pick<RugSlTracker, 'forget'>;
  rugExitPending: Set<string>;
  rugExitStore: Pick<RugExitStore, 'removePending'>;
  buildingToken2022Positions: Map<string, number>;
  publishReClose(m: Mirror): Promise<void>;
  leaderOf(m: Pick<Mirror, 'leaderAddress'>): string;
  closeConfirmedKey(leader: string, pool: string, ourPosition: string): string;
  cancelPendingOpen(leaderPosition: string, pool: string): void;
  pendingOpenMapsView(): PendingOpenMaps;
}

export interface ReconcileSweepDeps {
  log: Logger;
  /** The LIVE runtimes view (deactivated users stay here until their mirrors drain — never-miss). */
  runtimes(): Iterable<ReconcileRuntime>;
  /** ONE wallet enumeration per tick (heavy getProgramAccounts) — shared by every user. Enumerator output is
   *  used for ORPHAN detection only (it can lag); closes are decided on the direct reads below. */
  enumeratePositions(): Promise<UserPosition[]>;
  /** Direct `getAccountInfo`: an object (present), null (account gone — the reliable close signal) or a rejection
   *  (mapped to undefined — never acted on). Deduped by the per-sweep read cache. */
  readAccountInfo(pubkey: string): Promise<object | null | undefined>;
  /** Shared wallet-level re-close grace map (position pubkeys are globally unique on the one wallet). */
  recentlyPublishedClose: Map<string, number>;
  /** Publish a close for a position NO user tracks — SYSTEM-bound (wallet maintenance, INC3B-PLAN §4). */
  publishOrphanClose(p: UserPosition): Promise<void>;
  openGraceMs: number;
  recloseGraceMs: number;
  token2022DepositGraceMs: number;
  /** Injectable clock (tests). */
  nowMs?: () => number;
}

const intersect = (a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> => {
  const out = new Set<string>();
  for (const v of b) if (a.has(v)) out.add(v);
  return out;
};

/** Phase 2 for ONE user: direct reads (cached) → planReconcile (per-user orphans structurally empty) → apply
 *  markClosed/reClose against THAT user's store/registry/emitter. Returns the user's claims for the orphan pass. */
async function reconcileUser(
  rt: ReconcileRuntime,
  deps: ReconcileSweepDeps,
  ourOnChain: ReadonlySet<string>,
  readCached: (pubkey: string) => Promise<object | null | undefined>,
  now: number,
): Promise<OrphanScanUser> {
  const tracked = await rt.store.loadOpen();

  // Per-mirror DIRECT account reads — the RELIABLE close signal (a per-account getAccountInfo, not the laggy
  // enumerator): is OUR position gone? is the leader's? A read error → undefined → never added (no close on doubt).
  const ourClosed = new Set<string>();
  const leaderClosed = new Set<string>();
  await Promise.all(
    tracked.map(async (m) => {
      const [ours, leader] = await Promise.all([
        readCached(m.ourPosition),
        readCached(m.leaderPosition),
      ]);
      if (ours === null) ourClosed.add(m.ourPosition); // null = account gone (rent reclaimed on DLMM close)
      if (leader === null) leaderClosed.add(m.leaderPosition);
    }),
  );

  // Open-grace: a copy opened < openGraceMs ago isn't reliably confirmable on-chain yet → exclude it from close
  // decisions so a fresh open is never mistaken for "gone" (anti-dormant regression).
  const recentlyOpened = new Set(
    tracked.filter((m) => now - m.openedAt < deps.openGraceMs).map((m) => m.ourPosition),
  );
  const trackedOurs = new Set(tracked.map((m) => m.ourPosition));

  const plan = planReconcile({
    // INTERSECTED with THIS user's tracked set (INC3B-PLAN §4): another user's live position must never surface
    // in this user's plan as an orphan — the global pass below is the only orphan authority on the shared wallet.
    ourOnChain: intersect(ourOnChain, trackedOurs),
    ourClosed,
    tracked: tracked.map((m) => ({ ourPosition: m.ourPosition, leaderPosition: m.leaderPosition })),
    leaderClosed,
    recentlyOpened,
    rugExitPending: rt.rugExitPending, // re-close a rug-SL/stop-closed mirror until confirmed gone — never-miss-close
  });

  for (const our of plan.markClosed) {
    const m = tracked.find((x) => x.ourPosition === our);
    if (!m) continue;
    await rt.store.markClosed(m.leaderPosition);
    rt.registry.close(m.leaderPosition);
    deps.recentlyPublishedClose.delete(our);
    rt.rugSlTracker.forget(our);
    void purgeRugExitPending(rt.rugExitPending, rt.rugExitStore, our); // close CONFIRMED gone → stop retrying

    rt.events.closed({
      stage: 'close',
      outcome: 'confirmed',
      leader: rt.leaderOf(m), // the MIRROR's leader (3b)
      pool: m.pool,
      leaderPosition: m.leaderPosition,
      ourPosition: our,
      ourSizeSol: m.sizeSol,
      eventKey: rt.closeConfirmedKey(rt.leaderOf(m), m.pool, our),
      adminDetail: { nonSolSymbol: m.nonSolSymbol, via: 'reconcile' },
    });
  }
  for (const rc of plan.reClose) {
    // Grace: skip if we published a close for this position recently (let the in-flight close land first).
    if (now - (deps.recentlyPublishedClose.get(rc.ourPosition) ?? 0) < deps.recloseGraceMs)
      continue;
    const m = tracked.find((x) => x.ourPosition === rc.ourPosition);
    if (m) await rt.publishReClose(m);
  }
  return {
    tracked: trackedOurs,
    recentlyOpened,
    buildingToken2022: rt.buildingToken2022Positions,
  };
}

/**
 * The anti-dormant reconcile over the SHARED wallet (the no-miss-close pillar) — see the module doc.
 * Returns `{ enumerated }`: false when the position enumerator (getAllLbPairPositionsByUser) threw, which the
 * SDK does CONSISTENTLY for certain wallet states (issue #245). Crucially, an enumerator failure does NOT abort
 * the per-user close backstop (Phase 2): markClosed/reClose depend on per-account DIRECT reads, not on the
 * enumerator — so a leader close is still mirrored while the SDK enumerator is broken (ULTRACODE #17). Only the
 * orphan pass (Phase 3) needs the enumeration and is skipped. The caller treats `enumerated:false` as a reconcile
 * FAILURE so a permanently-broken enumerator trips the detection-stale watchdog instead of reading as healthy
 * (ULTRACODE #14).
 */
export async function runReconcileSweep(
  deps: ReconcileSweepDeps,
): Promise<{ enumerated: boolean }> {
  const now = (deps.nowMs ?? Date.now)();

  // Phase 1 — ONE shared enumeration. Failure degrades (does NOT abort): Phase 2's close backstop uses direct
  // reads and still runs; only the orphan pass (which genuinely needs the whole-wallet enumeration) is skipped.
  let held: UserPosition[] = [];
  let enumerated = true;
  try {
    held = await deps.enumeratePositions();
  } catch (e) {
    enumerated = false;
    deps.log.error(
      { e: (e as Error).message },
      'reconcile: enumerator failed → orphan pass skipped; per-user close backstop still runs (direct reads)',
    );
  }
  const ourOnChain = new Set(held.map((p) => p.position));

  // Per-sweep read cache, keyed by pubkey, caching PROMISES so concurrent readers of the same account share one
  // in-flight RPC (two users mirroring the same leaderPosition = one read). Never outlives the sweep (staleness
  // is bounded by the tick).
  const cache = new Map<string, Promise<object | null | undefined>>();
  const readCached = (pubkey: string): Promise<object | null | undefined> => {
    let p = cache.get(pubkey);
    if (!p) {
      p = deps.readAccountInfo(pubkey).catch(() => undefined); // read error → undefined → never a close on doubt
      cache.set(pubkey, p);
    }
    return p;
  };

  // Phase 2 — per-user plans, isolated per user.
  const runtimes = [...deps.runtimes()];
  const userClaims: OrphanScanUser[] = [];
  let claimsComplete = true;
  for (const rt of runtimes) {
    try {
      userClaims.push(await reconcileUser(rt, deps, ourOnChain, readCached, now));
    } catch (e) {
      // This user's claims are UNKNOWN this tick → the global orphan pass must not run (their live positions
      // would read as "tracked by no user" and be force-closed — the forbidden false close).
      claimsComplete = false;
      deps.log.error(
        { e: (e as Error).message, userId: rt.userId },
        "reconcile: user sweep failed → this user skipped this tick (others' sweeps ran)",
      );
    }
  }

  // Phase 3 — GLOBAL orphan pass (SYSTEM wallet maintenance). Requires the enumeration (no whole-wallet view
  // without it) AND complete per-user claims (else a user's live position reads as "tracked by no user").
  if (enumerated && claimsComplete) {
    const orphans = planOrphans({
      onChain: ourOnChain,
      users: userClaims,
      nowMs: now,
      buildingGraceMs: deps.token2022DepositGraceMs,
    });
    for (const orphan of orphans) {
      // A past-grace Token-2022 build entry (deposit never landed) is consumed here: the empty position IS this
      // orphan and gets cleaned; keeping the entry would re-shield it forever.
      for (const rt of runtimes) rt.buildingToken2022Positions.delete(orphan);
      // Stray position on our wallet (a bug-forgotten mirror or a manual open) → AUTO-CLOSE it. We have its
      // pool + bins from the enumerator. The grace avoids re-publishing while a previous orphan-close lands.
      const p = held.find((h) => h.position === orphan);
      if (p && now - (deps.recentlyPublishedClose.get(orphan) ?? 0) >= deps.recloseGraceMs) {
        await deps
          .publishOrphanClose(p)
          .catch((e) =>
            deps.log.error(
              { e: (e as Error).message, position: orphan },
              'orphan close publish failed (retried next sweep)',
            ),
          );
      }
    }
  }

  // Pending-open-cancel backstop, PER RUNTIME over its own pending maps: a leader that closed a position whose
  // MULTI-TX open is still in flight is never in `tracked` (no mirror yet), so the loops above can't catch it.
  // Cancel any pending open whose leader account is confirmably GONE so the continuation never funds an exited
  // pool — only on a CLEAN read (null; else rely on handleClose).
  for (const rt of runtimes) {
    try {
      const pendingLeaders = [...pendingOpenLeaders(rt.pendingOpenMapsView())].filter(
        ([lp]) => !rt.registry.hasOpen(lp),
      );
      await Promise.all(
        pendingLeaders.map(async ([lp, pool]) => {
          const info = await readCached(lp);
          if (info === null) rt.cancelPendingOpen(lp, pool); // leader gone → the pending open must not complete
        }),
      );
    } catch (e) {
      deps.log.error(
        { e: (e as Error).message, userId: rt.userId },
        'reconcile: pending-open backstop failed for this user (others unaffected)',
      );
    }
  }
  return { enumerated };
}

/** The per-user runtime surface the rug-SL sweep drives (structural — `UserRuntime` satisfies it). */
export interface RugSweepRuntime {
  readonly userId: string;
  registry: { openPositions(): Mirror[] };
  getConfig(): CopybotConfig;
  rugSlTracker: Pick<RugSlTracker, 'record' | 'check' | 'forget'>;
  rugExitPending: Set<string>;
  rugExitStore: Pick<RugExitStore, 'addPending' | 'addExited'>;
  rugExited: Set<string>;
  publishSafetyClose(m: Mirror, tag: string, reason: string): Promise<void>;
}

export interface RugSlSweepDeps {
  log: Logger;
  runtimes(): Iterable<RugSweepRuntime>;
  /** One active-bin token-price read per pool per tick — shared by every user's mirrors on that pool. A failed
   *  read yields null → NOT recorded, so a transient RPC blip can never fabricate a crash. */
  readPoolTokenPrice(pool: string): Promise<number | null>;
  recentlyPublishedClose: Map<string, number>;
  recloseGraceMs: number;
  nowMs?: () => number;
}

/**
 * Rug-SL over EVERY runtime's open mirrors, grouped by pool (Inc.3b step 6): poll each open pool's active-bin
 * token price ONCE, feed each (runtime, mirror) tracker, and close any position whose price crashed ≥ dropPercent
 * within ITS user's per-leader window. The leader keeps holding (it's OUR independent safety exit) → close + drop
 * the tracker window; re-copy only on a NEW leader open. Per-entry isolation: one user's failing publish never
 * blocks another user's crash exit.
 */
export async function runRugSlSweep(deps: RugSlSweepDeps): Promise<void> {
  const now = (deps.nowMs ?? Date.now)();
  const byPool = new Map<string, Array<{ rt: RugSweepRuntime; m: Mirror }>>();
  for (const rt of deps.runtimes()) {
    for (const m of rt.registry.openPositions())
      byPool.set(m.pool, [...(byPool.get(m.pool) ?? []), { rt, m }]);
  }
  for (const [pool, entries] of byPool) {
    const price = await deps.readPoolTokenPrice(pool);
    if (price === null) continue; // never record a garbage price → no false trigger
    for (const { rt, m } of entries) {
      try {
        // Per-(user, leader) config (3b): the trigger reads THE USER's settings for the leader THIS mirror
        // copies — user A's rug config must never fire (or mute) a close on user B's mirror, nor leader A's
        // config on leader B's mirror.
        const rugCfg = effectiveFor(rt.getConfig(), m.leaderAddress).rugSl;
        rt.rugSlTracker.record(m.ourPosition, price, now);
        if (!rugCfg.enabled) continue;
        if (now - (deps.recentlyPublishedClose.get(m.ourPosition) ?? 0) < deps.recloseGraceMs)
          continue; // a close is already in flight
        if (!rt.rugSlTracker.check(m.ourPosition, rugCfg, now)) continue;
        await rt.publishSafetyClose(m, 'rugsl', 'rug_sl');
        // Keep the mirror TRACKED (do NOT registry.close here): a failed rug-SL close (congestion — the rug case)
        // must be re-published by the reconcile until the position is confirmed gone on-chain. Marking it
        // rug-exit-pending drives that retry independent of `leaderClosed` (the leader still holds it — rug-SL is
        // OUR exit). The reconcile clears the pending flag + registry.close + DB markClosed once the close lands.
        rt.rugExitPending.add(m.ourPosition);
        void rt.rugExitStore.addPending(m.ourPosition); // persist so the retry survives a brain restart
        rt.rugSlTracker.forget(m.ourPosition); // stop price re-triggering (grace + reconcile now own the retry)
        rt.rugExited.add(m.leaderPosition); // suppress re-opening this leader position on its next add
        void rt.rugExitStore.addExited(m.leaderPosition); // persist so the suppression survives a brain restart
      } catch (e) {
        deps.log.error(
          { e: (e as Error).message, userId: rt.userId, our: m.ourPosition },
          "rug-sl: user trigger failed → other users' mirrors unaffected",
        );
      }
    }
  }
}
