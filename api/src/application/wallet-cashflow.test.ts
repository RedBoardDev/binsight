import { describe, expect, it } from 'vitest';
import { buildCashflowCurveFromDaily } from './wallet-cashflow';

describe('buildCashflowCurveFromDaily', () => {
  it('runs a cumulative trading curve and fills the days with no activity', () => {
    const { days, totalTradingSol } = buildCashflowCurveFromDaily([
      { date: '2026-06-01', trading: -10, external: 0 },
      { date: '2026-06-03', trading: 5, external: 0 }, // dumped a rug for 5
    ]);
    expect(days.map((d) => d.date)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
    expect(days.map((d) => d.cumulativeSol)).toEqual([-10, -10, -5]);
    // No external flow → the reconstructed cash balance tracks the trading curve exactly.
    expect(days.map((d) => d.cumulativeTotalSol)).toEqual([-10, -10, -5]);
    expect(totalTradingSol).toBeCloseTo(-5, 9);
  });

  it('keeps external transfers out of the trading curve but in the cash balance', () => {
    const { days, totalTradingSol, totalExternalSol } = buildCashflowCurveFromDaily([
      { date: '2026-06-01', trading: 3, external: -20 }, // sent 20 to a CEX
    ]);
    expect(totalTradingSol).toBe(3);
    expect(totalExternalSol).toBe(-20);
    expect(days[0]!.cumulativeSol).toBe(3);
    expect(days[0]!.cumulativeTotalSol).toBe(-17);
  });

  it('ends the cumulative curve on the total trading flow', () => {
    const { days, totalTradingSol } = buildCashflowCurveFromDaily([
      { date: '2026-06-01', trading: 1.5, external: 0 },
      { date: '2026-06-02', trading: -0.4, external: 0 },
      { date: '2026-06-04', trading: 2.1, external: 0 },
    ]);
    expect(days[days.length - 1]!.cumulativeSol).toBeCloseTo(totalTradingSol, 9);
    expect(totalTradingSol).toBeCloseTo(3.2, 9);
  });
});
