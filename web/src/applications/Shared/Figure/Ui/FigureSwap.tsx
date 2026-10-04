import { type ReactNode, useState } from 'react';

interface FigureSwapProps {
  // The figure as text: a new text is a new figure.
  value: string;
  children: ReactNode;
}

const ENTRANCE =
  'transition-[opacity,translate,background-color] duration-(--duration-figure) ease-out starting:translate-y-0.5 starting:bg-foreground/8 starting:opacity-0';

// Never a count from the old number to the new one: a number in between would be a figure that
// never existed. The first value appears without motion; reduced motion zeroes the durations.
export const FigureSwap = ({ value, children }: FigureSwapProps) => {
  const [firstValue] = useState(value);
  const [hasChanged, setHasChanged] = useState(false);
  if (!hasChanged && value !== firstValue) {
    setHasChanged(true);
  }

  return (
    <span key={value} className={`inline-flex rounded-sm ${hasChanged ? ENTRANCE : ''}`}>
      {children}
    </span>
  );
};
