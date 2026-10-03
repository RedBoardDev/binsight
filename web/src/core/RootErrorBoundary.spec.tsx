import { RootErrorBoundary } from '@app/core/RootErrorBoundary';
import { renderWithProviders } from '@test/renderWithProviders';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const CrashingTree = () => {
  throw new Error('a provider crashed');
};

describe('RootErrorBoundary', () => {
  it('replaces a crashed tree with a translated reload screen', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    renderWithProviders(
      <RootErrorBoundary>
        <CrashingTree />
      </RootErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: 'binsight stopped working' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeVisible();
  });

  it('renders its children while nothing fails', () => {
    renderWithProviders(
      <RootErrorBoundary>
        <p>all good</p>
      </RootErrorBoundary>,
    );

    expect(screen.getByText('all good')).toBeVisible();
  });
});
