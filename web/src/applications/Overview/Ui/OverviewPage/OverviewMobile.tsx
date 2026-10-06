import type { Overview } from '@app/applications/Overview/Api/getOverview';
import { KeyFigureStrip } from './OverviewMobile/KeyFigureStrip';
import { RealPnlPulseMobile } from './OverviewMobile/RealPnlPulseMobile';
import { TodayFigure } from './OverviewMobile/TodayFigure';

interface OverviewMobileProps {
  readonly overview: Overview;
}

// The phone's header: Today, the three figures on one line, then the chart.
export const OverviewMobile = ({ overview }: OverviewMobileProps) => (
  <div className="flex flex-col gap-7">
    <div>
      <TodayFigure today={overview.today} freshness={overview.freshness} />
      <KeyFigureStrip overview={overview} />
    </div>
    <RealPnlPulseMobile />
  </div>
);
