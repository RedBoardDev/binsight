import { describe, expect, it } from 'vitest';
import type { BinSol } from './position-adjust';
import {
  inRangeTokenAdds,
  type LeaderBinLegs,
  planTwoSided,
  planTwoSidedReshape,
  resolveTwoSidedTokenDeposit,
  sizeTwoSided,
  twoSidedLegTotals,
} from './two-sided';

const sumSol = (w: { solBps: number }[]): number => w.reduce((s, b) => s + b.solBps, 0);
const sumToken = (w: { tokenBps: number }[]): number => w.reduce((s, b) => s + b.tokenBps, 0);

describe('planTwoSided — replicate BOTH legs (or fall back to SOL-only)', () => {
  it('SOL-only position (token leg all zero) → twoSided=false, SOL BPS sum 10000, token BPS all 0', () => {
    const legs: LeaderBinLegs[] = [
      { binId: 100, solRaw: 100n, tokenRaw: 0n },
      { binId: 101, solRaw: 100n, tokenRaw: 0n },
      { binId: 102, solRaw: 100n, tokenRaw: 0n },
    ];
    const p = planTwoSided(legs, 102, 102, 0n); // delta 0
    expect(p.twoSided).toBe(false);
    expect(sumSol(p.weights)).toBe(10000);
    expect(sumToken(p.weights)).toBe(0);
    expect(p.leaderTokenRaw).toBe(0n);
  });

  it('token leg present but ≤ dust → twoSided=false (not worth a buy)', () => {
    const legs: LeaderBinLegs[] = [
      { binId: 100, solRaw: 100n, tokenRaw: 5n },
      { binId: 101, solRaw: 100n, tokenRaw: 3n },
    ];
    expect(planTwoSided(legs, 101, 101, 10n).twoSided).toBe(false); // 8 ≤ 10 dust
  });

  it('genuine two-sided → both legs reproduced, each summing 10000; the shared active bin carries BOTH', () => {
    // bins 99,100 hold SOL (≤ active); 100 (active) + 101,102 hold token. bin 100 = mixed (both legs).
    const legs: LeaderBinLegs[] = [
      { binId: 99, solRaw: 50n, tokenRaw: 0n },
      { binId: 100, solRaw: 50n, tokenRaw: 20n },
      { binId: 101, solRaw: 0n, tokenRaw: 40n },
      { binId: 102, solRaw: 0n, tokenRaw: 40n },
    ];
    const p = planTwoSided(legs, 100, 100, 0n);
    expect(p.twoSided).toBe(true);
    expect(sumSol(p.weights)).toBe(10000);
    expect(sumToken(p.weights)).toBe(10000);
    expect(p.leaderSolRaw).toBe(100n);
    expect(p.leaderTokenRaw).toBe(100n);
    const active = p.weights.find((w) => w.binId === 100);
    expect(active?.solBps).toBeGreaterThan(0);
    expect(active?.tokenBps).toBeGreaterThan(0); // the active bin is replicated on BOTH sides
  });

  it('fully-crossed token-only position (no SOL leg) → twoSided=true, SOL BPS all 0, token BPS sum 10000', () => {
    const legs: LeaderBinLegs[] = [
      { binId: 200, solRaw: 0n, tokenRaw: 60n },
      { binId: 201, solRaw: 0n, tokenRaw: 40n },
    ];
    const p = planTwoSided(legs, 199, 199, 0n);
    expect(p.twoSided).toBe(true);
    expect(sumSol(p.weights)).toBe(0);
    expect(sumToken(p.weights)).toBe(10000);
  });

  it('re-anchors to OUR active bin (delta shift) — bins move by ourActive − leaderActive', () => {
    const legs: LeaderBinLegs[] = [
      { binId: 100, solRaw: 50n, tokenRaw: 0n },
      { binId: 101, solRaw: 0n, tokenRaw: 50n },
    ];
    const p = planTwoSided(legs, 100, 105, 0n); // delta +5
    expect(p.weights.map((w) => w.binId).sort((a, b) => a - b)).toEqual([105, 106]);
  });

  it('empty position (no SOL, no token) → throws (must not silently produce an empty deposit)', () => {
    expect(() => planTwoSided([{ binId: 100, solRaw: 0n, tokenRaw: 0n }], 100, 100, 0n)).toThrow();
  });
});

