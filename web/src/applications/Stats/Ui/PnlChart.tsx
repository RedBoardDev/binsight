'use client';

import { usePortfolioFeed } from '@app/applications/Portfolio/Api/portfolioFeed.store';
import { ImageShareDialog } from '@app/applications/Position/Ui/SharePnlCardButton/ImageShareDialog';
import { toneOf, toneTextClass } from '@app/applications/Shared/Domain/tone';
import { MoneyValue } from '@app/applications/Shared/Ui/MoneyValue';
import { StateMessage } from '@app/applications/Shared/Ui/StateMessage';
import { useNetworthCurve, useProfitHistory } from '@app/applications/Stats/Api/useStats.api';
import { periodDays, sinceMs } from '@app/applications/Stats/Domain/period';
import { useUi } from '@app/core/stores/uiStore';
import type { Bucket, NetworthCurvePoint, ProfitBucket } from '@binsight/shared';
import { Button, Card, cn, Skeleton, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { Share2 } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { type ChartSource, PnlGraph } from './PnlChart/PnlGraph';
import { renderChartPng } from './PnlChart/renderChartPng';

const SOURCE_OPTIONS: { label: string; value: ChartSource }[] = [
  { label: 'Net Worth', value: 'networth' },
  { label: 'PnL', value: 'pnl' },
  { label: 'Positions', value: 'positions' },
];

const SOURCE_TITLE: Record<ChartSource, string> = {
  networth: 'Net Worth',
  pnl: 'Real PnL',
  positions: 'Positions PnL',
};

/** Explanatory note under the chart — each source measures a different thing, and confusing them is
 *  the single most common misreading of this screen. */
const SOURCE_NOTE: Record<ChartSource, string> = {
  networth:
    'Net Worth = your wallet VALUE (cash + positions). Drops to 0 if you empty it, never negative.',
  pnl: 'Real PnL = your performance net of deposits/withdrawals. Can be negative (you injected more than the current value). Verified on-chain.',
  positions:
    'Realized PnL per closed position (Meteora close value, LPAgent-style). Bars = each period; line = running total. Note: per-position close values can differ from the real wallet cash.',
};

/**
 * Per-position view: the running total is computed over the FULL history, then sliced to the selected
 * window — so hovering a given day shows the SAME cumulative whether the chart is on 1M or on 1Y
 * (absolute, range-invariant). Buckets are aggregated (a few hundred points), not per-position.
 */
function sliceCumulative(all: ProfitBucket[], since: number): ProfitBucket[] {
  let run = 0;
  const withCumulative = all.map((b) => {
    run += b.realized;
    return { t: b.t, realized: b.realized, cumulative: run };
  });
  return withCumulative.filter((b) => b.t >= since);
}

/**
 * Net-Worth / Real-PnL views: the daily curve, with the last point REPLACED by the live figure —
 *  • networth → live net worth (idle + open TVL) = walletTotalSol.
 *  • pnl      → live real PnL = walletTotalSol − apportsLast (cumulative net deposits, last point).
 * Today (the last point) is reconstructed "at cost" and briefly LAGS the live tx stream: a fresh
 * deposit hits the cash ledger before its position shows up in the legs, so the line would dip.
 * `walletTotalSol` is null only while the wallet total is unknown — never coalesce it to 0, a drained
 * wallet legitimately has 0 and coalescing both hid the real realized loss on the last point.
 */
function curveBuckets(
  points: NetworthCurvePoint[],
  source: Exclude<ChartSource, 'positions'>,
  walletTotalSol: number | null,
): ProfitBucket[] {
  const apportsLast = points.at(-1)?.apports ?? 0;
  const liveNow =
    walletTotalSol == null
      ? null
      : source === 'networth'
        ? walletTotalSol
        : walletTotalSol - apportsLast;
  let prev: number | null = null;
  return points.map((p, i) => {
    const base = source === 'networth' ? p.networth : p.realPnl;
    const value = i === points.length - 1 && liveNow != null ? liveNow : base;
    const delta = prev == null ? 0 : value - prev;
    prev = value;
    return { t: Date.parse(`${p.date}T00:00:00Z`), realized: delta, cumulative: value };
  });
}

interface PnlChartProps {
  bucket: Bucket;
  /** The clock the whole tab shares — frozen per (scope, period, closed set) so the query keys hold. */
  now: number;
}

export const PnlChart = ({ bucket, now }: PnlChartProps) => {
  const scope = usePortfolioFeed((s) => s.scope);
  const closedVersion = usePortfolioFeed((s) => s.closedVersion);
  // null (not 0) when the wallet total isn't loaded yet — a drained wallet legitimately has 0, and
  // coalescing both to 0 hid the real realized loss on the chart's last point (see curveBuckets).
  const netWorth = usePortfolioFeed((s) => s.portfolio?.totals.walletTotalSol ?? null);
  const period = useUi((s) => s.period);
  // Default to the Positions (LPAgent-style realized-PnL) view — that's the headline most users want.
  const [source, setSource] = useState<ChartSource>('positions');

  const isPositions = source === 'positions';
  // Only the selected source is fetched: the all-time history is a heavy query, and the networth
  // curve is shared with PnlBridge, so mounting both unconditionally cost an extra round-trip.
  const curve = useNetworthCurve(scope, periodDays(period, now), closedVersion, !isPositions);
  // ALL-TIME on purpose (see sliceCumulative) — the window is applied client-side.
  const history = useProfitHistory(scope, bucket, sinceMs('all', now), closedVersion, isPositions);

  const query = isPositions ? history : curve;
  const data = useMemo<ProfitBucket[] | null>(() => {
    if (isPositions)
      return history.data ? sliceCumulative(history.data, sinceMs(period, now)) : null;
    if (!curve.data) return null;
    return curveBuckets(curve.data.points, source === 'networth' ? 'networth' : 'pnl', netWorth);
  }, [isPositions, history.data, curve.data, source, period, now, netWorth]);

  // Headline:
  //  • networth → the live net worth (idle cash + open positions' value) = walletTotalSol.
  //  • pnl      → the live real PnL = netWorth − apportsLast; that IS the last point's (forced) cumulative.
  //  • positions→ the cumulative line's end (the realized PnL over the window).
  // For pnl / positions the last forced cumulative already encodes the live "now" figure.
  const total =
    source === 'networth'
      ? netWorth
      : data && data.length > 0
        ? (data.at(-1)?.cumulative ?? null)
        : null;

  const svgRef = useRef<SVGSVGElement>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const getImage = useCallback(() => renderChartPng(svgRef.current), []);

  const hasData = data != null && data.length > 0;

  return (
    <>
      <Card.Root>
        <Card.Header className="flex-row flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 items-baseline gap-3">
            <Card.Title>{SOURCE_TITLE[source]}</Card.Title>
            {total != null && (
              <span className={cn('tabular font-semibold text-sm', toneTextClass[toneOf(total)])}>
                <MoneyValue value={total} signed />
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {hasData && (
              <Button
                isIconOnly
                variant="ghost"
                size="sm"
                aria-label="Share chart"
                className="size-11 md:size-9"
                onPress={() => setShareOpen(true)}
              >
                <Share2 size={16} />
              </Button>
            )}
            <div className="-my-1 scrollbar-none min-w-0 overflow-x-auto py-1">
              <ToggleButtonGroup.Root
                aria-label="Chart source"
                size="sm"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[source]}
                onSelectionChange={(keys) => {
                  const picked = SOURCE_OPTIONS.find((option) => keys.has(option.value));
                  if (picked) setSource(picked.value);
                }}
              >
                {SOURCE_OPTIONS.map((option) => (
                  <ToggleButton.Root key={option.value} id={option.value} className="h-11 md:h-9">
                    {option.label}
                  </ToggleButton.Root>
                ))}
              </ToggleButtonGroup.Root>
            </div>
          </div>
        </Card.Header>

        <Card.Content>
          {query.isError && !data ? (
            <StateMessage
              variant="error"
              title="Couldn't load the chart"
              hint="The stats API didn't answer. Check the connection and try again."
              onRetry={() => void (isPositions ? history.refetch() : curve.refetch())}
            />
          ) : !data ? (
            <ChartSkeleton />
          ) : data.length === 0 ? (
            <StateMessage
              title={isPositions ? 'No realized PnL yet' : 'No on-chain activity yet'}
              hint={
                isPositions
                  ? 'Closed positions will chart here.'
                  : 'On-chain SOL cash-flow will chart here.'
              }
            />
          ) : (
            <div
              className={cn('transition-opacity', query.isPlaceholderData && 'opacity-60')}
              aria-busy={query.isPlaceholderData}
            >
              <PnlGraph
                buckets={data}
                netWorth={netWorth ?? 0}
                showBars={isPositions}
                mode={source}
                svgRef={svgRef}
              />
              <p className="mt-3 text-[11px] text-faint leading-relaxed">{SOURCE_NOTE[source]}</p>
            </div>
          )}
        </Card.Content>
      </Card.Root>

      <ImageShareDialog
        isOpen={shareOpen}
        onClose={() => setShareOpen(false)}
        title={SOURCE_TITLE[source]}
        filename={`binsight-${source}-pnl.png`}
        shareTitle={SOURCE_TITLE[source]}
        aspect="10 / 3"
        getImage={getImage}
      />
    </>
  );
};

/** Mirrors the rendered chart's geometry (readout slot, plot box, axis row, note) so the card keeps
 *  its height when the data lands. */
const ChartSkeleton = () => (
  <div className="flex flex-col gap-2">
    <Skeleton.Root className="h-[104px] w-full rounded-lg md:hidden" />
    <Skeleton.Root className="h-56 w-full rounded-lg sm:h-72 md:h-80" />
    <Skeleton.Root className="h-3 w-full" />
    <Skeleton.Root className="mt-3 h-3 w-3/4" />
  </div>
);
