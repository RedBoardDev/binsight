import type { DlmmLeg } from '@binsight/solana-core';
import { SOL_MINT, USDC_MINT, USDT_MINT } from '@binsight/solana-core';
import { describe, expect, it } from 'vitest';
import type { PoolMeta } from './dlmm';
import {
  binPriceRaw,
  legValueSol,
  openUnrealizedPnlSol,
  positionEconomics,
  positionEconomicsQuote,
  quoteConventionOf,
  solSideOf,
} from './dlmm-pnl';

const SOL = SOL_MINT;
const leg = (
  kind: DlmmLeg['kind'],
  activeBinId: number | null,
  amountX: bigint,
  amountY: bigint,
): DlmmLeg => ({
  kind,
  activeBinId,
  amountX,
  amountY,
  signature: '',
  blockTime: 0,
  position: '',
  lbPair: '',
});

describe('binPriceRaw', () => {
  it('is 1.0 at bin 0 (price reference) and geometric in binId', () => {
    expect(binPriceRaw(0, 100)).toBe(1);
    expect(binPriceRaw(1, 100)).toBeCloseTo(1.01, 10); // +binStep/10000
    expect(binPriceRaw(-1, 100)).toBeCloseTo(1 / 1.01, 10);
  });
});

describe('solSideOf', () => {
  it('detects which side is SOL, or null for a non-SOL-quote pool', () => {
    expect(solSideOf('Memecoin111', SOL)).toBe('Y');
    expect(solSideOf(SOL, 'Memecoin111')).toBe('X');
    expect(solSideOf('Usdc111', 'Memecoin111')).toBeNull();
  });
});

describe('positionPnlSol — validated against Meteora on real on-chain data', () => {
  // GYMtBiHX4MCa (SOTER-like / SOL pool, binStep 100): the exact raw amounts + active bins decoded
  // from chain. Meteora's own pnl for this position is 0.2415 SOL — the bin-price reconstruction must
  // reproduce it to the cent. This is the test that proves the decoupled valuation is correct.
  const meta: PoolMeta = { binStep: 100, solSide: 'Y' };
  const legs: DlmmLeg[] = [
    leg('deposit', -437, 205945537665n, 3376692725n),
    leg('withdraw', -429, 156784710127n, 4039260423n),
    leg('claim', -429, 0n, 46620648n),
  ];

  it('reproduces Meteora pnl 0.2415 to the cent', () => {
    expect(positionEconomics(legs, meta).pnlSol).toBeCloseTo(0.2415, 3);
  });

  it('values the deposit leg = Meteora deposit_sol 6.0393', () => {
    expect(legValueSol(legs[0]!, meta)!).toBeCloseTo(6.0393, 3);
  });

  it('values the withdraw leg = Meteora withdraw_sol 6.2343', () => {
    expect(legValueSol(legs[1]!, meta)).toBeCloseTo(6.2343, 3);
  });

  it('splits economics into deposit / withdraw / claimed-fees that reconcile to the validated pnl', () => {
    const e = positionEconomics(legs, meta);
    expect(e.depositSol).toBeCloseTo(6.0393, 3);
    expect(e.withdrawSol).toBeCloseTo(6.2343, 3);
    expect(e.claimedFeesSol).toBeCloseTo(0.0466, 3); // claimed fees are split OUT of withdrawals
    // the split must reconcile to the on-chain-validated total — fees never double-counted into withdraw
    expect(e.withdrawSol + e.claimedFeesSol - e.depositSol).toBeCloseTo(e.pnlSol, 9);
    expect(e.pnlSol).toBeCloseTo(0.2415, 3);
  });
});

describe('positionPnlSol — orientation + direction', () => {
  it('sums withdrawals + claims minus deposits', () => {
    const meta: PoolMeta = { binStep: 100, solSide: 'Y' };
    // deposit 1 SOL (all Y), withdraw 1.5 SOL (all Y), claim 0.1 SOL → +0.6
    const legs = [
      leg('deposit', 0, 0n, 1_000_000_000n),
      leg('withdraw', 0, 0n, 1_500_000_000n),
      leg('claim', 0, 0n, 100_000_000n),
    ];
    expect(positionEconomics(legs, meta).pnlSol).toBeCloseTo(0.6, 9);
  });

  it('values the non-SOL leg via price for a SOL-as-X pool (inverted)', () => {
    const meta: PoolMeta = { binStep: 100, solSide: 'X' };
    // bin 0 → price 1; X=SOL leg counts directly, Y leg divided by price.
    const v = legValueSol(leg('deposit', 0, 2_000_000_000n, 5_000_000_000n), meta);
    expect(v).not.toBeNull();
    expect(v!).toBeCloseTo(7, 9); // (2e9 + 5e9/1) / 1e9
  });
});

describe('positionEconomicsQuote — missing ClaimFee price anchor', () => {
  it('keeps an exact quote-only claim complete even without a bin', () => {
    const econ = positionEconomicsQuote([leg('claim', null, 0n, 112_397_677n)], {
      binStep: 100,
      quoteSide: 'Y',
      quoteDecimals: 9,
    });
    expect(econ.claimedFeesQuote).toBeCloseTo(0.112397677, 12);
    expect(econ.valuationStatus).toBe('complete');
    expect(econ.unpricedLegs).toBe(0);
  });

  it('retains a mixed claim as partial instead of inventing a bin price', () => {
    const econ = positionEconomicsQuote([leg('claim', null, 896_784_000n, 112_397_677n)], {
      binStep: 100,
      quoteSide: 'Y',
      quoteDecimals: 9,
    });
    // The wSOL component is an exact on-chain quantity; only the base-token conversion is unknown.
    expect(econ.claimedFeesQuote).toBeCloseTo(0.112397677, 12);
    expect(econ.valuationStatus).toBe('partial');
    expect(econ.unpricedLegs).toBe(1);
  });
});