describe('planTwoSided — gate two-sided on OUR SCALED token target (finding #144)', () => {
  // A leader with a REAL token leg (2_000_000 raw) on a mostly-SOL position; dust threshold 100_000 raw.
  const legs: LeaderBinLegs[] = [
    { binId: 100, solRaw: 500_000_000n, tokenRaw: 0n }, // SOL-heavy bin
    { binId: 101, solRaw: 10_000_000n, tokenRaw: 2_000_000n }, // active/mixed bin carries the token leg
  ];
  const DUST = 100_000n;

  it('small ratio scales a REAL two-sided leader down to a DUST token target → twoSided=false (falls through to SOL-only, NOT skipped)', () => {
    // WHY: at 2% our token target = 2_000_000 × 200bps / 10000 = 40_000 ≤ 100_000 dust. Buying 40_000 raw hits
    // Jupiter NO_ROUTES → the buy throws → the WHOLE open was dropped. Gating on the SCALED target makes the copy
    // fall through to the one-sided SOL path (still copied). The leg is real — only the small ratio makes it dust.
    const small = planTwoSided(legs, 101, 101, DUST, 2);
    expect(small.twoSided).toBe(false); // → handleOpen's `if (plan.twoSided …)` guard fails → SOL-only path taken
    // Proof it is the RATIO, not the leg: the SAME leader at a full 1:1 copy IS two-sided (the raw leg > dust).
    expect(planTwoSided(legs, 101, 101, DUST, 100).twoSided).toBe(true);
  });

  it('normal ratio keeps OUR scaled token target above dust → twoSided=true (both legs still replicated, each BPS sum 10000)', () => {
    // 50% → 2_000_000 × 5000bps / 10000 = 1_000_000 > 100_000 dust → a genuine two-sided copy is unaffected.
    const p = planTwoSided(legs, 101, 101, DUST, 50);
    expect(p.twoSided).toBe(true);
    expect(sumSol(p.weights)).toBe(10000);
    expect(sumToken(p.weights)).toBe(10000); // token leg reproduced
  });

  it('a genuinely one-sided leader (no token leg) stays SOL-only at ANY ratio — the scaled gate never invents a token side', () => {
    const solOnly: LeaderBinLegs[] = [
      { binId: 100, solRaw: 100n, tokenRaw: 0n },
      { binId: 101, solRaw: 100n, tokenRaw: 0n },
    ];
    expect(planTwoSided(solOnly, 101, 101, DUST, 2).twoSided).toBe(false); // 0 × any ratio = 0 ≤ dust
    expect(planTwoSided(solOnly, 101, 101, DUST, 100).twoSided).toBe(false);
  });
});

