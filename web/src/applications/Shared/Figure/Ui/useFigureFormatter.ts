import type { AmountPlacement } from '@app/applications/Shared/Figure/Domain/amountPlacement';
import type { DecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import type { Money, Price } from '@app/applications/Shared/Figure/Domain/figure';
import { formatAmount } from '@app/applications/Shared/Figure/Domain/formatAmount';
import {
  formatPercent,
  type PercentPlacement,
} from '@app/applications/Shared/Figure/Domain/formatPercent';
import {
  type FormattedPrice,
  formatPrice,
} from '@app/applications/Shared/Figure/Domain/formatPrice';
import { formatRatio } from '@app/applications/Shared/Figure/Domain/formatRatio';
import { formatTokenQuantity } from '@app/applications/Shared/Figure/Domain/formatTokenQuantity';
import type {
  FigureSigning,
  FormattedNumber,
} from '@app/applications/Shared/Figure/Domain/formattedNumber';
import { useDisplayPreferences } from '@app/applications/Shared/Preference/Ui/useDisplayPreferences';
import { useLanguageTag } from '@app/core/i18n/useLanguageTag';
import { useMemo } from 'react';

interface FigureFormatter {
  readonly areAmountsHidden: boolean;
  readonly amount: (
    money: Money,
    placement: AmountPlacement,
    signing: FigureSigning,
  ) => FormattedNumber;
  readonly percent: (
    value: DecimalString,
    placement: PercentPlacement,
    signing: FigureSigning,
  ) => FormattedNumber;
  readonly ratio: (value: DecimalString) => string;
  readonly price: (price: Price) => FormattedPrice;
  readonly tokenQuantity: (amount: DecimalString) => string;
}

export const useFigureFormatter = (): FigureFormatter => {
  const languageTag = useLanguageTag();
  const { areAmountsHidden } = useDisplayPreferences();

  return useMemo(
    () => ({
      areAmountsHidden,
      amount: (money, placement, signing) =>
        formatAmount(money, { languageTag, placement, signing }),
      percent: (value, placement, signing) =>
        formatPercent(value, { languageTag, placement, signing }),
      ratio: (value) => formatRatio(value, languageTag),
      price: (price) => formatPrice(price, languageTag),
      tokenQuantity: (amount) => formatTokenQuantity(amount, languageTag),
    }),
    [areAmountsHidden, languageTag],
  );
};
