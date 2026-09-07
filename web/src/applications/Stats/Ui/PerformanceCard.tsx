'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { fmtDuration } from '@app/applications/Shared/Domain/formatters';
import { toneOf } from '@app/applications/Shared/Domain/tone';
import { MoneyValue } from '@app/applications/Shared/Ui/MoneyValue';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import { StatTile } from '@app/applications/Shared/Ui/StatTile';
import { useStats } from '@app/applications/Stats/Api/useStats.api';
import { sinceMs } from '@app/applications/Stats/Domain/period';
import { useUi } from '@app/core/stores/uiStore';
import type { Stats } from '@binsight/shared';
import { Card, cn, Skeleton } from '@heroui/react';
import { Trophy } from 'lucide-react';
import { PnlBridge } from './PerformanceCard/PnlBridge';

const GRID = 'grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-4';

interface PerformanceCardProps {
  /** The clock the whole tab shares — frozen per (scope, period, closed set) so the query keys hold. */
  now: number;
}

export const PerformanceCard = ({ now }: PerformanceCardProps) => {
  const scope = usePortfolioFeed((s) => s.scope);
  const closedVersion = usePortfolioFeed((s) => s.closedVersion);
  const period = useUi((s) => s.period);
  const stats = useStats(scope, closedVersion, sinceMs(period, now));
  const data = stats.data;

  return (
    <Card.Root
      className={cn('transition-opacity', stats.isPlaceholderData && 'opacity-60')}
      aria-busy={stats.isPlaceholderData}
    >
      <Card.Header className="flex-row items-center justify-between gap-3">
        <Card.Title>Performance</Card.Title>
        {data && <span className="tabular text-faint text-xs">{data.closedCount} trades</span>}
      </Card.Header>
      <Card.Content>
        {stats.isError && !data ? (
          <StateMessage
            variant="error"
            title="Couldn't load your performance"
            hint="The stats API didn't answer. Check the connection and try again."
            onRetry={() => void stats.refetch()}
          />
        ) : !data ? (
          <PerformanceSkeleton />
        ) : data.closedCount === 0 ? (
          <StateMessage
            icon={<Trophy size={18} />}
            title="No closed trades yet"
            hint="Your realized performance will appear here."
          />
        ) : (
          <PerformanceBody stats={data} now={now} />
        )}
      </Card.Content>
    </Card.Root>
  );
};

interface PerformanceBodyProps {
  stats: Stats;
  now: number;
}

const PerformanceBody = ({ stats, now }: PerformanceBodyProps) => (
  <div className="flex flex-col">
    <PnlBridge positionsPnl={stats.totalPnlSol} now={now} />
    <div className={cn(GRID, 'mt-6 border-border border-t pt-6')}>
      <StatTile
        label="Win rate"
        value={`${stats.winRate.toFixed(0)}%`}
        sub={`${stats.wins}W · ${stats.losses}L`}
      />
      <StatTile
        label="Profit factor"
        tone={stats.profitFactor === 0 ? 'neutral' : stats.profitFactor >= 1 ? 'profit' : 'loss'}
        value={stats.profitFactor > 0 ? stats.profitFactor.toFixed(2) : '—'}
        sub="gross W / L"
      />
      <StatTile
        label="Expected value"
        tone={toneOf(stats.expectedValueSol)}
        value={<MoneyValue value={stats.expectedValueSol} signed />}
        sub="per trade"
      />
      <StatTile
        label="Avg invested"
        value={<MoneyValue value={stats.avgInvestedSol} />}
        sub="per trade"
      />
      <StatTile
        label="Avg / month"
        tone={toneOf(stats.avgMonthlyProfitSol)}
        value={<MoneyValue value={stats.avgMonthlyProfitSol} signed />}
      />
      <StatTile label="Avg hold" value={fmtDuration(stats.avgDurationSeconds)} />
      <StatTile
        label="Fees earned"
        value={<MoneyValue value={stats.totalFeesSol} />}
        sub="all-time"
      />
      <StatTile
        label="Volume"
        value={<MoneyValue value={stats.totalVolumeSol} />}
        sub="deposited"
      />
    </div>
  </div>
);

/** Mirrors the body's geometry (PnL band, rule, 8 metric tiles) so nothing reflows on arrival. */
const PerformanceSkeleton = () => (
  <div className="flex flex-col">
    <Skeleton.Root className="h-[88px] w-full rounded-lg" />
    <div className={cn(GRID, 'mt-6 border-border border-t pt-6')}>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <Skeleton.Root className="h-3 w-16 rounded" />
          <Skeleton.Root className="h-7 w-20 rounded" />
          <Skeleton.Root className="h-3 w-14 rounded" />
        </div>
      ))}
    </div>
  </div>
);
