import { SegmentedTabs } from '@app/applications/Shared/Control/Ui/SegmentedTabs';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

const Series = () => {
  const [selected, setSelected] = useState<'net-worth' | 'real-pnl'>('net-worth');
  return (
    <SegmentedTabs
      label="Series"
      selected={selected}
      onChange={setSelected}
      tabs={[
        { id: 'net-worth', label: 'Net worth', panel: 'Net worth chart' },
        { id: 'real-pnl', label: 'Real PnL', panel: 'Real PnL chart' },
      ]}
    />
  );
};

describe('SegmentedTabs', () => {
  it('shows the panel of the chosen view only', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Series />);
    expect(screen.getByText('Net worth chart')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Real PnL' }));

    expect(screen.getByRole('tab', { name: 'Real PnL' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Real PnL chart')).toBeInTheDocument();
    expect(screen.queryByText('Net worth chart')).toBeNull();
  });
});
