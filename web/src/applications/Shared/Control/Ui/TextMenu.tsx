import { FilterMenuTrigger } from '@app/applications/Shared/Control/Ui/FilterMenuTrigger';
import { Dropdown, Label } from '@heroui/react';

export interface MenuOption<Id extends string> {
  readonly id: Id;
  readonly label: string;
}

interface TextMenuProps<Id extends string> {
  label: string;
  options: readonly MenuOption<Id>[];
  selected: Id;
  neutral: Id;
  onChange: (selected: Id) => void;
}

export const TextMenu = <Id extends string>({
  label,
  options,
  selected,
  neutral,
  onChange,
}: TextMenuProps<Id>) => {
  const value = options.find((option) => option.id === selected)?.label ?? '';

  return (
    <Dropdown>
      <FilterMenuTrigger label={label} value={value} isFiltering={selected !== neutral} />
      <Dropdown.Popover placement="bottom start" className="min-w-48">
        <Dropdown.Menu
          aria-label={label}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[selected]}
          onSelectionChange={(keys) => {
            const option = options.find((candidate) => keys !== 'all' && keys.has(candidate.id));
            if (option !== undefined) {
              onChange(option.id);
            }
          }}
        >
          {options.map((option) => (
            <Dropdown.Item key={option.id} id={option.id} textValue={option.label}>
              <Label>{option.label}</Label>
              <Dropdown.ItemIndicator />
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
};
