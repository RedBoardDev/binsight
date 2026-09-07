'use client';

import { feeApr, fmtFeeApr } from '@app/applications/Position/Domain/feeApr';
import { fmtAmount, fmtDate, fmtDuration } from '@app/applications/Shared/Domain/formatters';
import { toneOf, toneTextClass } from '@app/applications/Shared/Domain/tone';
import { MoneyValue } from '@app/applications/Shared/Ui/MoneyValue';
import { SectionLabel } from '@app/applications/Shared/Ui/SectionLabel';
import { StatTile } from '@app/applications/Shared/Ui/StatTile';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';
import type { ClosedPosition } from '@binsight/shared';
import { cn } from '@heroui/react';

interface BreakdownRowProps {
  label: string;
  value: number;
  strong?: boolean;
}

const BreakdownRow = ({ label, value, strong }: BreakdownRowProps) => (
  <div className="flex items-center justify-between">
    <span className={strong ? 'font-medium text-foreground' : 'text-muted'}>{label}</span>
    <span className={cn('tabular', strong && 'font-medium', toneTextClass[toneOf(value)])}>
      <MoneyValue value={value} signed />
    </span>
  </div>
);

interface ClosedPositionSummaryProps {
  position: ClosedPosition;
}

/** The realized figures of a closed position, plus the invested → withdrawn → fees breakdown that
 *  reconciles to the net PnL. Every number comes from the backend; none is re-derived here. */
export const ClosedPositionSummary = ({ position }: ClosedPositionSummaryProps) => {
  const money = useMoney();
  const apr = feeApr(position.feesSol, position.depositSol, position.durationSeconds ?? 0);
  const hasResidual = (position.residualAmount ?? 0) > 0 && !!position.residualMint;

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Summary</SectionLabel>
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 md:gap-x-6">
        <StatTile
          label="Realized PnL"
          tone={toneOf(position.pnlSol)}
          value={<MoneyValue value={position.pnlSol} signed />}
          sub={money.pct(position.pnlPctSol)}
        />
        <StatTile
          label="Fee earned"
          value={<MoneyValue value={position.feesSol} />}
          sub={`${fmtFeeApr(apr)} APR`}
        />
        <StatTile label="Invested" value={<MoneyValue value={position.depositSol} />} />
        <StatTile label="Withdrawn" value={<MoneyValue value={position.withdrawSol} />} />
        <StatTile label="Opened" value={fmtDate(position.openedAt)} />
        <StatTile
          label="Closed"
          value={fmtDate(position.closedAt)}
          sub={fmtDuration(position.durationSeconds)}
        />
      </div>

      <div className="mt-2 flex flex-col gap-2">
        <SectionLabel>Breakdown</SectionLabel>
        <div className="flex flex-col gap-1.5 text-sm">
          <BreakdownRow label="Invested" value={-position.depositSol} />
          <BreakdownRow label="Withdrawn" value={position.withdrawSol} />
          <BreakdownRow label="Fees" value={position.feesSol} />
          {hasResidual && (
            <BreakdownRow label="Residual (sold/marked)" value={position.residualMarkSol ?? 0} />
          )}
          <div className="mt-1 border-border border-t pt-1.5">
            <BreakdownRow label="Net PnL" value={position.pnlSol} strong />
          </div>
        </div>
      </div>

      {hasResidual && (
        <p className="text-faint text-xs">
          Residual {fmtAmount(position.residualAmount ?? 0)} {position.tokenX} left at close, marked
          at <MoneyValue value={position.residualMarkSol ?? 0} /> (
          {position.pnlSource === 'market' ? 'live price' : 'pool spot'}).
        </p>
      )}
    </section>
  );
};
