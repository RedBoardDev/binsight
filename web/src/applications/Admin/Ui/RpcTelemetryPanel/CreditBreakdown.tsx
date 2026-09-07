'use client';

import type { CreditWeight } from '@app/applications/Admin/Domain/rpcTelemetry';
import { maxCredits, sortedByCredits } from '@app/applications/Admin/Domain/rpcTelemetry';
import { fmtAmount } from '@app/applications/Shared/Domain/formatters';
import { Card, cn } from '@heroui/react';
import { BAR_FILL_CLASS, WEIGHT_LABEL_CLASS } from './creditWeightClass';

interface CreditBarProps {
  label: string;
  credits: number;
  max: number;
  weight: CreditWeight;
}

const CreditBar = ({ label, credits, max, weight }: CreditBarProps) => {
  // Floor the fill at 2% so a tiny-but-present value still draws a sliver (visible, not zero-width).
  const pct = max > 0 ? Math.max(2, (credits / max) * 100) : 0;

  return (
    <div className="flex items-center gap-3">
      <div
        className={cn('w-32 shrink-0 truncate text-xs sm:w-40', WEIGHT_LABEL_CLASS[weight])}
        title={label}
      >
        {label}
      </div>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-surface-secondary">
        <div
          className={cn('absolute inset-y-0 left-0 rounded-full', BAR_FILL_CLASS[weight])}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="tabular w-16 shrink-0 text-right text-xs">{fmtAmount(credits)}</div>
    </div>
  );
};

interface LegendDotProps {
  className: string;
  label: string;
}

const LegendDot = ({ className, label }: LegendDotProps) => (
  <span className="flex items-center gap-1.5">
    <span className={cn('size-2 rounded-full', className)} />
    {label}
  </span>
);

interface CreditBreakdownProps {
  title: string;
  credits: Record<string, number>;
  weightOf?: (key: string) => CreditWeight;
  labelOf?: (key: string) => string;
  showLegend?: boolean;
}

/** One credit dimension (method, code path, wallet) as a ranked bar list. */
export const CreditBreakdown = ({
  title,
  credits,
  weightOf,
  labelOf,
  showLegend,
}: CreditBreakdownProps) => {
  const entries = sortedByCredits(credits);
  const max = maxCredits(entries);

  return (
    <Card.Root>
      <Card.Header className="flex items-center justify-between gap-3">
        <Card.Title>{title}</Card.Title>
        {showLegend && (
          <div className="flex items-center gap-3 text-faint text-xs">
            <LegendDot className="bg-danger" label="banned (100cr)" />
            <LegendDot className="bg-warning" label="heavy (10cr)" />
          </div>
        )}
      </Card.Header>
      <Card.Content>
        {entries.length === 0 ? (
          <p className="text-muted text-sm">No calls recorded this session.</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {entries.map((entry) => (
              <CreditBar
                key={entry.key}
                label={labelOf ? labelOf(entry.key) : entry.key}
                credits={entry.credits}
                max={max}
                weight={weightOf ? weightOf(entry.key) : 'normal'}
              />
            ))}
          </div>
        )}
      </Card.Content>
    </Card.Root>
  );
};
