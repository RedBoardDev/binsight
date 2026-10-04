import type { ReactNode } from 'react';

interface PageColumnProps {
  children: ReactNode;
  className?: string;
}

export const PageColumn = ({ children, className = '' }: PageColumnProps) => (
  <div className={`page-gutter mx-auto w-full max-w-page ${className}`}>{children}</div>
);
