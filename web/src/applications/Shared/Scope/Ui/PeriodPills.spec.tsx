import { PeriodPills } from '@app/applications/Shared/Scope/Ui/PeriodPills';
import { renderInScope } from '@test/renderInScope';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

describe('PeriodPills', () => {
  it('shows the period of the URL', async () => {
    await renderInScope(<PeriodPills />, '/?period=3m');

    expect(screen.getByRole('radio', { name: '3M' })).toBeChecked();
  });

  it('shows a month when the URL says nothing or something wrong', async () => {
    await renderInScope(<PeriodPills />, '/?period=2w');

    expect(screen.getByRole('radio', { name: '1M' })).toBeChecked();
  });

  it('writes the chosen period to the URL, and leaves the default out', async () => {
    const user = userEvent.setup();
    const { router } = await renderInScope(<PeriodPills />);

    await user.click(screen.getByRole('radio', { name: '1Y' }));
    expect(router.state.location.searchStr).toBe('?period=1y');

    await user.click(await screen.findByRole('radio', { name: '1M' }));
    expect(router.state.location.searchStr).toBe('');
  });

  it('keeps the period from one page to the next', async () => {
    const user = userEvent.setup();
    const { router } = await renderInScope(<PeriodPills />, '/?period=7d');

    await user.click(screen.getByRole('link', { name: 'Next page' }));

    expect(await screen.findByRole('heading', { name: 'Next page' })).toBeInTheDocument();
    expect(router.state.location.searchStr).toBe('?period=7d');
  });
});
