import { requireDecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { numberFormat } from '@app/applications/Shared/Figure/Domain/numberFormat';

const RATIO_FRACTION_DIGITS = 2;

export const formatRatio = (value: string, languageTag: string): string =>
  numberFormat(languageTag, {
    minimumFractionDigits: RATIO_FRACTION_DIGITS,
    maximumFractionDigits: RATIO_FRACTION_DIGITS,
  }).format(requireDecimalString(value));
