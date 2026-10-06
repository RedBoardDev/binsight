import { NetWorthFigure } from '@app/applications/Overview/Ui/NetWorthFigure';
import { PerformancePair } from '@app/applications/Overview/Ui/PerformancePair';
import { TodayHero } from '@app/applications/Overview/Ui/TodayHero';
import type { Period } from '@app/applications/Shared/Scope/Domain/period';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import type { ReactNode } from 'react';

interface OverviewMobileProps {
  readonly overview: ApiSchema<'Overview'>;
  readonly period: Period;
  readonly historyHref: string;
  readonly graph: ReactNode;
}

export const OverviewMobile = ({ overview, period, historyHref, graph }: OverviewMobileProps) => (
  <div className="flex flex-col gap-6">
    <TodayHero today={overview.today} freshness={overview.freshness} historyHref={historyHref} />
    <div className="grid grid-cols-3 gap-4 border-t border-border-subtle pt-4">
      <NetWorthFigure netWorth={overview.net_worth} layout="compact" />
      <PerformancePair overview={overview} period={period} layout="compact" />
    </div>
    {graph}
  </div>
);
