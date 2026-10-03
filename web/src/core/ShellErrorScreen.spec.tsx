import { renderAppAt } from '@test/renderAppAt';
import { signedInSession, stubApi } from '@test/stubApi';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const dashboard = vi.hoisted(() => ({ isBroken: true }));

vi.mock('@app/applications/Dashboard/Ui/DashboardPage', () => ({
  DashboardPage: () => {
    if (dashboard.isBroken) {
      throw new Error('the dashboard failed');
    }
    return <h1>Dashboard</h1>;
  },
}));

describe('ShellErrorScreen', () => {
  it('shows a failing page inside the shell and renders it again on retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    stubApi({ 'GET /api/v1/auth/session': signedInSession });
    renderAppAt('/');

    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeVisible();
    expect(screen.getAllByRole('navigation', { name: 'Main navigation' })).toHaveLength(2);

    dashboard.isBroken = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
