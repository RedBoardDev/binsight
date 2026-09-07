import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { CONFIG_DEFAULTS, type CopybotConfig } from '@/domain/copybot/config';
import type { OwnerTokenBalance } from '@/domain/copybot/residual-sell';
import type { UserPosition } from '@/infrastructure/solana/dlmm/leader-position-reader';
import type { Mirror } from './mirror-registry';
import type { PendingOpenMaps } from './pending-open-cancel';
import {
  type ReconcileSweepDeps,
  type ResidualSweepDeps,
  type ResidualSweepRuntime,
  RUG_SL_STALE_PRICE_READS,
  type RugSlSweepDeps,
  type RugSweepRuntime,
  runReconcileSweep,
  runReconcileSweepByWallet,
  runResidualSweep,
  runRugSlSweep,
  type WalletReconcileRuntime,
  type WalletReconcileSweepDeps,
} from './wallet-sweeps';

const log = pino({ level: 'silent' });
const NOW = 10_000_000;
const OPEN_GRACE_MS = 30_000;
const RECLOSE_GRACE_MS = 60_000;
const BUILDING_GRACE_MS = 90_000;
const LEADER = 'Leader1111111111111111111111111111111111111';
const LP = 'LEADER_POS_SHARED'; // the SAME leader position mirrored by both users (the 3b topology)
// Inc.4c wallets: the pre-4c topology is ONE shared wallet; a real user has their OWN (distinct) wallet.
const SHARED_WALLET = 'WalletSharedxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const WALLET_A = 'WalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WALLET_B = 'WalletBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WSOL = 'So11111111111111111111111111111111111111112';

const mirror = (over: Partial<Mirror>): Mirror => ({
  leaderPosition: LP,
  leaderAddress: LEADER,
  ourPosition: 'OUR',
  pool: 'POOL',
  nonSolSymbol: 'TOK',
  nonSolMint: 'MINT',
  sizeSol: 0.5,
  lowerBin: -5,
  upperBin: 5,
  openedAt: NOW - OPEN_GRACE_MS * 2, // past the open-grace unless a test overrides it
  status: 'open',
  ...over,
});

const emptyPendingMaps = (): PendingOpenMaps => ({
  twoSidedOpens: new Map(),
  token2022Deposits: new Map(),
  token2022Mirrors: new Map(),
  reshapeAdds: new Map(),
});

/** Recording ReconcileRuntime stub — every side effect the sweep may take is captured for assertions. Carries a
 *  `wallet` + `publishOrphanClose` (Inc.4c) so it also satisfies the per-wallet orchestrator; the plain
 *  `runReconcileSweep` tests ignore both (they publish orphans through the deps-level publisher). */
function makeReconcileRt(
  userId: string,
  mirrors: Mirror[],
  opts: { loadOpenThrows?: boolean; wallet?: string; inFlight?: string[] } = {},
) {
  const calls = {
    markClosed: [] as string[],
    registryClosed: [] as string[],
    reClosed: [] as string[],
    reCloseAttempts: [] as Array<number | undefined>, // the per-tick discriminator stamp threaded to publishReClose (#64)
    closedEvents: [] as unknown[],
    cancelled: [] as string[],
    orphanClosed: [] as string[],
  };
  const rt: WalletReconcileRuntime = {
    userId,
    wallet: opts.wallet ?? SHARED_WALLET,
    publishOrphanClose: async (p) => {
      calls.orphanClosed.push(p.position);
    },
    store: {
      loadOpen: async () => {
        if (opts.loadOpenThrows) throw new Error('db down for this user');
        return mirrors;
      },
      markClosed: async (lp) => {
        calls.markClosed.push(lp);
      },
    },
    registry: {
      close: (lp) => calls.registryClosed.push(String(lp)),
      hasOpen: () => false,
    },
    events: {
      closed: (fields: unknown) => {
        calls.closedEvents.push(fields);
      },
    } as WalletReconcileRuntime['events'],
    rugSlTracker: { forget: () => {} },
    rugExitPending: new Set<string>(),
    rugExitStore: { removePending: async () => {} },
    buildingToken2022Positions: new Map<string, number>(),
    publishReClose: async (m, reCloseAttempt) => {
      calls.reClosed.push(m.ourPosition);
      calls.reCloseAttempts.push(reCloseAttempt);
    },
    leaderOf: (m) => m.leaderAddress,
    closeConfirmedKey: (leader, pool, our) => `${leader}:${pool}:close-confirmed:${our}`,
    cancelPendingOpen: (lp) => calls.cancelled.push(lp),
    pendingOpenMapsView: emptyPendingMaps,
    isOpenInFlight: (lp) => (opts.inFlight ?? []).includes(lp),
  };
  return { rt, calls };
}

/** Deps with a scripted account universe: `reads` maps pubkey → present({}) / gone(null); unlisted → undefined. */
function makeDeps(
  runtimes: WalletReconcileRuntime[],
  held: UserPosition[],
  reads: Record<string, object | null>,
) {
  const readCounts = new Map<string, number>();
  const orphanCloses: string[] = [];
  const deps: ReconcileSweepDeps = {
    log,
    runtimes: () => runtimes,
    enumeratePositions: async () => held,
    readAccountInfo: async (pubkey) => {
      readCounts.set(pubkey, (readCounts.get(pubkey) ?? 0) + 1);
      return reads[pubkey];
    },
    recentlyPublishedClose: new Map<string, number>(),
    publishOrphanClose: async (p) => {
      orphanCloses.push(p.position);
    },
    openGraceMs: OPEN_GRACE_MS,
    recloseGraceMs: RECLOSE_GRACE_MS,
    token2022DepositGraceMs: BUILDING_GRACE_MS,
    nowMs: () => NOW,
  };
  return { deps, readCounts, orphanCloses };
}

const pos = (position: string): UserPosition => ({
  position,
  pool: 'POOL',
  lowerBinId: -5,
  upperBinId: 5,
});

