import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS, type CopybotConfig, type LeaderSettings } from './config';
import { planStopCloses, type StopCloseMirror } from './stop-closes';

const A = 'LeaderA1111111111111111111111111111111111111';
const B = 'LeaderB2222222222222222222222222222222222222';

const leader = (address: string, enabled: boolean): LeaderSettings => ({
  address,
  enabled,
  maxTotalExposureSol: null,
  overrides: {},
});

const cfg = (userEnabled: boolean, leaders: LeaderSettings[]): CopybotConfig => ({
  user: { ...CONFIG_DEFAULTS.user, enabled: userEnabled },
  leaders,
});

const mirror = (leaderAddress: string, i: number): StopCloseMirror => ({
  ourPosition: `our${leaderAddress.slice(6, 7)}${i}`,
  leaderPosition: `lp${leaderAddress.slice(6, 7)}${i}`,
  leaderAddress,
});

const MIRRORS = [mirror(A, 1), mirror(A, 2), mirror(B, 1)];

describe('planStopCloses · per-leader stop (SPEC §4.3 stop = force-close)', () => {
  it('a leader flipped enabled true→false closes ONLY its mirrors, the other leader untouched', () => {
    // WHY: stopping leader A must never touch leader B's live copies — a stop is scoped, not account-wide.
    const prev = cfg(true, [leader(A, true), leader(B, true)]);
    const next = cfg(true, [leader(A, false), leader(B, true)]);
    const plan = planStopCloses(prev, next, MIRRORS);
    expect(plan.toClose).toEqual([
      { ...mirror(A, 1), reason: 'leader_stopped' },
      { ...mirror(A, 2), reason: 'leader_stopped' },
    ]);
  });

  it('a leader REMOVED from the list counts as stopped → its mirrors close', () => {
    // WHY: leader removal is a stop (SPEC §4.3) — without this, deleting a leader would orphan its open copies
    // (still tracked, never mirror-closed, silently exposed to the market).
    const prev = cfg(true, [leader(A, true), leader(B, true)]);
    const next = cfg(true, [leader(B, true)]);
    const plan = planStopCloses(prev, next, MIRRORS);
    expect(plan.toClose).toEqual([
      { ...mirror(A, 1), reason: 'leader_removed' },
      { ...mirror(A, 2), reason: 'leader_removed' },
    ]);
  });

  it('a leader already stopped in prev, then removed → nothing (the stop transition was already consumed)', () => {
    // WHY: the diff is transition-based; re-planning closes for an already-stopped leader on every reload would
    // re-publish closes forever (the reconcile owns the retry-until-gone, not this planner).
    const prev = cfg(true, [leader(A, false), leader(B, true)]);
    const next = cfg(true, [leader(B, true)]);
    expect(planStopCloses(prev, next, MIRRORS).toClose).toEqual([]);
  });
});

describe('planStopCloses · global stop', () => {
  it('user.enabled true→false closes ALL open mirrors regardless of per-leader flags', () => {
    const prev = cfg(true, [leader(A, true), leader(B, false)]);
    const next = cfg(false, [leader(A, true), leader(B, false)]);
    const plan = planStopCloses(prev, next, MIRRORS);
    expect(plan.toClose).toEqual(MIRRORS.map((m) => ({ ...m, reason: 'user_stopped' })));
  });

  it('a simultaneous global stop + leader stop closes each mirror ONCE (user_stopped wins)', () => {
    // WHY: publishing two closes for the same mirror in one reload would double-journal and race the vault.
    const prev = cfg(true, [leader(A, true), leader(B, true)]);
    const next = cfg(false, [leader(A, false), leader(B, true)]);
    const plan = planStopCloses(prev, next, MIRRORS);
    expect(plan.toClose).toHaveLength(MIRRORS.length);
    expect(new Set(plan.toClose.map((c) => c.ourPosition)).size).toBe(MIRRORS.length);
    for (const c of plan.toClose) expect(c.reason).toBe('user_stopped');
  });

  it('global already stopped in prev → a later leader flip still closes only that leader (no global replay)', () => {
    const prev = cfg(false, [leader(A, true), leader(B, true)]);
    const next = cfg(false, [leader(A, false), leader(B, true)]);
    const plan = planStopCloses(prev, next, MIRRORS);
    expect(plan.toClose.map((c) => c.leaderAddress)).toEqual([A, A]);
  });
});

describe('planStopCloses · no-op transitions (forward-only start, SPEC §4.3)', () => {
  it('enabling a leader (false→true) plans NOTHING — a start never touches positions', () => {
    // WHY (forward-only): starting a leader copies FORWARD only — the plan type has no "open" channel at all, so
    // the config-reload path is structurally unable to copy the leader's already-open positions on an enable.
    const prev = cfg(true, [leader(A, false)]);
    const next = cfg(true, [leader(A, true)]);
    expect(planStopCloses(prev, next, MIRRORS)).toEqual({ toClose: [] });
  });

  it('global start (user.enabled false→true) plans nothing', () => {
    const prev = cfg(false, [leader(A, true)]);
    const next = cfg(true, [leader(A, true)]);
    expect(planStopCloses(prev, next, MIRRORS).toClose).toEqual([]);
  });

  it('an unchanged config plans nothing (the 5s poll reload must not re-close anything)', () => {
    const same = cfg(true, [leader(A, true), leader(B, true)]);
    expect(planStopCloses(same, same, MIRRORS).toClose).toEqual([]);
  });

  it('a settings-only edit (overrides/exposure changed, switches untouched) plans nothing', () => {
    // WHY: SPEC §4.3 — settings edits while a leader runs apply to FUTURE copies only; they never force-close.
    const prev = cfg(true, [leader(A, true)]);
    const next = cfg(true, [{ ...leader(A, true), maxTotalExposureSol: 0.5 }]);
    expect(planStopCloses(prev, next, MIRRORS).toClose).toEqual([]);
  });

  it('no open mirrors → nothing to close, whatever the transition', () => {
    const prev = cfg(true, [leader(A, true)]);
    const next = cfg(false, []);
    expect(planStopCloses(prev, next, []).toClose).toEqual([]);
  });

  it('a mirror of a leader ABSENT from prev is not closed (no boot-from-stale-prev force-close)', () => {
    // WHY: prev must be the config the brain actually ran. A mirror whose leader is in neither config belongs to
    // an earlier transition (downtime reconciliation is increment-3 territory) — planning a close here would mean
    // the diff came from a stale prev, exactly what the wiring contract forbids.
    const prev = cfg(true, [leader(B, true)]);
    const next = cfg(true, [leader(B, true)]);
    expect(planStopCloses(prev, next, [mirror(A, 1)]).toClose).toEqual([]);
  });
});
