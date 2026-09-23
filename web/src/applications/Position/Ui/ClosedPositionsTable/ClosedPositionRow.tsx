'use client';

import type { ClosedPositionEntity } from '@app/applications/Position/Domain/position';
import { PnlCell } from '@app/applications/Position/Ui/PnlCell';
import { PositionRowShell } from '@app/applications/Position/Ui/PositionRowShell';
import { SharePnlCardButton } from '@app/applications/Position/Ui/SharePnlCardButton';
import { TokenPair } from '@app/applications/Position/Ui/TokenPair';
import { fmtDuration, fmtRelative } from '@app/applications/Shared/Domain/formatters';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';
import { useUi } from '@app/core/stores/uiStore';
import { Table } from '@heroui/react';

interface ClosedPositionRowProps {
  position: ClosedPositionEntity;
  now: number;
  columnCount: number;
  chartOpen: boolean;
  onToggleChart: () => void;
}

export const ClosedPositionRow = ({
  position,
  now,
  columnCount,
  chartOpen,
  onToggleChart,
}: ClosedPositionRowProps) => {
  const select = useUi((s) => s.select);
  const money = useMoney();

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
        openedAt: position.raw.openedAt,
        closedAt: position.raw.closedAt,
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
          actions={<SharePnlCardButton position={position.raw} />}
        />
      </Table.Cell>
      <Table.Cell className="tabular text-right text-muted">
        {fmtDuration(position.durationSeconds)}
      </Table.Cell>
      <Table.Cell className="tabular text-right text-muted">
        {money.quote(position.displayDeposit, position.quoteSymbol)}
      </Table.Cell>
      <Table.Cell className="tabular text-right">
        {money.quote(position.displayFees, position.quoteSymbol)}
      </Table.Cell>
      <Table.Cell className="text-right">
        <PnlCell
          sol={position.displayPnl}
          pct={position.pnlPct}
          quoteSymbol={position.quoteSymbol}
          tone={position.tone}
          className="inline-block text-right"
        />
      </Table.Cell>
      <Table.Cell className="tabular text-right text-muted text-xs">
        {fmtRelative(position.closedAt, now)}
      </Table.Cell>
    </PositionRowShell>
  );
};
