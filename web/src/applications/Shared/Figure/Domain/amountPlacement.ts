export const AMOUNT_PLACEMENTS = [
  'hero',
  'key',
  'body',
  'cell-value',
  'cell-pnl',
  'axis',
  'compact',
] as const;

export type AmountPlacement = (typeof AMOUNT_PLACEMENTS)[number];

// An axis and a compact subline ("54 LP · 7.1 idle" under a figure on a phone) round to three
// significant digits ("1.2K"), with no fixed decimals.
export type DecimalPlacement = Exclude<AmountPlacement, 'axis' | 'compact'>;

const SOL_FRACTION_DIGITS: Record<DecimalPlacement, number> = {
  hero: 3,
  key: 3,
  body: 3,
  'cell-value': 2,
  'cell-pnl': 3,
};

// From 1,000 SOL, two decimals are enough everywhere: the thousands say the size.
const LARGE_AMOUNT_INTEGER_DIGITS = 4;
const LARGE_AMOUNT_FRACTION_DIGITS = 2;

export const solFractionDigits = (placement: DecimalPlacement, integerDigits: number): number =>
  integerDigits >= LARGE_AMOUNT_INTEGER_DIGITS
    ? Math.min(SOL_FRACTION_DIGITS[placement], LARGE_AMOUNT_FRACTION_DIGITS)
    : SOL_FRACTION_DIGITS[placement];
