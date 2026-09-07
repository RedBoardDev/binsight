import { Button, cn, EmptyState } from '@heroui/react';
import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

interface StateMessageProps {
  title: string;
  hint?: ReactNode;
  icon?: ReactNode;
  variant?: 'empty' | 'error';
  onRetry?: () => void;
  className?: string;
}

/**
 * The one placeholder every list, table and panel uses: a quiet empty state, or — with
 * `variant="error"` — a distinct failure with a retry. Keeping both in one component is what stops
 * "still loading" and "the feed is down" from ever looking the same.
 */
export const StateMessage = ({
  title,
  hint,
  icon,
  variant = 'empty',
  onRetry,
  className,
}: StateMessageProps) => {
  const isError = variant === 'error';
  const glyph = icon ?? (isError ? <TriangleAlert size={18} /> : null);

  return (
    <EmptyState.Root
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-10 text-center',
        className,
      )}
    >
      {glyph != null && (
        <span
          className={cn(
            'mb-1 grid size-9 place-items-center rounded-full',
            isError ? 'bg-danger-soft text-danger' : 'bg-surface-secondary text-faint',
          )}
        >
          {glyph}
        </span>
      )}
      <p className={cn('font-medium text-sm', isError ? 'text-foreground' : 'text-muted')}>
        {title}
      </p>
      {hint != null && <p className="max-w-sm text-faint text-xs leading-relaxed">{hint}</p>}
      {isError && onRetry && (
        <Button variant="secondary" size="sm" className="mt-2" onPress={onRetry}>
          Retry
        </Button>
      )}
    </EmptyState.Root>
  );
};
