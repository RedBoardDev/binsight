'use client';

import { usePositionBins } from '@app/applications/Position/Api/usePositions.api';
import {
  type BinChartGeometry,
  binChartBarCap,
  binChartContentWidth,
  binChartGeometry,
} from '@app/applications/Position/Domain/binChart';
import { cn } from '@heroui/react';
import { useEffect, useRef, useState } from 'react';

/** Matches the macOS card's chart slot, so a position reads the same size on both clients. */
const CHART_HEIGHT = 24;
const DEFAULT_WIDTH = 112;

interface BinChartProps {
  positionAddress: string;
  outOfRange: boolean;
}

/**
 * The open position's deposited-liquidity curve: one bar per bin bucket, coloured by side of the
 * live price, with a hairline marker on the active bin. This replaces the old flat range bar — the
 * range and where the price sits inside it are both read straight off the bars, exactly as in the
 * macOS client.
 *
 * Bins are fetched per position and only for OPEN ones (closed positions hold no live liquidity).
 */
export const BinChart = ({ positionAddress, outOfRange }: BinChartProps) => {
  const { data } = usePositionBins(positionAddress, true);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const ref = useRef<HTMLDivElement>(null);

  // The bucket count follows the MEASURED width, so the same component reads correctly in the dense
  // table cell and in the roomier mobile card without a per-call-site magic number.
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.width;
      if (next != null && next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const geometry: BinChartGeometry | null = data
    ? binChartGeometry(data, binChartBarCap(width))
    : null;

  return (
    <div
      ref={ref}
      role="img"
      aria-label={
        data
          ? `Liquidity across ${data.bins.length} price bins`
          : 'Liquidity distribution unavailable'
      }
      className="relative w-full"
      style={{ height: CHART_HEIGHT }}
    >
      {geometry && geometry.bars.length > 0 ? (
        <div
          // Anchored right so the curve stays on the cell's edge instead of drifting as the bucket
          // count changes.
          className="absolute inset-y-0 right-0 flex items-end gap-px"
          style={{ width: binChartContentWidth(geometry.bars.length, width) }}
        >
          {geometry.bars.map((bar) => (
            <span
              key={bar.binId}
              className={cn(
                'min-w-px flex-1 rounded-[1px]',
                bar.belowActive ? 'bg-bin-x' : 'bg-bin-y',
                // Out of range earns no fees, so the curve reads as dormant rather than live. Paired
                // with the marker pinned hard against the edge the price left, an idle position is
                // unmistakable next to an earning one even at a glance down the column.
                outOfRange && 'opacity-35',
              )}
              style={{ height: `${bar.height * 100}%` }}
            />
          ))}
          <span
            aria-hidden
            className={cn(
              'absolute inset-y-0 rounded-full',
              outOfRange ? 'w-0.5 bg-warning' : 'w-px bg-foreground/75',
            )}
            style={{
              left: `${Math.min(100, Math.max(0, geometry.activeFraction * 100))}%`,
              transform: geometry.activeFraction >= 1 ? 'translateX(-100%)' : undefined,
            }}
          />
        </div>
      ) : (
        // No data yet: a flat, dim baseline. Deliberately not a spinner — the row must not flicker
        // busy chrome every time it renders.
        <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-[1px] bg-foreground/10" />
      )}
    </div>
  );
};