describe('sizeTwoSided — scale BOTH legs by the leader-leg ratio (composition), COMBINED deployment capped', () => {
  it('50% → exactly half of EACH leg (composition preserved)', () => {
    // 3rd arg = token-leg SOL value; here small enough that the cap never binds → pure ratio.
    expect(sizeTwoSided(120_000_000n, 5_000_000n, 5_000_000n, 50, 1_000_000_000n)).toEqual({
      solLamports: 60_000_000n,
      tokenTarget: 2_500_000n,
    });
  });

  it('100% → both legs at full leader size', () => {
    expect(sizeTwoSided(120_000_000n, 5_000_000n, 5_000_000n, 100, 1_000_000_000n)).toEqual({
      solLamports: 120_000_000n,
      tokenTarget: 5_000_000n,
    });
  });

  it('cap (token value 0) → combined == the SOL leg, so it behaves as a plain SOL-leg cap; token scaled by the same factor', () => {
    // token value 0 ⇒ combined == the SOL leg ⇒ the OLD SOL-leg-only cap is the token-value-0 special case of the
    // combined cap. 100% of 1 SOL leg, cap 0.5 SOL → factor 0.5 → token also halved (composition holds).
    expect(sizeTwoSided(1_000_000_000n, 4_000_000n, 0n, 100, 500_000_000n)).toEqual({
      solLamports: 500_000_000n,
      tokenTarget: 2_000_000n,
    });
  });

  it('no cap (maxDeploy 0) → pure ratio, no clamp', () => {
    expect(sizeTwoSided(100n, 80n, 80n, 50, 0n)).toEqual({ solLamports: 50n, tokenTarget: 40n });
  });

  it('FRACTIONAL ratio (12.5%) does NOT throw and scales via bps (ULTRACODE #38/#49)', () => {
    // WHY: `BigInt(12.5)` throws a RangeError — a UI-valid fractional ratio would silently drop EVERY
    // two-sided open (swallowed as a generic "mirror error"). The domain function must be TOTAL for any ratio.
    expect(() => sizeTwoSided(1_000_000n, 800_000n, 800_000n, 12.5, 0n)).not.toThrow();
    expect(sizeTwoSided(1_000_000n, 800_000n, 800_000n, 12.5, 0n)).toEqual({
      solLamports: 125_000n, // 1_000_000 × 1250bps / 10000
      tokenTarget: 100_000n, // 800_000 × 1250bps / 10000
    });
  });

  it('sub-percent ratio (0.5%) also holds (bps rounding is total)', () => {
    expect(sizeTwoSided(1_000_000n, 0n, 0n, 0.5, 0n)).toEqual({
      solLamports: 5_000n,
      tokenTarget: 0n,
    });
  });
});

describe('sizeTwoSided — combined-deployment cap counts the token buy too (finding #94)', () => {
  const SOL = 1_000_000_000n;
  const PRICE = 500n; // lamports of SOL value per raw token unit (all scenarios), so buySpend = tokenTarget × PRICE

  it('symptom 1 — rich wallet: the SOL leg alone never trips the cap, but combined = ~2× the ceiling → both legs scaled so combined ≤ cap', () => {
    // leader 4 SOL leg + token worth 4 SOL, ratio 100%, maxTradeSize 5 SOL. OLD (SOL-leg-only cap): SOL leg 4 < 5 →
    // no clamp, token 8_000_000 → an ~4 SOL buy → ~8 SOL deployed vs the 5 SOL cap. NEW: combined 8 SOL > 5 → factor
    // 0.625 on BOTH legs → SOL 2.5 + buy 2.5 = exactly the 5 SOL cap.
    const leaderTokenRaw = 8_000_000n; // × PRICE = 4 SOL of value
    const maxDeploy = 5n * SOL; // = min(decision.sizeSol 8, maxTradeSize 5)
    const { solLamports, tokenTarget } = sizeTwoSided(
      4n * SOL,
      leaderTokenRaw,
      4n * SOL,
      100,
      maxDeploy,
    );
    expect(solLamports).toBe(2_500_000_000n); // 4 SOL × 0.625
    expect(tokenTarget).toBe(5_000_000n); // 8_000_000 × 0.625
    // combined = SOL leg + the SOL spent buying the token = EXACTLY the cap (the old cap let this reach 8 SOL).
    expect(solLamports + tokenTarget * PRICE).toBe(maxDeploy);
  });

  it('symptom 2 — token-heavy: the token buy ALONE would exceed maxTradeSol → both legs scaled so the buy fits (no coffre hard-reject / silent drop; old #12)', () => {
    // leader 1 SOL leg + token worth 8 SOL, ratio 100%, maxTradeSol 5. OLD: SOL leg 1 < 5 → no clamp, token buy
    // ~8 SOL > maxTradeSol 5 → the coffre HARD-rejects the buy → the whole open is silently DROPPED. NEW: combined
    // 9 SOL > 5 → factor 5/9 → the buy is scaled UNDER the per-command cap, so it is no longer rejected.
    const leaderTokenRaw = 16_000_000n; // × PRICE = 8 SOL of value
    const maxTradeSol = 5n * SOL; // the coffre's per-command hard cap (process-command.ts:442)
    const { solLamports, tokenTarget } = sizeTwoSided(
      1n * SOL,
      leaderTokenRaw,
      8n * SOL,
      100,
      maxTradeSol,
    );
    const buySpend = tokenTarget * PRICE;
    expect(buySpend).toBeLessThanOrEqual(maxTradeSol); // the buy fits the cap → NOT dropped (old: 8 SOL > 5 → dropped)
    expect(tokenTarget).toBeLessThan(leaderTokenRaw); // scaled down from the uncapped full leg
    expect(solLamports + buySpend).toBeLessThanOrEqual(maxTradeSol); // combined bounded
  });

  it('symptom 3 — the size to RECORD = SOL leg + buy spend counts BOTH legs (exposure basis), not the SOL leg alone', () => {
    // leader 1 SOL leg + token worth 1 SOL, ratio 100%, cap not binding. What the caller records on the mirror is the
    // COMBINED (SOL leg + SOL spent buying the token) = 2 SOL; recording only the 1 SOL leg undercounts exposure by
    // the token leg (2× here) and lets the exposure caps under-block.
    const leaderTokenRaw = 2_000_000n; // × PRICE = 1 SOL of value
    const { solLamports, tokenTarget } = sizeTwoSided(
      1n * SOL,
      leaderTokenRaw,
      1n * SOL,
      100,
      100n * SOL, // huge cap → full ratio on both legs
    );
    expect(solLamports).toBe(1n * SOL);
    expect(tokenTarget * PRICE).toBe(1n * SOL); // the buy spend
    expect(solLamports + tokenTarget * PRICE).toBe(2n * SOL); // recorded exposure = BOTH legs
  });
});

