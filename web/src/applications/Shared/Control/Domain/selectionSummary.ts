const NAMED_UP_TO = 2;

export type SelectionSummary =
  | { readonly kind: 'everything' }
  | { readonly kind: 'named'; readonly text: string }
  | { readonly kind: 'counted'; readonly first: string; readonly others: number };

export const summarizeSelection = (
  labels: readonly string[],
  languageTag: string,
): SelectionSummary => {
  const [first] = labels;
  if (first === undefined) {
    return { kind: 'everything' };
  }
  if (labels.length <= NAMED_UP_TO) {
    const list = new Intl.ListFormat(languageTag, { type: 'conjunction', style: 'narrow' });
    return { kind: 'named', text: list.format(labels) };
  }
  return { kind: 'counted', first, others: labels.length - 1 };
};
