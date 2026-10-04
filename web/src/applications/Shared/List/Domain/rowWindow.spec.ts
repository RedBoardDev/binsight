import { LOAD_AHEAD_ROWS, shouldLoadMore } from '@app/applications/Shared/List/Domain/rowWindow';
import { describe, expect, it } from 'vitest';

const window = { loadedCount: 50, hasMore: true, isLoadingMore: false };

describe('shouldLoadMore', () => {
  it('waits while the end of the loaded rows is far', () => {
    expect(shouldLoadMore({ ...window, lastDrawnIndex: 20 })).toBe(false);
  });

  it('asks for the next page a screenful before the end', () => {
    expect(shouldLoadMore({ ...window, lastDrawnIndex: 49 - LOAD_AHEAD_ROWS })).toBe(true);
  });

  it('never asks twice, nor past the last page', () => {
    expect(shouldLoadMore({ ...window, lastDrawnIndex: 49, isLoadingMore: true })).toBe(false);
    expect(shouldLoadMore({ ...window, lastDrawnIndex: 49, hasMore: false })).toBe(false);
  });

  it('leaves the first page to the query itself', () => {
    expect(shouldLoadMore({ ...window, loadedCount: 0, lastDrawnIndex: 0 })).toBe(false);
  });
});
