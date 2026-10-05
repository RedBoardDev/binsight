const MAXIMUM_AXIS_LABELS = 5;

export const axisLabels = (
  pointCount: number,
  maximum = MAXIMUM_AXIS_LABELS,
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
  if (pointCount === 0) return [];
  const count = Math.min(pointCount, maximum);
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, index) =>
    Math.round((index * (pointCount - 1)) / (count - 1)),
  );
};
