import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS, type CopybotConfig } from '@/domain/copybot/config';
import { computeLeaderSet, usersCopying } from '@/domain/copybot/fan-out';
import { type ReloadableRuntime, type ReloadDeps, reloadAllUsers } from './user-reload';

const log = pino({ level: 'silent' });
const LEADER_A = 'LeaderA11111111111111111111111111111111111';
const LEADER_B = 'LeaderB22222222222222222222222222222222222';

const cfg = (enabled: boolean, leaders: string[]): CopybotConfig => ({
  user: { ...CONFIG_DEFAULTS.user, enabled },
  leaders: leaders.map((address) => ({
    address,
    enabled: true,
    maxTotalExposureSol: null,
    overrides: {},
  })),
});

/** Recording ReloadableRuntime stub. */
function makeRt(userId: string, initial: CopybotConfig) {
  let current = initial;
  const stopDiffs: Array<{ prev: CopybotConfig; next: CopybotConfig }> = [];
  const bootStopConfigs: CopybotConfig[] = []; // the boot config each applyBootStopCloses pass saw (#135)
  const rt: ReloadableRuntime = {
    userId,
    getConfig: () => current,
    setConfig: (next) => {
      current = next;
    },
    applyStopCloses: async (prev, next) => {
      stopDiffs.push({ prev, next });
    },
    applyBootStopCloses: async (boot) => {
      bootStopConfigs.push(boot);
    },
  };
  return { rt, stopDiffs, bootStopConfigs };
}

/** Harness around reloadAllUsers with scripted DB rows; records spawns / leader-set applications / reconciles.
 *  `openMirrorUserIds` = the copy_positions DISTINCT-open projection (a DB fact, independent of config enabled).
 *  `pendingFeeUserIds` = the fee_ledger DISTINCT-pending projection (finding #3, likewise config-independent). */
function makeHarness(
  rows: Map<string, CopybotConfig>,
  openMirrorUserIds: string[] = [],
  pendingFeeUserIds: string[] = [],
) {
  const runtimes = new Map<string, ReloadableRuntime>();
  const userConfigs = new Map<string, CopybotConfig>();
  const spawned: string[] = [];
  const appliedLeaderSets: Array<Set<string>> = [];
  let reconciles = 0;
  const perRt = new Map<string, ReturnType<typeof makeRt>>();
  const deps: ReloadDeps<ReloadableRuntime> = {
    log,
    listActiveUserIds: async () =>
      [...rows.entries()].filter(([, c]) => c.user.enabled).map(([uid]) => uid),
    listUserIdsWithOpenMirrors: async () => openMirrorUserIds,
    listUserIdsWithPendingFees: async () => pendingFeeUserIds,
    loadConfig: async (uid) => {
      const row = rows.get(uid);
      if (!row) throw new Error(`no config row for ${uid}`);
      return row;
    },
    spawn: async (uid, config) => {
      spawned.push(uid);
      const made = makeRt(uid, config);
      perRt.set(uid, made);
      return made.rt;
    },
    runtimes,
    userConfigs,
    applyLeaderSet: async (next) => {
      appliedLeaderSets.push(next);
    },
    onUsersSpawned: async () => {
      reconciles += 1;
    },
  };
  return {
    deps,
    runtimes,
    userConfigs,
    spawned,
    appliedLeaderSets,
    reconciles: () => reconciles,
    perRt,
  };
}

