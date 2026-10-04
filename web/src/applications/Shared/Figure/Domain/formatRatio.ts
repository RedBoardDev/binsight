import type { DecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { numberFormat } from '@app/applications/Shared/Figure/Domain/numberFormat';

const RATIO_FRACTION_DIGITS = 2;

export const formatRatio = (value: DecimalString, languageTag: string): string =>
  numberFormat(languageTag, {
    minimumFractionDigits: RATIO_FRACTION_DIGITS,
    maximumFractionDigits: RATIO_FRACTION_DIGITS,
  }).format(value);
