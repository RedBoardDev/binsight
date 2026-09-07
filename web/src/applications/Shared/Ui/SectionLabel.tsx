import { cn } from '@heroui/react';
import type { ReactNode } from 'react';

interface SectionLabelProps {
  children: ReactNode;
  count?: number;
  className?: string;
}

/** Uppercase section caption with an optional count, mirroring the native clients' section label. */
export const SectionLabel = ({ children, count, className }: SectionLabelProps) => (
  <div className={cn('flex items-center gap-2', className)}>
    <span className="font-semibold text-[11px] text-faint uppercase tracking-wide">{children}</span>
    {count != null && <span className="tabular text-faint text-xs">{count}</span>}
  </div>
);
