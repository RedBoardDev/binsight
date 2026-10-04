import { Button } from '@heroui/react';
import { ArrowDown, ArrowUp } from 'lucide-react';

export type SortDirection = 'ascending' | 'descending';

interface SortHeaderProps {
  label: string;
  // The direction when this column sorts the list, null when another one does.
  direction: SortDirection | null;
  onSort: () => void;
  align?: 'start' | 'end';
}

const ALIGN_CLASSES = { start: 'justify-start', end: 'justify-end' } as const;

export const SortHeader = ({ label, direction, onSort, align = 'start' }: SortHeaderProps) => {
  const Arrow = direction === 'ascending' ? ArrowUp : ArrowDown;

  return (
    <th aria-sort={direction ?? 'none'} className={`flex font-normal ${ALIGN_CLASSES[align]}`}>
      <Button variant="ghost" size="sm" onPress={onSort} className="button--column-header">
        {label}
        {direction !== null && <Arrow aria-hidden strokeWidth={2} className="size-3" />}
      </Button>
    </th>
  );
};
