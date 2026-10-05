const MAXIMUM_AXIS_LABELS = 5;

interface AxisSpacing {
  readonly positions: readonly number[];
  readonly minimumSpacing: number;
}

const spacedLabels = (spacing: AxisSpacing, maximum: number): readonly number[] => {
  const { positions, minimumSpacing } = spacing;
  if (
    !Number.isFinite(minimumSpacing) ||
    minimumSpacing <= 0 ||
    positions.some(
      (position, index) =>
        !Number.isFinite(position) || position < (positions[index - 1] ?? position),
    )
  )
    throw new RangeError('Axis labels need ordered finite positions and positive pixel spacing');
  const first = positions[0];
  const last = positions.at(-1);
  if (first === undefined || last === undefined) return [];
  const labels = [0];
  if (last - first >= minimumSpacing) labels.push(positions.length - 1);
  while (labels.length < maximum) {
    let selected = -1;
    let greatestDistance = minimumSpacing;
    for (const [index, position] of positions.entries()) {
      const distance = Math.min(
        ...labels.map((label) => Math.abs(position - (positions[label] ?? position))),
      );
      if (distance >= greatestDistance && !labels.includes(index)) {
        selected = index;
        greatestDistance = distance;
      }
    }
    if (selected < 0) break;
    labels.push(selected);
  }
  return labels.sort((left, right) => left - right);
};

export const axisLabels = (
  pointCount: number,
  maximum = MAXIMUM_AXIS_LABELS,
  spacing?: AxisSpacing,
): readonly number[] => {
  if (
    !Number.isSafeInteger(pointCount) ||
    pointCount < 0 ||
    !Number.isInteger(maximum) ||
    maximum < 2 ||
    maximum > MAXIMUM_AXIS_LABELS
  ) {
    throw new RangeError('An axis needs a nonnegative point count and between 2 and 5 labels');
  }
  if (spacing !== undefined) {
    if (spacing.positions.length !== pointCount)
      throw new RangeError('Every axis reading needs a drawing position');
    return spacedLabels(spacing, maximum);
  }
  if (pointCount === 0) return [];
  const count = Math.min(pointCount, maximum);
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, index) =>
    Math.round((index * (pointCount - 1)) / (count - 1)),
  );
};
