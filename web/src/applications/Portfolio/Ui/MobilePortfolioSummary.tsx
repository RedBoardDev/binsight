'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { pctOf } from '@app/applications/Shared/Domain/percent';
import { toneOf, toneTextClass } from '@app/applications/Shared/Domain/tone';
import { SolMark } from '@app/applications/Shared/Ui/SolMark';
import { TickFlash } from '@app/applications/Shared/Ui/TickFlash';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';
import { useStats } from '@app/applications/Stats/Api/useStats.api';
import { Card, cn, Skeleton } from '@heroui/react';

/**
 * Compact global mobile header (rendered on every tab): Net Worth + Today only, to stay small on a
 * phone. The richer metrics live in MobilePortfolioStats on the Positions tab.
 */
export const MobilePortfolioSummary = () => {
  const portfolio = usePortfolioFeed((s) => s.portfolio);
  const scope = usePortfolioFeed((s) => s.scope);
  const closedVersion = usePortfolioFeed((s) => s.closedVersion);
  const scopeLoading = usePortfolioFeed((s) => s.scopeLoading);
  const money = useMoney();
  // Today's realized PnL is the backend's single source of truth (/stats.todayPnlSol) — the exact
  // value the macOS app shows. The client must NOT re-derive it.
  const { data: stats } = useStats(scope, closedVersion);

  if (!portfolio) return <Skeleton.Root className="h-[5.5rem] w-full rounded-xl" />;

  const totals = portfolio.totals;
  const today = stats?.todayPnlSol ?? null;
  const todayTone = today != null ? toneOf(today) : 'neutral';

  return (
    <Card.Root
      aria-busy={scopeLoading}
      className={cn('p-4 transition-opacity duration-200', scopeLoading && 'opacity-60')}
    >
      <Card.Content className="flex flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="font-medium text-[11px] text-faint uppercase tracking-wide">
            Net Worth
          </span>
          <TickFlash
            value={totals.walletTotalSol}
            className="tabular mt-1 flex items-center gap-2 font-semibold text-3xl text-foreground leading-none tracking-tight"
          >
            {money.hero(totals.walletTotalSol)}
            {money.showGlyph && <SolMark size={18} />}
          </TickFlash>
          <div className="tabular mt-1.5 text-faint text-xs">
            {money.sol(totals.tvlSol)} LP · {money.sol(totals.idleSol)} idle
          </div>
        </div>
        <div className="shrink-0 text-right">
          <span className="font-medium text-[11px] text-faint uppercase tracking-wide">Today</span>
          <div
            className={cn(
              'tabular mt-1 font-semibold text-lg leading-none',
              toneTextClass[todayTone],
            )}
          >
            {today != null ? money.sol(today, { signed: true }) : '—'}
          </div>
          {today != null && (
            <div
              className={cn(
                'tabular mt-1 text-xs',
                todayTone === 'neutral' ? 'text-faint' : toneTextClass[todayTone],
              )}
            >
              {money.pct(pctOf(today, totals.walletTotalSol))}
            </div>
          )}
        </div>
      </Card.Content>
    </Card.Root>
  );
};
