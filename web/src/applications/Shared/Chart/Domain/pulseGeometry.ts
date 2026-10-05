import { alignedDomains } from '@app/applications/Shared/Chart/Domain/alignedDomains';
import { axisLabels } from '@app/applications/Shared/Chart/Domain/axisLabels';
import {
  type ChartStroke,
  type ExactChartPoint,
  estimatedSegments,
} from '@app/applications/Shared/Chart/Domain/estimatedSegments';
import { type ChartDomain, linearScale } from '@app/applications/Shared/Chart/Domain/linearScale';
import { type ChartPoint, monotonePath } from '@app/applications/Shared/Chart/Domain/monotonePath';
import { plotValue } from '@app/applications/Shared/Chart/Domain/plotValue';
import type { Figure } from '@app/applications/Shared/Figure/Domain/figure';

export interface PulsePoint {
  readonly start: string;
  readonly bar?: Figure | null;
  readonly line: Figure;
}

export interface PulseBar {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly tone: 'gain' | 'loss' | 'neutral';
  readonly isEstimated: boolean;
}

export interface PulseGeometry {
  readonly width: number;
  readonly height: number;
  readonly bottom: number;
  readonly zeroY: number;
  readonly gridLines: readonly number[];
  readonly positions: readonly number[];
  readonly bars: readonly PulseBar[];
  readonly linePoints: readonly ExactChartPoint[];
  readonly strokes: readonly ChartStroke[];
  readonly areas: readonly string[];
  readonly labels: readonly number[];
}

export const PULSE_TOP_PADDING_PX = 10;
const PULSE_BOTTOM_PADDING_PX = 22;
const COMPACT_CHART_WIDTH_PX = 520;
const MINIMUM_BAR_WIDTH_PX = 1.5;
const MAXIMUM_BAR_WIDTH_PX = 20;
const MINIMUM_NONZERO_BAR_HEIGHT_PX = 1;
const COMPACT_BAR_WIDTH_RATIO = 0.62;
const BAR_WIDTH_RATIO = 0.6;

const plottedFigure = (figure: Figure | null | undefined): number | null =>
  figure === null || figure === undefined || figure.exactness === 'unavailable'
    ? null
    : plotValue(figure.value.amount);

const plottedDomain = (values: readonly (number | null)[]): ChartDomain =>
  values.reduce<ChartDomain>(
    (domain, value) =>
      value === null
        ? domain
        : {
            minimum: Math.min(domain.minimum, value),
            maximum: Math.max(domain.maximum, value),
          },
    { minimum: 0, maximum: 0 },
  );

const curveAreas = (points: readonly ExactChartPoint[], zeroY: number): readonly string[] => {
  const areas: string[] = [];
  let run: ChartPoint[] = [];
  const closeRun = () => {
    const first = run[0];
    const last = run.at(-1);
    if (first !== undefined && last !== undefined && run.length > 1) {
      areas.push(`${monotonePath(run)}L${last.x},${zeroY}L${first.x},${zeroY}Z`);
    }
    run = [];
  };
  for (const point of points) {
    if (point.exactness === 'unavailable') closeRun();
    else run.push(point.point);
  }
  closeRun();
  return areas;
};

export const pulseGeometry = (
  points: readonly PulsePoint[],
  dimensions: { readonly width: number; readonly height: number },
): PulseGeometry => {
  const { width, height } = dimensions;
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= PULSE_TOP_PADDING_PX + PULSE_BOTTOM_PADDING_PX
  ) {
    throw new RangeError('A pulse chart needs positive width and room for its plot');
  }
  const barValues = points.map((point) => plottedFigure(point.bar));
  const lineValues = points.map((point) => plottedFigure(point.line));
  const [barDomain, lineDomain] = alignedDomains(
    plottedDomain(barValues),
    plottedDomain(lineValues),
  );
  const bottom = height - PULSE_BOTTOM_PADDING_PX;
  const pixels = { minimum: bottom, maximum: PULSE_TOP_PADDING_PX };
  const barScale = linearScale(barDomain, pixels);
  const lineScale = linearScale(lineDomain, pixels);
  const zeroY = barScale.project(0);
  const step = width / Math.max(1, points.length);
  const positions = points.map((_, index) => step * (index + 0.5));
  const barWidth = Math.max(
    MINIMUM_BAR_WIDTH_PX,
    Math.min(
      MAXIMUM_BAR_WIDTH_PX,
      step * (width < COMPACT_CHART_WIDTH_PX ? COMPACT_BAR_WIDTH_RATIO : BAR_WIDTH_RATIO),
    ),
  );
  const bars = points.flatMap((point, index): PulseBar[] => {
    const value = barValues[index];
    const x = positions[index];
    if (value === null || value === undefined || x === undefined) return [];
    const y = barScale.project(value);
    const availableHeight = value > 0 ? zeroY - PULSE_TOP_PADDING_PX : bottom - zeroY;
    const barHeight =
      value === 0
        ? 0
        : Math.min(availableHeight, Math.max(MINIMUM_NONZERO_BAR_HEIGHT_PX, Math.abs(y - zeroY)));
    return [
      {
        index,
        x: x - barWidth / 2,
        y: value > 0 ? zeroY - barHeight : zeroY,
        width: barWidth,
        height: barHeight,
        tone: value === 0 ? 'neutral' : value > 0 ? 'gain' : 'loss',
        isEstimated: point.bar?.exactness === 'estimated',
      },
    ];
  });
  const linePoints = points.map((point, index): ExactChartPoint => {
    const value = lineValues[index];
    const x = positions[index];
    return value === null ||
      value === undefined ||
      x === undefined ||
      point.line.exactness === 'unavailable'
      ? { exactness: 'unavailable' }
      : { exactness: point.line.exactness, point: { x, y: lineScale.project(value) } };
  });
  return {
    width,
    height,
    bottom,
    zeroY,
    gridLines: [
      PULSE_TOP_PADDING_PX + (bottom - PULSE_TOP_PADDING_PX) / 3,
      PULSE_TOP_PADDING_PX + (2 * (bottom - PULSE_TOP_PADDING_PX)) / 3,
    ],
    positions,
    bars,
    linePoints,
    strokes: estimatedSegments(linePoints),
    areas: curveAreas(linePoints, zeroY),
    labels: axisLabels(points.length, width < COMPACT_CHART_WIDTH_PX ? 3 : 5),
  };
};
