'use client';

import { cn } from '@heroui/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

interface TickFlashProps {
  value: number;
  className?: string;
  children: ReactNode;
}

/**
 * Briefly washes its background green or red when the numeric `value` changes — the visual echo of a
 * socket tick. Re-keying restarts the one-shot CSS animation; reduced motion disables it globally.
 */
export const TickFlash = ({ value, className, children }: TickFlashProps) => {
  const previous = useRef(value);
  const [flash, setFlash] = useState<{ direction: '' | 'up' | 'down'; run: number }>({
    direction: '',
    run: 0,
  });

  useEffect(() => {
    if (value === previous.current) return;
    const direction = value > previous.current ? 'up' : 'down';
    previous.current = value;
    setFlash((f) => ({ direction, run: f.run + 1 }));
  }, [value]);

  return (
    <span
      key={flash.run}
      className={cn(
        '-mx-1 rounded px-1',
        flash.direction === 'up' && 'tick-up',
        flash.direction === 'down' && 'tick-down',
        className,
      )}
    >
      {children}
    </span>
  );
};