describe('runReconcileSweep — shared-wallet attribution (Inc.3b S6)', () => {
  it("A's ourPosition gone ⇒ A markClosed; B (same leaderPosition, still on-chain) untouched", async () => {
    // WHY: two users mirror the SAME leader position with DISTINCT ephemeral positions on ONE wallet. Attribution
    // is by the (user, ourPosition) mirror row — if the sweep keyed by leaderPosition alone, A's confirmed close
    // would also flip B's LIVE mirror to closed (B stops re-closing/rug-watching a position still holding capital).
    const { rt: rtA, calls: a } = makeReconcileRt('user-a', [mirror({ ourPosition: 'OUR_A' })]);
    const { rt: rtB, calls: b } = makeReconcileRt('user-b', [mirror({ ourPosition: 'OUR_B' })]);
    const { deps } = makeDeps([rtA, rtB], [pos('OUR_B')], {
      OUR_A: null, // gone on-chain — the reliable close signal
      OUR_B: {}, // still present
      [LP]: {}, // the leader still holds it
    });
    await runReconcileSweep(deps);
    expect(a.markClosed).toEqual([LP]);
    expect(a.registryClosed).toEqual([LP]);
    expect(a.closedEvents).toHaveLength(1);
    expect(b.markClosed).toEqual([]);
    expect(b.reClosed).toEqual([]);
    expect(b.closedEvents).toEqual([]);
  });

  it('leader gone ⇒ BOTH users reClose THEIR OWN mirror (per-user retry, per-user keys)', async () => {
    // WHY: one on-chain fact (the leader closed) must produce one close PER USER — each runtime publishes with
    // its own commandId derivation, so a missing per-user reClose would leave that user's capital dormant.
    const { rt: rtA, calls: a } = makeReconcileRt('user-a', [mirror({ ourPosition: 'OUR_A' })]);
    const { rt: rtB, calls: b } = makeReconcileRt('user-b', [mirror({ ourPosition: 'OUR_B' })]);
    const { deps } = makeDeps([rtA, rtB], [pos('OUR_A'), pos('OUR_B')], {
      OUR_A: {},
      OUR_B: {},
      [LP]: null, // leader position gone
    });
    await runReconcileSweep(deps);
    expect(a.reClosed).toEqual(['OUR_A']);
    expect(b.reClosed).toEqual(['OUR_B']);
  });

  it('#64 retry-audit: each reconcile tick threads its OWN stamp to publishReClose (distinct ticks ⇒ distinct rows; one tick ⇒ dedup)', async () => {
    // WHY: a leader-closed reClose reuses the SAME deterministic commandId every retry tick (so the vault idempotency
    // re-signs the SAME close until it lands). The journal dedup index is (wallet, correlationId, code) with
    // correlationId defaulting to commandId — so WITHOUT a per-tick discriminator every retry collapses onto the first
    // tick's audit row (a genuine retry silently lost). The sweep stamps its tick `now` onto publishReClose; the
    // event-store then turns distinct stamps into distinct correlationIds (see event-store.test.ts "keeps rows with a
    // DISTINCT correlationId"). A within-tick re-publish would share the stamp ⇒ correctly dedups.
    const { rt, calls } = makeReconcileRt('user-a', [mirror({ ourPosition: 'OUR_A' })]);
    const { deps } = makeDeps([rt], [pos('OUR_A')], { OUR_A: {}, [LP]: null }); // leader gone ⇒ reClose every tick

    const TICK_1 = NOW;
    const TICK_2 = NOW + RECLOSE_GRACE_MS + 1; // a LATER reconcile tick (past the reclose grace)
    deps.nowMs = () => TICK_1;
    await runReconcileSweep(deps);
    deps.nowMs = () => TICK_2;
    await runReconcileSweep(deps);

    // One reClose per tick (a given close is never double-published within one tick), each carrying THAT tick's
    // stamp — so the two retries differ (⇒ distinct correlationIds ⇒ distinct audit rows), while a within-tick
    // duplicate would share the stamp (⇒ dedup).
    expect(calls.reClosed).toEqual(['OUR_A', 'OUR_A']);
    expect(calls.reCloseAttempts).toEqual([TICK_1, TICK_2]);
    expect(TICK_1).not.toBe(TICK_2);
  });

  it('read-cache dedup: the shared leaderPosition is read ONCE for two users (O(distinct positions))', async () => {
    // WHY: the sweep's RPC cost must scale with the wallet, not the user count — N users mirroring one leader
    // position paying N direct reads would blow the RPC budget exactly when the bot scales.
    const { rt: rtA } = makeReconcileRt('user-a', [mirror({ ourPosition: 'OUR_A' })]);
    const { rt: rtB } = makeReconcileRt('user-b', [mirror({ ourPosition: 'OUR_B' })]);
    const { deps, readCounts } = makeDeps([rtA, rtB], [pos('OUR_A'), pos('OUR_B')], {
      OUR_A: {},
      OUR_B: {},
      [LP]: {},
    });
    await runReconcileSweep(deps);
    expect(readCounts.get(LP)).toBe(1); // deduped across users
    expect(readCounts.get('OUR_A')).toBe(1);
    expect(readCounts.get('OUR_B')).toBe(1);
  });

  it("per-user failure isolation: A's DB failure skips A only — B is swept; the orphan pass is SKIPPED", async () => {
    // WHY (two guarantees): one user's broken DB must not blind every other user's no-miss-close backstop; AND
    // with A's claims unknown, the orphan pass could read A's LIVE positions as "tracked by no user" and
    // force-close them — incomplete claims must veto the wallet-level pass, never guess.
    const { rt: rtA } = makeReconcileRt('user-a', [mirror({ ourPosition: 'OUR_A' })], {
      loadOpenThrows: true,
    });
    const { rt: rtB, calls: b } = makeReconcileRt('user-b', [mirror({ ourPosition: 'OUR_B' })]);
    const { deps, orphanCloses } = makeDeps(
      [rtA, rtB],
      [pos('OUR_A'), pos('OUR_B'), pos('TRUE_STRAY')],
      { OUR_B: {}, [LP]: null },
    );
    await runReconcileSweep(deps);
    expect(b.reClosed).toEqual(['OUR_B']); // B's sweep ran despite A's failure
    expect(orphanCloses).toEqual([]); // orphan pass vetoed — A's claims were unknown
  });

  it('global orphan pass: a position tracked by NO user is closed once, via the SYSTEM publisher', async () => {
    const { rt: rtA } = makeReconcileRt('user-a', [mirror({ ourPosition: 'OUR_A' })]);
    const { deps, orphanCloses } = makeDeps([rtA], [pos('OUR_A'), pos('STRAY')], {
      OUR_A: {},
      [LP]: {},
    });
    await runReconcileSweep(deps);
    expect(orphanCloses).toEqual(['STRAY']);
  });

  it("orphan suppressions: reclose-grace and ANY user's within-grace Token-2022 build both defer the close", async () => {
    const { rt: rtA } = makeReconcileRt('user-a', []);
    const { rt: rtB } = makeReconcileRt('user-b', []);
    rtB.buildingToken2022Positions.set('BUILDING', NOW - 1); // B's deposit still in flight
    const { deps, orphanCloses } = makeDeps([rtA, rtB], [pos('RECENT'), pos('BUILDING')], {});
    deps.recentlyPublishedClose.set('RECENT', NOW - 1); // an orphan close is already landing
    await runReconcileSweep(deps);
    expect(orphanCloses).toEqual([]);
    expect(rtB.buildingToken2022Positions.has('BUILDING')).toBe(true); // within grace → entry kept
  });

  it('a PAST-grace Token-2022 build is cleaned: entry dropped + the empty position orphan-closed', async () => {
    const { rt } = makeReconcileRt('user-a', []);
    rt.buildingToken2022Positions.set('STALE_BUILD', NOW - BUILDING_GRACE_MS);
    const { deps, orphanCloses } = makeDeps([rt], [pos('STALE_BUILD')], {});
    await runReconcileSweep(deps);
    expect(orphanCloses).toEqual(['STALE_BUILD']);
    expect(rt.buildingToken2022Positions.has('STALE_BUILD')).toBe(false);
  });

  it('enumeration failure DEGRADES (not aborts): the per-user close backstop still runs, only the orphan pass is skipped (#17)', async () => {
    // WHY (was the inverse assertion — the #17 bug): an enumerator throw (SDK #245) used to skip EVERYTHING,
    // silently dropping the leader-close backstop. Now the direct-read close signal still confirms a gone
    // position (markClosed) while only the orphan authority (which needs the whole-wallet enumeration) is skipped.
    const { rt, calls } = makeReconcileRt('user-a', [mirror({ ourPosition: 'OUR_A' })]);
    const { deps, orphanCloses } = makeDeps([rt], [], { OUR_A: null, [LP]: null });
    deps.enumeratePositions = async () => {
      throw new Error('rpc down');
    };
    const result = await runReconcileSweep(deps);
    expect(calls.markClosed).toEqual([LP]); // OUR_A confirmed gone via direct read → close confirmed
    expect(orphanCloses).toEqual([]); // orphan pass skipped (no enumeration)
    expect(result.enumerated).toBe(false); // reported as a reconcile failure to the watchdog (#14)
  });

  it('pending-open-cancel backstop runs PER RUNTIME: only the owner of the gone leader cancels', async () => {
    const { rt: rtA, calls: a } = makeReconcileRt('user-a', []);
    const { rt: rtB, calls: b } = makeReconcileRt('user-b', []);
    const stash = { e: { position: 'LP_PENDING', pool: 'POOL' } };
    rtA.pendingOpenMapsView = () => ({
      ...emptyPendingMaps(),
      twoSidedOpens: new Map([['CMD', stash]]) as PendingOpenMaps['twoSidedOpens'],
    });
    const { deps } = makeDeps([rtA, rtB], [], { LP_PENDING: null }); // leader account gone
    await runReconcileSweep(deps);
    expect(a.cancelled).toEqual(['LP_PENDING']);
    expect(b.cancelled).toEqual([]);
  });
});

