export const LOAD_AHEAD_ROWS = 12;

export interface RowWindow {
  readonly lastDrawnIndex: number;
  readonly loadedCount: number;
  readonly hasMore: boolean;
  readonly isLoadingMore: boolean;
}

export const shouldLoadMore = (window: RowWindow): boolean =>
  window.hasMore &&
  !window.isLoadingMore &&
  window.loadedCount > 0 &&
  window.lastDrawnIndex >= window.loadedCount - 1 - LOAD_AHEAD_ROWS;
