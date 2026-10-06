import type { Overview } from '@app/applications/Overview/Api/getOverview';
import { FreshnessNote } from '@app/applications/Overview/Ui/OverviewPage/FreshnessNote';
import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import { PercentValue } from '@app/applications/Shared/Figure/Ui/PercentValue';
import { useLingui } from '@lingui/react/macro';
import { TodaySummary } from './TodayHero/TodaySummary';

interface TodayHeroProps {
  readonly today: Overview['today'];
  readonly freshness: Overview['freshness'];
  readonly historyHref: string;
}

// The one hero of the page: the PnL realized since midnight, its percent on the same baseline,
// then what made it.
export const TodayHero = ({ today, freshness, historyHref }: TodayHeroProps) => {
  const { t } = useLingui();
  const { totals } = today;
  return (
    <section aria-label={t`Today`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-medium text-meta text-muted">
          {t`Today`} <span className="font-normal text-faint">· {t`since 00:00`}</span>
        </h2>
        <FreshnessNote freshness={freshness} timeZone={today.window.timezone} />
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3">
        <span className="text-hero">
          <FigureAmount
            figure={totals.pnl}
            placement="hero"
            signing="always"
            markPosition="hanging"
          />
        </span>
        <span
          className="font-medium text-body"
          title={t`Today's closed-position PnL as a share of their invested amount`}
        >
          <PercentValue figure={totals.pnl_pct} placement="hero" signing="always" />
        </span>
      </div>
      <TodaySummary totals={totals} historyHref={historyHref} />
    </section>
  );
};
