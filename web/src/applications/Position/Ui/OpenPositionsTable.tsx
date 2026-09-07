'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { OpenPositionRow } from '@app/applications/Position/Ui/OpenPositionsTable/OpenPositionRow';
import { toneOf, toneTextClass } from '@app/applications/Shared/Domain/tone';
import { PagerBar } from '@app/applications/Shared/Ui/PagerBar';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import { useMoney } from '@app/applications/Shared/Ui/useMoney';
import { Card, cn, Skeleton, Table } from '@heroui/react';
import { Layers } from 'lucide-react';
import { useState } from 'react';

// Open positions are usually a handful — only paginate once a wallet runs a LOT of them at once.
const OPEN_PAGE_SIZE = 100;
const COLUMN_COUNT = 7;
const STICKY_COLUMN = 'sticky top-0 z-20 bg-surface-secondary';

const OpenPositionsHeader = () => (
  <Table.Header>
    <Table.Column id="chart" className={cn(STICKY_COLUMN, 'w-12')}>
      <span className="sr-only">Price chart</span>
    </Table.Column>
    <Table.Column id="pair" isRowHeader className={STICKY_COLUMN}>
      Pair
    </Table.Column>
    <Table.Column id="age" className={cn(STICKY_COLUMN, 'text-end')}>
      Age
    </Table.Column>
    <Table.Column id="value" className={cn(STICKY_COLUMN, 'text-end')}>
      Value
    </Table.Column>
    <Table.Column id="fees" className={cn(STICKY_COLUMN, 'text-end')}>
      Fees
    </Table.Column>
    <Table.Column id="pnl" className={cn(STICKY_COLUMN, 'text-end')}>
      uPnL
    </Table.Column>
    <Table.Column id="range" className={cn(STICKY_COLUMN, 'text-end')}>
      Range
    </Table.Column>
  </Table.Header>
);

/** Placeholder rows built from the real table markup, so nothing reflows when the feed lands. */
const OpenPositionsSkeleton = () => (
  <Table.Root variant="secondary" className="flex min-h-0 flex-1 flex-col">
    <Table.ScrollContainer className="min-h-0 flex-1 overflow-y-auto">
      <Table.Content aria-label="Loading open positions">
        <OpenPositionsHeader />
        <Table.Body>
          {['a', 'b', 'c'].map((key) => (
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
                <Skeleton.Root className="ml-auto h-8 w-20" />
              </Table.Cell>
              <Table.Cell>
                <Skeleton.Root className="ml-auto h-8 w-20" />
              </Table.Cell>
              <Table.Cell>
                <Skeleton.Root className="ml-auto h-8 w-32" />
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Content>
    </Table.ScrollContainer>
  </Table.Root>
);

/** The live open-positions table: one row per position, an inline price chart per row (only one
 *  expanded at a time) and the detail panel on row press. */
export const OpenPositionsTable = () => {
  const portfolio = usePortfolioFeed((s) => s.portfolio);
  const feedError = usePortfolioFeed((s) => s.error);
  const retryFeed = usePortfolioFeed((s) => s.retry);
  const money = useMoney();
  const [openChart, setOpenChart] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const rows = portfolio?.openByValue ?? [];
  const totals = portfolio?.totals;
  const pages = Math.max(1, Math.ceil(rows.length / OPEN_PAGE_SIZE));
  const safePage = Math.min(page, pages); // clamp if the live set shrank under us
  const visible = rows.slice((safePage - 1) * OPEN_PAGE_SIZE, safePage * OPEN_PAGE_SIZE);
  const now = Date.now();
  const toggleChart = (address: string) =>
    setOpenChart((current) => (current === address ? null : address));

  return (
    <Card.Root className="flex h-full min-h-0 flex-col gap-0 p-0">
      <Card.Header className="flex-row flex-wrap items-center justify-between gap-x-5 gap-y-2 px-4 pt-4 pb-3">
        <Card.Title>Open positions</Card.Title>
        <div className="flex flex-wrap items-center justify-end gap-x-5 gap-y-1 text-xs">
          {totals && rows.length > 0 && (
            <>
              <span className="flex items-baseline gap-1.5">
                <span className="text-faint uppercase tracking-wide">Unrealized</span>
                <span className={cn('tabular font-medium', toneTextClass[toneOf(totals.uPnlSol)])}>
                  {money.sol(totals.uPnlSol, { signed: true })}
                </span>
              </span>
              <span className="flex items-baseline gap-1.5">
                <span className="text-faint uppercase tracking-wide">Fees</span>
                <span className="tabular font-medium text-profit">
                  {money.sol(totals.unclaimedFeesSol)}
                </span>
              </span>
            </>
          )}
          <span className="tabular text-faint">{rows.length}</span>
        </div>
      </Card.Header>

      {portfolio == null ? (
        feedError ? (
          <StateMessage
            variant="error"
            title="Couldn't load positions"
            hint="The wallet feed is unreachable."
            onRetry={retryFeed}
          />
        ) : (
          <OpenPositionsSkeleton />
        )
      ) : rows.length === 0 ? (
        <StateMessage
          icon={<Layers size={18} />}
          title="No open positions"
          hint="Active Meteora LP positions appear here live."
        />
      ) : (
        <Table.Root variant="secondary" className="flex min-h-0 flex-1 flex-col">
          <Table.ScrollContainer className="min-h-0 flex-1 overflow-y-auto">
            <Table.Content aria-label="Open positions">
              <OpenPositionsHeader />
              <Table.Body>
                {visible.map((position) => (
                  <OpenPositionRow
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
              label="Open positions pages"
              page={safePage}
              pages={pages}
              onPageChange={setPage}
            />
          </Table.Footer>
        </Table.Root>
      )}
    </Card.Root>
  );
};
