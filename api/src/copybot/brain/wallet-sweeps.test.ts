import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS, type CopybotConfig } from '@/domain/copybot/config';
import type { OwnerTokenBalance } from '@/domain/copybot/residual-sell';
import type { UserPosition } from '@/infrastructure/solana/dlmm/leader-position-reader';
import type { Mirror } from './mirror-registry';
import type { PendingOpenMaps } from './pending-open-cancel';
import {
  type ReconcileSweepDeps,
  type ResidualSweepDeps,
  type ResidualSweepRuntime,
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
  opts: { loadOpenThrows?: boolean; wallet?: string } = {},
) {
  const calls = {
    markClosed: [] as string[],
    registryClosed: [] as string[],
    reClosed: [] as string[],
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
  opts: { publishThrows?: boolean } = {},
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
        calls.pendingPersisted.push(our);
      },
      addExited: async () => {},
    },
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
    swapFailed: [] as string[],
  };
  const rt: ResidualSweepRuntime = {
    userId,
    wallet,
    events: {
      emit: (code) => {
        if (code === 'swap.sweep_detected') calls.sweepDetected += 1;
      },
      swapFailed: (fields) => {
        calls.swapFailed.push((fields.adminDetail as { mint: string }).mint);
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
});
