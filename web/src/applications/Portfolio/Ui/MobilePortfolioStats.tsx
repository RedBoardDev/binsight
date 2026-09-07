'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { pctOf } from '@app/applications/Shared/Domain/percent';
import { toneOf } from '@app/applications/Shared/Domain/tone';
import { StatTile } from '@app/applications/Shared/Ui/StatTile';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';
import { Card, Chip } from '@heroui/react';

/** Secondary portfolio metrics — Active PnL · Open · Fees · TVL. Shown on the Positions tab only,
 *  keeping the global MobilePortfolioSummary header compact. */
export const MobilePortfolioStats = () => {
  const portfolio = usePortfolioFeed((s) => s.portfolio);
  const money = useMoney();

  if (!portfolio) return null;

  const totals = portfolio.totals;
  const feesTotal = totals.claimedFeesSol + totals.unclaimedFeesSol;

  return (
    <Card.Root className="p-4">
      <Card.Content className="grid grid-cols-2 gap-x-5 gap-y-5">
        <StatTile
          label="Active PnL"
          tone={toneOf(totals.uPnlSol)}
          value={money.sol(totals.uPnlSol, { signed: true })}
          sub={money.pct(totals.uPnlPct)}
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
        <StatTile
          label="Fees"
          value={money.sol(feesTotal)}
          sub={`${money.pct(pctOf(feesTotal, totals.tvlSol))} of TVL`}
        />
        <StatTile label="TVL" value={money.sol(totals.tvlSol)} />
      </Card.Content>
    </Card.Root>
  );
};
