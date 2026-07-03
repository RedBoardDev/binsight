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
  const rt: ReloadableRuntime = {
    userId,
    getConfig: () => current,
    setConfig: (next) => {
      current = next;
    },
    applyStopCloses: async (prev, next) => {
      stopDiffs.push({ prev, next });
    },
  };
  return { rt, stopDiffs };
}

/** Harness around reloadAllUsers with scripted DB rows; records spawns / leader-set applications / reconciles. */
function makeHarness(rows: Map<string, CopybotConfig>) {
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
