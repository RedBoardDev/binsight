import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { formatTokenQuantity } from '@app/applications/Shared/Figure/Domain/formatTokenQuantity';
import { describe, expect, it } from 'vitest';

// French and German put a no-break space (or a narrow one, depending on the CLDR version of the
// runtime) before a unit and between thousands.
const withPlainSpaces = (text: string): string => text.replace(/[\u00a0\u202f]/g, ' ');

const decimal = (value: string) => {
  const parsed = parseDecimalString(value);
  if (parsed === null) {
    throw new Error(`${value} is not a decimal string`);
  }
  return parsed;
};

describe('formatTokenQuantity', () => {
  it('shortens a quantity from a million', () => {
    expect(formatTokenQuantity(decimal('12400000'), 'en-US')).toBe('12.4M');
    expect(withPlainSpaces(formatTokenQuantity(decimal('12400000'), 'fr-FR'))).toBe('12,4 M');
  });

  it('keeps two decimals below a million and four significant digits below one', () => {
    expect(formatTokenQuantity(decimal('1234.5678'), 'en-US')).toBe('1,234.57');
    expect(formatTokenQuantity(decimal('0.00012345'), 'en-US')).toBe('0.0001235');
  });
});
