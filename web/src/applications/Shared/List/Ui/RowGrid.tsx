import type { ReactNode } from 'react';

interface RowGridProps<Item> {
  label: string;
  items: readonly Item[];
  getKey: (item: Item) => string;
  columns: string;
  // The header row's cells (<th>).
  header: ReactNode;
  // A row's cells (<td>).
  renderRow: (item: Item) => ReactNode;
}

export const RowGrid = <Item,>({
  label,
  items,
  getKey,
  columns,
  header,
  renderRow,
}: RowGridProps<Item>) => (
  <table aria-label={label} className="block w-full">
    <thead className="block">
      <tr className="grid items-end gap-x-6 pb-2" style={{ gridTemplateColumns: columns }}>
        {header}
      </tr>
    </thead>
    <tbody className="block">
      {items.map((item) => (
        <tr
          key={getKey(item)}
          className="grid items-center gap-x-6"
          style={{ gridTemplateColumns: columns }}
        >
          {renderRow(item)}
        </tr>
      ))}
    </tbody>
  </table>
);
