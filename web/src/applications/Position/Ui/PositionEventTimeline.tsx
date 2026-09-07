import { fmtAmount, fmtDateTime } from '@app/applications/Shared/Domain/formatters';
import type { PositionEvent, PositionEventKind } from '@binsight/shared';
import { cn } from '@heroui/react';

const KIND_META: Record<PositionEventKind, { label: string; dot: string }> = {
  open: { label: 'Opened', dot: 'bg-bin-y' },
  deposit: { label: 'Deposit', dot: 'bg-bin-x' },
  withdraw: { label: 'Withdraw', dot: 'bg-warning' },
  claim: { label: 'Claim fees', dot: 'bg-success' },
  close: { label: 'Closed', dot: 'bg-faint' },
};

interface PositionEventTimelineProps {
  events: PositionEvent[];
  symbolX: string;
  symbolY: string;
}

/** Vertical event timeline (newest first), reconstructed from on-chain history. */
export const PositionEventTimeline = ({ events, symbolX, symbolY }: PositionEventTimelineProps) => {
  const ordered = [...events].reverse();
  return (
    <ol className="relative ml-1 border-border border-l">
      {ordered.map((event, index) => {
        const meta = KIND_META[event.kind];
        const amounts = [
          event.amountX !== 0 ? `${fmtAmount(event.amountX)} ${symbolX}` : null,
          event.amountY !== 0 ? `${fmtAmount(event.amountY)} ${symbolY}` : null,
        ].filter((amount) => amount != null);
        return (
          <li key={`${event.signature}-${event.kind}-${index}`} className="relative py-2.5 pl-5">
            <span className={cn('-left-[5px] absolute top-3.5 size-2 rounded-full', meta.dot)} />
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground text-sm">{meta.label}</span>
              <span className="tabular text-faint text-xs">{fmtDateTime(event.at)}</span>
            </div>
            {amounts.length > 0 && (
              <div className="tabular text-muted text-xs">{amounts.join(' · ')}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
};
