import { plotValue } from '@app/applications/Shared/Chart/Domain/plotValue';
import { describe, expect, it } from 'vitest';

describe('plotValue', () => {
  it('approximates canonical decimals only for drawing', () => {
    expect(plotValue('0')).toBe(0);
    expect(plotValue('-12.345')).toBe(-12.345);
    expect(plotValue('123456789012345678901234567890')).toBe(1.2345678901234568e29);
  });

  it.each(['', 'NaN', 'Infinity', ' 1', '+1', '-0', '01', '1.0', '1e3', '.5'])(
    'refuses the noncanonical value %s',
    (value) => {
      expect(plotValue(value)).toBeNull();
    },
  );

  it('refuses an overflow or a nonzero value that underflows to zero', () => {
    expect(plotValue(`1${'0'.repeat(400)}`)).toBeNull();
    expect(plotValue(`0.${'0'.repeat(400)}1`)).toBeNull();
  });
});
