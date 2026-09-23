'use client';

import { toneOf } from '@app/applications/Shared/Domain/tone';
import { StatTile } from '@app/applications/Shared/Ui/StatTile';
import { TickFlash } from '@app/applications/Shared/Ui/TickFlash';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';
import type { PortfolioTotals } from '@binsight/shared';
import { Chip } from '@heroui/react';

interface PortfolioTileProps {
  totals: PortfolioTotals;
}

/** The headline tiles both the desktop hero and the mobile stats grid show, so the two layouts read
 *  the same figure the same way. */
export const ActivePnlTile = ({ totals }: PortfolioTileProps) => {
  const money = useMoney();
  return (
    <StatTile
      label="Active PnL"
      tone={toneOf(totals.uPnlSol)}
      value={
        <TickFlash value={totals.uPnlSol}>{money.sol(totals.uPnlSol, { signed: true })}</TickFlash>
      }
      sub={money.pct(totals.uPnlPct)}
    />
  );
};

export const OpenCountTile = ({ totals }: PortfolioTileProps) => (
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
);
