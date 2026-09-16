'use client';

import { fetchPositionCard } from '@app/applications/Position/Api/usePositions.api';
import { strategyLabel } from '@app/applications/Position/Domain/positionLabels';
import { ImageShareDialog } from '@app/applications/Position/Ui/SharePnlCardButton/ImageShareDialog';
import { fmtDuration } from '@app/applications/Shared/Domain/formatters';
import { toneOf, toneTextClass } from '@app/applications/Shared/Domain/tone';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';
import type { ClosedPosition } from '@binsight/shared';
import { Button, Chip, cn, Tooltip } from '@heroui/react';
import { Share2 } from 'lucide-react';
import { useCallback, useState } from 'react';

interface SharePnlCardButtonProps {
  position: ClosedPosition;
  className?: string;
}

/**
 * A discreet share affordance for a closed position: opens the share dialog with the position
 * summary, the server-rendered PnL card PNG and share / copy / download.
 */
export const SharePnlCardButton = ({ position, className }: SharePnlCardButtonProps) => {
  const [isOpen, setOpen] = useState(false);
  const money = useMoney();
  const pair = `${position.tokenX}/${position.tokenY}`;
  // Mirror the server-rendered card, which draws the position's native quote.
  const quoteSymbol = position.quoteSymbol ?? 'SOL';
  const pnl = position.pnlQuote ?? position.pnlSol;
  const tone = toneOf(pnl);
  const strategy = strategyLabel(position.strategy);
  const filename = `pnl-${position.tokenX}-${position.tokenY}.png`.replace(/[^\w.-]+/g, '_');

  const getImage = useCallback(
    (signal?: AbortSignal) => fetchPositionCard(position.positionAddress, signal),
    [position.positionAddress],
  );

  return (
    <>
      <Tooltip.Root>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label="Share PnL card"
          className={cn('text-faint', className)}
          onPress={() => setOpen(true)}
        >
          <Share2 size={16} />
        </Button>
        <Tooltip.Content>Share PnL card</Tooltip.Content>
      </Tooltip.Root>
      <ImageShareDialog
        isOpen={isOpen}
        onClose={() => setOpen(false)}
        title={pair}
        filename={filename}
        shareTitle={`${pair} — PnL`}
        aspect="3 / 2"
        getImage={getImage}
        summary={
          <div className="flex items-start justify-between gap-3">
            <div className={cn('tabular leading-tight', toneTextClass[tone])}>
              <div className="font-semibold text-2xl">
                {money.quote(pnl, quoteSymbol, { signed: true })}
              </div>
              <div className="text-sm opacity-75">
                {money.pct(position.pnlPctQuote ?? position.pnlPctSol)}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 text-faint text-xs">
              {strategy && (
                <Chip.Root size="sm" variant="soft" color="default">
                  <Chip.Label>{strategy}</Chip.Label>
                </Chip.Root>
              )}
              <span className="tabular">
                Fees {money.quote(position.feesQuote ?? position.feesSol, quoteSymbol)} · Invested{' '}
                {money.quote(position.depositQuote ?? position.depositSol, quoteSymbol)}
              </span>
              <span className="tabular">Held {fmtDuration(position.durationSeconds)}</span>
            </div>
          </div>
        }
      />
    </>
  );
};
