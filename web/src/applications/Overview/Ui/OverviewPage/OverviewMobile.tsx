import type { Overview } from '@app/applications/Overview/Api/getOverview';
import type { ReactNode } from 'react';
import { KeyFigureStrip } from './OverviewMobile/KeyFigureStrip';
import { TodayFigure } from './OverviewMobile/TodayFigure';

interface OverviewMobileProps {
  readonly overview: Overview;
  readonly graph: ReactNode;
}

// The phone's header: Today, the three figures on one line, then the chart.
export const OverviewMobile = ({ overview, graph }: OverviewMobileProps) => (
  <div className="flex flex-col gap-7">
    <div>
      <TodayFigure today={overview.today} freshness={overview.freshness} />
      <KeyFigureStrip overview={overview} />
    </div>
    {graph}
  </div>
);
