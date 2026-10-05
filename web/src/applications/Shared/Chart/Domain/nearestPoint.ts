export const nearestPoint = (positions: readonly number[], target: number): number | null => {
  if (positions.length === 0 || !Number.isFinite(target)) return null;
  let lower = 0;
  let upper = positions.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const position = positions[middle];
    if (position !== undefined && position < target) lower = middle + 1;
    else upper = middle;
  }
  const after = positions[lower];
  const before = positions[lower - 1];
  if (before === undefined) return 0;
  if (after === undefined) return positions.length - 1;
  return target - before <= after - target ? lower - 1 : lower;
};
