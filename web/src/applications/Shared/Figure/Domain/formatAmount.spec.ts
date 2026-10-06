import type { DecimalPlacement } from '@app/applications/Shared/Figure/Domain/amountPlacement';
import { solFractionDigits } from '@app/applications/Shared/Figure/Domain/amountPlacement';
import {
  type DecimalString,
  integerDigitCount,
  parseDecimalString,
} from '@app/applications/Shared/Figure/Domain/decimalString';
import type { MoneyUnit } from '@app/applications/Shared/Figure/Domain/figure';
import {
  type AmountFormat,
  formatAmount,
} from '@app/applications/Shared/Figure/Domain/formatAmount';
import { formattedText } from '@app/applications/Shared/Figure/Domain/formattedNumber';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// French and German put a no-break space (or a narrow one, depending on the CLDR version of the
// runtime) before a unit and between thousands.
const withPlainSpaces = (text: string): string => text.replace(/[\u00a0\u202f]/g, ' ');

const decimal = (value: string): DecimalString => {
  const parsed = parseDecimalString(value);
  if (parsed === null) {
    throw new Error(`${value} is not a decimal string`);
  }
  return parsed;
};

const SIGNED_EN: AmountFormat = { languageTag: 'en-US', placement: 'hero', signing: 'always' };

const shown = (amount: string, unit: MoneyUnit, format: AmountFormat = SIGNED_EN): string => {
  const formatted = formatAmount({ amount: decimal(amount), unit }, format);
  return `${formatted.sign}${formattedText(formatted)}`;
};

describe('formatAmount', () => {
  it('says SOL to the milli-SOL in a hero, with a true minus', () => {
    expect(shown('-0.9494', 'sol')).toBe('−0.949');
    expect(shown('0.4215', 'sol')).toBe('+0.422');
  });

  it('colors only a signed figure, from its sign', () => {
    const format = SIGNED_EN;
    expect(formatAmount({ amount: decimal('1.5'), unit: 'sol' }, format).tone).toBe('gain');
    expect(formatAmount({ amount: decimal('-1.5'), unit: 'sol' }, format).tone).toBe('loss');
    const balance: AmountFormat = { ...format, signing: 'negative-only' };
    expect(formatAmount({ amount: decimal('61.54'), unit: 'sol' }, balance)).toEqual({
      sign: '',
      prefix: '',
      digits: '61.540',
      suffix: '',
      tone: 'neutral',
    });
  });

  it('shows dust rounded to zero without a sign or a color', () => {
    expect(formatAmount({ amount: decimal('-0.0004'), unit: 'sol' }, SIGNED_EN)).toEqual({
      sign: '',
      prefix: '',
      digits: '0.000',
      suffix: '',
      tone: 'neutral',
    });
    const balance: AmountFormat = { ...SIGNED_EN, signing: 'negative-only' };
    expect(shown('-0.0004', 'sol', balance)).toBe('0.000');
  });

  it('keeps two decimals in a value cell and from a thousand SOL', () => {
    const cell: AmountFormat = { ...SIGNED_EN, placement: 'cell-value', signing: 'negative-only' };
    expect(shown('4.005', 'sol', cell)).toBe('4.01');
    expect(shown('1234.5678', 'sol')).toBe('+1,234.57');
    expect(shown('0.0081', 'sol', { ...cell, placement: 'cell-pnl' })).toBe('0.008');
  });

  it('writes the separators of each language', () => {
    const french = shown('-1234.5', 'sol', { ...SIGNED_EN, languageTag: 'fr-FR' });
    expect(withPlainSpaces(french)).toBe('−1 234,50');
    expect(shown('-1234.5', 'sol', { ...SIGNED_EN, languageTag: 'de-DE' })).toBe('−1.234,50');
  });

  it('prefixes dollars in cents, and keeps four significant digits below one dollar', () => {
    expect(shown('1234.5', 'usd')).toBe('+$1,234.50');
    expect(shown('-0.004321', 'usd')).toBe('−$0.004321');
    expect(shown('0.5', 'usd')).toBe('+$0.50');
    expect(shown('0', 'usd')).toBe('$0.00');
    const french = shown('-12.5', 'usd', { ...SIGNED_EN, languageTag: 'fr-FR' });
    expect(withPlainSpaces(french)).toBe('−12,50 $');
  });

  it('keeps stablecoin quantities in cents, their ticker written beside them', () => {
    expect(shown('25.5', 'usdc')).toBe('+25.50');
  });

  it('shortens an axis label', () => {
    const axis: AmountFormat = { ...SIGNED_EN, placement: 'axis', signing: 'negative-only' };
    expect(shown('12500', 'sol', axis)).toBe('12.5K');
  });

  it('rounds a compact subline to three significant digits', () => {
    const compact: AmountFormat = { ...SIGNED_EN, placement: 'compact', signing: 'negative-only' };
    expect(shown('40.024', 'sol', compact)).toBe('40');
    expect(shown('339.821', 'sol', compact)).toBe('340');
    expect(shown('7.0712', 'sol', compact)).toBe('7.07');
  });
});

