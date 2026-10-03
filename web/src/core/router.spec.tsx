import { createAppRouter } from '@app/core/router';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

const renderAt = (path: string): void => {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  renderWithProviders(<RouterProvider router={router} />);
};

describe('the app router', () => {
  it('renders the dashboard inside the shell at /', async () => {
    renderAt('/');

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getAllByRole('navigation', { name: 'Main navigation' })).toHaveLength(2);
  });

  it('renders the not-found screen inside the shell for an unknown address', async () => {
    renderAt('/does-not-exist');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getAllByRole('navigation', { name: 'Main navigation' })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toHaveAttribute(
      'href',
      '/',
    );
  });
});
