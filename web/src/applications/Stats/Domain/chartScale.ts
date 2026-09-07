/** Pure SVG geometry helpers for the custom charts (no chart library). */

export type Point = [number, number];

/** Build a linear value→pixel mapper. */
export function scale(domainMin: number, domainMax: number, rangeMin: number, rangeMax: number) {
  const span = domainMax - domainMin || 1;
  return (value: number) => rangeMin + ((value - domainMin) / span) * (rangeMax - rangeMin);
}

export function linePath(points: Point[]): string {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`)
    .join(' ');
}

/**
 * Monotone cubic (Fritsch–Carlson) tangents for a series. The reason this method and not a plain
 * Catmull-Rom: a smoothing spline that overshoots would draw a peak or a dip the wallet never had.
 * Monotone cubic is guaranteed to stay within its neighbouring points, so the curve reads smooth
 * without inventing a value.
 */
function monotoneTangents(points: Point[]): number[] {
  const n = points.length;
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1]![0] - points[i]![0];
    slopes.push(dx === 0 ? 0 : (points[i + 1]![1] - points[i]![1]) / dx);
  }

  const tangents = new Array<number>(n);
  tangents[0] = slopes[0] ?? 0;
  tangents[n - 1] = slopes[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    const previous = slopes[i - 1] ?? 0;
    const next = slopes[i] ?? 0;
    tangents[i] = previous * next <= 0 ? 0 : (previous + next) / 2;
  }

  for (let i = 0; i < n - 1; i++) {
    const slope = slopes[i] ?? 0;
    if (slope === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = (tangents[i] ?? 0) / slope;
    const b = (tangents[i + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const t = 3 / Math.sqrt(magnitude);
      tangents[i] = t * a * slope;
      tangents[i + 1] = t * b * slope;
    }
  }

  return tangents;
}

/**
 * The same series as {@link linePath}, drawn as a smooth monotone cubic instead of straight
 * segments. Falls back to the polyline below three points, where there is nothing to smooth.
 */
export function smoothLinePath(points: Point[]): string {
  if (points.length < 3) return linePath(points);

  const tangents = monotoneTangents(points);
  const at = (n: number) => n.toFixed(2);
  let path = `M${at(points[0]![0])},${at(points[0]![1])}`;

  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const third = (x1 - x0) / 3;
    const c1x = x0 + third;
    const c1y = y0 + (tangents[i] ?? 0) * third;
    const c2x = x1 - third;
    const c2y = y1 - (tangents[i + 1] ?? 0) * third;
    path += ` C${at(c1x)},${at(c1y)} ${at(c2x)},${at(c2y)} ${at(x1)},${at(y1)}`;
  }

  return path;
}
