import { ToggleButton, ToggleButtonGroup } from '@heroui/react';
import type { LucideIcon } from 'lucide-react';
import { SelectionIndicator } from 'react-aria-components';

export interface TextPillOption<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly Icon?: LucideIcon;
}

interface TextPillsProps<Id extends string> {
  label: string;
  options: readonly TextPillOption<Id>[];
  selected: Id;
  onChange: (selected: Id) => void;
}

export const TextPills = <Id extends string>({
  label,
  options,
  selected,
  onChange,
}: TextPillsProps<Id>) => (
  <ToggleButtonGroup
    aria-label={label}
    selectionMode="single"
    disallowEmptySelection
    size="sm"
    selectedKeys={[selected]}
    onSelectionChange={(keys) => {
      const [key] = keys;
      const option = options.find((candidate) => candidate.id === key);
      if (option !== undefined) {
        onChange(option.id);
      }
    }}
    className="text-pills"
  >
    {options.map((option) => (
      <ToggleButton key={option.id} id={option.id} className="gap-1.5">
        <SelectionIndicator className="text-pills__indicator" />
        {option.Icon !== undefined && (
          <option.Icon aria-hidden strokeWidth={1.75} className="size-3.5" />
        )}
        {option.label}
      </ToggleButton>
    ))}
  </ToggleButtonGroup>
);
