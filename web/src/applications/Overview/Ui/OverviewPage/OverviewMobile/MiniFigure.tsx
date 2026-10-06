import type { ReactNode } from 'react';

const FIGURE_CLASSES = { current: '', stale: 'opacity-(--stale-figure-opacity)' } as const;

interface MiniFigureProps {
  readonly tone: keyof typeof FIGURE_CLASSES;
  readonly label: ReactNode;
  readonly figure: ReactNode;
  readonly caption: ReactNode;
}

// The phone's language: a capital label, a 16 px figure, a short caption; three share a line.
export const MiniFigure = ({ tone, label, figure, caption }: MiniFigureProps) => (
  <div className="min-w-0 flex-1">
    <div className="flex h-5 items-center gap-1">{label}</div>
    <div className={`mt-1 whitespace-nowrap text-section ${FIGURE_CLASSES[tone]}`}>{figure}</div>
    <div className="text-muted text-small">{caption}</div>
  </div>
);
