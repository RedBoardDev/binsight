'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { feeApr, fmtFeeApr } from '@app/applications/Position/Domain/feeApr';
import type { OpenPositionEntity } from '@app/applications/Position/Domain/position';
import { rangeChipColor, rangeLabel } from '@app/applications/Position/Domain/positionLabels';
import { fmtDuration } from '@app/applications/Shared/Domain/formatters';
import { MoneyValue } from '@app/applications/Shared/Ui/MoneyValue';
import { SectionLabel } from '@app/applications/Shared/Ui/SectionLabel';
import { StatTile } from '@app/applications/Shared/Ui/StatTile';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';
import { Chip } from '@heroui/react';

interface OpenPositionSummaryProps {
  position: OpenPositionEntity;
}

/** The live figures of an open position: value, unrealized PnL, fee yield, range. */
export const OpenPositionSummary = ({ position }: OpenPositionSummaryProps) => {
  const money = useMoney();
  const walletTotal = usePortfolioFeed(
    (s) => s.portfolio?.open.reduce((sum, open) => sum + open.sizeSol, 0) ?? 0,
  );
  const heldSeconds = position.raw.openedAt ? (Date.now() - position.raw.openedAt) / 1000 : 0;
  const apr = feeApr(position.totalFeesSol, position.sizeSol, heldSeconds);
  const share = walletTotal > 0 ? (position.sizeSol / walletTotal) * 100 : null;
  const openedFor = position.raw.openedAt ? fmtDuration(heldSeconds) : '—';

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Position</SectionLabel>
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 md:gap-x-6">
        <StatTile label="Value" value={<MoneyValue value={position.sizeSol} />} />
        <StatTile
          label="Unrealized PnL"
          tone={position.tone}
          value={<MoneyValue value={position.pnlSol} signed />}
          sub={money.pct(position.pnlPct)}
        />
        <StatTile
          label="Fee APR"
          value={fmtFeeApr(apr)}
          sub={`${position.feeYieldPct.toFixed(2)}% earned`}
        />
        <StatTile label="Share of wallet" value={share == null ? '—' : `${share.toFixed(1)}%`} />
        <StatTile label="Claimed fees" value={<MoneyValue value={position.raw.claimedFeesSol} />} />
        <StatTile
          label="Unclaimed fees"
          tone={position.raw.unclaimedFeesSol > 0 ? 'profit' : 'neutral'}
          value={<MoneyValue value={position.raw.unclaimedFeesSol} />}
        />
        <StatTile label="Open for" value={openedFor} />
        <StatTile
          label="Range"
          value={
            <Chip.Root size="md" variant="soft" color={rangeChipColor(position.rangeStatus)}>
              <Chip.Label>{rangeLabel(position.rangeStatus)}</Chip.Label>
            </Chip.Root>
          }
        />
      </div>
    </section>
  );
};
