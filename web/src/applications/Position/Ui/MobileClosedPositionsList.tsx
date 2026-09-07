'use client';

import { ClosedPositionCard } from '@app/applications/Position/Ui/ClosedPositionCard';
import {
  CLOSED_RESULTS,
  CLOSED_SORTS,
  useClosedPositionsQuery,
} from '@app/applications/Position/Ui/useClosedPositionsQuery';
import { PagerBar } from '@app/applications/Shared/Ui/PagerBar';
import { SectionLabel } from '@app/applications/Shared/Ui/SectionLabel';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import { Button, cn, SearchField, Skeleton, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { ArrowDown, ArrowUp, Download, History } from 'lucide-react';

/** Mobile "History" tab: the same headless query as the desktop table, rendered as cards with
 *  compact filter controls above them. */
export const MobileClosedPositionsList = () => {
  const closed = useClosedPositionsQuery();
  const now = Date.now();
  const isFiltered = closed.q !== '' || closed.result !== 'all';

  return (
    <div className="flex flex-col gap-3">
      <SearchField.Root
        aria-label="Search pair"
        value={closed.qInput}
        onChange={closed.setQInput}
        fullWidth
      >
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input placeholder="Search pair…" spellCheck={false} className="text-base" />
          <SearchField.ClearButton />
        </SearchField.Group>
      </SearchField.Root>

      {/* Phone-only view: every control in this row carries the 44px minimum touch target. */}
      <div className="scrollbar-none flex items-center gap-2 overflow-x-auto py-0.5">
        <ToggleButtonGroup.Root
          size="sm"
          selectionMode="single"
          disallowEmptySelection
          aria-label="Result filter"
          selectedKeys={[closed.result]}
          onSelectionChange={(keys) => {
            const [key] = [...keys];
            if (key != null) closed.setResult(key as typeof closed.result);
          }}
        >
          {CLOSED_RESULTS.map((option) => (
            <ToggleButton.Root key={option.value} className="h-11" id={option.value}>
              {option.label}
            </ToggleButton.Root>
          ))}
        </ToggleButtonGroup.Root>

        <ToggleButtonGroup.Root
          size="sm"
          selectionMode="single"
          disallowEmptySelection
          aria-label="Sort by"
          selectedKeys={[closed.sort]}
          onSelectionChange={(keys) => {
            const [key] = [...keys];
            if (key != null) closed.setSort(key as typeof closed.sort);
          }}
        >
          {CLOSED_SORTS.map((option) => (
            <ToggleButton.Root key={option.value} className="h-11" id={option.value}>
              {option.label}
            </ToggleButton.Root>
          ))}
        </ToggleButtonGroup.Root>

        <ToggleButton.Root
          isIconOnly
          className="size-11"
          size="sm"
          variant="ghost"
          isSelected={closed.dir === 'asc'}
          onChange={(isAscending) => closed.setDir(isAscending ? 'asc' : 'desc')}
          aria-label={closed.dir === 'asc' ? 'Sorted ascending' : 'Sorted descending'}
        >
          {closed.dir === 'asc' ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
        </ToggleButton.Root>

        <Button
          isIconOnly
          className="size-11"
          size="sm"
          variant="ghost"
          isDisabled={closed.total === 0}
          onPress={closed.exportCsv}
          aria-label="Export CSV"
        >
          <Download size={16} />
        </Button>
      </div>

      <SectionLabel count={closed.total}>Closed</SectionLabel>

      {closed.error && !closed.hasData ? (
        <StateMessage
          variant="error"
          title="Couldn't load history"
          hint="Check the connection and try again."
          onRetry={closed.refetch}
        />
      ) : closed.loading && !closed.hasData ? (
        <div className="flex flex-col gap-2.5">
          {['a', 'b', 'c'].map((key) => (
            <Skeleton.Root key={key} className="h-[4.75rem] w-full rounded-2xl" />
          ))}
        </div>
      ) : closed.rows.length === 0 ? (
        <StateMessage
          icon={<History size={18} />}
          title={isFiltered ? 'No matching trades' : 'No closed positions'}
          hint={isFiltered ? 'Try clearing the filters.' : 'Closed positions land here.'}
        />
      ) : (
        <div
          aria-busy={closed.stale}
          className={cn('flex flex-col gap-2.5 transition-opacity', closed.stale && 'opacity-60')}
        >
          {closed.rows.map((position) => (
            <ClosedPositionCard key={position.address} position={position} now={now} />
          ))}
        </div>
      )}

      <PagerBar
        label="History pages"
        page={closed.page}
        pages={closed.pages}
        onPageChange={closed.setPage}
      />
    </div>
  );
};
