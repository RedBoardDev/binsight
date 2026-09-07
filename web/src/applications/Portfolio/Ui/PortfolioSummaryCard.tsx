'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { pctOf } from '@app/applications/Shared/Domain/percent';
import { toneOf } from '@app/applications/Shared/Domain/tone';
import { SolMark } from '@app/applications/Shared/Ui/SolMark';
import { StatTile } from '@app/applications/Shared/Ui/StatTile';
import { TickFlash } from '@app/applications/Shared/Ui/TickFlash';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';
import { useNetworthCurve, useStats } from '@app/applications/Stats/Api/useStats.api';
import { ALL_TIME_DAYS } from '@app/applications/Stats/Domain/period';
import { periodLabel, realPnlGain } from '@app/applications/Stats/Domain/realPnl';
import { useUi } from '@app/core/stores/uiStore';
import { Card, Chip, cn, Skeleton } from '@heroui/react';

/** The desktop hero: live Net Worth plus the four headline metrics the whole product is read from. */
export const PortfolioSummaryCard = () => {
  const portfolio = usePortfolioFeed((s) => s.portfolio);
  const scope = usePortfolioFeed((s) => s.scope);
  const closedVersion = usePortfolioFeed((s) => s.closedVersion);
  const scopeLoading = usePortfolioFeed((s) => s.scopeLoading);
  const period = useUi((s) => s.period);
  const money = useMoney();
  // The REAL Net Worth curve (on-chain cash + capital deployed in open positions), per UTC day.
  // Fetched all-time and sliced client-side: the period gain is a NetWorth delta off it.
  const { data: curve } = useNetworthCurve(scope, ALL_TIME_DAYS, closedVersion);
  // Today's realized PnL comes from the backend (/stats.todayPnlSol) — the single source of truth, the
  // exact value the macOS/iOS apps show. The client must NOT re-derive it (that drifted from the apps).
  const { data: stats } = useStats(scope, closedVersion);

  if (!portfolio) return <PortfolioSummarySkeleton />;

  const totals = portfolio.totals;
  const today = stats?.todayPnlSol ?? null;
  // GAIN (period) = realPnl(now) − realPnl(start) — the shared headline formula (Stats/Domain/realPnl),
  // so this number and the PnL-bridge hero can never drift.
  const gain = realPnlGain(curve?.points ?? [], period, Date.now(), totals.walletTotalSol);

  return (
    <Card.Root
      aria-busy={scopeLoading}
      className={cn('p-6 transition-opacity duration-200 md:p-7', scopeLoading && 'opacity-60')}
    >
      {/* One grid rather than two blocks pushed to opposite edges: on a wide screen the split left a
          void down the middle of the app's most important card. */}
      <Card.Content className="grid grid-cols-2 items-end gap-x-8 gap-y-7 sm:grid-cols-4 lg:grid-cols-6 lg:gap-x-10">
        <div className="col-span-2 flex min-w-0 flex-col gap-2.5">
          <span className="font-medium text-faint text-xs uppercase tracking-wide">Net Worth</span>
          <TickFlash value={totals.walletTotalSol} className="flex items-center gap-2.5">
            <span className="tabular font-semibold text-4xl text-foreground leading-none tracking-tight md:text-[2.75rem]">
              {money.hero(totals.walletTotalSol)}
            </span>
            {money.showGlyph && <SolMark size={22} />}
          </TickFlash>
          <div className="tabular flex items-center gap-2 text-muted text-sm">
            <span>{money.sol(totals.tvlSol)} LP</span>
            <span className="text-faint">·</span>
            <span>{money.sol(totals.idleSol)} idle</span>
          </div>
        </div>

        <StatTile
          label="Today"
          tone={today != null ? toneOf(today) : 'neutral'}
          value={
            today != null ? (
              <TickFlash value={today}>{money.sol(today, { signed: true })}</TickFlash>
            ) : (
              '—'
            )
          }
          sub={today != null ? money.pct(pctOf(today, totals.walletTotalSol)) : '—'}
        />
        <StatTile
          label="Active PnL"
          tone={toneOf(totals.uPnlSol)}
          value={
            <TickFlash value={totals.uPnlSol}>
              {money.sol(totals.uPnlSol, { signed: true })}
            </TickFlash>
          }
          sub={money.pct(totals.uPnlPct)}
        />
        <StatTile
          label={`Gain (${periodLabel(period)})`}
          tone={gain != null ? toneOf(gain) : 'neutral'}
          value={gain != null ? money.sol(gain, { signed: true }) : '—'}
          sub="Real PnL Δ"
        />
        <StatTile
          label="Open"
          value={totals.openCount}
          sub={
            <span className="flex gap-1.5">
              <Chip.Root color="success" size="sm" variant="soft">
                <Chip.Label>{totals.inRangeCount} in</Chip.Label>
              </Chip.Root>
              <Chip.Root color="warning" size="sm" variant="soft">
                <Chip.Label>{totals.outOfRangeCount} out</Chip.Label>
              </Chip.Root>
            </span>
          }
        />
      </Card.Content>
    </Card.Root>
  );
};

const PortfolioSummarySkeleton = () => (
  <Card.Root className="p-6 md:p-7">
    <Card.Content className="grid grid-cols-2 items-end gap-x-8 gap-y-7 sm:grid-cols-4 lg:grid-cols-6 lg:gap-x-10">
      <div className="col-span-2 flex flex-col gap-2.5">
        <Skeleton.Root className="h-3 w-24" />
        <Skeleton.Root className="h-10 w-48" />
        <Skeleton.Root className="h-4 w-40" />
      </div>
      {['today', 'pnl', 'gain', 'open'].map((key) => (
        <div key={key} className="flex flex-col gap-1">
          <Skeleton.Root className="h-3 w-16" />
          <Skeleton.Root className="h-6 w-24" />
          <Skeleton.Root className="h-4 w-20" />
        </div>
      ))}
    </Card.Content>
  </Card.Root>
);
