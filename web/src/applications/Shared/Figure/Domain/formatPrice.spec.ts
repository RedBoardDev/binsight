import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import type { PriceQuote } from '@app/applications/Shared/Figure/Domain/figure';
import {
  type FormattedPrice,
  formatPrice,
  priceWithSubscriptZeros,
} from '@app/applications/Shared/Figure/Domain/formatPrice';
import { describe, expect, it } from 'vitest';

const priced = (
  amount: string,
  languageTag = 'en-US',
  quote: PriceQuote = 'sol',
): FormattedPrice => {
  const parsed = parseDecimalString(amount);
  if (parsed === null) {
    throw new Error(`${amount} is not a decimal string`);
  }
  return formatPrice({ amount: parsed, quote }, languageTag);
};

describe('formatPrice', () => {
  it('keeps four significant digits', () => {
    expect(priced('148.2149')).toEqual({ kind: 'plain', text: '148.2' });
    expect(priced('0.312')).toEqual({ kind: 'plain', text: '0.3120' });
    expect(priced('0.0045214')).toEqual({ kind: 'plain', text: '0.004521' });
  });

  it('counts the zeros of a tiny price instead of writing them', () => {
    expect(priced('0.0000221')).toEqual({
      kind: 'zeros-counted',
      text: '0.00002210',
      lead: '0.0',
      zeroCount: 4,
      digits: '2210',
    });
  });

  it('counts the zeros after rounding, in the language of the reader', () => {
    expect(priced('0.000099996', 'fr-FR')).toEqual({
      kind: 'zeros-counted',
      text: '0,0001000',
      lead: '0,0',
      zeroCount: 3,
      digits: '1000',
    });
  });
});

describe('priceWithSubscriptZeros', () => {
  it('writes the counted zeros of a tiny price as subscript digits', () => {
    expect(priceWithSubscriptZeros(priced('0.00000000152'))).toBe('0.0₈1520');
    expect(priceWithSubscriptZeros(priced('0.0000221'))).toBe('0.0₄2210');
  });

  it('writes a count of ten zeros or more with as many subscript digits', () => {
    expect(priceWithSubscriptZeros(priced('0.0000000000001234'))).toBe('0.0₁₂1234');
  });

  it('leaves an ordinary price as it is', () => {
    expect(priceWithSubscriptZeros(priced('148.2149'))).toBe('148.2');
  });
});
