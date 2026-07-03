import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS, type CopybotConfig, type LeaderSettings } from './config';
import { computeLeaderSet, type LeaderHoldings, shouldRetainLeader, usersCopying } from './fan-out';

const LEADER_A = 'LeaderAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LEADER_B = 'LeaderBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function leaderEntry(address: string, enabled = true): LeaderSettings {
  return { address, enabled, maxTotalExposureSol: null, overrides: {} };
}

function cfg(leaders: LeaderSettings[], userEnabled = true): CopybotConfig {
  return {
    user: { ...CONFIG_DEFAULTS.user, enabled: userEnabled },
    leaders,
  };
}

describe('computeLeaderSet — the union of STARTED leaders across enabled users (S5)', () => {
  it('unions enabled leaders across users and dedups a leader followed by both', () => {
    // WHY: the hub must watch each leader wallet ONCE no matter how many users copy it — one subscription,
    // one detector, one tracker per leader (the whole point of the shared-detection architecture).
    const configs = new Map([
      ['u1', cfg([leaderEntry(LEADER_A), leaderEntry(LEADER_B)])],
      ['u2', cfg([leaderEntry(LEADER_A)])],
    ]);
    expect(computeLeaderSet(configs)).toEqual(new Set([LEADER_A, LEADER_B]));
  });

  it('a STOPPED leader contributes nothing (stopped = not watched for new opens, SPEC §4.3)', () => {
    const configs = new Map([['u1', cfg([leaderEntry(LEADER_A, false)])]]);
    expect(computeLeaderSet(configs)).toEqual(new Set());
  });

  it("a DISABLED user's leaders contribute nothing (master switch off ⇒ no opens for them)", () => {
    // WHY: keeping a disabled user's leaders watched would burn detection for a user who can never open;
    // their still-open mirrors are covered by the retention predicate, not by the leader set.
    const configs = new Map([
      ['u1', cfg([leaderEntry(LEADER_A)], false)],
      ['u2', cfg([leaderEntry(LEADER_B)])],
    ]);
    expect(computeLeaderSet(configs)).toEqual(new Set([LEADER_B]));
  });

  it('empty configs (e.g. every row failed parseConfig upstream) ⇒ empty set (fail closed)', () => {
    expect(computeLeaderSet(new Map())).toEqual(new Set());
  });
});

describe('usersCopying — who a leader event fans out to for NEW copies (S5)', () => {
  it('targets exactly the users with that leader STARTED (second user included, others excluded)', () => {
    const configs = new Map([
      ['u1', cfg([leaderEntry(LEADER_A)])],
      ['u2', cfg([leaderEntry(LEADER_A)])],
      ['u3', cfg([leaderEntry(LEADER_B)])],
    ]);
    expect(usersCopying(LEADER_A, configs)).toEqual(['u1', 'u2']);
  });

  it('a user whose leader is STOPPED is not a target (their opens must never fire)', () => {
    const configs = new Map([
      ['u1', cfg([leaderEntry(LEADER_A, false)])],
      ['u2', cfg([leaderEntry(LEADER_A)])],
    ]);
    expect(usersCopying(LEADER_A, configs)).toEqual(['u2']);
  });

  it('a user who REMOVED the leader is not a target (removed counts as stopped, SPEC §4.3)', () => {
    const configs = new Map([['u1', cfg([leaderEntry(LEADER_B)])]]);
    expect(usersCopying(LEADER_A, configs)).toEqual([]);
  });

  it('a DISABLED user is not a target even with the leader started (master switch wins)', () => {
    const configs = new Map([['u1', cfg([leaderEntry(LEADER_A)], false)]]);
    expect(usersCopying(LEADER_A, configs)).toEqual([]);
  });
});

describe('shouldRetainLeader — a draining leader entry survives while any mirror can still close (S4)', () => {
  const holdings = (over: Partial<LeaderHoldings>): LeaderHoldings => ({
    openMirrorLeaders: [],
    rugExitPendingLeaders: [],
    ...over,
  });

  it('retained while ANY runtime holds an open mirror for it (its close must stay detectable)', () => {
    // WHY: a stop's force-closes are in flight; while a mirror survives on-chain, dropping the leader's detector
    // would blind us to its close — the forbidden miss.
    const hs = [holdings({}), holdings({ openMirrorLeaders: [LEADER_A] })];
    expect(shouldRetainLeader(LEADER_A, hs)).toBe(true);
    expect(shouldRetainLeader(LEADER_B, hs)).toBe(false);
  });

  it('retained while a pending rug-SL/stop close for it awaits its on-chain confirmation', () => {
    const hs = [holdings({ rugExitPendingLeaders: [LEADER_A] })];
    expect(shouldRetainLeader(LEADER_A, hs)).toBe(true);
  });

  it('an UNATTRIBUTABLE pending close (null leader) retains conservatively', () => {
    // WHY: a pending close restored after a restart may have lost its mirror row → we can't prove it is NOT this
    // leader's. Over-retaining costs one cheap poll per cycle; dropping early could miss a close.
    const hs = [holdings({ rugExitPendingLeaders: [null] })];
    expect(shouldRetainLeader(LEADER_A, hs)).toBe(true);
    expect(shouldRetainLeader(LEADER_B, hs)).toBe(true);
  });

  it('quiescent (no mirrors, nothing pending, or no runtimes at all) ⇒ not retained (entry reaped)', () => {
    expect(shouldRetainLeader(LEADER_A, [holdings({})])).toBe(false);
    expect(shouldRetainLeader(LEADER_A, [])).toBe(false);
  });
});