describe('sizeTwoSided — fixed-size mode deploys ~fixedSize, NOT 100% of the leader (#143)', () => {
  const SOL = 1_000_000_000n;
  const PRICE = 500n; // lamports of SOL value per raw token unit → buySpend = tokenTarget × PRICE
  // Fixed-size mode has no % ratio, so the two-sided OPEN sizes at a FULL (100%) NOMINAL ratio and lets the #94
  // COMBINED cap (`maxDeployLamports` = the pinned `maxTradeSizeSol`) bound the deployment. 100 here IS the
  // fixed-size nominal ratio (user-runtime's FIXED_SIZE_MIRROR_RATIO_PCT); the leader is BIGGER than the fixed size.
  const FIXED_SIZE_NOMINAL_PCT = 100;
  const leaderSolLeg = 4n * SOL; // leader SOL leg
  const leaderTokenRaw = 8_000_000n; // × PRICE = 4 SOL of token value
  const leaderTokenValue = 4n * SOL;
  const leaderCombined = leaderSolLeg + leaderTokenValue; // = 8 SOL (the leader's total value, both legs in SOL)
  const fixedSize = 5n * SOL; // the user's pinned `maxTradeSizeSol` (= `maxDeployLamports` in fixed-size mode)

  it('a leader worth MORE than the fixed size → both legs scaled so the combined deployment == the fixed size', () => {
    // WHY (#143): before, the two-sided open was read as "100% OF THE LEADER" (8 SOL) — ignoring the pinned 5 SOL.
    // The fixed-size nominal ratio + the #94 cap must instead deploy ~fixedSize: factor 0.625 on BOTH legs → 5 SOL.
    const { solLamports, tokenTarget } = sizeTwoSided(
      leaderSolLeg,
      leaderTokenRaw,
      leaderTokenValue,
      FIXED_SIZE_NOMINAL_PCT,
      fixedSize,
    );
    expect(solLamports + tokenTarget * PRICE).toBe(fixedSize); // combined = the fixed size, NOT 100% of the leader
    expect(solLamports).toBe(2_500_000_000n); // 4 SOL × 0.625 (composition preserved: both legs share the factor)
    expect(tokenTarget).toBe(5_000_000n); // 8_000_000 × 0.625
  });

  it('proof it is the CAP, not the ratio: the SAME 100% ratio with NO cap deploys the full leader (100% of 8 SOL)', () => {
    // The bug the fix guards: at 100% and NO combined cap the open deploys the WHOLE leader — the very "100% of the
    // leader" the fixed size must override. `maxDeploy = 0` disables the cap (the token-value-0 / no-cap sentinel).
    const { solLamports, tokenTarget } = sizeTwoSided(
      leaderSolLeg,
      leaderTokenRaw,
      leaderTokenValue,
      FIXED_SIZE_NOMINAL_PCT,
      0n,
    );
    expect(solLamports + tokenTarget * PRICE).toBe(leaderCombined); // 8 SOL — 100% of the leader (> the 5 SOL fixed size)
  });
});

