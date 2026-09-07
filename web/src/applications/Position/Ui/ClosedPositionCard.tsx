'use client';

import type { ClosedPositionEntity } from '@app/applications/Position/Domain/position';
import { PnlCell } from '@app/applications/Position/Ui/PnlCell';
import { TokenPair } from '@app/applications/Position/Ui/TokenPair';
import { fmtRelative } from '@app/applications/Shared/Domain/formatters';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';
import { useUi } from '@app/core/stores/uiStore';
import { Button } from '@heroui/react';

const CARD_CLASS =
  'h-auto min-h-[4.5rem] flex-col items-stretch gap-2 whitespace-normal rounded-2xl p-3 text-left';

interface ClosedPositionCardProps {
  position: ClosedPositionEntity;
  now: number;
}

/** The mobile stand-in for a history row: the whole card opens the detail sheet. */
export const ClosedPositionCard = ({ position, now }: ClosedPositionCardProps) => {
  const select = useUi((s) => s.select);
  const money = useMoney();

  return (
    <Button
      variant="tertiary"
      fullWidth
      className={CARD_CLASS}
      onPress={() =>
        select({
          address: position.address,
          pair: position.pair,
          open: false,
          closed: position.raw,
        })
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <TokenPair
            pair={position.pair}
            iconX={position.raw.tokenXIcon}
            iconY={position.raw.tokenYIcon}
            strategy={position.strategy}
          />
        </div>
        <PnlCell
          sol={position.pnlSol}
          pct={position.pnlPct}
          tone={position.tone}
          className="shrink-0 whitespace-nowrap text-right"
        />
      </div>
      <div className="tabular text-muted text-xs leading-snug">
        Fees {money.sol(position.feesSol)} · invested {money.sol(position.raw.depositSol)} ·{' '}
        {fmtRelative(position.closedAt, now)}
      </div>
    </Button>
  );
};