// The reference: round half away from zero, on the digits, with BigInt. Intl must agree with it on
// any decimal string, even beyond the precision of a JavaScript number.
const roundHalfExpand = (value: string, fractionDigits: number): string => {
  const isNegative = value.startsWith('-');
  const [integer = '0', fraction = ''] = (isNegative ? value.slice(1) : value).split('.');
  const kept = BigInt(integer + fraction.padEnd(fractionDigits, '0').slice(0, fractionDigits));
  const firstDropped = fraction.padEnd(fractionDigits + 1, '0').charAt(fractionDigits);
  const rounded = firstDropped >= '5' ? kept + 1n : kept;
  const text = rounded.toString().padStart(fractionDigits + 1, '0');
  const sign = isNegative && rounded !== 0n ? '-' : '';
  return `${sign}${text.slice(0, -fractionDigits)}.${text.slice(-fractionDigits)}`;
};

const decimalStrings = fc
  .tuple(
    fc.boolean(),
    fc.bigInt({ min: 0n, max: 10n ** 30n }),
    fc.array(fc.integer({ min: 0, max: 9 }), { maxLength: 30 }),
  )
  .map(([isNegative, integer, fractionDigits]) => {
    const fraction = fractionDigits.join('').replace(/0+$/, '');
    const unsigned = fraction === '' ? integer.toString() : `${integer}.${fraction}`;
    return decimal(isNegative && unsigned !== '0' ? `-${unsigned}` : unsigned);
  });

const PLACEMENTS: readonly DecimalPlacement[] = ['hero', 'body', 'cell-value', 'cell-pnl'];

describe('formatAmount on any decimal string', () => {
  it('shows exactly the decimal rounding of the string, up to 30 digits', () => {
    fc.assert(
      fc.property(decimalStrings, fc.constantFrom(...PLACEMENTS), (amount, placement) => {
        const { sign, digits } = formatAmount(
          { amount, unit: 'sol' },
          { languageTag: 'en-US', placement, signing: 'always' },
        );
        const written = `${sign === '−' ? '-' : ''}${digits.replaceAll(',', '')}`;
        const fractionDigits = solFractionDigits(placement, integerDigitCount(amount));
        expect(written).toBe(roundHalfExpand(amount, fractionDigits));
      }),
    );
  });

  it('colors a figure only when its rounded value is not zero', () => {
    fc.assert(
      fc.property(decimalStrings, (amount) => {
        const { sign, tone } = formatAmount({ amount, unit: 'sol' }, SIGNED_EN);
        const rounded = roundHalfExpand(
          amount,
          solFractionDigits('hero', integerDigitCount(amount)),
        );
        const isZero = /^-?0\.0+$/.test(rounded);
        expect(tone).toBe(isZero ? 'neutral' : rounded.startsWith('-') ? 'loss' : 'gain');
        expect(sign).toBe(isZero ? '' : rounded.startsWith('-') ? '−' : '+');
      }),
    );
  });
});