describe('planTwoSidedReshape — proportional removes (both legs) + per-leg token ADD deficit', () => {
  const ratio = 0.5;
  const NO_CAP = 1_000_000;
  const DEAD = 0.001;

  it('leader GREW both legs → SOL adds AND token adds (the token leg to buy + deposit)', () => {
    const leaderSol: BinSol[] = [{ offset: 0, sol: 1.0 }];
    const ourSol: BinSol[] = [{ offset: 0, sol: 0.2 }]; // target 0.5 → add 0.3
    const leaderToken: BinSol[] = [{ offset: 0, sol: 100 }]; // token "amount" (UI)
    const ourToken: BinSol[] = [{ offset: 0, sol: 20 }]; // target 50 → add 30
    const r = planTwoSidedReshape(leaderSol, ourSol, leaderToken, ourToken, ratio, NO_CAP, DEAD, 1);
    expect(r.ops.some((o) => o.action === 'add')).toBe(true);
    expect(r.tokenAddOps.length).toBe(1);
    expect(r.tokenAddOps[0]?.addSol).toBeCloseTo(30, 6); // 0.5×100 − 20
  });

  it('leader SHRANK → SOL-leg removes (proportional, cover BOTH legs) + NO token adds', () => {
    const leaderSol: BinSol[] = [{ offset: 0, sol: 0.2 }];
    const ourSol: BinSol[] = [{ offset: 0, sol: 0.4 }]; // target 0.1 → remove
    const leaderToken: BinSol[] = [{ offset: 0, sol: 20 }];
    const ourToken: BinSol[] = [{ offset: 0, sol: 40 }]; // token also above target → but removes are proportional
    const r = planTwoSidedReshape(leaderSol, ourSol, leaderToken, ourToken, ratio, NO_CAP, DEAD, 1);
    expect(r.ops.some((o) => o.action === 'remove')).toBe(true);
    expect(r.tokenAddOps.length).toBe(0); // no token ADD on a shrink
  });

  it('SOL-only position (no token leg) → no token adds', () => {
    const leaderSol: BinSol[] = [{ offset: 0, sol: 1.0 }];
    const ourSol: BinSol[] = [{ offset: 0, sol: 0.2 }];
    const r = planTwoSidedReshape(
      leaderSol,
      ourSol,
      [{ offset: 0, sol: 0 }],
      [{ offset: 0, sol: 0 }],
      ratio,
      NO_CAP,
      DEAD,
      1,
    );
    expect(r.tokenAddOps.length).toBe(0);
  });

  // FIX #119: when the SOL cap binds, BOTH legs must scale by the SAME factor (mirror the OPEN's sizeTwoSided).
  // The old code capped only the SOL leg and left the token leg at `ratio × leaderToken` → the copy bought token
  // toward an UNCAPPED target and ratcheted past maxTradeSizeSol, re-detecting a deficit every event.
  it('capped: SOL cap binds → token leg scaled by the SAME shared factor, NOT the uncapped ratio', () => {
    // ratio 1, leaderSol total 1.0, cap 0.5 → shared factor = min(1, 0.5/1.0) = 0.5.
    const leaderSol: BinSol[] = [{ offset: 0, sol: 1.0 }];
    const ourSol: BinSol[] = [{ offset: 0, sol: 0 }];
    const leaderToken: BinSol[] = [{ offset: 0, sol: 100 }];
    const ourToken: BinSol[] = [{ offset: 0, sol: 0 }];
    const CAP = 0.5;
    const r = planTwoSidedReshape(leaderSol, ourSol, leaderToken, ourToken, 1, CAP, DEAD, DEAD);
    const solAdd = r.ops.find((o) => o.offset === 0 && o.action === 'add');
    expect(solAdd?.action === 'add' && solAdd.addSol).toBeCloseTo(0.5, 6); // SOL leg capped at factor × 1.0
    // Token target = factor × 100 = 50 (SAME factor). The old POSITIVE_INFINITY/ratio code targeted ratio × 100 = 100.
    expect(r.tokenAddOps[0]?.addSol).toBeCloseTo(50, 6);
  });

  it('uncapped: cap does not bind → shared factor == ratio (token leg unchanged)', () => {
    const leaderSol: BinSol[] = [{ offset: 0, sol: 1.0 }];
    const ourSol: BinSol[] = [{ offset: 0, sol: 0 }];
    const leaderToken: BinSol[] = [{ offset: 0, sol: 100 }];
    const ourToken: BinSol[] = [{ offset: 0, sol: 0 }];
    const r = planTwoSidedReshape(
      leaderSol,
      ourSol,
      leaderToken,
      ourToken,
      0.5,
      NO_CAP,
      DEAD,
      DEAD,
    );
    const solAdd = r.ops.find((o) => o.offset === 0 && o.action === 'add');
    expect(solAdd?.action === 'add' && solAdd.addSol).toBeCloseTo(0.5, 6); // factor == ratio 0.5
    expect(r.tokenAddOps[0]?.addSol).toBeCloseTo(50, 6); // 0.5 × 100 — identical to the capped-off path
  });

  // The fidelity bug the on-chain SHRINK test caught: a PURE-TOKEN bin (above the active bin, no SOL leg) is
  // invisible to the SOL-leg remove plan, so on a leader shrink it was never trimmed → the copy drifted
  // token-heavy. The fix emits a token-leg remove on such bins (but NOT on mixed bins already covered by a SOL
  // remove, to avoid a double trim).
  it('leader SHRANK including a PURE-TOKEN bin → that bin gets a token-leg remove, mixed bin not double-trimmed', () => {
    const leaderSol: BinSol[] = [
      { offset: 0, sol: 0.2 },
      { offset: 2, sol: 0 },
    ]; // offset 2 = pure-token bin (no SOL)
    const ourSol: BinSol[] = [
      { offset: 0, sol: 0.4 },
      { offset: 2, sol: 0 },
    ]; // mixed bin over target → SOL remove
    const leaderToken: BinSol[] = [
      { offset: 0, sol: 20 },
      { offset: 2, sol: 10 },
    ];
    const ourToken: BinSol[] = [
      { offset: 0, sol: 40 },
      { offset: 2, sol: 20 },
    ]; // both over target after the shrink
    const r = planTwoSidedReshape(leaderSol, ourSol, leaderToken, ourToken, ratio, NO_CAP, DEAD, 1);

    const removes = r.ops.filter((o) => o.action === 'remove');
    // The pure-token bin (offset 2) is now removed — WITHOUT the fix it would be missing and the copy stays token-heavy.
    const tokenBinRemove = removes.find((o) => o.offset === 2);
    expect(tokenBinRemove).toBeDefined();
    if (tokenBinRemove?.action === 'remove') expect(tokenBinRemove.bps).toBe(7500); // target 5 vs cur 20 → remove 75%
    // The mixed bin (offset 0) is trimmed by the SOL-leg remove only — exactly ONE op, no token-leg duplicate.
    expect(removes.filter((o) => o.offset === 0).length).toBe(1);
    expect(r.tokenAddOps.length).toBe(0); // a shrink has no token adds
  });

  // #143: fixed-size RESYNC. The mode carries no % ratio, so resync feeds a FULL (100% → 1.0) NOMINAL ratio bounded
  // by `maxSol = maxTradeSizeSol` (⇒ factor = min(1, fixedSize/leaderSolTotal)). A leader de-risk must then SHRINK
  // the mirror — the exact behaviour the old fixed-size ratio of 0 silently disabled (planReshape's `ratio > 0`
  // guard returned []), leaving the copy fully deployed through the whole drawdown until the final close.
  it('fixed-size (ratio 1.0, cap = fixedSize) MIRRORS a leader de-risk (removes) — where the old ratio 0 was a silent no-op', () => {
    const leaderSol: BinSol[] = [
      { offset: 0, sol: 0.5 },
      { offset: 1, sol: 0.5 },
    ]; // leader de-risked to 1.0 SOL total (was larger)
    const ourSol: BinSol[] = [
      { offset: 0, sol: 2.5 },
      { offset: 1, sol: 2.5 },
    ]; // we still hold 5.0 SOL (the fixed size) → must shrink toward the de-risked leader
    const noToken: BinSol[] = [
      { offset: 0, sol: 0 },
      { offset: 1, sol: 0 },
    ];
    const FIXED_SIZE = 5; // maxTradeSizeSol (= maxSol); leaderSolTotal 1.0 < it ⇒ factor = min(1, 5/1) = 1.0
    const FIXED_SIZE_RATIO = 1.0; // FIXED_SIZE_MIRROR_RATIO_PCT / 100 — the fixed-size nominal mirror

    const fixed = planTwoSidedReshape(
      leaderSol,
      ourSol,
      noToken,
      noToken,
      FIXED_SIZE_RATIO,
      FIXED_SIZE,
      DEAD,
      DEAD,
    );
    expect(fixed.ops.some((o) => o.action === 'remove')).toBe(true); // the de-risk IS mirrored — the copy shrinks

    // The BUG being fixed: the old fixed-size path fed ratio 0 → planReshape's `ratio > 0` guard → EMPTY plan (no-op).
    const buggy = planTwoSidedReshape(
      leaderSol,
      ourSol,
      noToken,
      noToken,
      0,
      FIXED_SIZE,
      DEAD,
      DEAD,
    );
    expect(buggy.ops).toEqual([]); // silently disabled: the copy would ride the drawdown fully deployed (#143)
  });
});

