export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

export interface MonotoneSegment {
  readonly start: ChartPoint;
  readonly firstControl: ChartPoint;
  readonly secondControl: ChartPoint;
  readonly end: ChartPoint;
}

const CONTROL_DISTANCE_RATIO = 1 / 3;
const MAXIMUM_TANGENT_RATIO = 3;

const assertPoints = (points: readonly ChartPoint[]): void => {
  for (const [index, point] of points.entries()) {
    const previous = points[index - 1];
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      (previous !== undefined && previous.x >= point.x)
    ) {
      throw new RangeError('A chart curve needs finite points with strictly increasing x');
    }
  }
};

const secants = (points: readonly ChartPoint[]): number[] =>
  points.slice(1).map((end, index) => {
    const start = points[index];
    if (start === undefined) throw new RangeError('A chart segment needs a start');
    const width = end.x - start.x;
    const height = end.y - start.y;
    const slope = height / width;
    if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(slope)) {
      throw new RangeError('A chart segment span and slope must be finite');
    }
    return slope;
  });

const limitTangents = (first: number, second: number, slope: number): readonly [number, number] => {
  const largest = Math.max(Math.abs(first), Math.abs(second));
  if (largest === 0) return [0, 0];
  const firstRatio = first / largest;
  const secondRatio = second / largest;
  const magnitude = Math.hypot(firstRatio, secondRatio);
  if (largest / Math.abs(slope) <= MAXIMUM_TANGENT_RATIO / magnitude) return [first, second];
  // Normalize before dividing by the secant: a very small slope can otherwise create
  // infinite ratios, followed by 0 * Infinity and an invalid SVG path.
  const limit = Math.abs(slope) * (MAXIMUM_TANGENT_RATIO / magnitude);
  return [firstRatio * limit, secondRatio * limit];
};

const tangents = (slopes: readonly number[]): number[] => {
  const result = [
    slopes[0] ?? 0,
    ...slopes.slice(1).map((slope, index) => {
      const previous = slopes[index] ?? 0;
      return Math.sign(previous) === Math.sign(slope) ? previous / 2 + slope / 2 : 0;
    }),
    slopes.at(-1) ?? 0,
  ];
  for (const [index, slope] of slopes.entries()) {
    if (slope === 0) {
      result[index] = 0;
      result[index + 1] = 0;
      continue;
    }
    const [first, second] = limitTangents(result[index] ?? 0, result[index + 1] ?? 0, slope);
    result[index] = first;
    result[index + 1] = second;
  }
  return result;
};

export const monotoneSegments = (points: readonly ChartPoint[]): readonly MonotoneSegment[] => {
  assertPoints(points);
  const pointTangents = tangents(secants(points));
  return points.slice(1).map((end, index) => {
    const start = points[index];
    if (start === undefined) throw new RangeError('A chart segment needs a start');
    const distance = (end.x - start.x) * CONTROL_DISTANCE_RATIO;
    return {
      start,
      firstControl: { x: start.x + distance, y: start.y + distance * (pointTangents[index] ?? 0) },
      secondControl: { x: end.x - distance, y: end.y - distance * (pointTangents[index + 1] ?? 0) },
      end,
    };
  });
};

const coordinates = (point: ChartPoint): string => `${point.x},${point.y}`;

export const monotoneSegmentPath = (segments: readonly MonotoneSegment[]): string => {
  const first = segments[0];
  if (first === undefined) return '';
  return `M${coordinates(first.start)}${segments
    .map(
      (segment) =>
        `C${coordinates(segment.firstControl)} ${coordinates(segment.secondControl)} ${coordinates(segment.end)}`,
    )
    .join('')}`;
};

export const monotonePath = (points: readonly ChartPoint[]): string => {
  const segments = monotoneSegments(points);
  const first = points[0];
  return segments.length === 0
    ? first === undefined
      ? ''
      : `M${coordinates(first)}`
    : monotoneSegmentPath(segments);
};
