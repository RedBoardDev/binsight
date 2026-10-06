import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import { PercentValue } from '@app/applications/Shared/Figure/Ui/PercentValue';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';

type ReasonDisplay = 'static' | 'popover';

// The four readings of a day, each as a node: the tooltip and the phone's caption lay them out.
export interface PulseReadoutFigures {
  readonly profit: ReactNode;
  readonly profitShare: ReactNode;
  readonly cumulative: ReactNode;
  readonly cumulativeShare: ReactNode;
}

export const usePulseReadoutFigures = (
  point: ApiSchema<'SeriesPoint'>,
  reasonDisplay: ReasonDisplay,
): PulseReadoutFigures => {
  const { t } = useLingui();
  const unavailable = (
    <span>
      <span aria-hidden>—</span>
      <span className="sr-only">{t`Not available`}</span>
    </span>
  );
  const share = (figure: ApiSchema<'SeriesPoint'>['bar_share_of_net_worth']) =>
    figure === undefined || figure === null ? (
      unavailable
    ) : (
      <PercentValue
        figure={figure}
        placement="cell"
        signing="always"
        tone="neutral"
        reasonDisplay={reasonDisplay}
      />
    );
  return {
    profit:
      point.bar === undefined || point.bar === null ? (
        unavailable
      ) : (
        <FigureAmount
          figure={point.bar}
          placement="body"
          signing="always"
          reasonDisplay={reasonDisplay}
        />
      ),
    profitShare: share(point.bar_share_of_net_worth),
    cumulative: (
      <FigureAmount
        figure={point.line}
        placement="body"
        signing="always"
        reasonDisplay={reasonDisplay}
      />
    ),
    cumulativeShare: share(point.line_share_of_net_worth),
  };
};
