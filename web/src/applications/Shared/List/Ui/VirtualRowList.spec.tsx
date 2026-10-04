import { VirtualRowList } from '@app/applications/Shared/List/Ui/VirtualRowList';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const ROW_HEIGHT_PX = 52;

const renderList = (count: number, onLoadMore = vi.fn(), hasMore = true) => {
  const items = Array.from({ length: count }, (_, index) => `close ${index + 1}`);
  renderWithProviders(
    <VirtualRowList
      label="Closed positions"
      items={items}
      getKey={(item) => item}
      getHeight={() => ROW_HEIGHT_PX}
      columns="1fr"
      header={<th>Pool</th>}
      renderRow={(item) => <td>{item}</td>}
      hasMore={hasMore}
      isLoadingMore={false}
      onLoadMore={onLoadMore}
    />,
  );
  return onLoadMore;
};

describe('VirtualRowList', () => {
  it('numbers the drawn rows, and counts them all once the last page is in', () => {
    renderList(2_000, vi.fn(), false);

    const table = screen.getByRole('table', { name: 'Closed positions' });
    expect(table).toHaveAttribute('aria-rowcount', '2001');
    expect(screen.getByRole('columnheader').closest('tr')).toHaveAttribute('aria-rowindex', '1');
    expect(screen.getByText('close 1').closest('tr')).toHaveAttribute('aria-rowindex', '2');
  });

  it('leaves the row count unknown while pages remain to load', () => {
    renderList(50);

    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '-1');
  });

  it('draws only the rows on screen out of 2,000', () => {
    renderList(2_000);

    expect(screen.getAllByRole('cell').length).toBeLessThan(100);
  });

  it('gives every row its fixed height, so nothing jumps while scrolling', () => {
    renderList(3);

    expect(screen.getByText('close 1').closest('tr')).toHaveStyle({ height: `${ROW_HEIGHT_PX}px` });
  });

  it('asks for the next page when the loaded rows end on screen', () => {
    expect(renderList(5)).toHaveBeenCalled();
  });

  it('asks for nothing once the last page is in', () => {
    expect(renderList(5, vi.fn(), false)).not.toHaveBeenCalled();
  });
});
