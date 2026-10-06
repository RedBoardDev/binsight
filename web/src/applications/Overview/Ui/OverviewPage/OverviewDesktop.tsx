import type { Overview } from '@app/applications/Overview/Api/getOverview';
import type { Period } from '@app/applications/Shared/Scope/Domain/period';
import { KeyFigureList } from './OverviewDesktop/KeyFigureList';
import { RealPnlPulseDesktop } from './OverviewDesktop/RealPnlPulseDesktop';
import { TodayHero } from './OverviewDesktop/TodayHero';

interface OverviewDesktopProps {
  readonly overview: Overview;
  readonly period: Period;
  readonly historyHref: string;
}

// The key figures in a 320 px column, the chart beside them; the list ends on the chart's dates.
export const OverviewDesktop = ({ overview, period, historyHref }: OverviewDesktopProps) => (
  <div className="grid grid-cols-[20rem_minmax(0,1fr)] gap-x-16">
    <div className="flex flex-col justify-between gap-6">
      <TodayHero today={overview.today} freshness={overview.freshness} historyHref={historyHref} />
      <KeyFigureList overview={overview} period={period} />
    </div>
    <RealPnlPulseDesktop />
  </div>
);