/** Recording RugSweepRuntime stub. `checkResult` scripts the crash verdict per ourPosition. */
function makeRugRt(
  userId: string,
  mirrors: Mirror[],
  config: CopybotConfig,
  checkResult: (ourPosition: string) => boolean,
  opts: { publishThrows?: boolean; order?: string[]; trackExited?: boolean } = {},
) {
  const calls = {
    recorded: [] as Array<{ key: string; price: number }>,
    safetyCloses: [] as string[],
    pendingPersisted: [] as string[],
    forgotten: [] as string[],
  };
  const rt: RugSweepRuntime = {
    userId,
    registry: { openPositions: () => mirrors },
    getConfig: () => config,
    rugSlTracker: {
      record: (key, price) => calls.recorded.push({ key, price }),
      check: (key) => checkResult(key),
      forget: (key) => calls.forgotten.push(key),
    },
    rugExitPending: new Set<string>(),
    rugExitStore: {
      addPending: async (our) => {
        // When an `order` recorder is supplied, model the async DB INSERT commit with a real await gap: the durable
        // row lands only AFTER the write resolves. #153 requires this to be AWAITED before the close is published —
        // a fire-and-forget (void) would let the publish (and a crash) race ahead of the commit, reordering it after
        // 'publish'. Without `order`, addPending stays a synchronous push (existing tests unaffected).
        if (opts.order) await Promise.resolve();
        calls.pendingPersisted.push(our);
        opts.order?.push('addPending');
      },
      addExited: async () => {
        // Mirror addPending's async-commit gap so the ordering test can prove addExited is AWAITED before the
        // publish (the RE-OPEN-suppression channel, distinct from #153's re-close channel). Gated on `trackExited`
        // so the addPending-only #153 ordering test keeps its `order` == ['addPending','publish'].
        if (opts.order && opts.trackExited) {
          await Promise.resolve();
          opts.order.push('addExited');
        }
      },
    },
    rugExited: new Set<string>(),
    publishSafetyClose: async (m) => {
      opts.order?.push('publish'); // record the publish ATTEMPT (even when it then throws) for the ordering assertion
      if (opts.publishThrows) throw new Error('publish down');
      calls.safetyCloses.push(m.ourPosition);
    },
  };
  return { rt, calls };
}

const configWithRugSl = (enabled: boolean): CopybotConfig => ({
  user: { ...CONFIG_DEFAULTS.user, rugSl: { ...CONFIG_DEFAULTS.user.rugSl, enabled } },
  leaders: [{ address: LEADER, enabled: true, maxTotalExposureSol: null, overrides: {} }],
});

