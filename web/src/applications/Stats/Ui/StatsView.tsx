'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { PairsCard } from '@app/applications/Stats/Ui/PairsCard';
import { PerformanceCard } from '@app/applications/Stats/Ui/PerformanceCard';
import { PeriodFilterBar } from '@app/applications/Stats/Ui/PeriodFilterBar';
import { PnlChart } from '@app/applications/Stats/Ui/PnlChart';
import { useUi } from '@app/core/stores/uiStore';
import type { Bucket } from '@binsight/shared';
import { useMemo, useState } from 'react';

/**
 * The "Stats" tab — the time controls above the realized-performance stats, the PnL chart and the
 * pair breakdown. Only mounted when the tab is open, so its stats / history / curve fetches never run
 * on a plain reload (which lands on Positions).
 */
export const StatsView = () => {
  const [bucket, setBucket] = useState<Bucket>('day');
  const scope = usePortfolioFeed((s) => s.scope);
  const closedVersion = usePortfolioFeed((s) => s.closedVersion);
  const period = useUi((s) => s.period);

  // One clock for the whole tab, frozen until the wallet, the range or the closed set changes: the
  // period floor feeds every query key, so a render-time Date.now() would mint a new key on each
  // render and refetch forever. Sharing it also keeps the panels on the SAME window.
  // biome-ignore lint/correctness/useExhaustiveDependencies: those deps are the intended cache key — the clock is re-read only when the window they define moves.
  const now = useMemo(() => Date.now(), [scope, period, closedVersion]);

  return (
    <div className="flex flex-col gap-4 md:gap-5">
      <PeriodFilterBar bucket={bucket} onBucket={setBucket} />
      <PerformanceCard now={now} />
      <PnlChart bucket={bucket} now={now} />
      <PairsCard now={now} />
    </div>
  );
};
