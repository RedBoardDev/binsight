import type { NetworthCurvePoint } from '@binsight/shared';
import { PERIOD_OPTIONS, type Period, sinceMs } from './period';

/** Short label for the selected period (e.g. "1M") — used in the "Gain (1M)" caption. */
export function periodLabel(period: Period): string {
  return PERIOD_OPTIONS.find((o) => o.value === period)?.label ?? period.toUpperCase();
}

const dayStartMs = (point: NetworthCurvePoint): number => Date.parse(`${point.date}T00:00:00Z`);

/**
 * Real PnL gain over `period` = realPnl(now) − realPnl(start of period), where realPnl = performance
 * NET of apports (deposits/withdrawals). CAN be negative. Null when the curve is empty or the live net
 * worth is unknown. The single source of truth for this headline — SummaryCard and PnlBridge both call
 * it, so the two displayed numbers can never drift.
 *
 * Each curve point is the END-of-day value of its UTC `date`, so the baseline is the last point whose
 * day starts strictly BEFORE the floor (the first one on/after it would already include that day, and
 * 24H would read ≈ 0). All-time has nothing before the wallet's first day, when realPnl was 0; a curve
 * that starts inside the window (a younger wallet, a window cut at its own floor) falls back to its
 * earliest point — the closest baseline there is.
 *
 * realPnlNow uses the LIVE net worth (walletTotalSol) minus the cumulative apports of the LAST curve
 * point — NOT points[last].realPnl: today's at-cost reconstruction lags the live tx stream (a fresh
 * deposit hits the cash ledger before its position shows up in the legs).
 */
export function realPnlGain(
  points: NetworthCurvePoint[],
  period: Period,
  now: number,
  walletTotalSol: number | null,
): number | null {
  const first = points[0];
  if (first === undefined || walletTotalSol == null) return null;
  const apportsLast = points.at(-1)?.apports ?? 0;
  const realPnlNow = walletTotalSol - apportsLast;
  const floor = sinceMs(period, now);
  if (floor <= 0) return realPnlNow;
  let start = first;
  for (const point of points) {
    if (dayStartMs(point) >= floor) break;
    start = point;
  }
  return realPnlNow - start.realPnl;
}
