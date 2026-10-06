import type { Overview } from '@app/applications/Overview/Api/getOverview';
import { FreshnessNote } from '@app/applications/Overview/Ui/OverviewPage/FreshnessNote';
import type { FigureTone } from '@app/applications/Shared/Figure/Domain/formattedNumber';
import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import { PercentValue } from '@app/applications/Shared/Figure/Ui/PercentValue';
import { useFigureFormatter } from '@app/applications/Shared/Figure/Ui/useFigureFormatter';
import { useLingui } from '@lingui/react/macro';

const PILL_CLASSES: Record<FigureTone, string> = {
  gain: 'bg-gain-soft text-gain-on-soft',
  loss: 'bg-loss-soft text-loss-on-soft',
  neutral: 'bg-inset text-muted',
};

interface TodayFigureProps {
  readonly today: Overview['today'];
  readonly freshness: Overview['freshness'];
}

// The phone's hero: TODAY in capitals, the figure, and its percent in a soft pill of its color
// (the pill carries the color: the percent inside it stays neutral).
export const TodayFigure = ({ today, freshness }: TodayFigureProps) => {
  const { t } = useLingui();
  const format = useFigureFormatter();
  const percent = today.totals.pnl_pct;
  const tone =
    percent.exactness === 'unavailable'
      ? 'neutral'
      : format.percent(percent.value, 'hero', 'always').tone;
  return (
    <section aria-label={t`Today`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="caps-label">{t`Today`}</h2>
        <FreshnessNote freshness={freshness} timeZone={today.window.timezone} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-hero-phone">
          <FigureAmount
            figure={today.totals.pnl}
            placement="hero"
            signing="always"
            unitSize="coin"
          />
        </span>
        <span
          className={`inline-flex h-6 items-center rounded-md px-2 font-medium text-small ${PILL_CLASSES[tone]}`}
        >
          <PercentValue figure={percent} placement="hero" signing="always" tone="neutral" />
        </span>
      </div>
    </section>
  );
};
