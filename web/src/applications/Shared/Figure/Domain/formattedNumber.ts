// The tone is read from the formatted sign, never from a comparison: a loss rounded to zero is
// "0.000", without sign and without color.

export type FigureTone = 'gain' | 'loss' | 'neutral';

export type FigureSign = '' | '+' | '−';

// "always" for a performance (PnL, a change): + or −, and the matching tone. "negative-only" for
// a balance: a minus when there is one, never a color.
export type FigureSigning = 'always' | 'negative-only';

// The currency or unit symbol stays apart from the digits ("$" before, " %" after, as the
// language places them): hidden amounts mask the digits and keep the symbol.
export interface FormattedNumber {
  readonly sign: FigureSign;
  readonly prefix: string;
  readonly digits: string;
  readonly suffix: string;
  readonly tone: FigureTone;
}

const TRUE_MINUS: FigureSign = '−';

export const SIGN_DISPLAY: Record<FigureSigning, Intl.NumberFormatOptions['signDisplay']> = {
  always: 'exceptZero',
  'negative-only': 'negative',
};

const toneOf = (sign: FigureSign, signing: FigureSigning): FigureTone => {
  if (signing === 'negative-only' || sign === '') {
    return 'neutral';
  }
  return sign === '+' ? 'gain' : 'loss';
};

const NUMBER_PARTS: ReadonlySet<Intl.NumberFormatPart['type']> = new Set([
  'integer',
  'group',
  'decimal',
  'fraction',
  'compact',
  'exponentSeparator',
  'exponentMinusSign',
  'exponentInteger',
  'nan',
  'infinity',
]);

const joinParts = (parts: readonly Intl.NumberFormatPart[]): string =>
  parts.map((part) => part.value).join('');

// The minus becomes a true minus (U+2212): the hyphen Intl uses for English is too short next to
// tabular digits.
export const toFormattedNumber = (
  parts: readonly Intl.NumberFormatPart[],
  signing: FigureSigning,
): FormattedNumber => {
  const hasMinus = parts.some((part) => part.type === 'minusSign');
  const hasPlus = parts.some((part) => part.type === 'plusSign');
  const sign: FigureSign = hasMinus ? TRUE_MINUS : hasPlus ? '+' : '';
  const unsigned = parts.filter((part) => part.type !== 'minusSign' && part.type !== 'plusSign');
  const first = unsigned.findIndex((part) => NUMBER_PARTS.has(part.type));
  const last = unsigned.findLastIndex((part) => NUMBER_PARTS.has(part.type));
  return {
    sign,
    prefix: joinParts(unsigned.slice(0, first)).trimStart(),
    digits: joinParts(unsigned.slice(first, last + 1)),
    suffix: joinParts(unsigned.slice(last + 1)).trimEnd(),
    tone: toneOf(sign, signing),
  };
};

export const formattedText = ({ prefix, digits, suffix }: FormattedNumber): string =>
  `${prefix}${digits}${suffix}`;
