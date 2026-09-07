'use client';

import { ClosedPositionRow } from '@app/applications/Position/Ui/ClosedPositionsTable/ClosedPositionRow';
import {
  CLOSED_RESULTS,
  CLOSED_SORTS,
  useClosedPositionsQuery,
} from '@app/applications/Position/Ui/useClosedPositionsQuery';
import { PagerBar } from '@app/applications/Shared/Ui/PagerBar';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import {
  Button,
  Card,
  cn,
  SearchField,
  Skeleton,
  Table,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from '@heroui/react';
import { ArrowDown, ArrowUp, Download, History } from 'lucide-react';
import { useState } from 'react';

const COLUMN_COUNT = 7;
const STICKY_COLUMN = 'sticky top-0 z-20 bg-surface-secondary';

const ClosedPositionsHeader = () => (
  <Table.Header>
    <Table.Column id="chart" className={cn(STICKY_COLUMN, 'w-12')}>
      <span className="sr-only">Price chart</span>
    </Table.Column>
    <Table.Column id="pair" isRowHeader className={STICKY_COLUMN}>
      Pair
    </Table.Column>
    <Table.Column id="held" className={cn(STICKY_COLUMN, 'text-end')}>
      Held
    </Table.Column>
    <Table.Column id="invested" className={cn(STICKY_COLUMN, 'text-end')}>
      Invested
    </Table.Column>
    <Table.Column id="fees" className={cn(STICKY_COLUMN, 'text-end')}>
      Fees
    </Table.Column>
    <Table.Column id="pnl" className={cn(STICKY_COLUMN, 'text-end')}>
      PnL
    </Table.Column>
    <Table.Column id="closed" className={cn(STICKY_COLUMN, 'text-end')}>
      Closed
    </Table.Column>
  </Table.Header>
);

/** Placeholder rows built from the real table markup, so nothing reflows when the page lands. */
const ClosedPositionsSkeleton = () => (
  <Table.Root variant="secondary" className="flex min-h-0 flex-1 flex-col">
    <Table.ScrollContainer className="min-h-0 flex-1 overflow-y-auto">
      <Table.Content aria-label="Loading history">
        <ClosedPositionsHeader />
        <Table.Body>
          {['a', 'b', 'c', 'd', 'e'].map((key) => (
            <Table.Row key={key} id={key} textValue="Loading">
              <Table.Cell className="w-12 pr-0 pl-2">
                <Skeleton.Root className="size-7 rounded-lg" />
              </Table.Cell>
              <Table.Cell>
                <div className="flex items-center gap-2.5">
                  <Skeleton.Root className="size-5 rounded-full" />
                  <Skeleton.Root className="h-4 w-28" />
                </div>
              </Table.Cell>
              <Table.Cell>
                <Skeleton.Root className="ml-auto h-4 w-12" />
              </Table.Cell>
              <Table.Cell>
                <Skeleton.Root className="ml-auto h-4 w-16" />
              </Table.Cell>
              <Table.Cell>
                <Skeleton.Root className="ml-auto h-4 w-16" />
              </Table.Cell>
              <Table.Cell>
                <Skeleton.Root className="ml-auto h-8 w-20" />
              </Table.Cell>
              <Table.Cell>
                <Skeleton.Root className="ml-auto h-4 w-16" />
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Content>
    </Table.ScrollContainer>
  </Table.Root>
);

/** Closed-position history: debounced search, win/loss segment, sort + direction, CSV export of
 *  the current filter, and one inline price chart at a time. */
export const ClosedPositionsTable = () => {
  const closed = useClosedPositionsQuery();
  const [openChart, setOpenChart] = useState<string | null>(null);
  const now = Date.now();
  const toggleChart = (address: string) =>
    setOpenChart((current) => (current === address ? null : address));
  const isFiltered = closed.q !== '' || closed.result !== 'all';

  return (
    <Card.Root className="flex h-full min-h-0 flex-col gap-0 p-0">
      <Card.Header className="flex-row items-center justify-between gap-3 px-4 pt-4 pb-3">
        <Card.Title>History</Card.Title>
        <span className="tabular text-faint text-xs">{closed.total}</span>
      </Card.Header>

      <div className="flex flex-wrap items-center gap-2 border-border border-b px-4 pb-3">
        <SearchField.Root
          aria-label="Search pair"
          value={closed.qInput}
          onChange={closed.setQInput}
          className="w-full sm:w-48"
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="Search pair…" spellCheck={false} />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField.Root>

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
            <ToggleButton.Root key={option.value} id={option.value}>
              {option.label}
            </ToggleButton.Root>
          ))}
        </ToggleButtonGroup.Root>

        <div className="ml-auto flex items-center gap-2">
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
              <ToggleButton.Root key={option.value} id={option.value}>
                {option.label}
              </ToggleButton.Root>
            ))}
          </ToggleButtonGroup.Root>

          <Tooltip.Root>
            <ToggleButton.Root
              isIconOnly
              size="sm"
              variant="ghost"
              isSelected={closed.dir === 'asc'}
              onChange={(isAscending) => closed.setDir(isAscending ? 'asc' : 'desc')}
              aria-label={closed.dir === 'asc' ? 'Sorted ascending' : 'Sorted descending'}
            >
              {closed.dir === 'asc' ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
            </ToggleButton.Root>
            <Tooltip.Content>
              {closed.dir === 'asc' ? 'Sorted ascending' : 'Sorted descending'}
            </Tooltip.Content>
          </Tooltip.Root>

          <Tooltip.Root>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              isDisabled={closed.total === 0}
              onPress={closed.exportCsv}
              aria-label="Export CSV"
            >
              <Download size={16} />
            </Button>
            <Tooltip.Content>Export current filter as CSV</Tooltip.Content>
          </Tooltip.Root>
        </div>
      </div>

      {closed.error && !closed.hasData ? (
        <StateMessage
          variant="error"
          title="Couldn't load history"
          hint="Check the connection and try again."
          onRetry={closed.refetch}
        />
      ) : closed.loading && !closed.hasData ? (
        <ClosedPositionsSkeleton />
      ) : closed.rows.length === 0 ? (
        <StateMessage
          icon={<History size={18} />}
          title={isFiltered ? 'No matching trades' : 'No closed positions'}
          hint={isFiltered ? 'Try clearing the filters.' : 'Closed positions land here.'}
        />
      ) : (
        <Table.Root variant="secondary" className="flex min-h-0 flex-1 flex-col">
          <Table.ScrollContainer
            aria-busy={closed.stale}
            className={cn('transition-opacity', closed.stale && 'opacity-60')}
          >
            <Table.Content aria-label="Closed positions">
              <ClosedPositionsHeader />
              <Table.Body>
                {closed.rows.map((position) => (
                  <ClosedPositionRow
                    key={position.address}
                    position={position}
                    now={now}
                    columnCount={COLUMN_COUNT}
                    chartOpen={openChart === position.address}
                    onToggleChart={() => toggleChart(position.address)}
                  />
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>

          <Table.Footer className="shrink-0">
            <PagerBar
              label="History pages"
              numbered
              page={closed.page}
              pages={closed.pages}
              onPageChange={closed.setPage}
            />
          </Table.Footer>
        </Table.Root>
      )}
    </Card.Root>
  );
};
