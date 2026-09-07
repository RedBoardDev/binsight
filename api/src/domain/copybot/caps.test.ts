import { describe, expect, it } from 'vitest';
import { CAPS_DEFAULTS, type CapsConfig, type CapsState, checkCaps, exposureFor } from './caps';
import { sizeTwoSided } from './two-sided';

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
    it('the DEFAULT (1, finding #161) blocks a SECOND concurrent same-mint position', () => {
      // WHY (#161): the close-path residual sell reads the WHOLE wallet balance, so two concurrent same-mint
      // positions commingle proceeds → the performance fee over-charges (up to 2x). The default cap of 1 forbids it.
      expect(CAPS_DEFAULTS.maxConcurrentPerToken).toBe(1);
      expect(checkCaps(CAPS_DEFAULTS, state({ tokenOpenCount: 1 }), 1, NOW)).toEqual({
        action: 'block',
        reason: 'max_concurrent_per_token',
      });
    });
    it('an EXPLICIT null override restores unlimited concurrency', () => {
      // A user who accepts the shared-wallet imprecision can opt back into unlimited same-mint concurrency.
      const cfg = { ...CAPS_DEFAULTS, maxConcurrentPerToken: null };
      expect(checkCaps(cfg, state({ tokenOpenCount: 50 }), 1, NOW).action).toBe('allow');
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

  it('CAPS_DEFAULTS = expected envelope (maxOpen 8, 10/10min, kill OFF, per-token 1 for #161, exposure OFF)', () => {
    expect(CAPS_DEFAULTS).toEqual({
      killSwitchGlobal: false,
      killSwitchLeader: false,
      maxOpenPositions: 8,
      maxConcurrentPerToken: 1, // #161 — one open position per token mint (fee-attribution safety)
      maxOpensPerWindow: 10,
      windowMinutes: 10,
      maxTotalExposureSol: null,
    });
  });
});

describe('exposureFor — per-leader exposure sum (the leaderExposureSol input, SPEC §4.2/§12)', () => {
  const mirrors = [
    { leaderAddress: 'A', sizeSol: 0.5 },
    { leaderAddress: 'B', sizeSol: 2 },
    { leaderAddress: 'A', sizeSol: 0.25 },
  ];
  it("sums ONLY the candidate leader's mirrors — leader B's positions never consume A's budget", () => {
    // WHY: the per-leader cap makes maxTotalExposureSol a real per-leader ceiling; summing all mirrors would let
    // leader B's exposure block (or exhaust) leader A's opens — the exact bug the mirror→leader mapping prevents.
    expect(exposureFor(mirrors, 'A')).toBe(0.75);
    expect(exposureFor(mirrors, 'B')).toBe(2);
  });
  it('an unknown leader (or no mirrors) has zero exposure', () => {
    expect(exposureFor(mirrors, 'C')).toBe(0);
    expect(exposureFor([], 'A')).toBe(0);
  });
  it("legacy mirrors (leaderAddress '') never leak into a real leader's exposure", () => {
    // WHY: '' is the NULL-fallback of a pre-3b row — attributing it to a real leader would inflate that leader's
    // exposure and wrongly block its opens.
    expect(exposureFor([{ leaderAddress: '', sizeSol: 5 }], 'A')).toBe(0);
  });
});

describe('exposure counts BOTH legs of a two-sided copy (finding #94 §3)', () => {
  const SOL = 1_000_000_000n;
  const PRICE = 500n; // lamports of SOL value per raw token unit → buySpend = tokenTarget × PRICE
  // A rich-wallet two-sided open: 4 SOL leg + token worth 4 SOL, ratio 100%, combined capped at 5 SOL.
  const { solLamports, tokenTarget } = sizeTwoSided(4n * SOL, 8_000_000n, 4n * SOL, 100, 5n * SOL);
  const buySpendLamports = tokenTarget * PRICE;
  const combinedSol = Number(solLamports + buySpendLamports) / 1e9; // what openTwoSided now records
  const solLegOnlySol = Number(solLamports) / 1e9; // the OLD (buggy) SOL-leg-only recording

  it('the recorded mirror size is the COMBINED deployment (SOL leg + buy spend), not the SOL leg alone', () => {
    expect(combinedSol).toBe(5); // 2.5 leg + 2.5 buy = the 5 SOL actually deployed
    expect(solLegOnlySol).toBe(2.5); // the old undercount recorded only half
  });

  it('exposureFor sums the FULL deployed capital of a two-sided mirror (both legs)', () => {
    expect(exposureFor([{ leaderAddress: 'A', sizeSol: combinedSol }], 'A')).toBe(5);
  });

  it('WHY it is money-critical: the SOL-leg-only undercount let the total-exposure cap UNDER-block a new open', () => {
    const cfg: CapsConfig = { ...CAPS_DEFAULTS, maxTotalExposureSol: 6 };
    const NEW_OPEN = 2; // a proposed new position
    // Correct (both legs counted): 5 already deployed + 2 = 7 > 6 → BLOCK (refuses to over-deploy real capital).
    expect(checkCaps(cfg, state({ totalExposureSol: combinedSol }), NEW_OPEN, NOW)).toEqual({
      action: 'block',
      reason: 'max_total_exposure',
    });
    // Buggy (SOL leg only): 2.5 + 2 = 4.5 ≤ 6 → ALLOW → 7 SOL of REAL capital slips past a 6 SOL cap.
    expect(checkCaps(cfg, state({ totalExposureSol: solLegOnlySol }), NEW_OPEN, NOW).action).toBe(
      'allow',
    );
  });
});
