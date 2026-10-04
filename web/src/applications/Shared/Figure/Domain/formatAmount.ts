import {
  type AmountPlacement,
  solFractionDigits,
} from '@app/applications/Shared/Figure/Domain/amountPlacement';
import {
  integerDigitCount,
  isFractionOfOne,
} from '@app/applications/Shared/Figure/Domain/decimalString';
import type { Money } from '@app/applications/Shared/Figure/Domain/figure';
import {
  type FigureSigning,
  type FormattedNumber,
  SIGN_DISPLAY,
  toFormattedNumber,
} from '@app/applications/Shared/Figure/Domain/formattedNumber';
import { numberFormat } from '@app/applications/Shared/Figure/Domain/numberFormat';

export interface AmountFormat {
  readonly languageTag: string;
  readonly placement: AmountPlacement;
  readonly signing: FigureSigning;
}

const CENTS = { minimumFractionDigits: 2, maximumFractionDigits: 2 } as const;
// Below one dollar, cents would round most fees to zero: four significant digits instead.
const SMALL_DOLLARS = { minimumSignificantDigits: 2, maximumSignificantDigits: 4 } as const;
const AXIS = { notation: 'compact', maximumSignificantDigits: 3 } as const;
const USD_STYLE = { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' } as const;

const precisionOf = (money: Money, placement: AmountPlacement): Intl.NumberFormatOptions => {
  if (placement === 'axis') {
    return AXIS;
  }
  if (money.unit === 'sol') {
    const digits = solFractionDigits(placement, integerDigitCount(money.amount));
    return { minimumFractionDigits: digits, maximumFractionDigits: digits };
  }
  return isFractionOfOne(money.amount) ? SMALL_DOLLARS : CENTS;
};

// The unit itself is not in the digits, except the dollar sign: SOL is drawn as the Solana mark
// and stablecoins as their ticker, next to the number.
export const formatAmount = (money: Money, format: AmountFormat): FormattedNumber => {
  const options: Intl.NumberFormatOptions = {
    ...precisionOf(money, format.placement),
    ...(money.unit === 'usd' ? USD_STYLE : {}),
    signDisplay: SIGN_DISPLAY[format.signing],
  };
  const parts = numberFormat(format.languageTag, options).formatToParts(money.amount);
  return toFormattedNumber(parts, format.signing);
};
