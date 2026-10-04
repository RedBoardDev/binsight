import type { AmountPlacement } from '@app/applications/Shared/Figure/Domain/amountPlacement';
import type { Money } from '@app/applications/Shared/Figure/Domain/figure';
import type { FigureSigning } from '@app/applications/Shared/Figure/Domain/formattedNumber';
import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';

interface MoneyAmountProps {
  money: Money;
  placement: AmountPlacement;
  signing: FigureSigning;
}

export const MoneyAmount = ({ money, placement, signing }: MoneyAmountProps) => (
  <FigureAmount
    figure={{ exactness: 'complete', value: money }}
    placement={placement}
    signing={signing}
  />
);
