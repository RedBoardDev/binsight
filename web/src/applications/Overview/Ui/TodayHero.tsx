import { FigureAmount } from '@app/applications/Shared/Figure/Ui/FigureAmount';
import { describeReason } from '@app/applications/Shared/Figure/Ui/figureSpeech';
import { PercentValue } from '@app/applications/Shared/Figure/Ui/PercentValue';
import { useDateFormatters } from '@app/applications/Shared/Time/Ui/useDateFormatters';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { Link } from '@heroui/react';
import { Plural, useLingui } from '@lingui/react/macro';

interface TodayHeroProps {
  readonly today: ApiSchema<'Overview'>['today'];
  readonly freshness: ApiSchema<'Overview'>['freshness'];
  readonly historyHref: string;
}

export const TodayHero = ({ today, freshness, historyHref }: TodayHeroProps) => {
  const { t, i18n } = useLingui();
  const { formatTime } = useDateFormatters(today.window.timezone);
  const { totals } = today;
  const reasons = totals.pnl.exactness === 'complete' ? [] : totals.pnl.reasons;
  const reasonText = [...new Set(reasons.map((reason) => describeReason(i18n, reason)))].join(' ');
  return (
    <section aria-label={t`Today`} className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="caps-label">
          {t`Today`} · {t`since 00:00`}
        </h2>
        {freshness.state === 'lagging' && (
          <span className="text-small text-muted">{t`Data from ${formatTime(freshness.as_of)}`}</span>
        )}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <span className="text-hero-phone lg:text-hero">
          <FigureAmount figure={totals.pnl} placement="hero" signing="always" />
        </span>
        <span
          className="text-body"
          title={t`Today's closed-position PnL as a share of their invested amount`}
        >
          <PercentValue figure={totals.pnl_pct} placement="hero" signing="always" />
        </span>
      </div>
      {totals.count === 0 ? (
        <p className="text-small text-muted">
          {totals.pnl.exactness === 'complete'
            ? t`Nothing closed yet today`
            : reasonText || t`Not available`}
        </p>
      ) : (
        <Link
          href={historyHref}
          className="flex min-h-11 flex-wrap items-center gap-x-1 text-small text-muted lg:min-h-4"
        >
          <Plural value={totals.count} one="# close" other="# closes" />
          <span aria-hidden>·</span>
          <Plural value={totals.wins} one="# win" other="# wins" />
          <span aria-hidden>·</span>
          <Plural value={totals.losses} one="# loss" other="# losses" />
          {totals.flat > 0 && (
            <>
              <span aria-hidden>·</span>
              <Plural value={totals.flat} one="# flat" other="# flat" />
            </>
          )}
          {totals.unclassified_count > 0 && (
            <>
              <span aria-hidden>·</span>
              <Plural
                value={totals.unclassified_count}
                one="# unclassified"
                other="# unclassified"
              />
            </>
          )}
          <span aria-hidden>·</span>
          <span>{t`realized`}</span>
        </Link>
      )}
    </section>
  );
};
