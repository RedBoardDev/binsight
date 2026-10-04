import { Button } from '@heroui/react';
import { ChevronDown } from 'lucide-react';

interface FilterMenuTriggerProps {
  label: string;
  value: string;
  isFiltering: boolean;
}

export const FilterMenuTrigger = ({ label, value, isFiltering }: FilterMenuTriggerProps) => (
  <Button variant="ghost" size="sm" className="button--filter">
    <span className="text-faint">{label}</span>
    <span className={isFiltering ? 'text-foreground' : 'text-muted'}>{value}</span>
    <ChevronDown aria-hidden strokeWidth={1.75} className="size-3.5 text-faint" />
  </Button>
);