describe('positionEconomicsQuote — audited HX USDC fixtures', () => {
  it('reproduces the USDC-as-X orientation fixture exactly', () => {
    const legs = [
      leg('deposit', -2, 27_873_767n, 0n),
      leg('withdraw', -2, 27_873_798n, 0n),
      leg('claim', -2, 25_228n, 25_343n),
    ];
    const econ = positionEconomicsQuote(legs, {
      binStep: 1,
      quoteSide: 'X',
      quoteDecimals: 6,
    });
    expect(econ.depositQuote).toBeCloseTo(27.873767, 12);
    expect(econ.withdrawQuote).toBeCloseTo(27.873798, 12);
    expect(econ.claimedFeesQuote).toBeCloseTo(0.05057606885343, 12);
    expect(econ.pnlQuote).toBeCloseTo(0.0506070688534308, 12);
  });

  it('counts the audited CATE/USDC claim once', () => {
    const legs = [
      leg('deposit', -1523, 0n, 910_844_060n),
      leg('withdraw', -1523, 7_755_294n, 910_474_204n),
      leg('claim', -1523, 39_434_180n, 1_852_714n),
    ];
    const econ = positionEconomicsQuote(legs, {
      binStep: 20,
      quoteSide: 'Y',
      quoteDecimals: 6,
    });
    expect(econ.depositQuote).toBeCloseTo(910.84406, 9);
    expect(econ.withdrawQuote).toBeCloseTo(910.8440818924138, 9);
    expect(econ.claimedFeesQuote).toBeCloseTo(3.7334720199363214, 9);
    expect(econ.pnlQuote).toBeCloseTo(3.733493912350127, 9);
  });

  it('reproduces all twenty audited MET/USDC legs instead of using only the last pair', () => {
    const deposits = [
      [184_445_461n, -240],
      [212_133_125n, -240],
      [243_977_072n, -240],
      [280_601_194n, -240],
      [322_723_086n, -240],
      [14_341_516n, -245],
      [16_494_369n, -245],
      [18_970_400n, -245],
      [21_818_102n, -245],
      [25_093_289n, -245],
    ] as const;
    const withdrawals = [198_786_977n, 228_627_494n, 262_947_472n, 302_419_296n, 347_816_375n];
    const legs = [
      ...deposits.map(([amountX, activeBinId]) => leg('deposit', activeBinId, amountX, 0n)),
      ...withdrawals.flatMap((amountX) => [
        leg('withdraw', -254, amountX, 0n),
        leg('claim', -254, 0n, 0n),
      ]),
    ];
    const econ = positionEconomicsQuote(legs, {
      binStep: 20,
      quoteSide: 'Y',
      quoteDecimals: 6,
    });
    expect(legs).toHaveLength(20);
    expect(econ.depositQuote).toBeCloseTo(829.3420988217779, 9);
    expect(econ.withdrawQuote).toBeCloseTo(807.0439258287761, 9);
    expect(econ.claimedFeesQuote).toBe(0);
    expect(econ.pnlQuote).toBeCloseTo(-22.298172993001714, 9);
  });

  it('selects SOL first, then USDC, then USDT without changing the pool orientation', () => {
    expect(quoteConventionOf('BASE', SOL_MINT)).toMatchObject({
      quoteMint: SOL_MINT,
      quoteSide: 'Y',
      quoteDecimals: 9,
    });
    expect(quoteConventionOf(USDC_MINT, USDT_MINT)).toMatchObject({
      quoteMint: USDC_MINT,
      baseMint: USDT_MINT,
      quoteSide: 'X',
      quoteDecimals: 6,
    });
    expect(quoteConventionOf('BASE', USDT_MINT)).toMatchObject({
      quoteMint: USDT_MINT,
      quoteSide: 'Y',
    });
    expect(quoteConventionOf('BASE', 'OTHER')).toBeNull();
  });
});

describe('openUnrealizedPnlSol — open = snapshot ⊕ legs', () => {
  it('equals realized PnL when nothing is left in the position (live = 0)', () => {
    // a fully-withdrawn position must reconcile to its realized economics, not double-count
    const econ = { depositSol: 6.0393, withdrawSol: 6.2343, claimedFeesSol: 0.0466 };
    expect(openUnrealizedPnlSol(econ, { sizeSol: 0, unclaimedFeesSol: 0 })).toBeCloseTo(0.2416, 4);
  });

  it('adds live liquidity + unclaimed fees on top of the cost basis', () => {
    // deposited 6, nothing withdrawn/claimed yet, 6.5 still in pool + 0.1 unclaimed → +0.6
    const econ = { depositSol: 6, withdrawSol: 0, claimedFeesSol: 0 };
    expect(openUnrealizedPnlSol(econ, { sizeSol: 6.5, unclaimedFeesSol: 0.1 })).toBeCloseTo(0.6, 9);
  });

  it('combines partial withdrawals, claims, live size and unclaimed fees', () => {
    // 4 + 0.2 + 7 + 0.3 − 10 = 1.5
    const econ = { depositSol: 10, withdrawSol: 4, claimedFeesSol: 0.2 };
    expect(openUnrealizedPnlSol(econ, { sizeSol: 7, unclaimedFeesSol: 0.3 })).toBeCloseTo(1.5, 9);
  });
});
