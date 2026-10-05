import {
  integerDigitCount,
  requireDecimalString,
} from '@app/applications/Shared/Figure/Domain/decimalString';
import {
  type FigureSigning,
  type FormattedNumber,
  SIGN_DISPLAY,
  toFormattedNumber,
} from '@app/applications/Shared/Figure/Domain/formattedNumber';
import { numberFormat } from '@app/applications/Shared/Figure/Domain/numberFormat';

export type PercentPlacement = 'hero' | 'cell';

export interface PercentFormat {
  readonly languageTag: string;
  readonly placement: PercentPlacement;
  readonly signing: FigureSigning;
}

const PERCENT_FRACTION_DIGITS: Record<PercentPlacement, number> = { hero: 1, cell: 2 };
const LARGE_PERCENT_INTEGER_DIGITS = 4;

// The value is already in percent ("2.56" is 2.56 %): the percent unit adds the sign of the
// language (a narrow space before it in French) without multiplying by 100.
export const formatPercent = (value: string, format: PercentFormat): FormattedNumber => {
  const decimal = requireDecimalString(value);
  const digits =
    integerDigitCount(decimal) >= LARGE_PERCENT_INTEGER_DIGITS
      ? 0
      : PERCENT_FRACTION_DIGITS[format.placement];
  const parts = numberFormat(format.languageTag, {
    style: 'unit',
    unit: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: SIGN_DISPLAY[format.signing],
  }).formatToParts(decimal);
  return toFormattedNumber(parts, format.signing);
};
