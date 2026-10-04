export const findNewKeys = (
  previousKeys: readonly string[],
  currentKeys: readonly string[],
): ReadonlySet<string> => {
  const previous = new Set(previousKeys);
  return new Set(currentKeys.filter((key) => !previous.has(key)));
};

// Lists are compared by content: a caller derives its keys in render (rows.map(...)), a new array
// on every render for the same list.
export const haveSameKeys = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((key, index) => key === right[index]);
