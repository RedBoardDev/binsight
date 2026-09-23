'use client';

import type { OpenPositionEntity } from '@app/applications/Position/Domain/position';
import { rangeLabel } from '@app/applications/Position/Domain/positionLabels';
import { BinChart } from '@app/applications/Position/Ui/BinChart';
import { PnlCell } from '@app/applications/Position/Ui/PnlCell';
import { PositionRowShell } from '@app/applications/Position/Ui/PositionRowShell';
import { TokenPair } from '@app/applications/Position/Ui/TokenPair';
import { fmtDuration } from '@app/applications/Shared/Domain/formatters';
import { TickFlash } from '@app/applications/Shared/Ui/TickFlash';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';
import { useUi } from '@app/core/stores/uiStore';
import { Table, Tooltip } from '@heroui/react';

interface OpenPositionRowProps {
  position: OpenPositionEntity;
  now: number;
  columnCount: number;
  chartOpen: boolean;
  onToggleChart: () => void;
}

export const OpenPositionRow = ({
  position,
  now,
  columnCount,
  chartOpen,
  onToggleChart,
}: OpenPositionRowProps) => {
  const select = useUi((s) => s.select);
  const money = useMoney();
  const claimed = money.quote(position.displayClaimedFees, position.quoteSymbol);
  const unclaimed = money.quote(position.displayUnclaimedFees, position.quoteSymbol);

  return (
    <PositionRowShell
      rowId={position.address}
      textValue={position.pair}
      columnCount={columnCount}
      chartOpen={chartOpen}
      onToggleChart={onToggleChart}
      onOpen={() => select(position.selection)}
      chart={{
        positionAddress: position.address,
        poolAddress: position.raw.poolAddress,
        tokenX: position.raw.tokenX,
        tokenMint: position.raw.tokenXMint,
        minPrice: position.raw.minPrice,
        maxPrice: position.raw.maxPrice,
        rangeStatus: position.raw.rangeStatus,
        openedAt: position.raw.openedAt,
        closedAt: null,
      }}
    >
      <Table.Cell>
        <TokenPair
          pair={position.pair}
          iconX={position.raw.tokenXIcon}
          iconY={position.raw.tokenYIcon}
          strategy={position.strategy}
          poolAddress={position.raw.poolAddress}
          tokenMint={position.raw.tokenXMint}
        />
      </Table.Cell>
      <Table.Cell className="tabular text-right text-muted">
        {fmtDuration(position.ageSeconds(now))}
      </Table.Cell>
      <Table.Cell className="tabular text-right">
        {money.quote(position.displaySize, position.quoteSymbol)}
      </Table.Cell>
      <Table.Cell className="tabular text-right">
        <div
          className="inline-flex items-baseline gap-1.5"
          title={`${claimed} claimed · ${unclaimed} unclaimed`}
        >
          <span className="text-muted">{claimed}</span>
          <span className="text-faint">·</span>
          <span className="text-profit">{unclaimed}</span>
          <span className="text-faint text-xs">
            {position.displaySize > 0 ? `${position.feeYieldPct.toFixed(2)}%` : '—'}
          </span>
        </div>
      </Table.Cell>
      <Table.Cell className="text-right">
        <TickFlash value={position.displayPnl} className="inline-block">
          <PnlCell
            sol={position.displayPnl}
            pct={position.pnlPct}
            tone={position.tone}
            quoteSymbol={position.quoteSymbol}
          />
        </TickFlash>
      </Table.Cell>
      <Table.Cell>
        {/* The bin chart IS the range read: the marker pinned left means below, pinned right means
            above, and its colour carries in/out — so the status chip that used to sit above it was
            both redundant and the reason every row needed two lines. */}
        <Tooltip.Root delay={400}>
          <Tooltip.Trigger>
            <div className="ml-auto w-28 cursor-default">
              <BinChart positionAddress={position.address} outOfRange={!position.inRange} />
            </div>
          </Tooltip.Trigger>
          <Tooltip.Content>{rangeLabel(position.rangeStatus)}</Tooltip.Content>
        </Tooltip.Root>
      </Table.Cell>
    </PositionRowShell>
  );
};
