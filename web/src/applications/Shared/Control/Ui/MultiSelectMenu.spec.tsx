import { MultiSelectMenu } from '@app/applications/Shared/Control/Ui/MultiSelectMenu';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

const STRATEGIES = [
  { id: 'spot', label: 'Spot' },
  { id: 'curve', label: 'Curve' },
  { id: 'bid-ask', label: 'Bid-Ask' },
] as const;

type Strategy = (typeof STRATEGIES)[number]['id'];

const StrategyFilter = ({ initial }: { initial: Strategy[] }) => {
  const [selected, setSelected] = useState<Strategy[]>(initial);
  return (
    <MultiSelectMenu
      label="Strategy"
      options={STRATEGIES}
      selected={selected}
      onChange={setSelected}
    />
  );
};

describe('MultiSelectMenu', () => {
  it('reads "All" when nothing is chosen', () => {
    renderWithProviders(<StrategyFilter initial={[]} />);

    expect(screen.getByRole('button', { name: /Strategy/ })).toHaveTextContent('StrategyAll');
  });

  it('keeps the menu open while choices are ticked, and names them', async () => {
    const user = userEvent.setup();
    renderWithProviders(<StrategyFilter initial={[]} />);

    await user.click(screen.getByRole('button', { name: /Strategy/ }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Spot' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Curve' }));

    expect(screen.getByRole('menuitemcheckbox', { name: 'Curve' })).toBeChecked();
    await user.keyboard('{Escape}');

    expect(await screen.findByRole('button', { name: /Strategy/ })).toHaveTextContent(
      'Spot, Curve',
    );
  });

  it('counts beyond two choices', () => {
    renderWithProviders(<StrategyFilter initial={['spot', 'curve', 'bid-ask']} />);

    expect(screen.getByRole('button', { name: /Strategy/ })).toHaveTextContent('Spot +2');
  });
});
