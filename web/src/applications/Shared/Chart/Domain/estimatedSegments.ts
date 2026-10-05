import {
  type ChartPoint,
  type MonotoneSegment,
  monotonePath,
  monotoneSegmentPath,
  monotoneSegments,
} from '@app/applications/Shared/Chart/Domain/monotonePath';
import type { Exactness } from '@app/applications/Shared/Figure/Domain/figure';

export type ExactChartPoint =
  | { readonly exactness: Exclude<Exactness, 'unavailable'>; readonly point: ChartPoint }
  | { readonly exactness: 'unavailable' };

export interface ChartStroke {
  readonly style: 'solid' | 'dashed';
  readonly path: string;
}

type AvailableChartPoint = Extract<ExactChartPoint, { readonly point: ChartPoint }>;

const strokeStyle = (point: AvailableChartPoint): ChartStroke['style'] =>
  point.exactness === 'complete' ? 'solid' : 'dashed';

const strokesForRun = (run: readonly AvailableChartPoint[]): ChartStroke[] => {
  const first = run[0];
  if (first === undefined) return [];
  if (run.length === 1) return [{ style: strokeStyle(first), path: monotonePath([first.point]) }];
  const segments = monotoneSegments(run.map((entry) => entry.point));
  const strokes: ChartStroke[] = [];
  let current: MonotoneSegment[] = [];
  let currentStyle: ChartStroke['style'] = 'solid';
  for (const [index, segment] of segments.entries()) {
    const style =
      run[index]?.exactness === 'complete' && run[index + 1]?.exactness === 'complete'
        ? 'solid'
        : 'dashed';
    if (current.length > 0 && style !== currentStyle) {
      strokes.push({ style: currentStyle, path: monotoneSegmentPath(current) });
      current = [];
    }
    currentStyle = style;
    current.push(segment);
  }
  strokes.push({ style: currentStyle, path: monotoneSegmentPath(current) });
  return strokes;
};

// Split the already interpolated curve: interpolating each stroke separately changes the
// endpoint tangents and makes the solid/dashed junction visibly kink.
export const estimatedSegments = (points: readonly ExactChartPoint[]): readonly ChartStroke[] => {
  const strokes: ChartStroke[] = [];
  let run: AvailableChartPoint[] = [];
  for (const point of points) {
    if (point.exactness === 'unavailable') {
      strokes.push(...strokesForRun(run));
      run = [];
    } else run.push(point);
  }
  return [...strokes, ...strokesForRun(run)];
};
