/**
 * Copy-bot · BRAIN — validated numeric env tunables (grace/cadence/batch), finding #58. Split into its OWN module,
 * PURE + SDK-free, so it is unit-testable in isolation: brain-main.ts transitively imports the DLMM SDK, which does
 * not load under vitest, so the parser could not be tested through brain-main.
 *
 * A bare Number() lets a typo (e.g. `SWEEP_MS=6O000`, letter-O) become NaN, which then SILENTLY breaks the process:
 * `setInterval(NaN)` (and any value <= 0) busy-loops ~every 1ms, and `now - openedAt < NaN` is always false so the
 * reconcile open-grace never applies (a fresh open gets false-closed). So each tunable that is not a finite number in
 * its sensible range falls back to its documented default and is RECORDED as a warning the boot caller logs LOUDLY.
 * Mirrors coffre parseCoffreNumericConfig, but fail-SAFE (a mistyped operational tunable must not kill the brain — a
 * dead brain misses a leader close, the #1 sin), not fail-closed.
 */

const MIN_TUNABLE_MS = 1; // a cadence/grace <= 0 (or NaN) busy-loops a setInterval / disables the open-grace check
const MIN_FEE_SWEEP_BATCH = 1; // publish at least one pending fee transfer per sweep tick
const DEFAULT_RECONCILE_OPEN_GRACE_MS = 30_000; // skip the 1st reconcile tick after an open (~1-2s unconfirmed) — anti false-close → no-dormant
const DEFAULT_SWEEP_MS = 60_000; // wallet token→SOL safety-sweep cadence (SYSTEM) — no-miss backstop behind the close-triggered sell
const DEFAULT_FEE_SWEEP_MS = 60_000; // performance-fee sweep cadence (Inc.4d): retry each pending fee transfer until it lands
const DEFAULT_FEE_SWEEP_BATCH = 25; // max pending fees published per sweep tick (bounds the per-tick publish burst)
const DEFAULT_FEE_BACKSTOP_GRACE_MS = 300_000; // 5 min — a CLOSED position is only re-assessed by the backstop after this (the exact close-sell assess wins first)

/** The brain's validated numeric env tunables (grace/cadence/batch). */
export interface BrainNumericConfig {
  reconcileOpenGraceMs: number;
  sweepMs: number;
  feeSweepMs: number;
  feeSweepBatch: number;
  feeBackstopGraceMs: number;
}

/** A tunable that failed validation and fell back to its documented default (the boot caller logs it loudly). */
export interface BrainNumericTunableWarning {
  name: string;
  raw: string;
  fallback: number;
}

/** PURE (finding #58) — parse + validate the brain's numeric env tunables, FAIL-SAFE (see the module header). */
export function parseBrainNumericConfig(env: {
  RECONCILE_OPEN_GRACE_MS?: string;
  SWEEP_MS?: string;
  FEE_SWEEP_MS?: string;
  FEE_SWEEP_BATCH?: string;
  FEE_BACKSTOP_GRACE_MS?: string;
}): { config: BrainNumericConfig; warnings: BrainNumericTunableWarning[] } {
  const warnings: BrainNumericTunableWarning[] = [];
  // A finite duration (ms) >= MIN_TUNABLE_MS; anything else (NaN / <= 0 / non-finite) → default + a warning.
  const durationMs = (name: string, raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < MIN_TUNABLE_MS) {
      warnings.push({ name, raw, fallback });
      return fallback;
    }
    return n;
  };
  // A positive INTEGER count (>= MIN_FEE_SWEEP_BATCH); a fractional / NaN / < 1 batch → default + a warning.
  const positiveIntCount = (name: string, raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < MIN_FEE_SWEEP_BATCH) {
      warnings.push({ name, raw, fallback });
      return fallback;
    }
    return n;
  };
  const config: BrainNumericConfig = {
    reconcileOpenGraceMs: durationMs(
      'RECONCILE_OPEN_GRACE_MS',
      env.RECONCILE_OPEN_GRACE_MS,
      DEFAULT_RECONCILE_OPEN_GRACE_MS,
    ),
    sweepMs: durationMs('SWEEP_MS', env.SWEEP_MS, DEFAULT_SWEEP_MS),
    feeSweepMs: durationMs('FEE_SWEEP_MS', env.FEE_SWEEP_MS, DEFAULT_FEE_SWEEP_MS),
    feeSweepBatch: positiveIntCount(
      'FEE_SWEEP_BATCH',
      env.FEE_SWEEP_BATCH,
      DEFAULT_FEE_SWEEP_BATCH,
    ),
    feeBackstopGraceMs: durationMs(
      'FEE_BACKSTOP_GRACE_MS',
      env.FEE_BACKSTOP_GRACE_MS,
      DEFAULT_FEE_BACKSTOP_GRACE_MS,
    ),
  };
  return { config, warnings };
}
