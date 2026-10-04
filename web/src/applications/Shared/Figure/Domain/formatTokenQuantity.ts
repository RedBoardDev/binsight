import {
  type DecimalString,
  integerDigitCount,
  isFractionOfOne,
} from '@app/applications/Shared/Figure/Domain/decimalString';
import { numberFormat } from '@app/applications/Shared/Figure/Domain/numberFormat';

// From a million, a quantity is compact ("12.4M"): memecoin supplies are long numbers.
const COMPACT_FROM_INTEGER_DIGITS = 7;

const quantityOptions = (amount: DecimalString): Intl.NumberFormatOptions => {
  if (integerDigitCount(amount) >= COMPACT_FROM_INTEGER_DIGITS) {
    return { notation: 'compact', maximumFractionDigits: 1 };
  }
  return isFractionOfOne(amount) ? { maximumSignificantDigits: 4 } : { maximumFractionDigits: 2 };
};

export const formatTokenQuantity = (amount: DecimalString, languageTag: string): string =>
  numberFormat(languageTag, quantityOptions(amount)).format(amount);
