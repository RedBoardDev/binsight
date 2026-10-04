import { EmptyState } from '@heroui/react';
import type { ReactNode } from 'react';

interface EmptyBlockProps {
  message: string;
  action?: ReactNode;
}

export const EmptyBlock = ({ message, action }: EmptyBlockProps) => (
  <EmptyState className="flex flex-col items-start gap-2 px-0 py-8">
    <p className="text-body text-muted">{message}</p>
    {action}
  </EmptyState>
);
