import { createAppRouter } from '@app/core/router';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { renderWithProviders } from '@test/renderWithProviders';
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
    const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/'] }) });
    renderWithProviders(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeVisible();
    expect(screen.getAllByRole('navigation', { name: 'Main navigation' })).toHaveLength(2);

    dashboard.isBroken = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