describe('runRugSlSweep — pool-grouped across runtimes (Inc.3b S6)', () => {
  const rugDeps = (runtimes: RugSweepRuntime[], price: number | null | (() => number | null)) => {
    const priceReads: string[] = [];
    const deps: RugSlSweepDeps = {
      log,
      runtimes: () => runtimes,
      readPoolTokenPrice: async (pool) => {
        priceReads.push(pool);
        return typeof price === 'function' ? price() : price; // a fn scripts a per-tick price for staleness tests
      },
      recentlyPublishedClose: new Map(),
      recloseGraceMs: RECLOSE_GRACE_MS,
      priceReadStaleness: new Map(),
      nowMs: () => NOW,
    };
    return { deps, priceReads };
  };

  it('ONE price read per pool per tick even with two users on the pool; both trackers get the sample', async () => {
    // WHY: the price read is the sweep's only RPC — per-mirror reads would multiply cost by users×mirrors for
    // the same number. And BOTH users' windows must advance (a starved tracker can never detect a crash).
    const { rt: rtA, calls: a } = makeRugRt(
      'user-a',
      [mirror({ ourPosition: 'OUR_A' })],
      configWithRugSl(true),
      () => false,
    );
    const { rt: rtB, calls: b } = makeRugRt(
      'user-b',
      [mirror({ ourPosition: 'OUR_B' })],
      configWithRugSl(true),
      () => false,
    );
    const { deps, priceReads } = rugDeps([rtA, rtB], 1.5);
    await runRugSlSweep(deps);
    expect(priceReads).toEqual(['POOL']); // one read, not two
    expect(a.recorded).toEqual([{ key: 'OUR_A', price: 1.5 }]);
    expect(b.recorded).toEqual([{ key: 'OUR_B', price: 1.5 }]);
  });

  it("trigger isolation: only the user with rugSl ENABLED for that leader closes; the other's mirror is untouched", async () => {
    // WHY: rug-SL is per-(user, leader) config — user A opting into a crash exit must never force-close user B's
    // mirror of the same pool (B chose to ride it out), and B's opt-out must never mute A's exit.
    const { rt: rtA, calls: a } = makeRugRt(
      'user-a',
      [mirror({ ourPosition: 'OUR_A' })],
      configWithRugSl(true),
      () => true,
    );
    const { rt: rtB, calls: b } = makeRugRt(
      'user-b',
      [mirror({ ourPosition: 'OUR_B' })],
      configWithRugSl(false),
      () => true,
    );
    const { deps } = rugDeps([rtA, rtB], 0.1);
    await runRugSlSweep(deps);
    expect(a.safetyCloses).toEqual(['OUR_A']);
    expect(rtA.rugExitPending.has('OUR_A')).toBe(true); // retry-until-confirmed bookkeeping is A's
    expect(rtA.rugExited.has(LP)).toBe(true);
    expect(b.safetyCloses).toEqual([]);
    expect(rtB.rugExitPending.size).toBe(0);
  });

  it('a per-leader override disables the trigger for THAT leader only (per-(user,leader) resolution)', async () => {
    // WHY: effectiveFor must be resolved with the MIRROR's leader — resolving with a global/user view would let
    // leader A's rug settings fire (or mute) a close on leader B's mirror.
    const OTHER_LEADER = 'Leader2222222222222222222222222222222222222';
    const config: CopybotConfig = {
      user: { ...CONFIG_DEFAULTS.user, rugSl: { ...CONFIG_DEFAULTS.user.rugSl, enabled: true } },
      leaders: [
        {
          address: LEADER,
          enabled: true,
          maxTotalExposureSol: null,
          overrides: { rugSl: { enabled: false } },
        },
        { address: OTHER_LEADER, enabled: true, maxTotalExposureSol: null, overrides: {} },
      ],
    };
    const mirrors = [
      mirror({ ourPosition: 'OUR_MUTED', leaderAddress: LEADER }),
      mirror({ ourPosition: 'OUR_ARMED', leaderPosition: 'LP2', leaderAddress: OTHER_LEADER }),
    ];
    const { rt, calls } = makeRugRt('user-a', mirrors, config, () => true);
    const { deps } = rugDeps([rt], 0.1);
    await runRugSlSweep(deps);
    expect(calls.safetyCloses).toEqual(['OUR_ARMED']); // the muted leader's mirror never closes
  });

  it("failure isolation: user A's throwing publish never blocks user B's crash exit on the SAME pool", async () => {
    const { rt: rtA, calls: a } = makeRugRt(
      'user-a',
      [mirror({ ourPosition: 'OUR_A' })],
      configWithRugSl(true),
      () => true,
      { publishThrows: true },
    );
    const { rt: rtB, calls: b } = makeRugRt(
      'user-b',
      [mirror({ ourPosition: 'OUR_B' })],
      configWithRugSl(true),
      () => true,
    );
    const { deps } = rugDeps([rtA, rtB], 0.1);
    await runRugSlSweep(deps);
    expect(a.safetyCloses).toEqual([]);
    expect(b.safetyCloses).toEqual(['OUR_B']); // B's exit fired despite A's failure
  });

  it('a FAILED rug-SL publish STILL arms the retry state (persisted) so the reconcile re-closes (ULTRACODE #11/#15)', async () => {
    // WHY: the rug-SL close is our INDEPENDENT crash exit — the leader keeps holding, so `leaderClosed` never fires a
    // retry. If a failing publish (the rug case lands worst under congestion, and publish() re-throws non-connection
    // failures) skipped arming rugExitPending, the position would sit dormant full of a rugging token until the leader
    // closes (possibly days) — the exact loss rug-SL exists to prevent. So the pending set MUST be armed even when the
    // publish throws; the reconcile then re-closes each tick until the position is confirmed gone.
    const { rt, calls } = makeRugRt(
      'user-a',
      [mirror({ ourPosition: 'OUR_RUG' })],
      configWithRugSl(true),
      () => true,
      { publishThrows: true },
    );
    const { deps } = rugDeps([rt], 0.1);
    await runRugSlSweep(deps);
    expect(calls.safetyCloses).toEqual([]); // the publish threw → nothing landed
    expect(rt.rugExitPending.has('OUR_RUG')).toBe(true); // ...but the reconcile-retry channel IS armed
    expect(calls.pendingPersisted).toContain('OUR_RUG'); // ...and persisted so the retry survives a brain restart
    expect(rt.rugExited.has(LP)).toBe(true); // and the leader is suppressed from re-opening a rugged position
    expect(calls.forgotten).toContain('OUR_RUG'); // price-window forgotten → grace + reconcile own the retry
  });

  it('#153: the durable pending row is AWAITED (committed) BEFORE the safety close is published (a crash between publish and the INSERT can never lose the re-close channel)', async () => {
    // WHY: rugExitPending's durable row is the ONLY cross-restart re-close channel for a rug-SL close — the leader
    // keeps holding, so `leaderClosed` never retries. If addPending fired un-awaited (void), a SIGKILL AFTER the
    // close is published but BEFORE the INSERT commits would lose that row → the rugging position is never re-closed
    // after restart. So the durable arm MUST complete before the publish. `order` models the async DB commit; a
    // fire-and-forget would let the publish race ahead ⇒ ['publish','addPending'] (this test would then fail).
    const order: string[] = [];
    const { rt, calls } = makeRugRt(
      'user-a',
      [mirror({ ourPosition: 'OUR_RUG' })],
      configWithRugSl(true),
      () => true,
      { order, publishThrows: true }, // worst case: the publish then FAILS — the row must already be committed
    );
    const { deps } = rugDeps([rt], 0.1);
    await runRugSlSweep(deps);
    expect(order).toEqual(['addPending', 'publish']); // durable row committed BEFORE publish (fails with a void)
    expect(calls.pendingPersisted).toContain('OUR_RUG'); // ...and it is armed even though the publish threw
  });

  it('a null price read records NOTHING (a transient RPC blip can never fabricate a crash)', async () => {
    const { rt, calls } = makeRugRt(
      'user-a',
      [mirror({ ourPosition: 'OUR_A' })],
      configWithRugSl(true),
      () => true,
    );
    const { deps } = rugDeps([rt], null);
    await runRugSlSweep(deps);
    expect(calls.recorded).toEqual([]);
    expect(calls.safetyCloses).toEqual([]);
  });

  it('a close already in flight (reclose-grace) is not re-published', async () => {
    const { rt, calls } = makeRugRt(
      'user-a',
      [mirror({ ourPosition: 'OUR_A' })],
      configWithRugSl(true),
      () => true,
    );
    const { deps } = rugDeps([rt], 0.1);
    deps.recentlyPublishedClose.set('OUR_A', NOW - 1);
    await runRugSlSweep(deps);
    expect(calls.safetyCloses).toEqual([]);
  });

  it(`idx52: ${RUG_SL_STALE_PRICE_READS} consecutive null reads alert LOUD — a silently DISARMED crash exit (no fresh sample) becomes observable`, async () => {
    // WHY: a null read just `continue`d with no counter — a PERSISTENT read failure empties the tracker window, so the
    // rug-SL crash exit disarms with ZERO signal (heartbeats stay green). Count the streak and alert at the threshold.
    const errSpy = vi.spyOn(log, 'error');
    const { rt } = makeRugRt(
      'user-a',
      [mirror({ ourPosition: 'OUR_A' })],
      configWithRugSl(true),
      () => false,
    );
    const { deps } = rugDeps([rt], null);
    try {
      for (let i = 1; i < RUG_SL_STALE_PRICE_READS; i++) {
        await runRugSlSweep(deps);
        expect(errSpy).not.toHaveBeenCalled(); // below the threshold a few blips stay quiet (no false alarm)
      }
      await runRugSlSweep(deps); // the RUG_SL_STALE_PRICE_READS-th consecutive null read
      expect(errSpy).toHaveBeenCalledTimes(1); // crossing the threshold alerts LOUD
      expect(deps.priceReadStaleness.get('POOL')).toBe(RUG_SL_STALE_PRICE_READS);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('idx52: a GOOD read CLEARS the staleness streak (a recovered pool never carries a stale count into a new streak → no false alert)', async () => {
    const errSpy = vi.spyOn(log, 'error');
    const { rt } = makeRugRt(
      'user-a',
      [mirror({ ourPosition: 'OUR_A' })],
      configWithRugSl(false),
      () => false,
    );
    // Script (threshold-1) nulls, then ONE good read (must reset), then one trailing null: the reset keeps every
    // window below the threshold, so no alert ever fires and the trailing null counts from 1 again.
    let call = 0;
    const price = () => (call++ === RUG_SL_STALE_PRICE_READS - 1 ? 1.5 : null);
    const { deps } = rugDeps([rt], price);
    try {
      for (let i = 0; i < RUG_SL_STALE_PRICE_READS + 1; i++) await runRugSlSweep(deps);
      expect(errSpy).not.toHaveBeenCalled(); // the good read reset the streak → threshold never reached
      expect(deps.priceReadStaleness.get('POOL')).toBe(1); // only the single trailing null is counted
    } finally {
      errSpy.mockRestore();
    }
  });

  it('addExited: the durable RE-OPEN-suppression row is AWAITED (committed) BEFORE the safety close is published (a crash between publish and INSERT could otherwise spuriously RE-OPEN — the channel distinct from #153)', async () => {
    // WHY: rugExited's durable row is the ONLY cross-restart channel that SUPPRESSES re-opening this leader position on
    // its next add. Fired un-awaited (void), a crash after the publish but before the INSERT would lose it → a spurious
    // re-open. It must commit before the publish, exactly like addPending (#153). `order` models the async DB commit.
    const order: string[] = [];
    const { rt } = makeRugRt(
      'user-a',
      [mirror({ ourPosition: 'OUR_RUG' })],
      configWithRugSl(true),
      () => true,
      { order, trackExited: true },
    );
    const { deps } = rugDeps([rt], 0.1);
    await runRugSlSweep(deps);
    expect(order).toEqual(['addPending', 'addExited', 'publish']); // both durable rows commit BEFORE the publish (fails with a void addExited)
  });
});

describe('runReconcileSweep — enumerator failure degrades, never aborts the close backstop (#14/#17)', () => {
  it('#17: enumerator THROWS ⇒ a leader-closed mirror still reCloses (direct reads, not the SDK enumerator)', async () => {
    // WHY: getAllLbPairPositionsByUser throws CONSISTENTLY for certain wallet states (SDK #245). markClosed/reClose
    // depend on per-account direct reads, so a leader close MUST still be mirrored while the enumerator is broken —
    // otherwise the #1 no-miss-close pillar fails exactly when the enumerator is stuck.
    const { rt, calls } = makeReconcileRt('user-a', [mirror({ ourPosition: 'OUR_A' })]);
    const { deps } = makeDeps([rt], [], { OUR_A: {}, [LP]: null }); // leader gone
    deps.enumeratePositions = async () => {
      throw new Error('SDK #245: Cannot read properties of undefined');
    };
    const result = await runReconcileSweep(deps);
    expect(calls.reClosed).toEqual(['OUR_A']); // backstop ran despite the broken enumerator
    expect(result.enumerated).toBe(false);
  });

  it('#17: enumerator throws ⇒ the orphan pass is skipped (no whole-wallet view ⇒ no orphan authority)', async () => {
    const { rt } = makeReconcileRt('user-a', [mirror({ ourPosition: 'OUR_A' })]);
    const { deps, orphanCloses } = makeDeps([rt], [pos('STRAY')], {
      OUR_A: {},
      [LP]: {},
      STRAY: {},
    });
    deps.enumeratePositions = async () => {
      throw new Error('enumerator down');
    };
    await runReconcileSweep(deps);
    expect(orphanCloses).toEqual([]); // a stray can't be declared an orphan without the enumeration
  });

  it('#14: a successful enumeration returns enumerated:true (the watchdog resets on this)', async () => {
    const { rt } = makeReconcileRt('user-a', [mirror({ ourPosition: 'OUR_A' })]);
    const { deps } = makeDeps([rt], [pos('OUR_A')], { OUR_A: {}, [LP]: {} });
    const result = await runReconcileSweep(deps);
    expect(result.enumerated).toBe(true);
  });
});

/** Deps for the PER-WALLET reconcile: enumeration is keyed by wallet; reads are shared and counted. */
function makeByWalletDeps(
  runtimes: WalletReconcileRuntime[],
  heldByWallet: Record<string, UserPosition[]>,
  reads: Record<string, object | null>,
) {
  const enumeratedWallets: string[] = [];
  const readCounts = new Map<string, number>();
  const deps: WalletReconcileSweepDeps = {
    log,
    runtimes: () => runtimes,
    enumerateForWallet: async (wallet) => {
      enumeratedWallets.push(wallet);
      return heldByWallet[wallet] ?? [];
    },
    readAccountInfo: async (pubkey) => {
      readCounts.set(pubkey, (readCounts.get(pubkey) ?? 0) + 1);
      return reads[pubkey];
    },
    recentlyPublishedClose: new Map<string, number>(),
    openGraceMs: OPEN_GRACE_MS,
    recloseGraceMs: RECLOSE_GRACE_MS,
    token2022DepositGraceMs: BUILDING_GRACE_MS,
    nowMs: () => NOW,
  };
  return { deps, enumeratedWallets, readCounts };
}

describe('runReconcileSweepByWallet — per-distinct-wallet reconcile (Inc.4c)', () => {
  it('each DISTINCT wallet is enumerated independently; an orphan on wallet A is closed by A only', async () => {
    // WHY: a real user has their OWN Privy wallet — the whole-wallet enumeration + the orphan authority must be
    // keyed by wallet. A stray on wallet A (tracked by no user of A) is A's maintenance; a runtime on wallet B
    // must never enumerate A nor close A's orphan (it can't sign for A).
    const { rt: rtA, calls: a } = makeReconcileRt(
      'user-a',
      [mirror({ ourPosition: 'OUR_A', leaderPosition: 'LP_A' })],
      { wallet: WALLET_A },
    );
    const { rt: rtB, calls: b } = makeReconcileRt(
      'user-b',
      [mirror({ ourPosition: 'OUR_B', leaderPosition: 'LP_B' })],
      { wallet: WALLET_B },
    );
    const { deps, enumeratedWallets } = makeByWalletDeps(
      [rtA, rtB],
      { [WALLET_A]: [pos('OUR_A'), pos('STRAY_A')], [WALLET_B]: [pos('OUR_B')] },
      { OUR_A: {}, LP_A: {}, OUR_B: {}, LP_B: {}, STRAY_A: {} },
    );
    const result = await runReconcileSweepByWallet(deps);
    expect([...enumeratedWallets].sort()).toEqual([WALLET_A, WALLET_B]); // one enumeration per distinct wallet
    expect(a.orphanClosed).toEqual(['STRAY_A']); // wallet A's stray closed by A's runtime
    expect(b.orphanClosed).toEqual([]); // wallet B's runtime never touches A's orphan
    expect(a.markClosed).toEqual([]); // nothing else closed (both live)
    expect(b.markClosed).toEqual([]);
    expect(result.enumerated).toBe(true);
  });

  it("per-user isolation across wallets: A's ourPosition gone ⇒ A markClosed; B (other wallet) untouched", async () => {
    // WHY: the 3b per-(user, ourPosition) attribution must survive the per-wallet split — a confirmed close on one
    // wallet can never flip a live mirror on another.
    const { rt: rtA, calls: a } = makeReconcileRt(
      'user-a',
      [mirror({ ourPosition: 'OUR_A', leaderPosition: 'LP_A' })],
      { wallet: WALLET_A },
    );
    const { rt: rtB, calls: b } = makeReconcileRt(
      'user-b',
      [mirror({ ourPosition: 'OUR_B', leaderPosition: 'LP_B' })],
      { wallet: WALLET_B },
    );
    const { deps } = makeByWalletDeps(
      [rtA, rtB],
      { [WALLET_A]: [], [WALLET_B]: [pos('OUR_B')] },
      { OUR_A: null, LP_A: {}, OUR_B: {}, LP_B: {} }, // OUR_A gone on-chain
    );
    await runReconcileSweepByWallet(deps);
    expect(a.markClosed).toEqual(['LP_A']); // A's close confirmed (direct read)
    expect(b.markClosed).toEqual([]); // B untouched
    expect(b.reClosed).toEqual([]);
  });

  it('two users on the SAME wallet stay in ONE group: the shared leader position is read ONCE (dedup preserved)', async () => {
    // WHY: the pre-4c topology (multiple runtimes on one wallet) must keep its O(distinct-positions) read cache —
    // grouping by wallet must not split same-wallet users into separate enumerations/caches.
    const { rt: rtA } = makeReconcileRt('user-a', [mirror({ ourPosition: 'OUR_A' })], {
      wallet: WALLET_A,
    });
    const { rt: rtB } = makeReconcileRt('user-b', [mirror({ ourPosition: 'OUR_B' })], {
      wallet: WALLET_A,
    });
    const { deps, enumeratedWallets, readCounts } = makeByWalletDeps(
      [rtA, rtB],
      { [WALLET_A]: [pos('OUR_A'), pos('OUR_B')] },
      { OUR_A: {}, OUR_B: {}, [LP]: {} },
    );
    await runReconcileSweepByWallet(deps);
    expect(enumeratedWallets).toEqual([WALLET_A]); // ONE enumeration for the shared wallet
    expect(readCounts.get(LP)).toBe(1); // the shared leader position deduped across the two same-wallet users
  });

  it("a broken enumerator on ONE wallet degrades the whole reconcile (enumerated:false) but not the others' backstop", async () => {
    // WHY: `enumerated` feeds the detection-stale watchdog — a permanently-broken enumerator on any wallet must
    // read as a failure (not healthy), while the per-user close backstop (direct reads) still runs on every wallet.
    const { rt: rtA, calls: a } = makeReconcileRt(
      'user-a',
      [mirror({ ourPosition: 'OUR_A', leaderPosition: 'LP_A' })],
      { wallet: WALLET_A },
    );
    const { rt: rtB, calls: b } = makeReconcileRt(
      'user-b',
      [mirror({ ourPosition: 'OUR_B', leaderPosition: 'LP_B' })],
      { wallet: WALLET_B },
    );
    const { deps } = makeByWalletDeps(
      [rtA, rtB],
      { [WALLET_B]: [pos('OUR_B')] }, // WALLET_A enumeration below throws
      { OUR_A: null, LP_A: {}, OUR_B: {}, LP_B: null },
    );
    deps.enumerateForWallet = async (wallet) => {
      if (wallet === WALLET_A) throw new Error('SDK #245');
      return [pos('OUR_B')];
    };
    const result = await runReconcileSweepByWallet(deps);
    expect(result.enumerated).toBe(false); // wallet A's enumerator failure degrades the aggregate
    expect(a.markClosed).toEqual(['LP_A']); // A's close backstop still ran (direct read)
    expect(b.reClosed).toEqual(['OUR_B']); // B's leader-gone reClose still ran
  });
});

/** Recording ResidualSweepRuntime stub. */
function makeResidualRt(userId: string, wallet: string, opts: { publishThrows?: boolean } = {}) {
  const calls = {
    sold: [] as Array<{ mint: string; amountRaw: bigint; pool: string }>,
    sweepDetected: 0,
    sweepEventKeys: [] as string[],
    swapFailed: [] as string[],
    swapFailedKeys: [] as string[],
  };
  const rt: ResidualSweepRuntime = {
    userId,
    wallet,
    events: {
      emit: (code, fields) => {
        if (code === 'swap.sweep_detected') {
          calls.sweepDetected += 1;
          calls.sweepEventKeys.push((fields as { eventKey: string }).eventKey);
        }
      },
      swapFailed: (fields) => {
        calls.swapFailed.push((fields.adminDetail as { mint: string }).mint);
        calls.swapFailedKeys.push((fields as { eventKey: string }).eventKey);
      },
    } as ResidualSweepRuntime['events'],
    publishSell: async (mint, amountRaw, pool) => {
      if (opts.publishThrows) throw new Error('publish down');
      calls.sold.push({ mint, amountRaw, pool });
      return true;
    },
  };
  return { rt, calls };
}

const bal = (mint: string, amountRaw: bigint): OwnerTokenBalance => ({ mint, amountRaw });

function makeResidualDeps(
  runtimes: ResidualSweepRuntime[],
  balancesByWallet: Record<string, OwnerTokenBalance[]>,
  over: Partial<ResidualSweepDeps> = {},
) {
  const walletReads: string[] = [];
  const deps: ResidualSweepDeps = {
    log,
    runtimes: () => runtimes,
    readWalletBalances: async (wallet) => {
      walletReads.push(wallet);
      return balancesByWallet[wallet] ?? [];
    },
    inFlightBuyMints: new Map<string, number>(),
    wsolMint: WSOL,
    dustRaw: 0n,
    inflightGraceMs: 30_000,
    leaderLabel: LEADER,
    nowMs: () => NOW,
    ...over,
  };
  return { deps, walletReads };
}

describe('runResidualSweep — per-distinct-wallet residual safety sweep (Inc.4c)', () => {
  it('one balance read per DISTINCT wallet; each wallet residual sold by a runtime that owns it', async () => {
    // WHY: a residual on user B's wallet can only be sold by B (its owner signs) — the sweep must read + publish
    // per wallet, never fold two wallets into one balance read (which would cross-attribute the sell).
    const { rt: rtA, calls: a } = makeResidualRt('user-a', WALLET_A);
    const { rt: rtB, calls: b } = makeResidualRt('user-b', WALLET_B);
    const { deps, walletReads } = makeResidualDeps([rtA, rtB], {
      [WALLET_A]: [bal('MINT_A', 100n)],
      [WALLET_B]: [bal('MINT_B', 200n)],
    });
    await runResidualSweep(deps);
    expect([...walletReads].sort()).toEqual([WALLET_A, WALLET_B]); // one read per wallet
    expect(a.sold).toEqual([{ mint: 'MINT_A', amountRaw: 100n, pool: WALLET_A }]);
    expect(b.sold).toEqual([{ mint: 'MINT_B', amountRaw: 200n, pool: WALLET_B }]);
    expect(a.sweepDetected).toBe(1);
    expect(b.sweepDetected).toBe(1);
  });

  it('two runtimes on the SAME wallet sweep it ONCE (one publisher, one balance read)', async () => {
    // WHY: a shared wallet (the pre-4c topology) must be swept once — N publishers selling the same residual would
    // double-spend the swap.
    const { rt: rtA, calls: a } = makeResidualRt('user-a', WALLET_A);
    const { rt: rtB, calls: b } = makeResidualRt('user-b', WALLET_A);
    const { deps, walletReads } = makeResidualDeps([rtA, rtB], {
      [WALLET_A]: [bal('MINT_A', 100n)],
    });
    await runResidualSweep(deps);
    expect(walletReads).toEqual([WALLET_A]); // ONE read
    expect(a.sold).toEqual([{ mint: 'MINT_A', amountRaw: 100n, pool: WALLET_A }]); // first owner publishes
    expect(b.sold).toEqual([]); // the second same-wallet runtime does not double-sell
  });

  it('an in-flight two-sided buy is NOT swept within the grace (never empty a token leg mid-open)', async () => {
    // WHY: the bought token of an in-flight two-sided open sits on the wallet before its deposit — selling it would
    // empty the leg. The grace protects it; past the grace a still-present token means the open failed → swept.
    const { rt, calls } = makeResidualRt('user-a', WALLET_A);
    const inFlightBuyMints = new Map<string, number>([['MINT_INFLIGHT', NOW - 1]]); // just published
    const { deps } = makeResidualDeps(
      [rt],
      { [WALLET_A]: [bal('MINT_INFLIGHT', 100n)] },
      { inFlightBuyMints },
    );
    await runResidualSweep(deps);
    expect(calls.sold).toEqual([]); // protected within the grace
    expect(calls.sweepDetected).toBe(0); // nothing to sweep this tick
  });

  // finding #96 — a two-sided open is a MULTI-hop chain (buy → deposit; the deposit can land ~100s after the buy
  // under congestion). The brain RE-STAMPS inFlightBuyMints at EVERY hop, so the sweep keeps seeing a fresh stamp for
  // the whole open — even long past the ORIGINAL buy. The grace is sized to the multi-tx open window (mirrors the
  // production INFLIGHT_BUY_GRACE_MS, raised from 30s so one hop's window outlasts one tx's land time).
  const INFLIGHT_GRACE_MS = 90_000; // == the production INFLIGHT_BUY_GRACE_MS (== OPEN_PENDING_TTL_MS)
  const DEPOSIT_INFLIGHT_AGE_MS = 60_000; // time since the DEPOSIT hop re-stamped it; > the pre-fix 30s, < the grace

  it('a mint whose in-flight deposit was re-stamped past the OLD 30s window is NOT swept (finding #96)', async () => {
    // WHY: at 60s the pre-fix 30s grace had expired → the sweep sold the bought leg while its deposit was still
    // landing → the deposit failed insufficient-funds, the open aborted (leader open MISSED, two swap fees burned).
    // The re-stamped, multi-tx-sized grace spares the leg for the whole open.
    const { rt, calls } = makeResidualRt('user-a', WALLET_A);
    const inFlightBuyMints = new Map<string, number>([
      ['MINT_INFLIGHT', NOW - DEPOSIT_INFLIGHT_AGE_MS],
    ]);
    const { deps } = makeResidualDeps(
      [rt],
      { [WALLET_A]: [bal('MINT_INFLIGHT', 100n)] },
      { inFlightBuyMints, inflightGraceMs: INFLIGHT_GRACE_MS },
    );
    await runResidualSweep(deps);
    expect(calls.sold).toEqual([]); // spared: its deposit is still in flight
    expect(calls.sweepDetected).toBe(0);
  });

  it('once the open completes (grace elapsed, no more re-stamp) a genuine residual of that mint IS swept', async () => {
    // WHY: the guard must be a DELAY, not a mute — past the grace a still-present token is a real stranded residual
    // (a failed/aborted open, or leftover dust) and MUST be recovered by the safety sweep, never held forever.
    const { rt, calls } = makeResidualRt('user-a', WALLET_A);
    const inFlightBuyMints = new Map<string, number>([
      ['MINT_INFLIGHT', NOW - (INFLIGHT_GRACE_MS + 1)],
    ]);
    const { deps } = makeResidualDeps(
      [rt],
      { [WALLET_A]: [bal('MINT_INFLIGHT', 100n)] },
      { inFlightBuyMints, inflightGraceMs: INFLIGHT_GRACE_MS },
    );
    await runResidualSweep(deps);
    expect(calls.sold).toEqual([{ mint: 'MINT_INFLIGHT', amountRaw: 100n, pool: WALLET_A }]);
    expect(calls.sweepDetected).toBe(1);
  });

  it('a residual that is only WSOL/dust is not swept (nothing to do)', async () => {
    const { rt, calls } = makeResidualRt('user-a', WALLET_A);
    const { deps } = makeResidualDeps([rt], { [WALLET_A]: [bal(WSOL, 5n)] }); // WSOL is excluded by planWalletSweep
    await runResidualSweep(deps);
    expect(calls.sold).toEqual([]);
    expect(calls.sweepDetected).toBe(0);
  });

  it('a failing publishSell emits the swap-failed path (pinned, feed-visible) and never throws', async () => {
    const { rt, calls } = makeResidualRt('user-a', WALLET_A, { publishThrows: true });
    const { deps } = makeResidualDeps([rt], { [WALLET_A]: [bal('MINT_A', 100n)] });
    await expect(runResidualSweep(deps)).resolves.toBeUndefined();
    expect(calls.swapFailed).toEqual(['MINT_A']); // the residual is surfaced, not silently dropped
  });

  it('#156: one wallet’s balance-read rejection does NOT abort the sweep for the remaining wallets (per-wallet isolation)', async () => {
    // WHY: readWalletBalances was unwrapped — a single wallet’s persistent read rejection propagated out and
    // aborted runResidualSweep for EVERY wallet after it, silently killing the no-dormant-non-SOL-balance backstop
    // for all of them (unlike the reconcile’s per-user isolation). Each wallet’s read+sweep must be isolated:
    // WALLET_A throws, yet WALLET_B (iterated after it) must still be read and swept, and the sweep must not throw.
    const { rt: rtA, calls: a } = makeResidualRt('user-a', WALLET_A);
    const { rt: rtB, calls: b } = makeResidualRt('user-b', WALLET_B);
    const walletReads: string[] = [];
    const { deps } = makeResidualDeps(
      [rtA, rtB],
      {},
      {
        readWalletBalances: async (wallet) => {
          walletReads.push(wallet);
          if (wallet === WALLET_A) throw new Error('balance read down for A');
          return [bal('MINT_B', 200n)];
        },
      },
    );
    await expect(runResidualSweep(deps)).resolves.toBeUndefined(); // A’s rejection is isolated, not propagated
    expect(walletReads).toEqual([WALLET_A, WALLET_B]); // B was still reached despite A failing first
    expect(a.sold).toEqual([]); // A produced nothing (its read failed)
    expect(b.sold).toEqual([{ mint: 'MINT_B', amountRaw: 200n, pool: WALLET_B }]); // B swept regardless
  });

  it('idx42: two wallets with residuals in the SAME tick emit DISTINCT sweep-detected eventKeys (the wallet disambiguates so the correlationId=eventKey dedup never drops a real sweep row)', async () => {
    // WHY: `now` is computed ONCE per tick — without the wallet in the key, wallet A and wallet B both emit
    // `LEADER:sweep:NOW`, so the CopyEvents dedup (correlationId = eventKey) collapses them to ONE row, silently
    // dropping a real sweep from the feed. The wallet must make each per-wallet sweep row unique.
    const { rt: rtA, calls: a } = makeResidualRt('user-a', WALLET_A);
    const { rt: rtB, calls: b } = makeResidualRt('user-b', WALLET_B);
    const { deps } = makeResidualDeps([rtA, rtB], {
      [WALLET_A]: [bal('MINT_A', 100n)],
      [WALLET_B]: [bal('MINT_B', 200n)],
    });
    await runResidualSweep(deps);
    expect(a.sweepEventKeys).toEqual([`${LEADER}:sweep:${WALLET_A}:${NOW}`]);
    expect(b.sweepEventKeys).toEqual([`${LEADER}:sweep:${WALLET_B}:${NOW}`]);
    expect(a.sweepEventKeys[0]).not.toBe(b.sweepEventKeys[0]); // distinct ⇒ the dedup keeps BOTH sweep rows
  });

  it('idx42: two wallets failing to sell the SAME residual mint emit DISTINCT swap-failed eventKeys (a real per-wallet failure is never deduped away)', async () => {
    const { rt: rtA, calls: a } = makeResidualRt('user-a', WALLET_A, { publishThrows: true });
    const { rt: rtB, calls: b } = makeResidualRt('user-b', WALLET_B, { publishThrows: true });
    const { deps } = makeResidualDeps([rtA, rtB], {
      [WALLET_A]: [bal('SAME_MINT', 100n)],
      [WALLET_B]: [bal('SAME_MINT', 100n)],
    });
    await runResidualSweep(deps);
    expect(a.swapFailedKeys).toEqual([`${LEADER}:sweep:${WALLET_A}:${NOW}:SAME_MINT`]);
    expect(b.swapFailedKeys).toEqual([`${LEADER}:sweep:${WALLET_B}:${NOW}:SAME_MINT`]);
    expect(a.swapFailedKeys[0]).not.toBe(b.swapFailedKeys[0]); // same mint on two wallets ⇒ still distinct rows
  });
});

// A6-01: the reconcile must never false-close an open that is still LANDING. An open landing between openGraceMs and
// its ~60-75s deadline reads as "gone" on-chain; without an event-driven grace the reconcile markCloses it and the
// orphan pass force-closes the live open (a missed copy + fee round-trip). isOpenInFlight (the pending-open
// reservation) protects it regardless of elapsed time; the raised time-grace is the backstop for the simple one-tx open.
describe('runReconcileSweep — A6-01 event-driven open-grace (a still-landing open is never false-closed)', () => {
  it('gone on-chain + PAST the time-grace but still IN FLIGHT → NOT markClosed (event-driven grace)', async () => {
    const { rt, calls } = makeReconcileRt(
      'u',
      [mirror({ ourPosition: 'OUR', leaderPosition: LP })],
      {
        inFlight: [LP],
      },
    );
    const { deps } = makeDeps([rt], [], { OUR: null, [LP]: {} }); // our open not yet confirmed; leader still holds it
    await runReconcileSweep(deps);
    expect(calls.markClosed).toEqual([]); // protected by the event-driven in-flight grace
    expect(calls.reClosed).toEqual([]);
  });

  it('control — the SAME mirror NOT in flight and past the time-grace → markClosed (proves the grace is what protects it)', async () => {
    const { rt, calls } = makeReconcileRt('u', [
      mirror({ ourPosition: 'OUR', leaderPosition: LP }),
    ]); // not in flight
    const { deps } = makeDeps([rt], [], { OUR: null, [LP]: {} });
    await runReconcileSweep(deps);
    expect(calls.markClosed).toEqual([LP]); // no grace → a still-landing open WOULD be false-closed
  });
});
