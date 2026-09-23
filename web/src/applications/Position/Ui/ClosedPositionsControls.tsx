'use client';

import {
  CLOSED_RESULTS,
  CLOSED_SORTS,
  type ClosedPositionsQueryState,
} from '@app/applications/Position/Ui/useClosedPositionsQuery';
import { Button, SearchField, ToggleButton, ToggleButtonGroup, Tooltip } from '@heroui/react';
import { ArrowDown, ArrowUp, Download } from 'lucide-react';

interface SegmentProps<T extends string> {
  label: string;
  options: { label: string; value: T }[];
  value: T;
  onChange: (value: T) => void;
  itemClassName?: string;
}

const Segment = <T extends string>({
  label,
  options,
  value,
  onChange,
  itemClassName,
}: SegmentProps<T>) => (
  <ToggleButtonGroup.Root
    size="sm"
    selectionMode="single"
    disallowEmptySelection
    aria-label={label}
    selectedKeys={[value]}
    onSelectionChange={(keys) => {
      const [key] = [...keys];
      if (key != null) onChange(key as T);
    }}
  >
    {options.map((option) => (
      <ToggleButton.Root key={option.value} id={option.value} className={itemClassName}>
        {option.label}
      </ToggleButton.Root>
    ))}
  </ToggleButtonGroup.Root>
);

interface ClosedPositionsControlsProps {
  closed: ClosedPositionsQueryState;
  /** Phone layout: the search on its own full-width line, then one scrollable row of controls that
   *  each carry the 44px minimum touch target (and no hover tooltips). */
  touch?: boolean;
}

/** The history filter toolbar — search, win/loss, sort + direction, CSV export of the current
 *  filter — shared by the desktop table and the mobile list. */
export const ClosedPositionsControls = ({
  closed,
  touch = false,
}: ClosedPositionsControlsProps) => {
  const itemClassName = touch ? 'h-11' : undefined;
  const iconClassName = touch ? 'size-11' : undefined;
  const direction = closed.dir === 'asc' ? 'Sorted ascending' : 'Sorted descending';

  const search = (
    <SearchField.Root
      aria-label="Search pair"
      value={closed.qInput}
      onChange={closed.setQInput}
      fullWidth={touch}
      className={touch ? undefined : 'w-full sm:w-48'}
    >
      <SearchField.Group>
        <SearchField.SearchIcon />
        <SearchField.Input
          placeholder="Search pair…"
          spellCheck={false}
          className={touch ? 'text-base' : undefined}
        />
        <SearchField.ClearButton />
      </SearchField.Group>
    </SearchField.Root>
  );
  const resultFilter = (
    <Segment
      label="Result filter"
      options={CLOSED_RESULTS}
      value={closed.result}
      onChange={closed.setResult}
      itemClassName={itemClassName}
    />
  );
  const sortBy = (
    <Segment
      label="Sort by"
      options={CLOSED_SORTS}
      value={closed.sort}
      onChange={closed.setSort}
      itemClassName={itemClassName}
    />
  );
  const directionToggle = (
    <ToggleButton.Root
      isIconOnly
      className={iconClassName}
      size="sm"
      variant="ghost"
      isSelected={closed.dir === 'asc'}
      onChange={(isAscending) => closed.setDir(isAscending ? 'asc' : 'desc')}
      aria-label={direction}
    >
      {closed.dir === 'asc' ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
    </ToggleButton.Root>
  );
  const exportButton = (
    <Button
      isIconOnly
      className={iconClassName}
      size="sm"
      variant="ghost"
      isDisabled={closed.total === 0}
      onPress={closed.exportCsv}
      aria-label="Export CSV"
    >
      <Download size={16} />
    </Button>
  );

  if (touch) {
    return (
      <>
        {search}
        <div className="scrollbar-none flex items-center gap-2 overflow-x-auto py-0.5">
          {resultFilter}
          {sortBy}
          {directionToggle}
          {exportButton}
        </div>
      </>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-border border-b px-4 pb-3">
      {search}
      {resultFilter}
      <div className="ml-auto flex items-center gap-2">
        {sortBy}
        <Tooltip.Root>
          {directionToggle}
          <Tooltip.Content>{direction}</Tooltip.Content>
        </Tooltip.Root>
        <Tooltip.Root>
          {exportButton}
          <Tooltip.Content>Export current filter as CSV</Tooltip.Content>
        </Tooltip.Root>
      </div>
    </div>
  );
};
