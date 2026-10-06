import {
  type ChartStroke,
  type ExactChartPoint,
  estimatedSegments,
} from '@app/applications/Shared/Chart/Domain/estimatedSegments';
import { linearScale } from '@app/applications/Shared/Chart/Domain/linearScale';
import type { ChartPoint } from '@app/applications/Shared/Chart/Domain/monotonePath';
import { plotValue } from '@app/applications/Shared/Chart/Domain/plotValue';
import type { Figure } from '@app/applications/Shared/Figure/Domain/figure';

const LINE_PADDING_PX = 3;
const LINE_WIDTH_UNITS = 100;

interface LineSeriesGeometry {
  readonly strokes: readonly ChartStroke[];
  readonly lastPoint: ChartPoint | null;
  readonly points: readonly ExactChartPoint[];
  readonly positions: readonly number[];
}

export const lineSeriesGeometry = (
  values: readonly Figure[],
  height: number,
  width = LINE_WIDTH_UNITS,
  padding = LINE_PADDING_PX,
): LineSeriesGeometry => {
  if (
    !Number.isFinite(padding) ||
    padding <= 0 ||
    !Number.isFinite(height) ||
    height <= padding * 2
  )
    throw new RangeError('A line series needs room for its stroke and point');
  if (!Number.isFinite(width) || width <= padding * 2)
    throw new RangeError('A line needs room for its horizontal padding');
  const plotted = values.map((figure) =>
    figure.exactness === 'unavailable' ? null : plotValue(figure.value.amount),
  );
  const available = plotted.filter((value) => value !== null);
  const scale = linearScale(
    {
      minimum: available.reduce((minimum, value) => Math.min(minimum, value), available[0] ?? 0),
      maximum: available.reduce((maximum, value) => Math.max(maximum, value), available[0] ?? 0),
    },
    { minimum: height - padding, maximum: padding },
  );
  const positions = values.map((_, index) =>
    values.length === 1
      ? width / 2
      : padding + (index * (width - padding * 2)) / (values.length - 1),
  );
  const points: ExactChartPoint[] = values.map((figure, index) => {
    const value = plotted[index];
    if (value === null || value === undefined || figure.exactness === 'unavailable')
      return { exactness: 'unavailable' };
    return {
      exactness: figure.exactness,
      point: {
        x: positions[index] ?? width / 2,
        y: scale.project(value),
      },
    };
  });
  const last = points.at(-1);
  return {
    strokes: estimatedSegments(points),
    lastPoint: last?.exactness === 'unavailable' ? null : (last?.point ?? null),
    points,
    positions,
  };
};
