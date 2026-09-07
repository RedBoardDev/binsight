'use client';

import type { Tone } from '@app/applications/Shared/Domain/tone';
import { toneTextClass } from '@app/applications/Shared/Domain/tone';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';
import { cn } from '@heroui/react';

interface PnlCellProps {
  sol: number;
  pct: number;
  tone: Tone;
  className?: string;
}

/** A PnL amount with its percentage stacked beneath — the shared read for rows and cards. */
export const PnlCell = ({ sol, pct, tone, className }: PnlCellProps) => {
  const money = useMoney();
  return (
    <div className={cn('tabular text-sm leading-tight', toneTextClass[tone], className)}>
      <div className="font-medium">{money.sol(sol, { signed: true })}</div>
      <div className="text-xs opacity-80">{money.pct(pct)}</div>
    </div>
  );
};
