import { describe, expect, it } from 'vitest';
import { CAPS_DEFAULTS, type CapsConfig, type CapsState, checkCaps } from './caps';

const state = (over: Partial<CapsState> = {}): CapsState => ({
  openPositions: 0,
  totalExposureSol: 0,
  leaderExposureSol: 0,
  tokenOpenCount: 0,
  openTimestampsMs: [],
  ...over,
});
const NOW = 1_000_000_000;

describe('checkCaps — caps + kill-switch envelope', () => {
  it('defaults + empty state → allow', () => {
    expect(checkCaps(CAPS_DEFAULTS, state(), 1, NOW)).toEqual({ action: 'allow' });
  });

  it('global kill-switch ON → block kill_switch_global (absolute priority)', () => {
    const cfg: CapsConfig = { ...CAPS_DEFAULTS, killSwitchGlobal: true };
    // even with a perfect state, the kill-switch wins.
    expect(checkCaps(cfg, state(), 1, NOW)).toEqual({
      action: 'block',
      reason: 'kill_switch_global',
    });
  });

  it('leader kill-switch ON (global OFF) → block kill_switch_leader', () => {
    expect(checkCaps({ ...CAPS_DEFAULTS, killSwitchLeader: true }, state(), 1, NOW)).toEqual({
      action: 'block',
      reason: 'kill_switch_leader',
    });
  });

  describe('maxOpenPositions', () => {
    it('at the cap → block', () => {
      expect(
        checkCaps({ ...CAPS_DEFAULTS, maxOpenPositions: 8 }, state({ openPositions: 8 }), 1, NOW),
      ).toEqual({
        action: 'block',
        reason: 'max_open_positions',
      });
    });
    it('below the cap → allow', () => {
      expect(
        checkCaps({ ...CAPS_DEFAULTS, maxOpenPositions: 8 }, state({ openPositions: 7 }), 1, NOW)
          .action,
      ).toBe('allow');
    });
    it('null (uncapped) → allow even with many positions', () => {
      expect(
        checkCaps(
          { ...CAPS_DEFAULTS, maxOpenPositions: null },
          state({ openPositions: 999 }),
          1,
          NOW,
        ).action,
      ).toBe('allow');
    });
  });

  describe('maxConcurrentPerToken', () => {
    it('at the cap for this token → block', () => {
      const cfg = { ...CAPS_DEFAULTS, maxConcurrentPerToken: 1 };
      expect(checkCaps(cfg, state({ tokenOpenCount: 1 }), 1, NOW)).toEqual({
        action: 'block',
        reason: 'max_concurrent_per_token',
      });
    });
    it('null (unlimited, default) → allow', () => {
      expect(checkCaps(CAPS_DEFAULTS, state({ tokenOpenCount: 50 }), 1, NOW).action).toBe('allow');
    });
  });

  describe('maxOpensPerWindow (sliding window 10/10min)', () => {
    it('enough opens INSIDE the window → block', () => {
      const recent = Array.from({ length: 10 }, (_, i) => NOW - i * 1000); // 10 opens in the last 10s
      expect(checkCaps(CAPS_DEFAULTS, state({ openTimestampsMs: recent }), 1, NOW)).toEqual({
        action: 'block',
        reason: 'max_opens_per_window',
      });
    });
    it('opens OUTSIDE the window (older than windowMinutes) do not count → allow', () => {
      const old = Array.from({ length: 20 }, () => NOW - 11 * 60_000); // 20 opens 11 min ago (> 10 min)
      expect(checkCaps(CAPS_DEFAULTS, state({ openTimestampsMs: old }), 1, NOW).action).toBe(
        'allow',
      );
    });
    it('window OFF (null) → not enforced', () => {
      const recent = Array.from({ length: 50 }, () => NOW);
      expect(
        checkCaps(
          { ...CAPS_DEFAULTS, maxOpensPerWindow: null },
          state({ openTimestampsMs: recent }),
          1,
          NOW,
        ).action,
      ).toBe('allow');
    });
  });

  describe('maxTotalExposureSol', () => {
    it('exposure + new size > cap → block', () => {
      const cfg = { ...CAPS_DEFAULTS, maxTotalExposureSol: 5 };
      expect(checkCaps(cfg, state({ totalExposureSol: 4.5 }), 1, NOW)).toEqual({
        action: 'block',
        reason: 'max_total_exposure',
      });
    });
    it('exposure + size == cap → allow (boundary included)', () => {
      const cfg = { ...CAPS_DEFAULTS, maxTotalExposureSol: 5 };
      expect(checkCaps(cfg, state({ totalExposureSol: 4 }), 1, NOW).action).toBe('allow');
    });
    it('null (OFF, default) → allow', () => {
      expect(checkCaps(CAPS_DEFAULTS, state({ totalExposureSol: 9999 }), 100, NOW).action).toBe(
        'allow',
      );
    });
  });

  describe('leaderMaxTotalExposureSol (per-leader cap, SPEC §4.2/§12)', () => {
    it('leader exposure + new size > the per-leader cap → block max_leader_exposure', () => {
      // WHY: the per-leader ceiling protects against ONE leader eating the whole wallet even when the account-wide
      // exposure cap is off — it must be enforced against THAT leader's mirrors only.
      expect(checkCaps(CAPS_DEFAULTS, state({ leaderExposureSol: 0.8 }), 0.3, NOW, 1)).toEqual({
        action: 'block',
        reason: 'max_leader_exposure',
      });
    });
    it('scoped to the leader: a big GLOBAL exposure does not trip the per-leader cap', () => {
      const s = state({ totalExposureSol: 100, leaderExposureSol: 0.1 });
      expect(checkCaps(CAPS_DEFAULTS, s, 0.3, NOW, 1).action).toBe('allow');
    });
    it('leader exposure + size == cap → allow (boundary included, same rule as the global cap)', () => {
      expect(checkCaps(CAPS_DEFAULTS, state({ leaderExposureSol: 0.7 }), 0.3, NOW, 1).action).toBe(
        'allow',
      );
    });
    it('null / omitted (no per-leader cap) → allow whatever the leader exposure', () => {
      const s = state({ leaderExposureSol: 9999 });
      expect(checkCaps(CAPS_DEFAULTS, s, 100, NOW, null).action).toBe('allow');
      expect(checkCaps(CAPS_DEFAULTS, s, 100, NOW).action).toBe('allow'); // default param = no cap
    });
    it('the ACCOUNT-wide cap still wins first when both would block (first block wins)', () => {
      const cfg = { ...CAPS_DEFAULTS, maxTotalExposureSol: 5 };
      const s = state({ totalExposureSol: 5, leaderExposureSol: 5 });
      expect(checkCaps(cfg, s, 1, NOW, 1)).toEqual({
        action: 'block',
        reason: 'max_total_exposure',
      });
    });
  });

  it('order: the kill-switch comes before the counting caps', () => {
    const cfg: CapsConfig = { ...CAPS_DEFAULTS, killSwitchGlobal: true, maxOpenPositions: 8 };
    expect(checkCaps(cfg, state({ openPositions: 999 }), 1, NOW)).toEqual({
      action: 'block',
      reason: 'kill_switch_global',
    });
  });

  it('CAPS_DEFAULTS = expected envelope (maxOpen 8, 10/10min, kill OFF, per-token & exposure OFF)', () => {
    expect(CAPS_DEFAULTS).toEqual({
      killSwitchGlobal: false,
      killSwitchLeader: false,
      maxOpenPositions: 8,
      maxConcurrentPerToken: null,
      maxOpensPerWindow: 10,
      windowMinutes: 10,
      maxTotalExposureSol: null,
    });
  });
});
