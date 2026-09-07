import type { Tone } from '@app/applications/Shared/Domain/tone';
import { toneTextClass } from '@app/applications/Shared/Domain/tone';
import { cn } from '@heroui/react';
import type { ReactNode } from 'react';

interface StatTileProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  className?: string;
}

/** A labelled headline metric: caption, large tabular value, optional sub-line. */
export const StatTile = ({ label, value, sub, tone = 'neutral', className }: StatTileProps) => (
  <div className={cn('flex min-w-0 flex-col gap-1', className)}>
    <span className="font-medium text-faint text-xs uppercase tracking-wide">{label}</span>
    <span
      className={cn('tabular font-semibold text-xl leading-none md:text-2xl', toneTextClass[tone])}
    >
      {value}
    </span>
    {sub != null && <span className="tabular truncate text-muted text-sm">{sub}</span>}
  </div>
);
