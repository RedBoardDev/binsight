'use client';

import type { Tone } from '@app/applications/Shared/Domain/tone';
import { toneTextClass } from '@app/applications/Shared/Domain/tone';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';
import { cn } from '@heroui/react';

interface PnlCellProps {
  /** The amount in `quoteSymbol`'s unit — SOL unless the pool quotes in something else. */
  sol: number;
  pct: number;
  tone: Tone;
  /** Native quote of the position. Defaults to SOL, which follows the SOL⇄USD switch. */
  quoteSymbol?: string;
  className?: string;
}

/** A PnL amount with its percentage stacked beneath — the shared read for rows and cards. */
export const PnlCell = ({ sol, pct, tone, quoteSymbol = 'SOL', className }: PnlCellProps) => {
  const money = useMoney();
  return (
    <div className={cn('tabular text-sm leading-tight', toneTextClass[tone], className)}>
      <div className="font-medium">{money.quote(sol, quoteSymbol, { signed: true })}</div>
      <div className="text-xs opacity-80">{money.pct(pct)}</div>
    </div>
  );
};
