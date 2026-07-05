import { describe, expect, it } from 'vitest';
import { parseBrainNumericConfig } from './brain-numeric-config';

describe('parseBrainNumericConfig — validated numeric env tunables (finding #58)', () => {
  it('unset env → every documented default, no warnings', () => {
    const { config, warnings } = parseBrainNumericConfig({});
    expect(config).toEqual({
      reconcileOpenGraceMs: 30_000,
      sweepMs: 60_000,
      feeSweepMs: 60_000,
      feeSweepBatch: 25,
      feeBackstopGraceMs: 300_000,
    });
    expect(warnings).toEqual([]);
  });

  it('valid overrides are taken as-is (no warnings)', () => {
    const { config, warnings } = parseBrainNumericConfig({
      RECONCILE_OPEN_GRACE_MS: '45000',
      SWEEP_MS: '90000',
      FEE_SWEEP_MS: '120000',
      FEE_SWEEP_BATCH: '10',
      FEE_BACKSTOP_GRACE_MS: '600000',
    });
    expect(config).toEqual({
      reconcileOpenGraceMs: 45_000,
      sweepMs: 90_000,
      feeSweepMs: 120_000,
      feeSweepBatch: 10,
      feeBackstopGraceMs: 600_000,
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
    expect(zero.config.reconcileOpenGraceMs).toBe(30_000);
    expect(zero.warnings[0]?.name).toBe('RECONCILE_OPEN_GRACE_MS');
    const negative = parseBrainNumericConfig({ FEE_SWEEP_MS: '-5' });
    expect(negative.config.feeSweepMs).toBe(60_000);
    expect(negative.warnings[0]?.name).toBe('FEE_SWEEP_MS');
  });

  it('FEE_SWEEP_BATCH must be a positive integer: a fractional or < 1 value falls back', () => {
    const fractional = parseBrainNumericConfig({ FEE_SWEEP_BATCH: '2.5' });
    expect(fractional.config.feeSweepBatch).toBe(25);
    expect(fractional.warnings[0]).toEqual({ name: 'FEE_SWEEP_BATCH', raw: '2.5', fallback: 25 });
    const zero = parseBrainNumericConfig({ FEE_SWEEP_BATCH: '0' });
    expect(zero.config.feeSweepBatch).toBe(25);
    expect(zero.warnings[0]?.name).toBe('FEE_SWEEP_BATCH');
  });

  it('only the mistyped tunable falls back — the valid ones are untouched (per-tunable isolation)', () => {
    const { config, warnings } = parseBrainNumericConfig({
      SWEEP_MS: 'oops',
      FEE_SWEEP_BATCH: '5',
    });
    expect(config.sweepMs).toBe(60_000); // fell back
    expect(config.feeSweepBatch).toBe(5); // valid → kept
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.name).toBe('SWEEP_MS');
  });
});
