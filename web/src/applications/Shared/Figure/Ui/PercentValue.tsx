import type { PercentFigure } from '@app/applications/Shared/Figure/Domain/figure';
import type { PercentPlacement } from '@app/applications/Shared/Figure/Domain/formatPercent';
import {
  type FigureSigning,
  formattedText,
} from '@app/applications/Shared/Figure/Domain/formattedNumber';
import {
  ExactnessMark,
  type FigureLayout,
  type FigureReasonDisplay,
} from '@app/applications/Shared/Figure/Ui/ExactnessMark';
import { TONE_CLASSES } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import { useFigureFormatter } from '@app/applications/Shared/Figure/Ui/useFigureFormatter';

interface PercentValueProps {
  figure: PercentFigure;
  placement: PercentPlacement;
  signing: FigureSigning;
  layout?: FigureLayout;
  reasonDisplay?: FigureReasonDisplay;
  tone?: 'signed' | 'neutral';
}

// A percentage. Never hidden with the amounts: a ratio reveals no balance.
export const PercentValue = ({
  figure,
  placement,
  signing,
  layout = 'inline',
  reasonDisplay = 'popover',
  tone = 'signed',
}: PercentValueProps) => {
  const format = useFigureFormatter();
  const reasons = figure.exactness === 'complete' ? [] : figure.reasons;
  const mark = (
    <ExactnessMark
      exactness={figure.exactness}
      reasons={reasons}
      layout={layout}
      reasonDisplay={reasonDisplay}
    />
  );
  if (figure.exactness === 'unavailable') {
    return <span className="num inline-flex items-baseline whitespace-nowrap">{mark}</span>;
  }
  const formatted = format.percent(figure.value, placement, signing);
  const toneOf = tone === 'neutral' ? 'neutral' : formatted.tone;

  return (
    <span className="num inline-flex items-baseline gap-[0.2em] whitespace-nowrap">
      {(figure.exactness !== 'complete' || layout === 'column') && (
        <span className={`-me-[0.1em] ${TONE_CLASSES[toneOf]}`}>{mark}</span>
      )}
      <span className={TONE_CLASSES[toneOf]}>
        {formatted.sign}
        {formattedText(formatted)}
      </span>
    </span>
  );
};
