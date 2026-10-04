import {
  otherCurrency,
  parseDisplayPreferences,
  serializeAmountsHidden,
} from '@app/applications/Shared/Preference/Domain/displayPreference';
import { describe, expect, it } from 'vitest';

describe('parseDisplayPreferences', () => {
  it('shows SOL with visible amounts by default', () => {
    expect(parseDisplayPreferences({ currency: null, areAmountsHidden: null })).toEqual({
      currency: 'sol',
      areAmountsHidden: false,
    });
  });

  it('reads what was stored, and only that', () => {
    expect(parseDisplayPreferences({ currency: 'usd', areAmountsHidden: 'true' })).toEqual({
      currency: 'usd',
      areAmountsHidden: true,
    });
    expect(parseDisplayPreferences({ currency: 'eur', areAmountsHidden: 'yes' })).toEqual({
      currency: 'sol',
      areAmountsHidden: false,
    });
  });

  it('stores the hidden state as it reads it back', () => {
    for (const areAmountsHidden of [true, false]) {
      const stored = serializeAmountsHidden(areAmountsHidden);
      expect(parseDisplayPreferences({ currency: 'sol', areAmountsHidden: stored })).toEqual({
        currency: 'sol',
        areAmountsHidden,
      });
    }
  });
});

describe('otherCurrency', () => {
  it('switches between SOL and dollars', () => {
    expect(otherCurrency('sol')).toBe('usd');
    expect(otherCurrency('usd')).toBe('sol');
  });
});
