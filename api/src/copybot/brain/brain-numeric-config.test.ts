import { describe, expect, it } from 'vitest';
import { parseBrainNumericConfig } from './brain-numeric-config';

describe('parseBrainNumericConfig — validated numeric env tunables (finding #58)', () => {
  it('unset env → every documented default, no warnings', () => {
    const { config, warnings } = parseBrainNumericConfig({});
    expect(config).toEqual({
      reconcileOpenGraceMs: 90_000, // A6-01: raised 30s→90s to cover the worst-case open-landing window
      sweepMs: 60_000,
      copierBalanceSol: 10,
    });
    expect(warnings).toEqual([]);
  });

  it('valid overrides are taken as-is (no warnings)', () => {
    const { config, warnings } = parseBrainNumericConfig({
      RECONCILE_OPEN_GRACE_MS: '45000',
      SWEEP_MS: '90000',
      COPIER_BALANCE_SOL: '25',
    });
    expect(config).toEqual({
      reconcileOpenGraceMs: 45_000,
      sweepMs: 90_000,
      copierBalanceSol: 25,
    });
    expect(warnings).toEqual([]);
  });

  it('a typo that yields NaN falls back to the default AND is recorded as a warning (never a silent NaN)', () => {
    // WHY (#58): the exact bug — a NaN SWEEP_MS makes setInterval(NaN) busy-loop ~every 1ms, and a NaN grace makes
    // `now - openedAt < NaN` always false (grace disabled). The fallback + loud warning is what averts that silently.
    const { config, warnings } = parseBrainNumericConfig({ SWEEP_MS: '6O000' }); // letter-O, not a zero → NaN
    expect(config.sweepMs).toBe(60_000); // the documented default, NOT NaN
    expect(warnings).toEqual([{ name: 'SWEEP_MS', raw: '6O000', fallback: 60_000 }]);
  });

  it('a non-positive duration (<= 0) falls back too — a 0/negative setInterval busy-loops just like NaN', () => {
    const zero = parseBrainNumericConfig({ RECONCILE_OPEN_GRACE_MS: '0' });
    expect(zero.config.reconcileOpenGraceMs).toBe(90_000); // A6-01: default raised to 90s
    expect(zero.warnings[0]?.name).toBe('RECONCILE_OPEN_GRACE_MS');
    const negative = parseBrainNumericConfig({ SWEEP_MS: '-5' });
    expect(negative.config.sweepMs).toBe(60_000);
    expect(negative.warnings[0]?.name).toBe('SWEEP_MS');
  });

  it('COPIER_BALANCE_SOL is validated as a positive finite amount: NaN / <= 0 fall back, a fractional balance is kept', () => {
    // WHY (#2): COPIER_BALANCE_SOL escaped #58's original pass — a bare Number() let a typo become NaN that silently
    // corrupts the SYSTEM/bench sizing. Unlike a duration it MAY be fractional (e.g. 0.5 SOL), so it gets its own
    // strictly-positive-finite check rather than reusing durationMs (which would wrongly reject 0.5).
    const nan = parseBrainNumericConfig({ COPIER_BALANCE_SOL: '1O' }); // letter-O, not a zero → NaN
    expect(nan.config.copierBalanceSol).toBe(10); // the documented default, NOT NaN
    expect(nan.warnings).toEqual([{ name: 'COPIER_BALANCE_SOL', raw: '1O', fallback: 10 }]);
    const zero = parseBrainNumericConfig({ COPIER_BALANCE_SOL: '0' });
    expect(zero.config.copierBalanceSol).toBe(10); // a 0 balance sizes every position to nothing → fall back
    expect(zero.warnings[0]?.name).toBe('COPIER_BALANCE_SOL');
    const negative = parseBrainNumericConfig({ COPIER_BALANCE_SOL: '-5' });
    expect(negative.config.copierBalanceSol).toBe(10);
    expect(negative.warnings[0]?.name).toBe('COPIER_BALANCE_SOL');
    const fractional = parseBrainNumericConfig({ COPIER_BALANCE_SOL: '0.5' });
    expect(fractional.config.copierBalanceSol).toBe(0.5); // fractional SOL is VALID (not rejected like a duration)
    expect(fractional.warnings).toEqual([]);
  });

  it('only the mistyped tunable falls back — the valid ones are untouched (per-tunable isolation)', () => {
    const { config, warnings } = parseBrainNumericConfig({
      SWEEP_MS: 'oops',
      COPIER_BALANCE_SOL: '5',
    });
    expect(config.sweepMs).toBe(60_000); // fell back
    expect(config.copierBalanceSol).toBe(5); // valid → kept
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.name).toBe('SWEEP_MS');
  });
});
