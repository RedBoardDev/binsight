/**
 * Copy-bot · TWO-SIDED re-anchoring (PURE, no I/O). Extends the SOL-only copy to ALSO replicate the leader's
 * TOKEN leg, so a leader position that holds token (a deliberate two-sided deposit, the always-mixed active bin,
 * or bins the price has crossed) is copied faithfully. Each leg is re-anchored independently (BPS sum 10000 per
 * leg via the tested `reanchorShape`), then merged per bin into `{ solBps, tokenBps }`.
 *
 * The caller (gated by the SOL-only flag) buys `ratio × leaderTokenRaw` of the token (ExactOut) and deposits
 * BOTH legs via the SDK by-weight (`totalXAmount`/`totalYAmount` + per-bin `xBps`/`yBps`). When OUR SCALED token
 * leg (`ratio × leaderTokenRaw`) is ≤ dust the position is one-sided → `twoSided=false` and the caller keeps the
 * fast SOL-only path (finding #144: gating on the leader's RAW leg dropped small-ratio copies of real two-sided leaders).
 */
import { type BinSol, planReshape, type ReshapeOp } from './position-adjust';
import { type LeaderBinAmount, type ReanchoredShape, reanchorShape } from './reanchor';
import { minOutWithSlippage } from './residual-sell';

/** Per-bin raw legs of the leader's position: SOL side + the non-SOL token side, keyed by ABSOLUTE bin. */
export interface LeaderBinLegs {
  binId: number;
  solRaw: bigint;
  tokenRaw: bigint;
}

/** A bin's two-sided weights: SOL-leg BPS + token-leg BPS (each a share of its OWN leg total). */
export interface TwoSidedBin {
  binId: number;
  solBps: number;
  tokenBps: number;
}

export interface TwoSidedPlan {
  /** false → OUR SCALED token leg (ratio × leaderTokenRaw) ≤ dust (one-sided SOL position) → caller uses the SOL-only path. */
  twoSided: boolean;
  /** merged per-bin SOL+token BPS, anchored on OUR active bin. */
  weights: TwoSidedBin[];
  leaderSolRaw: bigint;
  /** total token leg of the leader (raw) — the caller buys `ratio × this` (ExactOut) to fund the token side. */
  leaderTokenRaw: bigint;
  lowerBinId: number;
  upperBinId: number;
}

/**
 * Map a two-sided deposit's (SOL, token) amounts onto the pool's (X, Y) token order. The DLMM pool fixes which
 * mint is token X vs Y; `solSide` says which one is SOL. Both the OPEN and the RESHAPE-ADD paths MUST agree on
 * this mapping — they used to compute it inline and DIVERGED (ULTRACODE #16: the reshape-add put the SOL amount
 * on the token side for `solSide==='X'`, so a two-sided grow failed on-chain or landed with the legs inverted —
 * real money). One tested function is now the single source of truth. Pure, bigint-exact.
 */
export function twoSidedLegTotals(
  solSide: 'X' | 'Y',
  solAmount: bigint,
  tokenAmount: bigint,
): { totalX: bigint; totalY: bigint } {
  return solSide === 'X'
    ? { totalX: solAmount, totalY: tokenAmount }
    : { totalX: tokenAmount, totalY: solAmount };
}

/** Default copy ratio (%) = a 1:1 copy → classify two-sided on the FULL leader token leg (pre-#144 behavior). */
const FULL_COPY_RATIO_PCT = 100;

/**
 * Percentage ratio → integer basis points, bigint. Scale via BASIS POINTS, not `BigInt(pct)`: a fractional ratio
 * the UI accepts (12.5%, 0.5%) would make `BigInt(12.5)` throw a RangeError → EVERY two-sided open silently dropped
 * (mirror error, no feed row). Single source of truth so two-sided CLASSIFICATION (planTwoSided) and SIZING
 * (sizeTwoSided) can never diverge on how a leg is scaled by the ratio (ULTRACODE #38/#49; finding #144).
 */
