import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS, type CopybotConfig } from '@/domain/copybot/config';
import type { UserPosition } from '@/infrastructure/solana/dlmm/leader-position-reader';
import type { Mirror } from './mirror-registry';
import type { PendingOpenMaps } from './pending-open-cancel';
import {
  type ReconcileRuntime,
  type ReconcileSweepDeps,
  type RugSlSweepDeps,
  type RugSweepRuntime,
  runReconcileSweep,
  runRugSlSweep,
} from './wallet-sweeps';

const log = pino({ level: 'silent' });
const NOW = 10_000_000;
const OPEN_GRACE_MS = 30_000;
const RECLOSE_GRACE_MS = 60_000;
const BUILDING_GRACE_MS = 90_000;
const LEADER = 'Leader1111111111111111111111111111111111111';
const LP = 'LEADER_POS_SHARED'; // the SAME leader position mirrored by both users (the 3b topology)

const mirror = (over: Partial<Mirror>): Mirror => ({
  leaderPosition: LP,
  leaderAddress: LEADER,
  ourPosition: 'OUR',
  pool: 'POOL',
  nonSolSymbol: 'TOK',
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

/** Recording ReconcileRuntime stub — every side effect the sweep may take is captured for assertions. */
function makeReconcileRt(
  userId: string,
  mirrors: Mirror[],
  opts: { loadOpenThrows?: boolean } = {},
) {
  const calls = {
    markClosed: [] as string[],
    registryClosed: [] as string[],
    reClosed: [] as string[],
    closedEvents: [] as unknown[],
    cancelled: [] as string[],
  };
  const rt: ReconcileRuntime = {
    userId,
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
    } as ReconcileRuntime['events'],
    rugSlTracker: { forget: () => {} },
    rugExitPending: new Set<string>(),
    rugExitStore: { removePending: async () => {} },
    buildingToken2022Positions: new Map<string, number>(),
    publishReClose: async (m) => {
      calls.reClosed.push(m.ourPosition);
    },
    leaderOf: (m) => m.leaderAddress,
    closeConfirmedKey: (leader, pool, our) => `${leader}:${pool}:close-confirmed:${our}`,
    cancelPendingOpen: (lp) => calls.cancelled.push(lp),
    pendingOpenMapsView: emptyPendingMaps,
  };
  return { rt, calls };
}

/** Deps with a scripted account universe: `reads` maps pubkey → present({}) / gone(null); unlisted → undefined. */
function makeDeps(
  runtimes: ReconcileRuntime[],
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

  it('enumeration failure aborts the WHOLE sweep (no per-user plan, no orphan pass — never act on incomplete data)', async () => {
    const { rt, calls } = makeReconcileRt('user-a', [mirror({ ourPosition: 'OUR_A' })]);
    const { deps, orphanCloses } = makeDeps([rt], [], { OUR_A: null, [LP]: null });
    deps.enumeratePositions = async () => {
      throw new Error('rpc down');
    };
    await runReconcileSweep(deps);
    expect(calls.markClosed).toEqual([]);
    expect(orphanCloses).toEqual([]);
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
  opts: { publishThrows?: boolean } = {},
) {
  const calls = {
    recorded: [] as Array<{ key: string; price: number }>,
    safetyCloses: [] as string[],
  };
  const rt: RugSweepRuntime = {
    userId,
    registry: { openPositions: () => mirrors },
    getConfig: () => config,
    rugSlTracker: {
      record: (key, price) => calls.recorded.push({ key, price }),
      check: (key) => checkResult(key),
      forget: () => {},
    },
    rugExitPending: new Set<string>(),
    rugExitStore: { addPending: async () => {}, addExited: async () => {} },
    rugExited: new Set<string>(),
    publishSafetyClose: async (m) => {
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
  const rugDeps = (runtimes: RugSweepRuntime[], price: number | null) => {
    const priceReads: string[] = [];
    const deps: RugSlSweepDeps = {
      log,
      runtimes: () => runtimes,
      readPoolTokenPrice: async (pool) => {
        priceReads.push(pool);
        return price;
      },
      recentlyPublishedClose: new Map(),
      recloseGraceMs: RECLOSE_GRACE_MS,
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
});
