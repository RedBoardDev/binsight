import type { AmountPlacement } from '@app/applications/Shared/Figure/Domain/amountPlacement';
import type { Figure } from '@app/applications/Shared/Figure/Domain/figure';
import type {
  FigureSigning,
  FigureTone,
} from '@app/applications/Shared/Figure/Domain/formattedNumber';
import { MASKED_DIGITS } from '@app/applications/Shared/Figure/Domain/maskedDigits';
import { ExactnessMark, type FigureLayout } from '@app/applications/Shared/Figure/Ui/ExactnessMark';
import { speakFigure } from '@app/applications/Shared/Figure/Ui/figureSpeech';
import { useFigureFormatter } from '@app/applications/Shared/Figure/Ui/useFigureFormatter';
import { UnitMark } from '@app/applications/Shared/Unit/Ui/UnitMark';
import { useLingui } from '@lingui/react/macro';

export const TONE_CLASSES: Record<FigureTone, string> = {
  gain: 'text-gain',
  loss: 'text-loss',
  neutral: '',
};

interface FigureAmountProps {
  figure: Figure;
  placement: AmountPlacement;
  signing: FigureSigning;
  layout?: FigureLayout;
  // "hidden" in a table cell, whose column header already names the unit.
  unit?: 'shown' | 'hidden';
}

export const FigureAmount = ({
  figure,
  placement,
  signing,
  layout = 'inline',
  unit = 'shown',
}: FigureAmountProps) => {
  const { i18n } = useLingui();
  const format = useFigureFormatter();
  const reasons = figure.exactness === 'complete' ? [] : figure.reasons;
  const mark = <ExactnessMark exactness={figure.exactness} reasons={reasons} layout={layout} />;

  if (figure.exactness === 'unavailable') {
    return <span className="num inline-flex items-baseline whitespace-nowrap">{mark}</span>;
  }
  const formatted = format.amount(figure.value, placement, signing);
  const spoken = speakFigure(i18n, {
    formatted,
    unit: figure.value.unit,
    exactness: figure.exactness,
    isHidden: format.areAmountsHidden,
  });

  return (
    <span className="num inline-flex items-baseline gap-[0.2em] whitespace-nowrap">
      {mark}
      <span aria-hidden className={TONE_CLASSES[formatted.tone]}>
        {formatted.sign}
        {formatted.prefix}
        {format.areAmountsHidden ? MASKED_DIGITS : formatted.digits}
        {formatted.suffix}
      </span>
      {unit === 'shown' && (
        <UnitMark unit={figure.value.unit} size={placement === 'hero' ? 'hero' : 'amount'} />
      )}
      <span className="sr-only">{spoken}</span>
    </span>
  );
};
