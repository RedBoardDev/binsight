import type { Overview } from '@app/applications/Overview/Api/getOverview';
import { todayCaption } from '@app/applications/Overview/Domain/keyFigureCaptions';
import { describeReason } from '@app/applications/Shared/Figure/Ui/figureSpeech';
import { Link } from '@heroui/react';
import { Plural, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';

interface TallyProps {
  readonly count: number;
  readonly short: string;
  readonly children: ReactNode;
}

// A count read at a glance ("3 W"); a screen reader hears the words ("3 wins").
const Tally = ({ count, short, children }: TallyProps) => (
  <span>
    <span aria-hidden>
      {count} {short}
    </span>
    <span className="sr-only">{children}</span>
  </span>
);

interface TodaySummaryProps {
  readonly totals: Overview['today']['totals'];
  readonly historyHref: string;
}

// "5 closes · 3 W · 2 L · realized", a link to that day in History.
export const TodaySummary = ({ totals, historyHref }: TodaySummaryProps) => {
  const { t, i18n } = useLingui();
  const caption = todayCaption(totals);
  if (caption !== 'closes') {
    const reasons = totals.pnl.exactness === 'complete' ? [] : totals.pnl.reasons;
    const reasonText = [...new Set(reasons.map((reason) => describeReason(i18n, reason)))].join(
      ' ',
    );
    return (
      <p className="mt-2 text-faint text-small">
        {caption === 'nothing-closed'
          ? t`Nothing closed yet today`
          : reasonText || t`Not available`}
      </p>
    );
  }
  return (
    <Link
      href={historyHref}
      className="mt-2 flex flex-wrap items-center gap-x-1 text-faint text-small no-underline hover:text-foreground"
    >
      <Plural value={totals.count} one="# close" other="# closes" />
      <span aria-hidden>·</span>
      <Tally
        count={totals.wins}
        short={t({ message: 'W', comment: 'Short for wins, after a count: 3 W' })}
      >
        <Plural value={totals.wins} one="# win" other="# wins" />
      </Tally>
      <span aria-hidden>·</span>
      <Tally
        count={totals.losses}
        short={t({ message: 'L', comment: 'Short for losses, after a count: 2 L' })}
      >
        <Plural value={totals.losses} one="# loss" other="# losses" />
      </Tally>
      {totals.flat > 0 && (
        <>
          <span aria-hidden>·</span>
          <Plural value={totals.flat} one="# flat" other="# flat" />
        </>
      )}
      {totals.unknown > 0 && (
        <>
          <span aria-hidden>·</span>
          <Plural value={totals.unknown} one="# unknown" other="# unknown" />
        </>
      )}
      <span aria-hidden>·</span>
      <span>{t`realized`}</span>
    </Link>
  );
};
