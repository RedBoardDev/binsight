import { renderAppAt } from '@test/renderAppAt';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('the app router', () => {
  it('renders the dashboard inside the shell at /', async () => {
    renderAppAt('/');

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getAllByRole('navigation', { name: 'Main navigation' })).toHaveLength(2);
  });

  it('renders the not-found screen inside the shell for an unknown address', async () => {
    renderAppAt('/does-not-exist');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getAllByRole('navigation', { name: 'Main navigation' })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toHaveAttribute(
      'href',
      '/',
    );
  });
});
