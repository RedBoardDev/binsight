import { shouldLoadMore } from '@app/applications/Shared/List/Domain/rowWindow';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { memo, type ReactNode, useEffect, useRef } from 'react';
import { useDocumentTop } from './VirtualRowList/useDocumentTop';
import { useFocusedRow } from './VirtualRowList/useFocusedRow';

const OVERSCAN_ROWS = 8;
// aria-rowcount for a list whose total is not known yet (more pages to load, day lines among them).
const UNKNOWN_ROW_COUNT = -1;

interface VirtualRowListProps<Item> {
  label: string;
  items: readonly Item[];
  getKey: (item: Item) => string;
  getHeight: (item: Item) => number;
  columns: string;
  header: ReactNode;
  // Pass a stable function (useCallback): a drawn row then re-renders only when its item changes,
  // not on every scroll frame.
  renderRow: (item: Item) => ReactNode;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}

interface RowCellsProps<Item> {
  item: Item;
  renderRow: (item: Item) => ReactNode;
}

const RowCellsOf = <Item,>({ item, renderRow }: RowCellsProps<Item>): ReactNode => renderRow(item);
// memo() drops the type parameter; the cast gives it back.
const RowCells = memo(RowCellsOf) as typeof RowCellsOf;

export const VirtualRowList = <Item,>({
  label,
  items,
  getKey,
  getHeight,
  columns,
  header,
  renderRow,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: VirtualRowListProps<Item>) => {
  const listRef = useRef<HTMLTableSectionElement>(null);
  const scrollMargin = useDocumentTop(listRef);
  const { keepFocusedRow, followFocus } = useFocusedRow();
  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: (index) => {
      const item = items[index];
      return item === undefined ? 0 : getHeight(item);
    },
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? index : getKey(item);
    },
    overscan: OVERSCAN_ROWS,
    scrollMargin,
    rangeExtractor: keepFocusedRow,
    // Without it, the first render draws nothing until the window is measured, and a restored
    // scroll position would land on an empty list.
    initialRect: { width: window.innerWidth, height: window.innerHeight },
  });
  const rows = virtualizer.getVirtualItems();
  const lastDrawnIndex = rows.at(-1)?.index ?? -1;

  useEffect(() => {
    if (shouldLoadMore({ lastDrawnIndex, loadedCount: items.length, hasMore, isLoadingMore })) {
      onLoadMore();
    }
  }, [lastDrawnIndex, items.length, hasMore, isLoadingMore, onLoadMore]);

  return (
    <table
      aria-label={label}
      aria-rowcount={hasMore ? UNKNOWN_ROW_COUNT : items.length + 1}
      className="block w-full"
    >
      <thead className="block">
        <tr
          aria-rowindex={1}
          className="grid items-end gap-x-6 pb-2"
          style={{ gridTemplateColumns: columns }}
        >
          {header}
        </tr>
      </thead>
      <tbody
        ref={listRef}
        onFocus={followFocus}
        className="relative block"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {rows.map((row) => {
          const item = items[row.index];
          return item === undefined ? null : (
            <tr
              key={row.key}
              aria-rowindex={row.index + 2}
              data-index={row.index}
              className="absolute inset-x-0 top-0 grid items-center gap-x-6"
              style={{
                gridTemplateColumns: columns,
                height: row.size,
                transform: `translateY(${row.start - scrollMargin}px)`,
              }}
            >
              <RowCells item={item} renderRow={renderRow} />
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};
