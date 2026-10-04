import type { Price } from '@app/applications/Shared/Figure/Domain/figure';
import { useFigureFormatter } from '@app/applications/Shared/Figure/Ui/useFigureFormatter';

interface PriceValueProps {
  price: Price;
}

export const PriceValue = ({ price }: PriceValueProps) => {
  const formatted = useFigureFormatter().price(price);
  if (formatted.kind === 'plain') {
    return <span className="num whitespace-nowrap">{formatted.text}</span>;
  }
  return (
    <span className="num whitespace-nowrap">
      <span aria-hidden>
        {formatted.lead}
        <sub>{formatted.zeroCount}</sub>
        {formatted.digits}
      </span>
      <span className="sr-only">{formatted.text}</span>
    </span>
  );
};