function ratioToBps(pct: number): bigint {
  return BigInt(Math.round(pct * 100));
}

/**
 * Size a two-sided copy: scale BOTH legs by `pct`% of the leader (preserves the leader's SOL:token composition),
 * capping the COMBINED SOL deployment at `maxDeployLamports`. Pure, bigint-exact.
 *
 * The token leg is funded by a SEPARATE SOL command (an ExactIn buy), so capping ONLY the SOL leg let the combined
 * deployment (SOL leg + the SOL spent buying the token) run to ~2× the ceiling — or, when the token leg's SOL value
 * alone exceeded maxTradeSol, the coffre HARD-rejected the buy and the whole open was silently dropped (finding #94).
 * We value the token leg in SOL (`tokenLegValueLamports` — the detected event already prices BOTH legs in SOL) and
 * cap the TOTAL: the effective factor is `min(pct/100, maxDeployLamports / (leaderSolRaw + tokenLegValueLamports))`,
 * applied to BOTH legs so composition holds and `solLamports + expectedBuySpend ≤ maxDeployLamports`.
 *
 * NB: still scales each leg by the ratio of LEADER legs (composition) — NOT decideEntry's sizeSol directly; the
 * caller folds decideEntry's sizeSol into `maxDeployLamports` (min with maxTradeSol) so reduce-to-fit is honored.
 */
export function sizeTwoSided(
  leaderSolRaw: bigint,
  leaderTokenRaw: bigint,
  tokenLegValueLamports: bigint,
  pct: number,
  maxDeployLamports: bigint,
): { solLamports: bigint; tokenTarget: bigint } {
  const bps = ratioToBps(pct); // pct → integer bps (fractional-ratio safe; see ratioToBps · ULTRACODE #38/#49)
  let solLamports = (leaderSolRaw * bps) / 10_000n;
  let tokenTarget = (leaderTokenRaw * bps) / 10_000n;
  // Combined SOL deployment at the ratio = SOL leg + the token leg valued in SOL (both scaled by the same bps). When
  // it exceeds the cap, scale BOTH legs by the SAME factor (maxDeploy / combined) so the total is bounded and the
  // SOL:token composition is preserved. token value 0 ⇒ combined == solLamports ⇒ identical to a pure SOL-leg cap.
  const tokenLegValueScaled = (tokenLegValueLamports * bps) / 10_000n;
  const combined = solLamports + tokenLegValueScaled;
  if (maxDeployLamports > 0n && combined > maxDeployLamports) {
    solLamports = (solLamports * maxDeployLamports) / combined;
    tokenTarget = (tokenTarget * maxDeployLamports) / combined;
  }
  return { solLamports, tokenTarget };
}

/**
 * Plan a TWO-SIDED re-shape of an existing position (PURE). `removeLiquidity(bps)` pulls BOTH legs of a bin at
 * once, so a SOL-leg remove already trims the token in any bin that ALSO carries SOL (the active bin + the SOL
 * range). But a position's PURE-TOKEN bins (above the active bin, no SOL leg) are invisible to the SOL-leg plan —
 * on a leader shrink they would never be trimmed and the copy would drift token-heavy. So we ALSO compute the
 * token leg's REMOVE ops and merge in those on bins NOT already covered by a SOL-leg remove (avoiding a double
 * trim on mixed bins). Token ADD ops stay separate (an add can be per-leg → the deficit token to BUY + deposit).
 * Reuses the tested `planReshape` per leg (unit-agnostic: pass each leg's per-bin amount + a per-leg deadband).
 */
