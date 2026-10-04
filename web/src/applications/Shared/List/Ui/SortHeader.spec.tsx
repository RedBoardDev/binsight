import { SortHeader } from '@app/applications/Shared/List/Ui/SortHeader';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

// A header cell lives in a table's header row.
const inHeaderRow = (cell: ReactNode) => (
  <table>
    <thead>
      <tr>{cell}</tr>
    </thead>
  </table>
);

describe('SortHeader', () => {
  it('says how the column sorts and sorts on press', async () => {
    const onSort = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      inHeaderRow(<SortHeader label="Value" direction="descending" onSort={onSort} />),
    );

    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'descending');
    await user.click(screen.getByRole('button', { name: 'Value' }));

    expect(onSort).toHaveBeenCalledOnce();
  });

  it('shows no arrow on a column that does not sort', () => {
    const { container } = renderWithProviders(
      inHeaderRow(<SortHeader label="Age" direction={null} onSort={() => undefined} />),
    );

    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'none');
    expect(container.querySelector('svg.lucide-arrow-down, svg.lucide-arrow-up')).toBeNull();
  });
});
