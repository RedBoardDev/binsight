import { cn } from '@heroui/react';

interface RangeBarProps {
  /** Pool-price placement inside [min,max], 0..1; null when the pair is not priceable. */
  placement: number | null;
  inRange: boolean;
  className?: string;
}

/** Min↔max range track with a marker showing where the live pool price sits. */
export const RangeBar = ({ placement, inRange, className }: RangeBarProps) => {
  const pct = placement == null ? null : Math.min(100, Math.max(0, placement * 100));
  const accent = inRange ? 'bg-in-range' : 'bg-out-range';
  const label =
    pct == null
      ? 'Price position in range unavailable'
      : `Price at ${Math.round(pct)}% of the range, ${inRange ? 'in range' : 'out of range'}`;

  return (
    <div
      role="img"
      aria-label={label}
      className={cn('relative h-1.5 w-full rounded-full bg-surface-tertiary', className)}
    >
      <div className={cn('absolute inset-0 rounded-full opacity-30', accent)} />
      {pct != null && (
        <span
          className={cn(
            '-translate-x-1/2 -translate-y-1/2 absolute top-1/2 size-2.5 rounded-full border-2 border-background',
            accent,
          )}
          style={{ left: `${pct}%` }}
        />
      )}
    </div>
  );
};
