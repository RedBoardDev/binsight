/**
 * Copy-bot · BRAIN — validated numeric env tunables (grace/cadence/balance), finding #58. Split into its OWN module,
 * PURE + SDK-free, so it is unit-testable in isolation: brain-main.ts transitively imports the DLMM SDK, which does
 * not load under vitest, so the parser could not be tested through brain-main.
 *
 * A bare Number() lets a typo (e.g. `SWEEP_MS=6O000`, letter-O) become NaN, which then SILENTLY breaks the process:
 * `setInterval(NaN)` (and any value <= 0) busy-loops ~every 1ms, and `now - openedAt < NaN` is always false so the
 * reconcile open-grace never applies (a fresh open gets false-closed). So each tunable that is not a finite number in
 * its sensible range falls back to its documented default and is RECORDED as a warning the boot caller logs LOUDLY.
 * COPIER_BALANCE_SOL (the SYSTEM/bench sizing balance) is validated here too — it escaped #58's original pass, and a
 * NaN there silently corrupts the SYSTEM/bench sizing — with the SAME fail-safe fallback + loud warning (a positive
 * amount that, unlike the ms/count tunables, MAY be fractional, e.g. 0.5 SOL).
 * Mirrors coffre parseCoffreNumericConfig, but fail-SAFE (a mistyped operational tunable must not kill the brain — a
 * dead brain misses a leader close, the #1 sin), not fail-closed.
 */

const MIN_TUNABLE_MS = 1; // a cadence/grace <= 0 (or NaN) busy-loops a setInterval / disables the open-grace check
const DEFAULT_RECONCILE_OPEN_GRACE_MS = 90_000; // A6-01: time-based open-grace backstop, raised 30s→90s to cover the worst-case open-landing window (~60-75s, = OPEN_PENDING_TTL_MS); the event-driven isOpenInFlight grace (reconcile) is the primary guard — anti false-close → no-dormant
const DEFAULT_SWEEP_MS = 60_000; // wallet token→SOL safety-sweep cadence (SYSTEM) — no-miss backstop behind the close-triggered sell
const DEFAULT_COPIER_BALANCE_SOL = 10; // SYSTEM/bench copy-wallet balance (SOL) used for sizing when COPIER_BALANCE_SOL is unset

/** The brain's validated numeric env tunables (grace/cadence). */
export interface BrainNumericConfig {
  reconcileOpenGraceMs: number;
  sweepMs: number;
  copierBalanceSol: number;
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
  COPIER_BALANCE_SOL?: string;
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
  // A finite amount strictly > 0 (SOL — MAY be fractional, e.g. 0.5, so it is NOT a durationMs/count); NaN / <= 0 /
  // non-finite → default + a warning. A 0 or NaN balance would size every position to nothing (silent sizing corruption).
  const positiveFinite = (name: string, raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
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
    copierBalanceSol: positiveFinite(
      'COPIER_BALANCE_SOL',
      env.COPIER_BALANCE_SOL,
      DEFAULT_COPIER_BALANCE_SOL,
    ),
  };
  return { config, warnings };
}
