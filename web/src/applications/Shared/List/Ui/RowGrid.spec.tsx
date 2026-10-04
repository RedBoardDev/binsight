import { RowGrid } from '@app/applications/Shared/List/Ui/RowGrid';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('RowGrid', () => {
  it('reads as a table whose rows share one grid', () => {
    renderWithProviders(
      <RowGrid
        label="Closed today"
        items={['WIF/SOL', 'JUP/SOL']}
        getKey={(item) => item}
        columns="1fr 6rem"
        header={
          <>
            <th>Pool</th>
            <th>PnL</th>
          </>
        }
        renderRow={(item) => (
          <>
            <td>{item}</td>
            <td>+0.1</td>
          </>
        )}
      />,
    );

    const table = screen.getByRole('table', { name: 'Closed today' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveStyle({ gridTemplateColumns: '1fr 6rem' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Pool', 'PnL']);
  });
});
