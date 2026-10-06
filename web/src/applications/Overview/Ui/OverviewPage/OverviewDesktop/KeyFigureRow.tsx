import type { ReactNode } from 'react';

interface KeyFigureRowProps {
  readonly label: ReactNode;
  readonly figure: ReactNode;
  readonly percent?: ReactNode;
  readonly caption?: ReactNode;
}

// One line of the list (KeyFigureList holds the columns), 40 px with its hairline: the label on
// the left, the figure on the right, its percent in the shared gutter; an optional caption under.
export const KeyFigureRow = ({ label, figure, percent, caption }: KeyFigureRowProps) => (
  <div className="col-span-3 grid min-h-10 grid-cols-subgrid items-center border-border-subtle border-t first:border-t-0">
    <dt className="min-w-0 truncate text-meta text-muted">{label}</dt>
    <dd className="text-right">{figure}</dd>
    <dd className="text-right text-faint text-small">{percent}</dd>
    {caption !== undefined && caption !== null && (
      <dd className="col-span-3 pb-2 text-faint text-small">{caption}</dd>
    )}
  </div>
);
