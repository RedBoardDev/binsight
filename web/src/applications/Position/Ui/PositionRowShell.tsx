'use client';

import type { PositionChartInput } from '@app/applications/Position/Ui/PositionPriceChart';
import { Button, cn, Skeleton, Table, Tooltip } from '@heroui/react';
import { ChartCandlestick } from 'lucide-react';
import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';

// Lazy-load the chart (and its heavy klinecharts dep) only when a row's chart is opened — keeps
// klinecharts out of the dashboard's initial client bundle.
const PositionPriceChart = dynamic(
  () =>
    import('@app/applications/Position/Ui/PositionPriceChart').then((m) => m.PositionPriceChart),
  {
    ssr: false,
    loading: () => (
      <div className="border-border border-t bg-background p-6">
        <Skeleton.Root className="h-[28rem] w-full" />
      </div>
    ),
  },
);

interface PositionRowShellProps {
  rowId: string;
  /** Accessible text for the row (the pair) — rows carry non-text cells. */
  textValue: string;
  /** Total column count, so the expanded chart cell can span the whole row. */
  columnCount: number;
  chart: PositionChartInput;
  /** Controlled by the parent table so only one row's chart is expanded at a time. */
  chartOpen: boolean;
  onToggleChart: () => void;
  onOpen: () => void;
  /** The data cells, rendered after the chart-toggle cell. */
  children: ReactNode;
}

/**
 * The shared chrome of a position row: a chart toggle on the far left, the data cells, and — when
 * expanded — a full-width row holding the price chart. Pressing the row opens the detail panel;
 * the toggle and the pool links inside the cells stop before that press.
 */
export const PositionRowShell = ({
  rowId,
  textValue,
  columnCount,
  chart,
  chartOpen,
  onToggleChart,
  onOpen,
  children,
}: PositionRowShellProps) => (
  <>
    <Table.Row id={rowId} textValue={textValue} onAction={onOpen} className="group cursor-pointer">
      <Table.Cell className="w-12 pr-0 pl-2">
        <Tooltip.Root>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="Toggle price chart"
            aria-expanded={chartOpen}
            className={cn(chartOpen ? 'text-accent' : 'text-faint')}
            onPress={onToggleChart}
          >
            <ChartCandlestick size={16} />
          </Button>
          <Tooltip.Content>Toggle price chart</Tooltip.Content>
        </Tooltip.Root>
      </Table.Cell>
      {children}
    </Table.Row>
    {chartOpen && (
      <Table.Row
        id={`${rowId}--chart`}
        textValue={`${textValue} price chart`}
        className="cursor-default"
      >
        <Table.Cell colSpan={columnCount} className="p-0">
          <PositionPriceChart {...chart} />
        </Table.Cell>
      </Table.Row>
    )}
  </>
);
