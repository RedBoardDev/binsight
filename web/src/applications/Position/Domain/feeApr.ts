const YEAR_SECONDS = 31_536_000;

/** Annualised fee yield (%) = fees/base scaled to a year. Null when not computable (no base or no
 *  elapsed time) — callers must render the null as "—" rather than substituting a zero. */
export function feeApr(fees: number, base: number, seconds: number): number | null {
  if (base <= 0 || seconds <= 0) return null;
  return (fees / base) * (YEAR_SECONDS / seconds) * 100;
}

export function fmtFeeApr(apr: number | null): string {
  if (apr == null) return '—';
  return `${apr.toLocaleString('en-US', { maximumFractionDigits: apr >= 100 ? 0 : 1 })}%`;
}