describe('reloadAllUsers — boot + live reload (Inc.3b S7)', () => {
  it('boot from listActiveUserIds: one runtime per ACTIVE user, configs registered, leader set applied, one reconcile', async () => {
    // WHY: the multi-user brain is born here — every enabled row must yield exactly one runtime, and the hub
    // must watch exactly the config-derived union (a missed user = their leader unwatched = missed closes).
    const rows = new Map([
      ['u1', cfg(true, [LEADER_A])],
      ['u2', cfg(true, [LEADER_B])],
      ['u3', cfg(false, [LEADER_B])], // disabled → not spawned
    ]);
    const h = makeHarness(rows);
    await reloadAllUsers(h.deps);
    expect(h.spawned).toEqual(['u1', 'u2']);
    expect([...h.runtimes.keys()]).toEqual(['u1', 'u2']);
    expect(h.userConfigs.get('u1')).toBe(rows.get('u1'));
    expect(h.appliedLeaderSets).toEqual([new Set([LEADER_A, LEADER_B])]);
    expect(h.reconciles()).toBe(1); // fresh users join the reconcile immediately (boot failsafe)
  });

  it('RESTART with a STOPPED config + persisted OPEN mirrors: the user is spawned DRAINED and boot-force-closed (#134/#135)', async () => {
    // WHY (the forbidden missed close): a user who pressed STOP — or whose disabling was written — while the brain
    // was DOWN is enabled:false, so listActiveUserIds omits them; yet their live positions sit on-chain. Boot MUST
    // still spawn them (from the open-mirror UNION) so reconcile/stop-close/sweeps run on their wallet and
    // force-close the stranded mirrors — WITHOUT ever making the disabled user an OPEN fan-out target.
    const rows = new Map([['u1', cfg(false, [LEADER_A])]]); // the config on disk is STOPPED
    const h = makeHarness(rows, ['u1']); // ...yet u1 still owns an OPEN mirror row (persisted before the downtime)
    await reloadAllUsers(h.deps);
    expect(h.spawned).toEqual(['u1']); // Bug A: spawned despite being inactive — the open-mirror union caught it
    expect(h.runtimes.has('u1')).toBe(true); // retained: keeps reconciling until the mirror drains
    expect(usersCopying(LEADER_A, h.userConfigs)).toEqual([]); // drained: NEVER an open fan-out target
    expect(h.appliedLeaderSets.at(-1)).toEqual(new Set()); // and its leader is not watched for opens either
    // Bug B: the seeded mirror is force-closed at boot — applyBootStopCloses ran with the STOPPED boot config. The
    // phase-2 prev/next diff NEVER runs for a fresh spawn, so this is the only path that can close a downtime STOP.
    expect(h.perRt.get('u1')?.bootStopConfigs).toEqual([cfg(false, [LEADER_A])]);
    expect(h.perRt.get('u1')?.stopDiffs).toEqual([]); // not the live prev/next path (spawnedNow skips phase 2)
    expect(h.reconciles()).toBe(1); // the drained user still joins the immediate reconcile backstop
  });

  it('every FRESH spawn (even a healthy active user) gets a boot stop-close pass (#135 covers per-leader downtime stops too)', async () => {
    // WHY: the boot replay is NOT gated to globally-stopped users. An ACTIVE user who disabled ONE leader during
    // downtime keeps user.enabled=true (still in listActiveUserIds); the ONLY thing that force-closes that one
    // leader's stranded mirror is the per-fresh-spawn boot stop-close (the runtime no-ops it when nothing is
    // stranded). Here we pin the WIRING: the boot config reaches applyBootStopCloses for every fresh spawn.
    const rows = new Map([
      ['u1', cfg(true, [LEADER_A])],
      ['u2', cfg(true, [LEADER_B])],
    ]);
    const h = makeHarness(rows);
    await reloadAllUsers(h.deps);
    expect(h.perRt.get('u1')?.bootStopConfigs).toEqual([rows.get('u1')]);
    expect(h.perRt.get('u2')?.bootStopConfigs).toEqual([rows.get('u2')]);
  });

  it('a user that is BOTH active and holds open mirrors is spawned exactly ONCE (union dedup)', async () => {
    // WHY: the spawn set is a UNION — a normally-running user appears in both listActiveUserIds and the open-mirror
    // projection. Dedup must yield a single runtime (a double spawn would clobber the first with a half-entry).
    const rows = new Map([['u1', cfg(true, [LEADER_A])]]);
    const h = makeHarness(rows, ['u1']);
    await reloadAllUsers(h.deps);
    expect(h.spawned).toEqual(['u1']);
    expect(h.perRt.get('u1')?.bootStopConfigs).toHaveLength(1);
  });

  it('a user STOPPED with a PENDING fee but NO open mirror is spawned fee-sweep-only so the operator collects it (#3)', async () => {
    // WHY (operator-fee no-loss): a user whose LAST position closed with a pending performance fee, then STOPPED, is
    // enabled:false (absent from listActiveUserIds) AND holds no open mirror (absent from listUserIdsWithOpenMirrors).
    // Without the pending-fee union NOTHING boots them → feeSweep (booted-only, #155) never sees them → the fee is
    // NEVER collected. The union boots them DRAINED: the feeSweep can collect it, yet they are never an OPEN target.
    const rows = new Map([['u1', cfg(false, [LEADER_A])]]); // STOPPED on disk
    const h = makeHarness(rows, [], ['u1']); // no open mirror; only a pending fee row
    await reloadAllUsers(h.deps);
    expect(h.spawned).toEqual(['u1']); // booted SOLELY by the pending-fee union
    expect(h.runtimes.has('u1')).toBe(true); // retained so the feeSweep (booted-only) can now see + collect it
    expect(usersCopying(LEADER_A, h.userConfigs)).toEqual([]); // drained: NEVER an open fan-out target
    expect(h.appliedLeaderSets.at(-1)).toEqual(new Set()); // and its leader is not watched for opens
  });

  it('a user in ALL THREE sets (active + open mirror + pending fee) is spawned exactly ONCE (union dedup)', async () => {
    // WHY: the three projections overlap for a normally-running user; dedup must yield a single runtime (a double
    // spawn would clobber the first with a half-entry).
    const rows = new Map([['u1', cfg(true, [LEADER_A])]]);
    const h = makeHarness(rows, ['u1'], ['u1']);
    await reloadAllUsers(h.deps);
    expect(h.spawned).toEqual(['u1']);
    expect(h.perRt.get('u1')?.bootStopConfigs).toHaveLength(1);
  });

  it('listUserIdsWithPendingFees failure degrades to "no fee-sweep-only spawns this pass" — active spawns still run', async () => {
    // WHY: the fee-collection backstop is best-effort like the open-mirror one — a hiccup in it must NEVER block the
    // active spawns or the existing refresh; the stranded-fee user is re-spawned the moment the query recovers.
    const rows = new Map([['u1', cfg(true, [LEADER_A])]]);
    const h = makeHarness(rows);
    h.deps.listUserIdsWithPendingFees = async () => {
      throw new Error('fee listing down');
    };
    await expect(reloadAllUsers(h.deps)).resolves.toBeUndefined(); // the reload loop never rejects
    expect(h.runtimes.has('u1')).toBe(true); // the active spawn survived the fee-query failure
  });

  it('live ADD: only the new user is spawned; existing runtimes are diffed, not respawned', async () => {
    const rows = new Map([['u1', cfg(true, [LEADER_A])]]);
    const h = makeHarness(rows);
    await reloadAllUsers(h.deps);
    expect(h.spawned).toEqual(['u1']);
    rows.set('u2', cfg(true, [LEADER_B]));
    await reloadAllUsers(h.deps);
    expect(h.spawned).toEqual(['u1', 'u2']); // u1 NOT respawned
    expect(h.reconciles()).toBe(2); // the added user reconciled immediately too
    // u1 went through the prev/next diff on the second pass (a live config edit must reach applyStopCloses).
    expect(h.perRt.get('u1')?.stopDiffs).toHaveLength(1);
    // the leader set now includes the added leader — the hub replay-seeds it BEFORE watching (forward-only is
    // applyLeaderSet's contract, pinned by the LeaderHub S4 tests; here we pin that the reload passes the set).
    expect(h.appliedLeaderSets.at(-1)).toEqual(new Set([LEADER_A, LEADER_B]));
  });

  it('live STOP: the runtime is RETAINED, its stop diff runs, and the fan-out/leader set drop it', async () => {
    // WHY (SPEC §4.3 + never-miss): stop = force-close, and the force-closes need the runtime alive to keep
    // reconciling until its mirrors drain — but the user must instantly stop being an OPEN target, and a leader
    // nobody else copies must leave the watch set (drain), all from the same pass.
    const rows = new Map([
      ['u1', cfg(true, [LEADER_A])],
      ['u2', cfg(true, [LEADER_B])],
    ]);
    const h = makeHarness(rows);
    await reloadAllUsers(h.deps);
    rows.set('u1', cfg(false, [LEADER_A])); // user u1 flips their master switch off
    await reloadAllUsers(h.deps);
    expect(h.runtimes.has('u1')).toBe(true); // retained — keeps reconciling its stop-closes
    const diff = h.perRt.get('u1')?.stopDiffs.at(-1);
    expect(diff?.prev.user.enabled).toBe(true);
    expect(diff?.next.user.enabled).toBe(false); // applyStopCloses sees the stop transition
    expect(usersCopying(LEADER_A, h.userConfigs)).toEqual([]); // dropped from open fan-out targets
    expect(h.appliedLeaderSets.at(-1)).toEqual(new Set([LEADER_B])); // A drains from the hub
    expect(h.reconciles()).toBe(1); // no NEW user ⇒ no extra immediate reconcile
  });

  it("per-user spawn isolation: u1's throwing spawn leaves NO half-entry and never blocks u2", async () => {
    const rows = new Map([
      ['u1', cfg(true, [LEADER_A])],
      ['u2', cfg(true, [LEADER_B])],
    ]);
    const h = makeHarness(rows);
    const originalSpawn = h.deps.spawn;
    h.deps.spawn = async (uid, config) => {
      if (uid === 'u1') throw new Error('u1 boot broken');
      return originalSpawn(uid, config);
    };
    await reloadAllUsers(h.deps);
    expect(h.runtimes.has('u1')).toBe(false);
    expect(h.userConfigs.has('u1')).toBe(false); // no half-entry: a dead runtime must not be a fan-out target
    expect(h.runtimes.has('u2')).toBe(true);
    // u1 is retried on the NEXT pass (transient DB/RPC boot failures self-heal).
    h.deps.spawn = originalSpawn;
    await reloadAllUsers(h.deps);
    expect(h.runtimes.has('u1')).toBe(true);
  });

  it('a user with no resolvable wallet (spawn → null) is skipped this pass and retried next (Inc.4c)', async () => {
    // WHY: a real user whose Privy wallet isn't provisioned yet must NOT become a runtime or a fan-out target
    // (it can't sign) — but it must not be dropped forever either: provisioning completes → the next reload spawns
    // it. Mirrors the inactive-user path exactly.
    const rows = new Map([
      ['u1', cfg(true, [LEADER_A])],
      ['u2', cfg(true, [LEADER_B])],
    ]);
    const h = makeHarness(rows);
    const originalSpawn = h.deps.spawn;
    let provisioned = false;
    h.deps.spawn = async (uid, config) =>
      uid === 'u2' && !provisioned ? null : originalSpawn(uid, config);
    await reloadAllUsers(h.deps);
    expect(h.runtimes.has('u1')).toBe(true);
    expect(h.runtimes.has('u2')).toBe(false); // not provisioned → no runtime
    expect(h.userConfigs.has('u2')).toBe(false); // and no fan-out entry
    expect(h.reconciles()).toBe(1); // only u1 was a NEW runtime
    provisioned = true;
    await reloadAllUsers(h.deps);
    expect(h.runtimes.has('u2')).toBe(true); // retried next reload → now spawned
  });

  it("per-user refresh isolation: u1's failing config load keeps u1's previous config; u2 still refreshes", async () => {
    // WHY: a kill-switch edit for u2 must land even while u1's row read is broken — and u1 must keep RUNNING on
    // its last-known config (fail-closed parsing upstream already handles corrupt rows; here the READ itself died).
    const rows = new Map([
      ['u1', cfg(true, [LEADER_A])],
      ['u2', cfg(true, [LEADER_B])],
    ]);
    const h = makeHarness(rows);
    await reloadAllUsers(h.deps);
    const u1Before = h.runtimes.get('u1')?.getConfig();
    const originalLoad = h.deps.loadConfig;
    h.deps.loadConfig = async (uid) => {
      if (uid === 'u1') throw new Error('row read failed');
      return originalLoad(uid);
    };
    rows.set('u2', cfg(false, [LEADER_B]));
    await reloadAllUsers(h.deps);
    expect(h.runtimes.get('u1')?.getConfig()).toBe(u1Before); // previous config stands
    expect(h.perRt.get('u2')?.stopDiffs.at(-1)?.next.user.enabled).toBe(false); // u2's stop landed
  });

  it('★ idx45: a throwing applyStopCloses KEEPS the committed config and logs the HONEST outcome — never "previous config stands"', async () => {
    // WHY: phase 2 commits the fresh config (setConfig + userConfigs.set) BEFORE applyStopCloses. When the
    // force-close throws, the new config is ALREADY the live fan-out view — logging "previous config stands" is a
    // lie that also hides the lost stop transition. The honest report: the config committed; only the stop-close
    // failed (reconcile / the next reload retries it). This test FAILS if the misleading message returns.
    const rows = new Map([['u1', cfg(true, [LEADER_A])]]);
    const errors: string[] = [];
    const capture = {
      error: (_o: unknown, m?: string) => errors.push(m ?? ''),
      info() {},
      warn() {},
    };
    const h = makeHarness(rows);
    h.deps.log = capture as unknown as typeof log;
    await reloadAllUsers(h.deps); // boot u1

    const u1 = h.perRt.get('u1')!;
    u1.rt.applyStopCloses = async () => {
      throw new Error('force-close failed');
    };
    const stopped = cfg(false, [LEADER_A]);
    rows.set('u1', stopped);
    errors.length = 0; // ignore boot logs; assert only the refresh pass
    await expect(reloadAllUsers(h.deps)).resolves.toBeUndefined(); // the reload loop never rejects

    expect(h.runtimes.get('u1')?.getConfig()).toBe(stopped); // the NEW config IS committed (not rolled back)
    expect(h.userConfigs.get('u1')).toBe(stopped); // and it IS the live fan-out view
    const msg = errors.find((m) => m.includes('stop-close'));
    expect(msg).toBeDefined(); // the failure was surfaced...
    expect(msg).not.toContain('previous config stands'); // ...HONESTLY: not the old lie
    expect(msg).toContain('committed'); // it states the fresh config was committed
  });

  it('listActiveUserIds failure: no spawns, but EXISTING runtimes still refresh and the leader set still applies', async () => {
    const rows = new Map([['u1', cfg(true, [LEADER_A])]]);
    const h = makeHarness(rows);
    await reloadAllUsers(h.deps);
    h.deps.listActiveUserIds = async () => {
      throw new Error('listing down');
    };
    rows.set('u1', cfg(true, [])); // u1 removed their leader
    await reloadAllUsers(h.deps);
    expect(h.perRt.get('u1')?.stopDiffs).toHaveLength(1); // the diff still ran (spawn pass never diffs)
    expect(h.appliedLeaderSets.at(-1)).toEqual(new Set()); // the leader drains regardless
  });

  it('the applied leader set IS computeLeaderSet(configs) — corrupt/disabled rows contribute nothing', async () => {
    // WHY (7a): detection is driven by the CONFIGS, not the env — the wiring must not filter/augment the pure
    // function's output (any drift would open a watched-vs-copied gap).
    const rows = new Map([
      ['u1', cfg(true, [LEADER_A, LEADER_B])],
      ['u2', cfg(false, [LEADER_B])],
    ]);
    const h = makeHarness(rows);
    await reloadAllUsers(h.deps);
    expect(h.appliedLeaderSets.at(-1)).toEqual(computeLeaderSet(h.userConfigs));
    expect(h.appliedLeaderSets.at(-1)).toEqual(new Set([LEADER_A, LEADER_B]));
  });

  it('a failing applyLeaderSet degrades to "retry next pass" (the reload loop itself never rejects)', async () => {
    const rows = new Map([['u1', cfg(true, [LEADER_A])]]);
    const h = makeHarness(rows);
    h.deps.applyLeaderSet = async () => {
      throw new Error('replay-seed failed');
    };
    await expect(reloadAllUsers(h.deps)).resolves.toBeUndefined();
    expect(h.runtimes.has('u1')).toBe(true); // the spawn survived the hub failure
  });
});
