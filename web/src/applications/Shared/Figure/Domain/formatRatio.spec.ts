import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { formatRatio } from '@app/applications/Shared/Figure/Domain/formatRatio';
import { describe, expect, it } from 'vitest';

const decimal = (value: string) => {
  const parsed = parseDecimalString(value);
  if (parsed === null) {
    throw new Error(`${value} is not a decimal string`);
  }
  return parsed;
};

describe('formatRatio', () => {
  it('writes a multiple with two decimals', () => {
    expect(formatRatio(decimal('1.834'), 'en-US')).toBe('1.83');
    expect(formatRatio(decimal('2'), 'de-DE')).toBe('2,00');
  });
});
