import type { RatioFigure } from '@app/applications/Shared/Figure/Domain/figure';
import { ExactnessMark } from '@app/applications/Shared/Figure/Ui/ExactnessMark';
import { useFigureFormatter } from '@app/applications/Shared/Figure/Ui/useFigureFormatter';

interface RatioValueProps {
  figure: RatioFigure;
}

export const RatioValue = ({ figure }: RatioValueProps) => {
  const format = useFigureFormatter();
  const reasons = figure.exactness === 'complete' ? [] : figure.reasons;

  return (
    <span className="num inline-flex items-baseline gap-[0.2em] whitespace-nowrap">
      <ExactnessMark exactness={figure.exactness} reasons={reasons} layout="inline" />
      {figure.exactness === 'unavailable' ? null : format.ratio(figure.value)}
    </span>
  );
};
