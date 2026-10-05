import { PriceChart } from '@app/applications/Shared/Chart/Ui/PriceChart';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ shouldFail: true }));
vi.mock('@app/applications/Shared/Chart/Ui/PriceChart/LightweightPriceChart', () => ({
  LightweightPriceChart: () => {
    if (fixture.shouldFail) throw new Error('Fixture chart loading failure');
    return <p>The fixture chart is ready</p>;
  },
}));

describe('PriceChart', () => {
  it('keeps a loading failure local and retries the lazy renderer without losing the section heading', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderWithProviders(
      <PriceChart
        candles={[]}
        ranges={[]}
        events={[]}
        quoteSymbol="sol"
        timeframe="5m"
        label="Position price"
        summary="Market data"
        activeIndex={null}
        onScrub={() => undefined}
      />,
    );
    expect(await screen.findByRole('alert', {}, { timeout: 10000 })).toHaveTextContent(
      'The price chart could not be loaded.',
    );
    expect(screen.getByText('Price')).toBeVisible();
    expect(error).toHaveBeenCalled();
    fixture.shouldFail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('The fixture chart is ready')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
