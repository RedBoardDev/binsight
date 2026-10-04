import { renderAppAt } from '@test/renderAppAt';
import { signedInSession, stubApi } from '@test/stubApi';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const overview = vi.hoisted(() => ({ isBroken: true }));

vi.mock('@app/applications/Overview/Ui/OverviewPage', () => ({
  OverviewPage: () => {
    if (overview.isBroken) {
      throw new Error('the overview failed');
    }
    return <h1>Overview</h1>;
  },
}));

describe('ShellErrorScreen', () => {
  it('shows a failing page inside the shell and renders it again on retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    stubApi({ 'GET /api/v1/auth/session': signedInSession });
    renderAppAt('/');

    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeVisible();
    expect(screen.getAllByRole('navigation', { name: 'Main' })).toHaveLength(2);

    overview.isBroken = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeVisible();
  });
});
