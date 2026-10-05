import type {
  PriceChartSeries,
  PriceTimeframe,
} from '@app/applications/Shared/Chart/Domain/Candle/priceCandles';
import { SkeletonBlock } from '@app/applications/Shared/Layout/Ui/SkeletonBlock';
import { useIsDesktop } from '@app/applications/Shared/Layout/Ui/useIsDesktop';
import { lazy, Suspense, useState } from 'react';
import { PriceChartErrorBoundary } from './PriceChart/PriceChartErrorBoundary';
import { PriceChartHeader } from './PriceChart/PriceChartHeader';

const createLazyChart = () =>
  lazy(() =>
    import('./PriceChart/LightweightPriceChart').then((module) => ({
      default: module.LightweightPriceChart,
    })),
  );

export interface PriceChartProps extends PriceChartSeries {
  readonly label: string;
  readonly summary: string;
  readonly activeIndex: number | null;
  readonly onScrub: (index: number | null) => void;
  readonly activeEventId?: string | null;
  // A canvas leave clears only canvas hover; callers keep timeline hover as a separate source.
  readonly onEventHover?: (id: string | null) => void;
  readonly describeStatus?: (index: number) => string;
  readonly onTimeframeChange?: (timeframe: PriceTimeframe) => void;
}

export const PriceChart = (props: PriceChartProps) => {
  const [LazyChart, setLazyChart] = useState(createLazyChart);
  const [attempt, setAttempt] = useState(0);
  const isDesktop = useIsDesktop();
  const height = props.height ?? (isDesktop ? 260 : 220);
  const retry = () => {
    setLazyChart(createLazyChart());
    setAttempt((previous) => previous + 1);
  };
  return (
    <figure aria-label={props.label} className="w-full min-w-0">
      <PriceChartHeader source={props} />
      <PriceChartErrorBoundary key={attempt} onRetry={retry}>
        <Suspense
          fallback={
            <div style={{ height }}>
              <SkeletonBlock className="h-full w-full" />
            </div>
          }
        >
          <LazyChart {...props} height={height} />
        </Suspense>
      </PriceChartErrorBoundary>
    </figure>
  );
};
