import { EXACTNESS_GLYPHS } from '@app/applications/Shared/Figure/Domain/exactness';
import type { Exactness, FigureReason } from '@app/applications/Shared/Figure/Domain/figure';
import { FigureReasons } from '@app/applications/Shared/Figure/Ui/FigureReasons';
import {
  EXACTNESS_QUESTIONS,
  EXACTNESS_TITLES,
} from '@app/applications/Shared/Figure/Ui/figureSpeech';
import { useLingui } from '@lingui/react/macro';

// "inline": the glyph only when there is one. "column": a gutter of fixed width, empty for a
// complete figure, so the digits of a column stay aligned whatever the exactness of each row.
export type FigureLayout = 'inline' | 'column';
export type FigureReasonDisplay = 'popover' | 'static';

interface ExactnessMarkProps {
  exactness: Exactness;
  reasons: readonly FigureReason[];
  layout: FigureLayout;
  reasonDisplay?: FigureReasonDisplay;
}

export const ExactnessMark = ({
  exactness,
  reasons,
  layout,
  reasonDisplay = 'popover',
}: ExactnessMarkProps) => {
  const { i18n } = useLingui();
  const gutter = layout === 'column' ? 'inline-block w-[0.9em]' : '';
  if (exactness === 'complete') {
    return layout === 'column' ? <span aria-hidden className={gutter} /> : null;
  }
  if (reasonDisplay === 'static') {
    return (
      <span className={gutter}>
        <span aria-hidden className="text-muted">
          {EXACTNESS_GLYPHS[exactness]}
        </span>
        <span className="sr-only">{i18n._(EXACTNESS_TITLES[exactness])}</span>
      </span>
    );
  }
  return (
    <FigureReasons
      label={i18n._(EXACTNESS_QUESTIONS[exactness])}
      title={i18n._(EXACTNESS_TITLES[exactness])}
      reasons={reasons}
    >
      <span className={`text-faint ${gutter}`}>{EXACTNESS_GLYPHS[exactness]}</span>
    </FigureReasons>
  );
};