export function planTwoSidedReshape(
  leaderSol: BinSol[],
  ourSol: BinSol[],
  leaderToken: BinSol[],
  ourToken: BinSol[],
  ratio: number,
  maxSol: number,
  solDeadband: number,
  tokenDeadband: number,
): { ops: ReshapeOp[]; tokenAddOps: Extract<ReshapeOp, { action: 'add' }>[] } {
  // ONE shared cap factor for BOTH legs (mirrors sizeTwoSided's same-factor semantics): when the SOL cap
  // binds, the token leg must scale by the SAME factor — else the copy buys token toward an UNCAPPED
  // `ratio × leaderToken`, ratchets past maxTradeSizeSol, and re-detects a deficit on every event. The cap is
  // folded into `factor` here, so both planReshape calls take `factor` as ratio with maxSol = ∞.
  const leaderSolTotal = leaderSol.reduce((s, b) => s + b.sol, 0);
  const factor = leaderSolTotal > 0 ? Math.min(ratio, maxSol / leaderSolTotal) : ratio;
  const solOps = planReshape(leaderSol, ourSol, factor, Number.POSITIVE_INFINITY, solDeadband);
  const tokenOps = planReshape(
    leaderToken,
    ourToken,
    factor,
    Number.POSITIVE_INFINITY,
    tokenDeadband,
  );
  const tokenAddOps = tokenOps.filter(
    (o): o is Extract<ReshapeOp, { action: 'add' }> => o.action === 'add',
  );
  // Token REMOVE ops only on bins a SOL-leg remove doesn't already trim (pure-token bins) — else we'd double-trim.
  const solRemoveOffsets = new Set(
    solOps.filter((o) => o.action === 'remove').map((o) => o.offset),
  );
  const tokenRemoveOps = tokenOps.filter(
    (o) => o.action === 'remove' && !solRemoveOffsets.has(o.offset),
  );
  return { ops: [...solOps, ...tokenRemoveOps], tokenAddOps };
}

/**
 * The token ADD deficits of a reshape mapped into OUR position's FIXED bin range (PURE). A reshape's token adds can
 * fall OUTSIDE our [lower,upper] (the leader extended its range past ours — a v1 limit) or round to 0 raw units; both
 * are dropped. When NONE survive there is no token leg to grow, so the caller must NOT enter the two-sided-BUY branch
 * (which would price a 0-token leg, throw "priced at 0 SOL", and drop the SOL-leg adds with it) — it must fall through
 * to the one-sided SOL add path so the SOL leg STILL grows this cycle (ULTRACODE #48: else the copy stays undersized
 * until the next leader event, and if the leader closes first the copy was undersized its whole life). Keyed by
 * ABSOLUTE binId = lowerBinId + offset (the token leg shares the SOL leg's lower-bin alignment).
 */
export function inRangeTokenAdds(
  tokenAddOps: Array<{ offset: number; addSol: number }>,
  lowerBinId: number,
  upperBinId: number,
): Array<{ binId: number; raw: number }> {
  return tokenAddOps
    .map((o) => ({ binId: lowerBinId + o.offset, raw: Math.round(o.addSol) }))
    .filter((a) => a.binId >= lowerBinId && a.binId <= upperBinId && a.raw > 0);
}

/**
 * Decide whether the just-bought token leg has SETTLED enough to deposit (PURE). The token BUY confirms on the
 * coffre's connection; the brain reads the balance ~300ms later on ITS connection → a read-after-write lag can show
 * the balance still at (or near) its PRE-buy value. Depositing that stale/short amount = a forbidden one-sided half
 * copy (SPEC: both-or-nothing on a two-sided leg). `bought = actualBalance − preBuyBalance` isolates what THIS buy
 * added, so a pre-existing residual of the same mint is never co-deposited (ULTRACODE #33). The read is trusted only
 * once `bought` clears the quote-derived floor `minOut(expectedOut, slippage)` — the least the landed buy must have
 * delivered. Deposit `min(bought, expectedOut)` so a positive-slippage overfill isn't deposited past the leader's
 * composition (the remainder is swept). `ready:false` → the caller retries the read; retries exhausted → the caller
 * SKIPS the deposit (both-or-nothing), never depositing a short leg.
 */
