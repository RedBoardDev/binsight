import type { DecimalString } from '@app/applications/Shared/Figure/Domain/decimalString';
import { MASKED_DIGITS } from '@app/applications/Shared/Figure/Domain/maskedDigits';
import { useFigureFormatter } from '@app/applications/Shared/Figure/Ui/useFigureFormatter';

interface TokenQuantityProps {
  amount: DecimalString;
  symbol: string;
}

export const TokenQuantity = ({ amount, symbol }: TokenQuantityProps) => {
  const format = useFigureFormatter();

  return (
    <span className="num whitespace-nowrap">
      {format.areAmountsHidden ? MASKED_DIGITS : format.tokenQuantity(amount)}{' '}
      <span className="text-muted">{symbol}</span>
    </span>
  );
};
