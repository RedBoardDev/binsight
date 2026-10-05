import {
  type ChartStroke,
  type ExactChartPoint,
  estimatedSegments,
} from '@app/applications/Shared/Chart/Domain/estimatedSegments';
import { linearScale } from '@app/applications/Shared/Chart/Domain/linearScale';
import type { ChartPoint } from '@app/applications/Shared/Chart/Domain/monotonePath';
import { plotValue } from '@app/applications/Shared/Chart/Domain/plotValue';
import type { Figure } from '@app/applications/Shared/Figure/Domain/figure';

const SPARKLINE_PADDING_PX = 3;
const SPARKLINE_WIDTH_UNITS = 100;

interface SparklineGeometry {
  readonly strokes: readonly ChartStroke[];
  readonly lastPoint: ChartPoint | null;
}

export const sparklineGeometry = (values: readonly Figure[], height: number): SparklineGeometry => {
  if (!Number.isFinite(height) || height <= SPARKLINE_PADDING_PX * 2)
    throw new RangeError('A sparkline needs room for its stroke and point');
  const plotted = values.map((figure) =>
    figure.exactness === 'unavailable' ? null : plotValue(figure.value.amount),
  );
  const available = plotted.filter((value) => value !== null);
  const scale = linearScale(
    {
      minimum: available.reduce((minimum, value) => Math.min(minimum, value), available[0] ?? 0),
      maximum: available.reduce((maximum, value) => Math.max(maximum, value), available[0] ?? 0),
    },
    { minimum: height - SPARKLINE_PADDING_PX, maximum: SPARKLINE_PADDING_PX },
  );
  const points: ExactChartPoint[] = values.map((figure, index) => {
    const value = plotted[index];
    if (value === null || value === undefined || figure.exactness === 'unavailable')
      return { exactness: 'unavailable' };
    return {
      exactness: figure.exactness,
      point: {
        x:
          values.length === 1
            ? SPARKLINE_WIDTH_UNITS / 2
            : SPARKLINE_PADDING_PX +
              (index * (SPARKLINE_WIDTH_UNITS - SPARKLINE_PADDING_PX * 2)) / (values.length - 1),
        y: scale.project(value),
      },
    };
  });
  const last = points.at(-1);
  return {
    strokes: estimatedSegments(points),
    lastPoint: last?.exactness === 'unavailable' ? null : (last?.point ?? null),
  };
};
