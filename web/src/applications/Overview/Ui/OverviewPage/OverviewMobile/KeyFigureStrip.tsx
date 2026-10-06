import type { Overview } from '@app/applications/Overview/Api/getOverview';
import { isCatchingUp } from '@app/applications/Overview/Domain/dataFreshness';
import {
  gainImports,
  hasNoOpenPositions,
} from '@app/applications/Overview/Domain/keyFigureCaptions';
import { ImportHistoryLabel } from '@app/applications/Overview/Ui/OverviewPage/ImportHistoryLabel';
import { GainPeriodMenu } from '@app/applications/Overview/Ui/OverviewPage/OverviewMobile/GainPeriodMenu';
import { MiniFigure } from '@app/applications/Overview/Ui/OverviewPage/OverviewMobile/MiniFigure';
import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import { PercentValue } from '@app/applications/Shared/Figure/Ui/PercentValue';
import { useLingui } from '@lingui/react/macro';

interface KeyFigureStripProps {
  readonly overview: Overview;
}

// Net worth, Active PnL and Gain on one line under Today, after a hairline.
export const KeyFigureStrip = ({ overview }: KeyFigureStripProps) => {
  const { t } = useLingui();
  const { net_worth: netWorth, open, gain, sync } = overview;
  const imports = gainImports(gain.value, sync.importing);
  // While a wallet catches up, the figures are dimmed (not their captions: see KeyFigureList).
  const tone = isCatchingUp(overview.freshness) ? 'stale' : 'current';
  return (
    <div className="mt-5 flex gap-3 border-border border-t pt-4">
      <MiniFigure
        tone={tone}
        label={<span className="caps-label">{t`Net worth`}</span>}
        figure={
          <FigureAmount figure={netWorth.total} placement="cell-value" signing="negative-only" />
        }
        caption={
          <span className="num">
            <FigureAmount
              figure={netWorth.lp}
              placement="compact"
              signing="negative-only"
              unit="hidden"
            />{' '}
            {t`LP`} ·{' '}
            <FigureAmount
              figure={netWorth.idle}
              placement="compact"
              signing="negative-only"
              unit="hidden"
            />{' '}
            {t`idle`}
          </span>
        }
      />
      <MiniFigure
        tone={tone}
        label={<span className="caps-label">{t`Active PnL`}</span>}
        figure={<FigureAmount figure={open.pnl} placement="key" signing="always" />}
        caption={
          hasNoOpenPositions(open) ? (
            t`No open positions`
          ) : (
            <PercentValue figure={open.pnl_pct} placement="cell" signing="always" />
          )
        }
      />
      <MiniFigure
        tone={tone}
        label={
          <>
            <span className="caps-label">{t`Gain`}</span>
            <GainPeriodMenu />
          </>
        }
        figure={<FigureAmount figure={gain.value} placement="cell-value" signing="always" />}
        caption={
          imports.length > 0 ? (
            <ImportHistoryLabel importing={imports} />
          ) : (
            <PercentValue figure={gain.pct} placement="hero" signing="always" tone="neutral" />
          )
        }
      />
    </div>
  );
};
