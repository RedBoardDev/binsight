import { NetWorthFigure } from '@app/applications/Overview/Ui/NetWorthFigure';
import { PerformancePair } from '@app/applications/Overview/Ui/PerformancePair';
import { TodayHero } from '@app/applications/Overview/Ui/TodayHero';
import type { Period } from '@app/applications/Shared/Scope/Domain/period';
import type { ApiSchema } from '@app/lib/api/apiSchema';

interface OverviewDesktopProps {
  readonly overview: ApiSchema<'Overview'>;
  readonly period: Period;
  readonly historyHref: string;
}

export const OverviewDesktop = ({ overview, period, historyHref }: OverviewDesktopProps) => (
  <div className="flex w-80 flex-col gap-6">
    <TodayHero today={overview.today} freshness={overview.freshness} historyHref={historyHref} />
    <div>
      <NetWorthFigure netWorth={overview.net_worth} layout="stocks" />
      <PerformancePair overview={overview} period={period} layout="stocks" />
    </div>
  </div>
);