describe('twoSidedLegTotals — SOL/token → pool X/Y mapping (ULTRACODE #16)', () => {
  const SOL = 100n;
  const TOK = 7n;

  it('solSide=X → the SOL amount is on X, the token on Y', () => {
    // WHY: the pool fixes which mint is X/Y; the SOL amount must land on the SOL side. The reshape-add path had
    // this inverted (SOL on the token side) → a two-sided grow failed on-chain or deposited swapped legs.
    expect(twoSidedLegTotals('X', SOL, TOK)).toEqual({ totalX: SOL, totalY: TOK });
  });

  it('solSide=Y → the SOL amount is on Y, the token on X', () => {
    expect(twoSidedLegTotals('Y', SOL, TOK)).toEqual({ totalX: TOK, totalY: SOL });
  });

  it('the SOL amount is NEVER placed on the token side (the #16 invariant), both sides', () => {
    expect(twoSidedLegTotals('X', SOL, TOK).totalX).toBe(SOL);
    expect(twoSidedLegTotals('Y', SOL, TOK).totalY).toBe(SOL);
  });
});

describe('inRangeTokenAdds — token deficits mapped into OUR fixed range (#48)', () => {
  it('a token add OUTSIDE our range OR rounding to 0 raw is dropped; in-range positive survives', () => {
    // our range: bins [100, 102]. offsets: 0→100, 1→101, 2→102, 3→103 (out), -1→99 (out).
    const ops = [
      { offset: 3, addSol: 500 }, // → bin 103, above upper → dropped
      { offset: -1, addSol: 500 }, // → bin 99, below lower → dropped
      { offset: 0, addSol: 0.4 }, // rounds to 0 raw → dropped (no real token to deposit)
      { offset: 1, addSol: 12 }, // → bin 101, raw 12 → kept
    ];
    expect(inRangeTokenAdds(ops, 100, 102)).toEqual([{ binId: 101, raw: 12 }]);
  });

  it('WHY the gate matters: an all-out-of-range token deficit yields ZERO adds → caller must NOT go two-sided', () => {
    // Every token add falls above our fixed upper bin (leader extended its range). If the caller still entered the
    // two-sided BUY branch it would price a 0-token leg, throw, and drop the SOL-leg adds. Empty result = fall through.
    const ops = [
      { offset: 5, addSol: 1000 },
      { offset: 6, addSol: 1000 },
    ];
    expect(inRangeTokenAdds(ops, 100, 102)).toEqual([]);
  });
});