export function resolveTwoSidedTokenDeposit(args: {
  actualBalance: bigint;
  preBuyBalance: bigint;
  expectedOut: bigint;
  slippageBps: number;
}): { ready: boolean; depositRaw: bigint } {
  const { actualBalance, preBuyBalance, expectedOut, slippageBps } = args;
  const floor = minOutWithSlippage(expectedOut, slippageBps);
  const bought = actualBalance - preBuyBalance;
  if (bought < floor) return { ready: false, depositRaw: 0n };
  const depositRaw = bought < expectedOut ? bought : expectedOut;
  return { ready: true, depositRaw };
}

/** Re-anchor ONE leg, or null when the leg carries no liquidity (avoids reanchorShape throwing on an empty leg). */
function reanchorLeg(
  legs: LeaderBinLegs[],
  pick: (b: LeaderBinLegs) => bigint,
  leaderActive: number,
  ourActive: number,
): ReanchoredShape | null {
  const perBin: LeaderBinAmount[] = legs.map((b) => ({ binId: b.binId, amount: pick(b) }));
  if (perBin.every((b) => b.amount <= 0n)) return null;
  return reanchorShape(leaderActive, ourActive, perBin);
}

/**
 * Plan a two-sided re-anchored copy. Pure. Handles all cases: plain SOL-only (token ≤ dust → twoSided=false),
 * genuine two-sided (both legs), and fully-crossed token-only (no SOL leg). Throws only on an empty position.
 */
export function planTwoSided(
  legs: LeaderBinLegs[],
  leaderActiveBinId: number,
  ourActiveBinId: number,
  dustTokenRaw: bigint,
  ratioPct: number = FULL_COPY_RATIO_PCT,
): TwoSidedPlan {
  const leaderSolRaw = legs.reduce((s, b) => s + b.solRaw, 0n);
  const leaderTokenRaw = legs.reduce((s, b) => s + b.tokenRaw, 0n);
  const solShape = reanchorLeg(legs, (b) => b.solRaw, leaderActiveBinId, ourActiveBinId);
  // Finding #144 — classify two-sided on OUR SCALED token target, NOT the leader's raw leg. The caller buys
  // `ratio × leaderTokenRaw` (sizeTwoSided): a small ratio scales a REAL leader leg down to dust, for which Jupiter
  // returns NO_ROUTES → the buy throws → the WHOLE open is dropped (a copy the SOL-only path would have made is
  // MISSED). Gating on the scaled target here yields twoSided=false, so the caller FALLS THROUGH to the one-sided
  // SOL path (position still copied, not missed). Mirrors sizeTwoSided's pre-clamp scale via the shared ratioToBps.
  const scaledTokenRaw = (leaderTokenRaw * ratioToBps(ratioPct)) / 10_000n;
  const twoSided = scaledTokenRaw > dustTokenRaw;

  const byBin = new Map<number, TwoSidedBin>();
  if (solShape)
    for (const w of solShape.weights)
      byBin.set(w.binId, { binId: w.binId, solBps: w.bps, tokenBps: 0 });

  if (twoSided) {
    const tokenShape = reanchorLeg(legs, (b) => b.tokenRaw, leaderActiveBinId, ourActiveBinId);
    if (tokenShape) {
      for (const w of tokenShape.weights) {
        const e = byBin.get(w.binId);
        if (e) e.tokenBps = w.bps;
        else byBin.set(w.binId, { binId: w.binId, solBps: 0, tokenBps: w.bps });
      }
    }
  }

  const weights = [...byBin.values()].sort((a, b) => a.binId - b.binId);
  if (weights.length === 0)
    throw new Error('planTwoSided: empty position (no SOL and no token liquidity)');
  const binIds = weights.map((w) => w.binId);
  return {
    twoSided,
    weights,
    leaderSolRaw,
    leaderTokenRaw,
    lowerBinId: Math.min(...binIds),
    upperBinId: Math.max(...binIds),
  };
}
