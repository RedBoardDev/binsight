import { parseDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import {
  formatPercent,
  type PercentFormat,
} from '@app/applications/Shared/Figure/Domain/formatPercent';
import { formattedText } from '@app/applications/Shared/Figure/Domain/formattedNumber';
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

const shown = (value: string, format: PercentFormat): string => {
  const formatted = formatPercent(decimal(value), format);
  return `${formatted.sign}${formattedText(formatted)}`;
};

const CELL: PercentFormat = { languageTag: 'en-US', placement: 'cell', signing: 'always' };

describe('formatPercent', () => {
  it('reads the value as a percentage already', () => {
    expect(shown('2.5', CELL)).toBe('+2.50%');
    expect(shown('-4.984', CELL)).toBe('−4.98%');
  });

  it('keeps one decimal in a hero, none from a thousand percent', () => {
    expect(shown('0.74', { ...CELL, placement: 'hero' })).toBe('+0.7%');
    expect(shown('1234.5', CELL)).toBe('+1,235%');
  });

  it('writes the percent sign of each language', () => {
    expect(withPlainSpaces(shown('2.5', { ...CELL, languageTag: 'fr-FR' }))).toBe('+2,50 %');
    expect(withPlainSpaces(shown('2.5', { ...CELL, languageTag: 'de-DE' }))).toBe('+2,50 %');
  });

  it('shows a rounded zero without a sign', () => {
    expect(formatPercent(decimal('-0.001'), CELL)).toEqual({
      sign: '',
      prefix: '',
      digits: '0.00',
      suffix: '%',
      tone: 'neutral',
    });
  });
});
