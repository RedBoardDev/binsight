'use client';

import { ClosedPositionsControls } from '@app/applications/Position/Ui/ClosedPositionsControls';
import { ClosedPositionRow } from '@app/applications/Position/Ui/ClosedPositionsTable/ClosedPositionRow';
import { ClosedPositionsState } from '@app/applications/Position/Ui/PositionListState';
import { useClosedPositionsQuery } from '@app/applications/Position/Ui/useClosedPositionsQuery';
import { PagerBar } from '@app/applications/Shared/Ui/PagerBar';
import { Card, cn, Skeleton, Table } from '@heroui/react';
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

  return (
    <Card.Root className="flex h-full min-h-0 flex-col gap-0 p-0">
      <Card.Header className="flex-row items-center justify-between gap-3 px-4 pt-4 pb-3">
        <Card.Title>History</Card.Title>
        <span className="tabular text-faint text-xs">{closed.total}</span>
      </Card.Header>

      <ClosedPositionsControls closed={closed} />

      <ClosedPositionsState closed={closed} skeleton={<ClosedPositionsSkeleton />}>
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
      </ClosedPositionsState>
    </Card.Root>
  );
};
