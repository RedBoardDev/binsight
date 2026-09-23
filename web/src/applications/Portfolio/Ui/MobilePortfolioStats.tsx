'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { ActivePnlTile, OpenCountTile } from '@app/applications/Portfolio/Ui/PortfolioStatTiles';
import { pctOf } from '@app/applications/Shared/Domain/percent';
import { StatTile } from '@app/applications/Shared/Ui/StatTile';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';
import { Card } from '@heroui/react';

/** Secondary portfolio metrics — Active PnL · Open · Fees · TVL. Shown on the Positions tab only,
 *  keeping the global MobilePortfolioSummary header compact. */
export const MobilePortfolioStats = () => {
  const portfolio = usePortfolioFeed((s) => s.portfolio);
  const money = useMoney();

  if (!portfolio) return null;

  const totals = portfolio.totals;

  return (
    <Card.Root className="p-4">
      <Card.Content className="grid grid-cols-2 gap-x-5 gap-y-5">
        <ActivePnlTile totals={totals} />
        <OpenCountTile totals={totals} />
        <StatTile
          label="Fees"
          value={money.sol(totals.feesSol)}
          sub={`${money.pct(pctOf(totals.feesSol, totals.tvlSol))} of TVL`}
        />
        <StatTile label="TVL" value={money.sol(totals.tvlSol)} />
      </Card.Content>
    </Card.Root>
  );
};
