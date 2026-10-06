import type { AmountPlacement } from '@app/applications/Shared/Figure/Domain/amountPlacement';
import type { Figure } from '@app/applications/Shared/Figure/Domain/figure';
import type {
  FigureSigning,
  FigureTone,
} from '@app/applications/Shared/Figure/Domain/formattedNumber';
import { MASKED_DIGITS } from '@app/applications/Shared/Figure/Domain/maskedDigits';
import {
  ExactnessMark,
  type FigureLayout,
  type FigureReasonDisplay,
  type MarkPosition,
} from '@app/applications/Shared/Figure/Ui/ExactnessMark';
import { speakFigure } from '@app/applications/Shared/Figure/Ui/figureSpeech';
import { useFigureFormatter } from '@app/applications/Shared/Figure/Ui/useFigureFormatter';
import type { SolanaMarkSize } from '@app/applications/Shared/Unit/Ui/SolanaMark';
import { UnitMark } from '@app/applications/Shared/Unit/Ui/UnitMark';
import { useLingui } from '@lingui/react/macro';

// A hero's glyph is small, beside the digits (a phone, where the margin is a 16 px edge) or
// hanging in the margin at their top left (a desktop, whose column keeps the digits aligned).
// Any other figure carries it at its own size, tight against the digits.
const MARK_POSITION_CLASSES: Record<MarkPosition | 'figure', string> = {
  figure: '-me-[0.1em]',
  inline: 'font-normal text-section',
  hanging: 'absolute top-0 right-full pe-1 font-normal text-section',
};

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
  reasonDisplay?: FigureReasonDisplay;
  // "hidden" in a table cell, whose column header already names the unit.
  unit?: 'shown' | 'hidden';
  // Where the exactness glyph of a hero goes (see ExactnessMark).
  markPosition?: MarkPosition;
  // The Solana mark's size, when it is not the placement's own (the phone's hero coin).
  unitSize?: SolanaMarkSize;
}

export const FigureAmount = ({
  figure,
  placement,
  signing,
  layout = 'inline',
  reasonDisplay = 'popover',
  unit = 'shown',
  markPosition = 'inline',
  unitSize,
}: FigureAmountProps) => {
  const { i18n } = useLingui();
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
  const formatted = format.amount(figure.value, placement, signing);
  const spoken = speakFigure(i18n, {
    formatted,
    unit: figure.value.unit,
    exactness: figure.exactness,
    isHidden: format.areAmountsHidden,
  });

  const isHero = placement === 'hero';
  const isHanging = isHero && markPosition === 'hanging';
  return (
    <span
      className={`num inline-flex items-baseline gap-[0.2em] whitespace-nowrap ${isHanging ? 'relative' : ''}`}
    >
      {(figure.exactness !== 'complete' || layout === 'column') && (
        <span
          data-mark-position={isHero ? markPosition : undefined}
          className={`${MARK_POSITION_CLASSES[isHero ? markPosition : 'figure']} ${TONE_CLASSES[formatted.tone]}`}
        >
          {mark}
        </span>
      )}
      <span aria-hidden className={TONE_CLASSES[formatted.tone]}>
        {formatted.sign}
        {formatted.prefix}
        {format.areAmountsHidden ? MASKED_DIGITS : formatted.digits}
        {formatted.suffix}
      </span>
      {unit === 'shown' && (
        <UnitMark
          unit={figure.value.unit}
          size={unitSize ?? (placement === 'hero' ? 'hero' : 'amount')}
        />
      )}
      <span className="sr-only">{spoken}</span>
    </span>
  );
};
