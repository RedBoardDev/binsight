import { defaultRangeExtractor, type Range } from '@tanstack/react-virtual';
import { type FocusEvent, useCallback, useRef } from 'react';

interface FocusedRow {
  readonly keepFocusedRow: (range: Range) => number[];
  readonly followFocus: (event: FocusEvent<HTMLElement>) => void;
}

// A row scrolled out of the window is unmounted, and the keyboard focus inside it would fall back
// to the page: the focused row stays drawn wherever the list scrolls.
export const useFocusedRow = (): FocusedRow => {
  const focusedIndex = useRef<number | null>(null);

  const keepFocusedRow = useCallback((range: Range): number[] => {
    const indexes = defaultRangeExtractor(range);
    const focused = focusedIndex.current;
    if (focused === null || focused >= range.count || indexes.includes(focused)) {
      return indexes;
    }
    return [...indexes, focused].sort((left, right) => left - right);
  }, []);

  const followFocus = useCallback((event: FocusEvent<HTMLElement>): void => {
    const row = event.target.closest<HTMLElement>('[data-index]');
    const index = Number.parseInt(row?.dataset.index ?? '', 10);
    focusedIndex.current = Number.isNaN(index) ? null : index;
  }, []);

  return { keepFocusedRow, followFocus };
};
