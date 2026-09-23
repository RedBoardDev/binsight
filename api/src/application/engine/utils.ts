/**
 * Whether the realized-PnL pass is due again after a close.
 *
 * A freshly closed position's residual is typically market-sold within seconds, so the pass fired at
 * close detection can run BEFORE that sale exists and mark the residual as still held. The pass is
 * therefore re-run on a small front-loaded schedule of offsets after the close (e.g. 25 s, 60 s,
 * 150 s): bounded (≤ offsets.length extra passes per close), then it stops.
 *
 * `lastRealizedRunAt` is set to the close time when the close is detected, so the close-time pass
 * counts as offset 0.
 */
export function shouldRefreshRealized(args: {
  now: number;
  lastCloseAt: number;
  lastRealizedRunAt: number;
  offsetsMs: number[];
}): boolean {
  const { now, lastCloseAt, lastRealizedRunAt, offsetsMs } = args;
  if (lastCloseAt <= 0) return false; // no close seen → nothing to converge
  const ageNow = now - lastCloseAt;
  const ageLastRun = lastRealizedRunAt - lastCloseAt;
  // Fire iff a checkpoint falls in (ageLastRun, ageNow] — one we're due for but haven't run.
  return offsetsMs.some((o) => o > ageLastRun && o <= ageNow);
}
