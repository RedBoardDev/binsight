import { NetWorthFigure } from '@app/applications/Overview/Ui/NetWorthFigure';
import { PerformancePair } from '@app/applications/Overview/Ui/PerformancePair';
import { TodayHero } from '@app/applications/Overview/Ui/TodayHero';
import type { Period } from '@app/applications/Shared/Scope/Domain/period';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import type { ReactNode } from 'react';

interface OverviewDesktopProps {
  readonly overview: ApiSchema<'OverviewV2'>;
  readonly period: Period;
  readonly historyHref: string;
  readonly graph: ReactNode;
}

export const OverviewDesktop = ({ overview, period, historyHref, graph }: OverviewDesktopProps) => (
  <div className="grid grid-cols-[20rem_minmax(0,1fr)] items-end gap-10">
    <div className="flex flex-col gap-6">
      <TodayHero today={overview.today} freshness={overview.freshness} historyHref={historyHref} />
      <div>
        <NetWorthFigure netWorth={overview.net_worth} layout="stocks" />
        <PerformancePair overview={overview} period={period} layout="stocks" />
      </div>
    </div>
    {graph}
  </div>
);
