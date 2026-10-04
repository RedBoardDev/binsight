import { summarizeSelection } from '@app/applications/Shared/Control/Domain/selectionSummary';
import { FilterMenuTrigger } from '@app/applications/Shared/Control/Ui/FilterMenuTrigger';
import type { MenuOption } from '@app/applications/Shared/Control/Ui/TextMenu';
import { useLanguageTag } from '@app/core/i18n/useLanguageTag';
import { Dropdown, Label } from '@heroui/react';
import { useLingui } from '@lingui/react/macro';

interface MultiSelectMenuProps<Id extends string> {
  label: string;
  options: readonly MenuOption<Id>[];
  selected: readonly Id[];
  onChange: (selected: Id[]) => void;
}

export const MultiSelectMenu = <Id extends string>({
  label,
  options,
  selected,
  onChange,
}: MultiSelectMenuProps<Id>) => {
  const { t } = useLingui();
  const labels = options.filter((option) => selected.includes(option.id)).map((o) => o.label);
  const languageTag = useLanguageTag();
  const summary = summarizeSelection(labels, languageTag);
  const value =
    summary.kind === 'everything'
      ? t`All`
      : summary.kind === 'named'
        ? summary.text
        : `${summary.first} +${summary.others}`;

  return (
    <Dropdown>
      <FilterMenuTrigger label={label} value={value} isFiltering={summary.kind !== 'everything'} />
      <Dropdown.Popover placement="bottom start" className="min-w-48">
        <Dropdown.Menu
          aria-label={label}
          selectionMode="multiple"
          selectedKeys={selected}
          onSelectionChange={(keys) =>
            onChange(
              options
                .filter((option) => keys === 'all' || keys.has(option.id))
                .map((option) => option.id),
            )
          }
        >
          {options.map((option) => (
            <Dropdown.Item key={option.id} id={option.id} textValue={option.label}>
              <Dropdown.ItemIndicator type="checkmark" />
              <Label>{option.label}</Label>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
};
