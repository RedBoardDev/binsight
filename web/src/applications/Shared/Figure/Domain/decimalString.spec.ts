import {
  integerDigitCount,
  isDecimalString,
  isFractionOfOne,
  parseDecimalString,
  requireDecimalString,
} from '@app/applications/Shared/Figure/Domain/decimalString';
import { describe, expect, it } from 'vitest';

const decimal = (value: string) => {
  const parsed = parseDecimalString(value);
  if (parsed === null) {
    throw new Error(`${value} is not a decimal string`);
  }
  return parsed;
};

describe('parseDecimalString', () => {
  it('accepts canonical decimals of any length', () => {
    for (const value of ['0', '-0.949', '61.541203117', '123456789012345678901234567890.5']) {
      expect(isDecimalString(value)).toBe(true);
    }
  });

  it('refuses what the API never sends', () => {
    for (const value of ['', '+1', '-0', '1.50', '01', '1e3', '.5', '1.', 'NaN', ' 1']) {
      expect(parseDecimalString(value)).toBeNull();
    }
  });
});

describe('generated decimal strings at the formatting boundary', () => {
  it('keeps long exact amounts and refuses coercible malformed strings', () => {
    const amount = '123456789012345678901234567890.5';
    expect(requireDecimalString(amount)).toBe(amount);
    for (const value of ['1e3', '-0', '01', 'NaN', 42, null, true]) {
      expect(() => requireDecimalString(value)).toThrow(RangeError);
    }
  });
});

describe('reading the magnitude from the string', () => {
  it('counts the digits of the integer part', () => {
    expect(integerDigitCount(decimal('1234.5'))).toBe(4);
    expect(integerDigitCount(decimal('-999.99'))).toBe(3);
    expect(integerDigitCount(decimal('0.004'))).toBe(1);
  });

  it('tells a fraction of one, which zero is not', () => {
    expect(isFractionOfOne(decimal('0.5'))).toBe(true);
    expect(isFractionOfOne(decimal('-0.004'))).toBe(true);
    expect(isFractionOfOne(decimal('1'))).toBe(false);
    expect(isFractionOfOne(decimal('0'))).toBe(false);
  });
});
