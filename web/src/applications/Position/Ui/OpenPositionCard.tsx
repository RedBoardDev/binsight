'use client';

import type { OpenPositionEntity } from '@app/applications/Position/Domain/position';
import { rangeChipColor, rangeShortLabel } from '@app/applications/Position/Domain/positionLabels';
import { BinChart } from '@app/applications/Position/Ui/BinChart';
import { PnlCell } from '@app/applications/Position/Ui/PnlCell';
import { TokenPair } from '@app/applications/Position/Ui/TokenPair';
import { fmtDuration } from '@app/applications/Shared/Domain/formatters';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';
import { useUi } from '@app/core/stores/uiStore';
import { Button, Chip } from '@heroui/react';

/** Card chrome shared by both mobile cards: a full-width tap target, roomy enough for a thumb. */
const CARD_CLASS =
  'h-auto min-h-[4.5rem] flex-col items-stretch gap-2.5 whitespace-normal rounded-2xl p-3 text-left';

interface OpenPositionCardProps {
  position: OpenPositionEntity;
  now: number;
}

/** The mobile stand-in for a desktop row: the whole card opens the detail sheet. */
export const OpenPositionCard = ({ position, now }: OpenPositionCardProps) => {
  const select = useUi((s) => s.select);
  const money = useMoney();
  const age = position.raw.openedAt ? fmtDuration((now - position.raw.openedAt) / 1000) : '—';

  return (
    <Button
      variant="tertiary"
      fullWidth
      className={CARD_CLASS}
      onPress={() => select({ address: position.address, pair: position.pair, open: true })}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <TokenPair
            pair={position.pair}
            iconX={position.raw.tokenXIcon}
            iconY={position.raw.tokenYIcon}
            strategy={position.strategy}
          />
          <Chip.Root
            size="sm"
            variant="soft"
            color={rangeChipColor(position.rangeStatus)}
            className="shrink-0"
          >
            <Chip.Label>{rangeShortLabel(position.rangeStatus)}</Chip.Label>
          </Chip.Root>
        </div>
        <PnlCell
          sol={position.displayPnl}
          pct={position.pnlPct}
          quoteSymbol={position.quoteSymbol}
          tone={position.tone}
          className="shrink-0 whitespace-nowrap text-right"
        />
      </div>

      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 leading-snug">
          <div className="tabular text-muted text-xs">
            Size {money.quote(position.displaySize, position.quoteSymbol)} · {age}
          </div>
          <div className="tabular text-muted text-xs">
            Fees {money.quote(position.displayTotalFees, position.quoteSymbol)} ·{' '}
            {position.displaySize > 0 ? `${position.feeYieldPct.toFixed(2)}%` : '—'}
          </div>
        </div>
        <div className="w-28 shrink-0">
          <BinChart positionAddress={position.address} outOfRange={!position.inRange} />
        </div>
      </div>
    </Button>
  );
};
