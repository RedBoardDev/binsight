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

describe('sizeTwoSided — scale BOTH legs by the leader-leg ratio (NOT total value), SOL leg capped', () => {
  it('50% → exactly half of EACH leg (composition preserved)', () => {
    expect(sizeTwoSided(120_000_000n, 5_000_000n, 50, 1_000_000_000n)).toEqual({
      solLamports: 60_000_000n,
      tokenTarget: 2_500_000n,
    });
  });

  it('100% → both legs at full leader size', () => {
    expect(sizeTwoSided(120_000_000n, 5_000_000n, 100, 1_000_000_000n)).toEqual({
      solLamports: 120_000_000n,
      tokenTarget: 5_000_000n,
    });
  });

  it('cap: SOL leg over maxSol → SOL clamped AND token scaled by the SAME factor (composition still holds)', () => {
    // 100% of 1 SOL leg, cap 0.5 SOL → factor 0.5 → token also halved.
    expect(sizeTwoSided(1_000_000_000n, 4_000_000n, 100, 500_000_000n)).toEqual({
      solLamports: 500_000_000n,
      tokenTarget: 2_000_000n,
    });
  });

  it('no cap (maxSol 0) → pure ratio, no clamp', () => {
    expect(sizeTwoSided(100n, 80n, 50, 0n)).toEqual({ solLamports: 50n, tokenTarget: 40n });
  });

  it('FRACTIONAL ratio (12.5%) does NOT throw and scales via bps (ULTRACODE #38/#49)', () => {
    // WHY: `BigInt(12.5)` throws a RangeError — a UI-valid fractional ratio would silently drop EVERY
    // two-sided open (swallowed as a generic "mirror error"). The domain function must be TOTAL for any ratio.
    expect(() => sizeTwoSided(1_000_000n, 800_000n, 12.5, 0n)).not.toThrow();
    expect(sizeTwoSided(1_000_000n, 800_000n, 12.5, 0n)).toEqual({
      solLamports: 125_000n, // 1_000_000 × 1250bps / 10000
      tokenTarget: 100_000n, // 800_000 × 1250bps / 10000
    });
  });

  it('sub-percent ratio (0.5%) also holds (bps rounding is total)', () => {
    expect(sizeTwoSided(1_000_000n, 0n, 0.5, 0n)).toEqual({ solLamports: 5_000n, tokenTarget: 0n });
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
