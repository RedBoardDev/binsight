import type { Overview } from '@app/applications/Overview/Api/getOverview';
import { isCatchingUp } from '@app/applications/Overview/Domain/dataFreshness';
import {
  gainImports,
  hasNoOpenPositions,
} from '@app/applications/Overview/Domain/keyFigureCaptions';
import { ImportHistoryLabel } from '@app/applications/Overview/Ui/OverviewPage/ImportHistoryLabel';
import { KeyFigureRow } from '@app/applications/Overview/Ui/OverviewPage/OverviewDesktop/KeyFigureRow';
import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import { PercentValue } from '@app/applications/Shared/Figure/Ui/PercentValue';
import { PERIOD_LABELS, type Period } from '@app/applications/Shared/Scope/Domain/period';
import { useLingui } from '@lingui/react/macro';

// While a wallet catches up, the live figures are dimmed: they are true, but as old as the lag.
// Only the figures themselves: their dimmer captions would fall under the contrast floor.
const FIGURE_CLASSES = {
  current: 'text-stat',
  stale: 'text-stat opacity-(--stale-figure-opacity)',
} as const;

interface KeyFigureListProps {
  readonly overview: Overview;
  readonly period: Period;
}

// The key statistics under Today, read like Apple Stocks': one aligned list, hairlines between
// the lines, nothing boxed. The percents are neutral: only the signed figures carry a color.
export const KeyFigureList = ({ overview, period }: KeyFigureListProps) => {
  const { t, i18n } = useLingui();
  const { net_worth: netWorth, open, gain, sync } = overview;
  const imports = gainImports(gain.value, sync.importing);
  const figureClass = FIGURE_CLASSES[isCatchingUp(overview.freshness) ? 'stale' : 'current'];
  return (
    // The percent gutter is 64 px, or the width of the longest percent: every figure still ends
    // on the same edge.
    <dl className="grid grid-cols-[minmax(0,1fr)_auto_minmax(4rem,auto)] gap-x-3">
      <KeyFigureRow
        label={t`Net worth`}
        figure={
          <span className={figureClass}>
            <FigureAmount figure={netWorth.total} placement="key" signing="negative-only" />
          </span>
        }
      />
      <KeyFigureRow
        label={
          <span className="text-faint">
            <span aria-hidden>↳ </span>
            {t`LP · idle`}
          </span>
        }
        figure={
          <span className="font-medium text-meta text-muted">
            <FigureAmount
              figure={netWorth.lp}
              placement="cell-value"
              signing="negative-only"
              unit="hidden"
            />
            <span aria-hidden> · </span>
            <FigureAmount
              figure={netWorth.idle}
              placement="cell-value"
              signing="negative-only"
              unit="hidden"
            />
          </span>
        }
      />
      <KeyFigureRow
        label={t`Active PnL`}
        figure={
          <span className={figureClass}>
            <FigureAmount figure={open.pnl} placement="key" signing="always" />
          </span>
        }
        percent={
          <PercentValue figure={open.pnl_pct} placement="cell" signing="always" tone="neutral" />
        }
        caption={hasNoOpenPositions(open) ? t`No open positions` : null}
      />
      <KeyFigureRow
        label={t`Gain · ${i18n._(PERIOD_LABELS[period])}`}
        figure={
          <span className={figureClass}>
            <FigureAmount figure={gain.value} placement="key" signing="always" />
          </span>
        }
        percent={
          <PercentValue figure={gain.pct} placement="hero" signing="always" tone="neutral" />
        }
        caption={imports.length > 0 ? <ImportHistoryLabel importing={imports} /> : null}
      />
    </dl>
  );
};
