import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from './defaults';
import type { CopybotConfig, LeaderSettings } from './types';
import { InvalidConfigWriteError, MAX_STARTED_LEADERS, validateConfigWrite } from './validate';

const leader = (i: number, enabled: boolean): LeaderSettings => ({
  address: `Leader${i}1111111111111111111111111111111111111`,
  enabled,
  maxTotalExposureSol: null,
  overrides: {},
});

const cfgWith = (leaders: LeaderSettings[]): CopybotConfig => ({
  user: CONFIG_DEFAULTS.user,
  leaders,
});

describe('validateConfigWrite · started-leaders cap (SPEC §4.3)', () => {
  it(`accepts up to ${MAX_STARTED_LEADERS} STARTED leaders`, () => {
    const leaders = Array.from({ length: MAX_STARTED_LEADERS }, (_, i) => leader(i, true));
    expect(validateConfigWrite(cfgWith(leaders))).toEqual([]);
  });

  it(`rejects ${MAX_STARTED_LEADERS + 1} started leaders with a TYPED error`, () => {
    // WHY: the Valhalla-aligned product cap is on SIMULTANEOUSLY STARTED leaders — a config write is the only
    // gate (there is no runtime clamp), so letting a 5th enabled leader through would silently over-run the bot.
    const leaders = Array.from({ length: MAX_STARTED_LEADERS + 1 }, (_, i) => leader(i, true));
    expect(validateConfigWrite(cfgWith(leaders))).toEqual([
      {
        code: 'too_many_started_leaders',
        startedCount: MAX_STARTED_LEADERS + 1,
        max: MAX_STARTED_LEADERS,
      },
    ]);
  });

  it('configured-but-STOPPED leaders are unlimited (they never count toward the cap)', () => {
    const stopped = Array.from({ length: 25 }, (_, i) => leader(i, false));
    expect(validateConfigWrite(cfgWith(stopped))).toEqual([]);
    // Mixed: many stopped + exactly MAX started stays accepted.
    const started = Array.from({ length: MAX_STARTED_LEADERS }, (_, i) => leader(100 + i, true));
    expect(validateConfigWrite(cfgWith([...stopped, ...started]))).toEqual([]);
  });

  it('CONFIG_DEFAULTS passes (the seed must always be writable)', () => {
    expect(validateConfigWrite(CONFIG_DEFAULTS)).toEqual([]);
  });
});

describe('InvalidConfigWriteError', () => {
  it('carries the typed errors and a code-bearing message', () => {
    const errors = validateConfigWrite(
      cfgWith(Array.from({ length: MAX_STARTED_LEADERS + 2 }, (_, i) => leader(i, true))),
    );
    const err = new InvalidConfigWriteError(errors);
    expect(err.errors).toEqual(errors);
    expect(err.message).toContain('too_many_started_leaders');
  });
});