describe('resolveTwoSidedTokenDeposit — never deposit a stale/short token leg (#33)', () => {
  const EXPECTED = 1_000_000n;
  const SLIPPAGE_BPS = 100; // 1% → floor = 990_000

  it('a stale read still at the PRE-buy balance is NOT ready (read-after-write lag) → retry, no half copy', () => {
    // The buy landed on the coffre's connection but the brain's read lags: balance unchanged from pre-buy.
    const r = resolveTwoSidedTokenDeposit({
      actualBalance: 5n,
      preBuyBalance: 5n,
      expectedOut: EXPECTED,
      slippageBps: SLIPPAGE_BPS,
    });
    expect(r.ready).toBe(false);
    expect(r.depositRaw).toBe(0n);
  });

  it('a partial (below-floor) read is NOT ready → never deposits a short leg', () => {
    const r = resolveTwoSidedTokenDeposit({
      actualBalance: 900_000n, // bought 900_000 < floor 990_000
      preBuyBalance: 0n,
      expectedOut: EXPECTED,
      slippageBps: SLIPPAGE_BPS,
    });
    expect(r.ready).toBe(false);
  });

  it('a settled read (bought ≥ floor) is ready and deposits min(bought, expected)', () => {
    const r = resolveTwoSidedTokenDeposit({
      actualBalance: 995_000n,
      preBuyBalance: 0n,
      expectedOut: EXPECTED,
      slippageBps: SLIPPAGE_BPS,
    });
    expect(r.ready).toBe(true);
    expect(r.depositRaw).toBe(995_000n); // bought < expected → deposit the real bought amount
  });

  it('a PRE-EXISTING residual of the same mint is NOT co-deposited (uses bought = actual − preBuy)', () => {
    // preBuy already holds 400_000 of the token; the buy adds 1_000_000. Deposit only the bought delta, capped at
    // expected — never the residual (which would over-grow the token leg past the leader composition).
    const r = resolveTwoSidedTokenDeposit({
      actualBalance: 1_400_000n,
      preBuyBalance: 400_000n,
      expectedOut: EXPECTED,
      slippageBps: SLIPPAGE_BPS,
    });
    expect(r.ready).toBe(true);
    expect(r.depositRaw).toBe(1_000_000n); // min(bought=1_000_000, expected=1_000_000)
  });

  it('a positive-slippage overfill is capped at expected (remainder swept, composition preserved)', () => {
    const r = resolveTwoSidedTokenDeposit({
      actualBalance: 1_050_000n, // received MORE than quoted
      preBuyBalance: 0n,
      expectedOut: EXPECTED,
      slippageBps: SLIPPAGE_BPS,
    });
    expect(r.ready).toBe(true);
    expect(r.depositRaw).toBe(EXPECTED); // min(bought, expected) → capped
  });
});
