import { requireDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import type { Price } from '@app/applications/Shared/Figure/Domain/figure';
import { numberFormat } from '@app/applications/Shared/Figure/Domain/numberFormat';

export type FormattedPrice =
  | { readonly kind: 'plain'; readonly text: string }
  | {
      readonly kind: 'zeros-counted';
      readonly text: string;
      readonly lead: string;
      readonly zeroCount: number;
      readonly digits: string;
    };

const SIGNIFICANT_DIGITS = 4;
const COUNT_ZEROS_FROM = 3;
const LEADING_ZEROS = /^0+/;

export const formatPrice = (price: Price, languageTag: string): FormattedPrice => {
  const parts = numberFormat(languageTag, {
    minimumSignificantDigits: SIGNIFICANT_DIGITS,
    maximumSignificantDigits: SIGNIFICANT_DIGITS,
  }).formatToParts(requireDecimalString(price.amount));
  const text = parts.map((part) => part.value).join('');
  const integer = parts.find((part) => part.type === 'integer')?.value;
  const decimal = parts.find((part) => part.type === 'decimal')?.value;
  const fraction = parts.find((part) => part.type === 'fraction')?.value ?? '';
  const zeroCount = LEADING_ZEROS.exec(fraction)?.[0].length ?? 0;
  if (integer !== '0' || decimal === undefined || zeroCount < COUNT_ZEROS_FROM) {
    return { kind: 'plain', text };
  }
  return {
    kind: 'zeros-counted',
    text,
    lead: `0${decimal}0`,
    zeroCount,
    digits: fraction.slice(zeroCount),
  };
};

const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';

// The same price as plain text, its zero count in subscript digits ("0.0₈1520"): for a canvas,
// such as a chart's price scale, where no <sub> can be drawn.
export const priceWithSubscriptZeros = (price: FormattedPrice): string => {
  if (price.kind === 'plain') return price.text;
  const subscript = [...String(price.zeroCount)]
    .map((digit) => SUBSCRIPT_DIGITS.charAt(Number.parseInt(digit, 10)))
    .join('');
  return `${price.lead}${subscript}${price.digits}`;
};
